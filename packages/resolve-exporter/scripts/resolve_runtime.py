#!/usr/bin/env python
import json
import os
import sys
import time


def _append_module_path():
    candidates = [
        os.environ.get("RESOLVE_SCRIPT_API"),
        os.environ.get("RESOLVE_SCRIPT_LIB"),
        r"C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting\Modules",
    ]
    for candidate in candidates:
        if candidate and os.path.isdir(candidate) and candidate not in sys.path:
            sys.path.append(candidate)


def _get_resolve():
    _append_module_path()
    import DaVinciResolveScript as dvr  # type: ignore

    return dvr.scriptapp("Resolve")


def _load_payload():
    if len(sys.argv) < 2:
        raise RuntimeError("Expected action argument.")

    action = sys.argv[1]
    payload = {}
    if len(sys.argv) >= 3:
        payload_path = os.path.abspath(sys.argv[2])
        with open(payload_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    return action, payload


def _find_timeline_by_name(project, timeline_name):
    for index in range(1, int(project.GetTimelineCount() or 0) + 1):
        timeline = project.GetTimelineByIndex(index)
        if timeline and timeline.GetName() == timeline_name:
            return timeline
    return None


def _resolve_project_and_timeline(resolve, payload):
    project_manager = resolve.GetProjectManager()
    project_name = payload.get("projectName")
    timeline_name = payload.get("timelineName")

    if project_name:
        project = project_manager.LoadProject(project_name)
        if not project:
            raise RuntimeError(f"Unable to load Resolve project: {project_name}")
    else:
        project = project_manager.GetCurrentProject()

    if not project:
        raise RuntimeError("No active Resolve project.")

    if timeline_name:
        timeline = _find_timeline_by_name(project, timeline_name)
        if not timeline:
            raise RuntimeError(f"Unable to find timeline: {timeline_name}")
        project.SetCurrentTimeline(timeline)
    else:
        timeline = project.GetCurrentTimeline()

    return project_manager, project, timeline


def _find_or_create_folder(media_pool, parent_folder, name):
    for folder in parent_folder.GetSubFolderList() or []:
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


def _collect_audio_paths(folder_path, recursive):
    allowed = {".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"}
    collected = []
    for root, dirs, files in os.walk(folder_path):
        for file_name in files:
            extension = os.path.splitext(file_name)[1].lower()
            if extension in allowed:
                collected.append(os.path.abspath(os.path.join(root, file_name)))
        if not recursive:
            break
    return sorted(collected)


def _cmd_ping(resolve, _payload):
    project_manager = resolve.GetProjectManager()
    project = project_manager.GetCurrentProject()
    timeline = project.GetCurrentTimeline() if project else None
    return {
        "currentProjectName": project.GetName() if project else None,
        "currentTimelineName": timeline.GetName() if timeline else None,
        "ok": True,
        "productName": resolve.GetProductName(),
    }


def _cmd_sync_audio_folder(resolve, payload):
    folder_path = os.path.abspath(payload.get("folderPath") or "")
    if not folder_path or not os.path.isdir(folder_path):
        raise RuntimeError(f"Audio folder was not found: {folder_path}")

    _, project, _timeline = _resolve_project_and_timeline(resolve, payload)
    media_pool = project.GetMediaPool()
    root_folder = media_pool.GetRootFolder()
    bin_name = payload.get("binName") or os.path.basename(folder_path.rstrip("\\/")) or "Imported Audio"
    target_folder = _find_or_create_folder(media_pool, root_folder, bin_name)
    media_pool.SetCurrentFolder(target_folder)

    discovered_paths = _collect_audio_paths(folder_path, bool(payload.get("recursive")))
    imported_by_path = _build_imported_by_path(target_folder, [])
    missing_paths = [
        candidate
        for candidate in discovered_paths
        if os.path.normcase(candidate) not in imported_by_path
    ]

    imported_items = media_pool.ImportMedia(missing_paths) if missing_paths else []
    imported_count = len(imported_items or [])

    return {
        "binName": bin_name,
        "discoveredCount": len(discovered_paths),
        "folderPath": folder_path,
        "importedCount": imported_count,
        "ok": True,
        "projectName": project.GetName(),
    }


def _cmd_render_current(resolve, payload):
    _, project, timeline = _resolve_project_and_timeline(resolve, payload)
    if not timeline:
        raise RuntimeError("No active Resolve timeline.")

    preset_name = payload.get("presetName")
    if preset_name:
        ok = project.LoadRenderPreset(preset_name)
        if not ok:
            raise RuntimeError(f"Unable to load render preset: {preset_name}")

    settings = {}
    if payload.get("outputDir"):
        settings["TargetDir"] = os.path.abspath(payload["outputDir"])
    if payload.get("customName"):
        settings["CustomName"] = payload["customName"]
    if settings:
        ok = project.SetRenderSettings(settings)
        if not ok:
            raise RuntimeError("Unable to apply Resolve render settings.")

    job_id = project.AddRenderJob()
    if not job_id:
        raise RuntimeError("Unable to add Resolve render job.")

    started = False
    if payload.get("start", True):
        started = bool(project.StartRendering())
        if not started:
            raise RuntimeError("Unable to start Resolve rendering.")

    waited = False
    if started and payload.get("wait"):
        waited = True
        while project.IsRenderingInProgress():
            time.sleep(0.5)

    return {
        "customName": payload.get("customName"),
        "jobId": job_id,
        "ok": True,
        "outputDir": settings.get("TargetDir"),
        "presetName": preset_name,
        "projectName": project.GetName(),
        "started": started,
        "timelineName": timeline.GetName(),
        "waited": waited,
    }


COMMANDS = {
    "ping": _cmd_ping,
    "render-current": _cmd_render_current,
    "sync-audio-folder": _cmd_sync_audio_folder,
}


def main():
    action, payload = _load_payload()
    if action not in COMMANDS:
        raise RuntimeError(f"Unsupported action: {action}")

    resolve = _get_resolve()
    if not resolve:
        raise RuntimeError("DaVinci Resolve is not running or scripting is unavailable.")

    result = COMMANDS[action](resolve, payload)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
