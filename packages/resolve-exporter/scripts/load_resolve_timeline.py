#!/usr/bin/env python
import json
import math
import os
import sys
import time
import traceback


def _append_module_path():
    default_modules = (
        r"C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting\Modules"
    )
    if default_modules not in sys.path:
        sys.path.append(default_modules)


def _get_resolve():
    existing = globals().get("resolve")
    if existing:
        return existing

    _append_module_path()
    import DaVinciResolveScript as dvr  # type: ignore

    return dvr.scriptapp("Resolve")


def _ensure_project(project_manager, name):
    project = project_manager.LoadProject(name)
    if project:
        return project

    project = project_manager.CreateProject(name)
    if project:
        return project

    project = project_manager.LoadProject(name)
    if project:
        return project

    raise RuntimeError(f"Unable to create or load Resolve project: {name}")


def _dedupe_paths(items):
    seen = set()
    ordered = []
    for item in items:
        path_value = os.path.abspath(item["path"])
        normalized = os.path.normcase(path_value)
        if normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(path_value)
    return ordered


def _find_or_create_folder(media_pool, parent_folder, name):
    for folder in parent_folder.GetSubFolderList():
        if folder.GetName() == name:
            return folder
    created = media_pool.AddSubFolder(parent_folder, name)
    if not created:
        raise RuntimeError(f"Unable to create media pool folder: {name}")
    return created


def _build_imported_by_path(folder, imported_items):
    imported_by_path = {}

    for item in imported_items or []:
        clip_path = item.GetClipProperty("File Path")
        if clip_path:
            imported_by_path[os.path.normcase(os.path.abspath(clip_path))] = item

    for item in folder.GetClipList() or []:
        clip_path = item.GetClipProperty("File Path")
        if clip_path:
            imported_by_path[os.path.normcase(os.path.abspath(clip_path))] = item

    return imported_by_path


def _collect_missing_paths(import_paths, imported_by_path):
    return [
        import_path
        for import_path in import_paths
        if os.path.normcase(os.path.abspath(import_path)) not in imported_by_path
    ]


def _apply_timeline_item_properties(timeline_items, item_definition):
    properties = item_definition.get("properties") or {}
    if not properties:
        return

    for timeline_item in timeline_items or []:
        for property_key, property_value in properties.items():
            ok = timeline_item.SetProperty(property_key, property_value)
            if not ok:
                raise RuntimeError(
                    f"Unable to set timeline property {property_key} for item: {item_definition['id']}"
                )


def _ensure_track_count(timeline, track_type, target_count, audio_tracks=None):
    while timeline.GetTrackCount(track_type) < target_count:
        index = timeline.GetTrackCount(track_type) + 1
        if track_type == "audio":
            audio_type = "stereo"
            if audio_tracks and len(audio_tracks) >= index:
                audio_type = audio_tracks[index - 1].get("audioType", "stereo")
            ok = timeline.AddTrack(track_type, {"audioType": audio_type, "index": index})
        else:
            ok = timeline.AddTrack(track_type, {"index": index})
        if not ok:
            raise RuntimeError(f"Unable to add {track_type} track {target_count}")


def _load_request_payload():
    if len(sys.argv) >= 2:
        manifest_path = os.path.abspath(sys.argv[1])
        return {
            "manifestPath": manifest_path,
            "requestPath": None,
            "resultPath": None,
        }

    script_path = os.path.abspath(globals().get("__file__") or sys.argv[0])
    request_path = os.path.splitext(script_path)[0] + ".request.json"
    if not os.path.exists(request_path):
        raise RuntimeError(
            "Manifest path was not provided and no request file was found next to the loader script."
        )

    with open(request_path, "r", encoding="utf-8-sig") as handle:
        payload = json.load(handle)

    manifest_path = os.path.abspath(payload["manifestPath"])
    result_path = payload.get("resultPath")
    if result_path:
        result_path = os.path.abspath(result_path)

    return {
        "manifestPath": manifest_path,
        "requestPath": request_path,
        "resultPath": result_path,
    }


def _write_result(result_path, payload):
    if not result_path:
        return

    parent_dir = os.path.dirname(result_path)
    if parent_dir:
        os.makedirs(parent_dir, exist_ok=True)

    with open(result_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def _timecode_to_frame_count(timecode, fps):
    parts = [int(part) for part in str(timecode).split(":")]
    if len(parts) != 4:
        raise RuntimeError(f"Unsupported timecode format: {timecode}")

    hours, minutes, seconds, frames = parts
    return (((hours * 60) + minutes) * 60 + seconds) * int(fps) + frames


def _append_via_media_pool(media_pool, imported_by_path, timeline_start_frame, items):
    created_items_by_id = {}
    for item in items:
        source_path = os.path.normcase(os.path.abspath(item["path"]))
        media_pool_item = imported_by_path.get(source_path)
        if not media_pool_item:
            raise RuntimeError(f"Imported media item not found for path: {item['path']}")

        clip_info = {
            "mediaPoolItem": media_pool_item,
            "startFrame": 0,
            "endFrame": max(0, int(item["durationFrames"]) - 1),
            "recordFrame": timeline_start_frame + int(item["recordFrame"]),
            "trackIndex": int(item["trackIndex"]),
            "mediaType": 2 if item["trackType"] == "audio" else 1,
        }
        appended = media_pool.AppendToTimeline([clip_info])
        if not appended:
            raise RuntimeError(f"Unable to append item to timeline: {item['id']}")
        _apply_timeline_item_properties(appended, item)
        created_items_by_id[item["id"]] = appended
    return created_items_by_id


def _set_comp_time(comp, frame):
    if hasattr(comp, "_SetCurrentTime"):
        comp._SetCurrentTime(int(frame))
        return

    if hasattr(comp, "SetCurrentTime"):
        comp.SetCurrentTime(int(frame))
        return

    raise RuntimeError("Fusion composition does not expose a time setter.")


def _connect_media_output(media_out, tool):
    ok = media_out.ConnectInput("Input", tool)
    if not ok:
        raise RuntimeError("Unable to connect Fusion tool to MediaOut.")


def _build_character_fusion(item, animation, fps):
    if not animation:
        return {"created": False, "reason": "animation-config-missing"}

    comp = item.AddFusionComp()
    if not comp:
        return {"created": False, "reason": "add-fusion-comp-failed"}

    media_out = comp.FindTool("MediaOut1")
    if not media_out:
        return {"created": False, "reason": "media-out-missing"}

    loaders = {}
    dissolves = {}
    transform = None
    comp.Lock()
    try:
        for key in ("closed", "mid", "open", "blink"):
            tool = comp.AddTool("Loader")
            if not tool:
                raise RuntimeError(f"Unable to create Loader for {key}")
            tool.SetInput("Clip", os.path.abspath(animation["assets"][key]))
            loaders[key] = tool

        dissolves["closed_mid"] = comp.AddTool("Dissolve")
        dissolves["mouth"] = comp.AddTool("Dissolve")
        dissolves["blink"] = comp.AddTool("Dissolve")
        transform = comp.AddTool("Transform")
        if not dissolves["closed_mid"] or not dissolves["mouth"] or not dissolves["blink"] or not transform:
            raise RuntimeError("Unable to create Fusion blend tools")

        dissolves["closed_mid"].ConnectInput("Background", loaders["closed"])
        dissolves["closed_mid"].ConnectInput("Foreground", loaders["mid"])

        dissolves["mouth"].ConnectInput("Background", dissolves["closed_mid"])
        dissolves["mouth"].ConnectInput("Foreground", loaders["open"])

        dissolves["blink"].ConnectInput("Background", dissolves["mouth"])
        dissolves["blink"].ConnectInput("Foreground", loaders["blink"])

        transform.ConnectInput("Input", dissolves["blink"])
        _connect_media_output(media_out, transform)

        mouth_by_frame = animation.get("mouthByFrame") or []
        blink_by_frame = animation.get("blinkByFrame") or []
        frame_count = max(len(mouth_by_frame), len(blink_by_frame))
        amplitude = float(animation["bob"]["amplitude"])
        frequency_hz = float(animation["bob"]["frequencyHz"])
        phase_offset = float(animation["bob"]["phaseOffset"])

        for frame in range(frame_count):
            _set_comp_time(comp, frame)
            mouth = mouth_by_frame[frame] if frame < len(mouth_by_frame) else "closed"
            blink = bool(blink_by_frame[frame]) if frame < len(blink_by_frame) else False

            dissolves["closed_mid"].SetInput("Mix", 1.0 if mouth == "mid" else 0.0)
            dissolves["mouth"].SetInput("Mix", 1.0 if mouth == "open" else 0.0)
            dissolves["blink"].SetInput("Mix", 1.0 if blink else 0.0)

            y = 0.5 + amplitude * math.sin(((frame / float(fps)) * (math.pi * 2.0) * frequency_hz) + phase_offset)
            transform.SetInput("Center", {1: 0.5, 2: y})
            transform.SetInput("Size", 1.0)

        _set_comp_time(comp, 0)
    finally:
        comp.Unlock()

    return {
        "created": True,
        "frameCount": frame_count,
        "speaker": animation.get("speaker"),
    }


def _apply_character_fusions(created_video_items_by_id, manifest):
    animation_results = []
    fps = int(manifest["fps"])
    for animation in manifest.get("characterAnimations") or []:
        item_id = animation.get("itemId")
        created_items = created_video_items_by_id.get(item_id) or []
        if not created_items:
            animation_results.append(
                {"created": False, "itemId": item_id, "reason": "timeline-item-missing"}
            )
            continue
        timeline_item = created_items[0]
        result = _build_character_fusion(timeline_item, animation, fps)
        result["itemId"] = item_id
        animation_results.append(result)
    return animation_results


def _append_subtitle_srt(media_pool, target_folder, timeline, timeline_start_frame, manifest, subtitle_config):
    srt_path = os.path.abspath(subtitle_config.get("srtPath") or "")
    if not srt_path:
        return {"created": False, "reason": "subtitle-srt-path-missing"}

    if not os.path.exists(srt_path):
        return {"created": False, "reason": "subtitle-srt-not-found", "srtPath": srt_path}

    if timeline.GetTrackCount("subtitle") < 1:
        ok = timeline.AddTrack("subtitle", {"index": 1})
        if not ok:
            return {"created": False, "reason": "add-subtitle-track-failed", "srtPath": srt_path}

    before_count = len(timeline.GetItemListInTrack("subtitle", 1) or [])
    timeline.SetCurrentTimecode(manifest["startTimecode"])

    imported_items = media_pool.ImportMedia([srt_path]) or []
    imported_by_path = _build_imported_by_path(target_folder, imported_items)
    media_pool_item = imported_by_path.get(os.path.normcase(srt_path))
    if not media_pool_item:
        return {
            "created": False,
            "reason": "subtitle-srt-not-imported-as-media",
            "importedCount": len(imported_items),
            "srtPath": srt_path,
        }

    appended = media_pool.AppendToTimeline([media_pool_item]) or []
    if not appended:
        return {"created": False, "reason": "subtitle-append-failed", "srtPath": srt_path}

    track_locations = []
    subtitle_items = []
    for timeline_item in appended:
        track_type, track_index = timeline_item.GetTrackTypeAndIndex()
        track_locations.append({"trackIndex": track_index, "trackType": track_type})
        if track_type == "subtitle":
            subtitle_items.append(timeline_item)

    if not subtitle_items:
        timeline.DeleteClips(appended, False)
        return {
            "created": False,
            "reason": "subtitle-appended-to-non-subtitle-track",
            "locations": track_locations,
            "srtPath": srt_path,
        }

    after_count = len(timeline.GetItemListInTrack("subtitle", 1) or [])
    timeline.SetTrackName("subtitle", 1, subtitle_config.get("trackName", "Subtitle"))
    timeline.SetCurrentTimecode(manifest["startTimecode"])
    return {
        "afterItemCount": after_count,
        "created": after_count > before_count,
        "importedCount": len(imported_items),
        "locations": track_locations,
        "method": "import-srt",
        "srtPath": srt_path,
    }


def _create_subtitles(resolve, media_pool, target_folder, timeline, manifest):
    subtitle_config = manifest.get("subtitle")
    if not subtitle_config:
        return {"created": False}

    srt_result = _append_subtitle_srt(
        media_pool,
        target_folder,
        timeline,
        _timecode_to_frame_count(manifest["startTimecode"], manifest["fps"]),
        manifest,
        subtitle_config,
    )
    if srt_result.get("created"):
        return srt_result

    product_name = str(resolve.GetProductName() or "")
    if "Studio" not in product_name:
        srt_result["studioFallback"] = "unavailable-in-resolve-free"
        return srt_result

    before_count = timeline.GetTrackCount("subtitle")
    settings = {
        resolve.SUBTITLE_LANGUAGE: resolve.AUTO_CAPTION_AUTO,
        resolve.SUBTITLE_CAPTION_PRESET: resolve.AUTO_CAPTION_SUBTITLE_DEFAULT,
        resolve.SUBTITLE_CHARS_PER_LINE: int(subtitle_config.get("charsPerLine", 24)),
        resolve.SUBTITLE_LINE_BREAK: resolve.AUTO_CAPTION_LINE_DOUBLE
        if subtitle_config.get("lineBreak") == "double"
        else resolve.AUTO_CAPTION_LINE_SINGLE,
        resolve.SUBTITLE_GAP: 0,
    }
    ok = timeline.CreateSubtitlesFromAudio(settings)
    after_count = timeline.GetTrackCount("subtitle")
    if ok and after_count > 0:
        timeline.SetTrackName("subtitle", after_count, subtitle_config.get("trackName", "Subtitle"))
    return {
        "created": bool(ok),
        "method": "auto-from-audio",
        "srtAttempt": srt_result,
        "subtitleTrackCount": after_count,
        "subtitleTrackCountBefore": before_count,
    }


def main():
    request = _load_request_payload()
    manifest_path = request["manifestPath"]
    with open(manifest_path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    resolve = _get_resolve()
    if not resolve:
        raise RuntimeError("DaVinci Resolve is not running or scripting is unavailable.")

    project_manager = resolve.GetProjectManager()
    project = _ensure_project(project_manager, manifest["projectName"])

    project.SetSetting("timelineFrameRate", str(manifest["fps"]))
    project.SetSetting("timelinePlaybackFrameRate", str(manifest["fps"]))
    project.SetSetting("timelineResolutionWidth", str(manifest["width"]))
    project.SetSetting("timelineResolutionHeight", str(manifest["height"]))

    media_pool = project.GetMediaPool()
    root_folder = media_pool.GetRootFolder()
    target_folder = _find_or_create_folder(media_pool, root_folder, manifest["projectId"])
    media_pool.SetCurrentFolder(target_folder)

    import_paths = _dedupe_paths(manifest["items"])
    imported_items = media_pool.ImportMedia(import_paths)
    imported_by_path = {}
    missing_paths = import_paths

    for _ in range(10):
        imported_by_path = _build_imported_by_path(target_folder, imported_items)
        missing_paths = _collect_missing_paths(import_paths, imported_by_path)
        if not missing_paths:
            break
        time.sleep(0.5)

    if missing_paths:
        raise RuntimeError(
            "Resolve did not expose expected media items after import: "
            + ", ".join(missing_paths[:5])
        )

    timeline_name = manifest["timelineName"]
    timeline = media_pool.CreateEmptyTimeline(timeline_name)
    if not timeline:
        fallback_name = f"{timeline_name} {time.strftime('%Y-%m-%dT%H-%M-%S')}"
        timeline = media_pool.CreateEmptyTimeline(fallback_name)
    if not timeline:
        raise RuntimeError(f"Unable to create timeline: {timeline_name}")

    project.SetCurrentTimeline(timeline)
    timeline.SetStartTimecode(manifest["startTimecode"])
    timeline_start_frame = _timecode_to_frame_count(manifest["startTimecode"], manifest["fps"])

    _ensure_track_count(timeline, "video", len(manifest["videoTracks"]))
    _ensure_track_count(timeline, "audio", len(manifest["audioTracks"]), manifest["audioTracks"])

    for track in manifest["videoTracks"]:
        timeline.SetTrackName("video", track["index"], track["name"])
    for track in manifest["audioTracks"]:
        timeline.SetTrackName("audio", track["index"], track["name"])

    video_items = [item for item in manifest["items"] if item["trackType"] == "video"]
    narration_items = [
        item
        for item in manifest["items"]
        if item["trackType"] == "audio" and item["trackIndex"] == manifest["subtitle"]["sourceAudioTrackIndex"]
    ] if manifest.get("subtitle") else [item for item in manifest["items"] if item["trackType"] == "audio"]
    other_audio_items = [
        item
        for item in manifest["items"]
        if item["trackType"] == "audio"
        and (not manifest.get("subtitle") or item["trackIndex"] != manifest["subtitle"]["sourceAudioTrackIndex"])
    ]

    created_video_items_by_id = _append_via_media_pool(media_pool, imported_by_path, timeline_start_frame, sorted(video_items, key=lambda item: (item["recordFrame"], item["trackIndex"])))
    _append_via_media_pool(media_pool, imported_by_path, timeline_start_frame, sorted(narration_items, key=lambda item: (item["recordFrame"], item["trackIndex"])))
    _append_via_media_pool(media_pool, imported_by_path, timeline_start_frame, sorted(other_audio_items, key=lambda item: (item["recordFrame"], item["trackIndex"])))
    subtitle_result = _create_subtitles(resolve, media_pool, target_folder, timeline, manifest)
    fusion_result = _apply_character_fusions(created_video_items_by_id, manifest)
    timeline.SetCurrentTimecode(manifest["startTimecode"])

    project_manager.SaveProject()
    resolve.OpenPage("edit")
    timeline.SetCurrentTimecode(manifest["startTimecode"])
    message = f"Resolve timeline loaded: {timeline.GetName()}"
    _write_result(
        request["resultPath"],
        {
            "manifestPath": manifest_path,
            "ok": True,
            "projectName": project.GetName(),
            "subtitle": subtitle_result,
            "fusion": fusion_result,
            "timelineName": timeline.GetName(),
            "timelineStartFrame": timeline_start_frame,
        },
    )
    if request["requestPath"] and os.path.exists(request["requestPath"]):
        os.remove(request["requestPath"])
    print(message)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        result_path = None
        try:
            request = _load_request_payload()
            result_path = request["resultPath"]
        except Exception:
            pass

        _write_result(
            result_path,
            {
                "error": str(exc),
                "manifestPath": request.get("manifestPath") if "request" in locals() else None,
                "ok": False,
                "traceback": traceback.format_exc(),
            },
        )
        raise
