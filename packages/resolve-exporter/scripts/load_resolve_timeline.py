#!/usr/bin/env python
import json
import os
import sys
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


def _ensure_track_count(timeline, track_type, target_count):
    while timeline.GetTrackCount(track_type) < target_count:
        if not timeline.AddTrack(track_type):
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

    with open(request_path, "r", encoding="utf-8") as handle:
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
    if not imported_items or len(imported_items) != len(import_paths):
        raise RuntimeError("Resolve did not import every expected media item.")

    imported_by_path = {
        os.path.normcase(os.path.abspath(import_path)): media_pool_item
        for import_path, media_pool_item in zip(import_paths, imported_items)
    }

    timeline_name = manifest["timelineName"]
    timeline = media_pool.CreateEmptyTimeline(timeline_name)
    if not timeline:
        timeline = media_pool.CreateEmptyTimeline(f"{timeline_name} {manifest['generatedAt'][:19]}")
    if not timeline:
        raise RuntimeError(f"Unable to create timeline: {timeline_name}")

    project.SetCurrentTimeline(timeline)
    timeline.SetStartTimecode(manifest["startTimecode"])

    _ensure_track_count(timeline, "video", len(manifest["videoTracks"]))
    _ensure_track_count(timeline, "audio", len(manifest["audioTracks"]))

    for track in manifest["videoTracks"]:
        timeline.SetTrackName("video", track["index"], track["name"])
    for track in manifest["audioTracks"]:
        timeline.SetTrackName("audio", track["index"], track["name"])

    for item in manifest["items"]:
        source_path = os.path.normcase(os.path.abspath(item["path"]))
        media_pool_item = imported_by_path.get(source_path)
        if not media_pool_item:
            raise RuntimeError(f"Imported media item not found for path: {item['path']}")

        clip_info = {
            "mediaPoolItem": media_pool_item,
            "startFrame": 0,
            "endFrame": max(0, int(item["durationFrames"]) - 1),
            "recordFrame": int(item["recordFrame"]),
            "trackIndex": int(item["trackIndex"]),
            "mediaType": 2 if item["trackType"] == "audio" else 1,
        }
        if not media_pool.AppendToTimeline([clip_info]):
            raise RuntimeError(f"Unable to append item to timeline: {item['id']}")

    project_manager.SaveProject()
    resolve.OpenPage("edit")
    message = f"Resolve timeline loaded: {timeline.GetName()}"
    _write_result(
        request["resultPath"],
        {
            "manifestPath": manifest_path,
            "ok": True,
            "projectName": project.GetName(),
            "timelineName": timeline.GetName(),
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
                "ok": False,
                "traceback": traceback.format_exc(),
            },
        )
        raise
