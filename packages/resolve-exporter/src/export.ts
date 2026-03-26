import {execFile} from "node:child_process";
import * as fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {loadCueRuntime, type CueRuntime} from "@gpu-render/gpu-renderer";
import {resolveFromProject, type SpeakerId, type TalkVideoProject} from "@gpu-render/shared";

const execFileAsync = promisify(execFile);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loaderScriptPath = path.join(packageRoot, "scripts", "load_resolve_timeline.py");
const resolveUserScriptsUtilityDir = path.join(
  process.env.APPDATA ?? "",
  "Blackmagic Design",
  "DaVinci Resolve",
  "Support",
  "Fusion",
  "Scripts",
  "Utility",
);
const menuLoaderFileName = "GPURender_LoadTimeline.py";
const menuRequestFileName = "GPURender_LoadTimeline.request.json";

const zundamonDims = {height: 424, width: 348, x: -66, y: 530};
const metanDims = {height: 424, width: 364, x: 1642, y: 530};

type SubtitleMode = "auto-from-audio";
type SubtitleLineBreak = "single" | "double";

export type ResolveManifestItem = {
  durationFrames: number;
  id: string;
  path: string;
  recordFrame: number;
  trackIndex: number;
  trackType: "audio" | "video";
};

export type ResolveSubtitleConfig = {
  charsPerLine: number;
  lineBreak: SubtitleLineBreak;
  mode: SubtitleMode;
  sourceAudioTrackIndex: number;
  srtPath: string;
  trackName: string;
};

export type ResolveExportManifest = {
  audioTracks: Array<{audioType?: string; index: number; name: string}>;
  exportDir: string;
  fps: number;
  generatedAt: string;
  height: number;
  items: ResolveManifestItem[];
  loaderScriptPath: string;
  projectId: string;
  projectName: string;
  startTimecode: string;
  subtitle?: ResolveSubtitleConfig;
  timelineName: string;
  videoTracks: Array<{index: number; name: string}>;
  width: number;
};

export type ResolveExportResult = {
  exportDir: string;
  loaderScriptPath: string;
  manifest: ResolveExportManifest;
  manifestPath: string;
};

export type ResolveMenuLoaderInstallResult = {
  loaderPath: string;
  requestPath: string;
  resultPath: string;
  utilityDir: string;
};

type ExportOptions = {
  log?: (message: string) => void;
};

const runFfmpeg = async (args: string[], log: (message: string) => void) => {
  log(`ffmpeg ${args.join(" ")}`);
  await execFileAsync("ffmpeg", ["-y", ...args], {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 16,
  });
};

const formatTimecode = (frame: number, fps: number) => {
  const totalMs = Math.round((frame / fps) * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
    seconds,
  ).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
};

const buildSrt = (cues: CueRuntime[], fps: number) =>
  cues
    .map((cue, index) =>
      [
        `${index + 1}`,
        `${formatTimecode(cue.startFrame, fps)} --> ${formatTimecode(
          cue.startFrame + cue.durationFrames,
          fps,
        )}`,
        cue.subtitleText || cue.text,
      ].join("\n"),
    )
    .join("\n\n");

const buildBackgroundFilter = () =>
  [
    "format=rgba",
    "drawbox=x=0:y=0:w=iw:h=ih:color=0x9eb7f2:t=fill",
    "drawbox=x=0:y=0:w=iw:h=ih:color=0xb4c7fb@0.35:t=fill",
    "drawgrid=width=34:height=34:thickness=1:color=white@0.12",
    "drawbox=x=1420:y=704:w=270:h=210:color=0xffffff@0.14:t=fill",
    "drawbox=x=104:y=824:w=400:h=150:color=0xffd2ee@0.16:t=fill",
  ].join(",");

const getCharacterDefinition = (project: TalkVideoProject, speaker: SpeakerId) => {
  const character = project.characters.find((item) => item.id === speaker);
  if (!character) {
    throw new Error(`Character definition for ${speaker} was not found.`);
  }
  return character;
};

const getClosedUpperBodyPath = (
  projectPath: string,
  project: TalkVideoProject,
  speaker: SpeakerId,
) => {
  const character = getCharacterDefinition(project, speaker);
  const upperDir = resolveFromProject(projectPath, character.visual.upperDir);
  const expression = character.visual.defaultExpression ?? "normal";
  return path.join(upperDir, `${expression}-closed.png`);
};

const exportBackgroundStill = async (
  cue: CueRuntime,
  outputPath: string,
  log: (message: string) => void,
) => {
  if (!cue.topAssetPath || !cue.cardAssetPath) {
    throw new Error(`Cue ${cue.index + 1} is missing background assets.`);
  }

  await runFfmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      "color=c=0x9eb7f2:s=1920x1080:r=1:d=1",
      "-loop",
      "1",
      "-t",
      "1",
      "-i",
      cue.topAssetPath,
      "-loop",
      "1",
      "-t",
      "1",
      "-i",
      cue.cardAssetPath,
      "-filter_complex",
      [
        `[0:v]${buildBackgroundFilter()}[bg]`,
        "[1:v]format=rgba[top]",
        "[2:v]format=rgba[card]",
        "[bg][top]overlay=0:0:shortest=1:eof_action=pass[b1]",
        "[b1][card]overlay=255:138:shortest=1:eof_action=pass[v]",
      ].join(";"),
      "-map",
      "[v]",
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgba",
      outputPath,
    ],
    log,
  );
};

const exportCharacterStill = async (
  projectPath: string,
  project: TalkVideoProject,
  speaker: SpeakerId,
  outputPath: string,
  log: (message: string) => void,
) => {
  const dims = speaker === "zundamon" ? zundamonDims : metanDims;
  const upperPath = getClosedUpperBodyPath(projectPath, project, speaker);
  const speakerFilter =
    speaker === "zundamon"
      ? `[1:v]scale=${dims.width}:${dims.height}:flags=lanczos,format=rgba,hflip[char]`
      : `[1:v]scale=${dims.width}:${dims.height}:flags=lanczos,format=rgba[char]`;

  await runFfmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      "color=c=black@0.0:s=1920x1080:r=1:d=1",
      "-loop",
      "1",
      "-t",
      "1",
      "-i",
      upperPath,
      "-filter_complex",
      [
        "[0:v]format=rgba,colorchannelmixer=aa=0[base]",
        speakerFilter,
        `[base][char]overlay=${dims.x}:${dims.y}:shortest=1:eof_action=pass[v]`,
      ].join(";"),
      "-map",
      "[v]",
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgba",
      outputPath,
    ],
    log,
  );
};

const normalizeAudio = async (
  inputPath: string,
  outputPath: string,
  log: (message: string) => void,
) => {
  await runFfmpeg(
    [
      "-i",
      inputPath,
      "-map",
      "0:a:0",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      outputPath,
    ],
    log,
  );
};

export const exportProjectForResolve = async (
  projectPath: string,
  project: TalkVideoProject,
  options?: ExportOptions,
): Promise<ResolveExportResult> => {
  const log = options?.log ?? (() => {});
  const absoluteProjectPath = path.resolve(projectPath);
  const exportDir = resolveFromProject(absoluteProjectPath, project.renderTargets.resolve.exportDir);
  await fsPromises.rm(exportDir, {force: true, recursive: true});
  const backgroundsDir = path.join(exportDir, "media", "backgrounds");
  const charactersDir = path.join(exportDir, "media", "characters");
  const audioDir = path.join(exportDir, "media", "audio");
  const subtitlesDir = path.join(exportDir, "subtitles");

  await fsPromises.mkdir(backgroundsDir, {recursive: true});
  await fsPromises.mkdir(charactersDir, {recursive: true});
  await fsPromises.mkdir(audioDir, {recursive: true});
  await fsPromises.mkdir(subtitlesDir, {recursive: true});

  const {cues} = loadCueRuntime(absoluteProjectPath, project);
  const manifestItems: ResolveManifestItem[] = [];
  const fps = project.timeline.fps;

  const zundamonStillPath = path.join(charactersDir, "zundamon.png");
  const metanStillPath = path.join(charactersDir, "metan.png");
  await exportCharacterStill(absoluteProjectPath, project, "zundamon", zundamonStillPath, log);
  await exportCharacterStill(absoluteProjectPath, project, "metan", metanStillPath, log);

  for (const cue of cues) {
    const suffix = String(cue.index + 1).padStart(2, "0");
    const backgroundPath = path.join(backgroundsDir, `cue-${suffix}.png`);
    await exportBackgroundStill(cue, backgroundPath, log);

    manifestItems.push(
      {
        durationFrames: cue.durationFrames,
        id: `background-${suffix}`,
        path: backgroundPath,
        recordFrame: cue.startFrame,
        trackIndex: 1,
        trackType: "video",
      },
      {
        durationFrames: cue.durationFrames,
        id: `zundamon-${suffix}`,
        path: zundamonStillPath,
        recordFrame: cue.startFrame,
        trackIndex: 2,
        trackType: "video",
      },
      {
        durationFrames: cue.durationFrames,
        id: `metan-${suffix}`,
        path: metanStillPath,
        recordFrame: cue.startFrame,
        trackIndex: 3,
        trackType: "video",
      },
    );
  }

  const narrationPath = path.join(audioDir, "narration.wav");
  const bgmPath = path.join(audioDir, "bgm.wav");
  await normalizeAudio(
    resolveFromProject(absoluteProjectPath, project.timeline.audioMix.combinedNarrationPath),
    narrationPath,
    log,
  );
  if (project.timeline.audioMix.bgmPath) {
    await normalizeAudio(
      resolveFromProject(absoluteProjectPath, project.timeline.audioMix.bgmPath),
      bgmPath,
      log,
    );
  }

  manifestItems.push({
    durationFrames: project.timeline.durationFrames,
    id: "audio-narration",
    path: narrationPath,
    recordFrame: 0,
    trackIndex: 1,
    trackType: "audio",
  });
  if (project.timeline.audioMix.bgmPath && fs.existsSync(bgmPath)) {
    manifestItems.push({
      durationFrames: project.timeline.durationFrames,
      id: "audio-bgm",
      path: bgmPath,
      recordFrame: 0,
      trackIndex: 2,
      trackType: "audio",
    });
  }

  const srtPath = path.join(subtitlesDir, "timeline.srt");
  await fsPromises.writeFile(srtPath, `${buildSrt(cues, fps)}\n`, "utf8");

  const manifest: ResolveExportManifest = {
    audioTracks: [
      {audioType: "stereo", index: 1, name: "Narration"},
      ...(project.timeline.audioMix.bgmPath ? [{audioType: "stereo", index: 2, name: "BGM"}] : []),
    ],
    exportDir,
    fps,
    generatedAt: new Date().toISOString(),
    height: project.timeline.height,
    items: manifestItems,
    loaderScriptPath,
    projectId: project.project.id,
    projectName: `${project.project.title} Resolve Auto`,
    startTimecode: project.timeline.startTimecode ?? "01:00:00:00",
    subtitle: {
      charsPerLine: 24,
      lineBreak: project.style.subtitleBand.maxLines === 1 ? "single" : "double",
      mode: "auto-from-audio",
      sourceAudioTrackIndex: 1,
      srtPath,
      trackName: "Subtitle",
    },
    timelineName: `${project.project.title} Timeline`,
    videoTracks: [
      {index: 1, name: "Background"},
      {index: 2, name: "Zundamon"},
      {index: 3, name: "Metan"},
    ],
    width: project.timeline.width,
  };

  const manifestPath = path.join(exportDir, "resolve-export.manifest.json");
  await fsPromises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    exportDir,
    loaderScriptPath,
    manifest,
    manifestPath,
  };
};

export const loadResolveManifest = async (
  manifestPath: string,
  options?: ExportOptions,
) => {
  const log = options?.log ?? (() => {});
  const absoluteManifestPath = path.resolve(manifestPath);
  if (!fs.existsSync(loaderScriptPath)) {
    throw new Error(`Resolve loader script was not found: ${loaderScriptPath}`);
  }

  log(`python ${loaderScriptPath} ${absoluteManifestPath}`);
  await execFileAsync("python", [loaderScriptPath, absoluteManifestPath], {
    windowsHide: false,
    maxBuffer: 1024 * 1024 * 16,
  });
};

export const installResolveMenuLoader = async (
  manifestPath: string,
): Promise<ResolveMenuLoaderInstallResult> => {
  const absoluteManifestPath = path.resolve(manifestPath);
  const utilityDir = resolveUserScriptsUtilityDir;
  const loaderPath = path.join(utilityDir, menuLoaderFileName);
  const requestPath = path.join(utilityDir, menuRequestFileName);
  const resultPath = `${absoluteManifestPath}.resolve-load.result.json`;

  await fsPromises.mkdir(utilityDir, {recursive: true});
  await fsPromises.copyFile(loaderScriptPath, loaderPath);
  await fsPromises.writeFile(
    requestPath,
    `${JSON.stringify(
      {
        manifestPath: absoluteManifestPath,
        requestedAt: new Date().toISOString(),
        resultPath,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    loaderPath,
    requestPath,
    resultPath,
    utilityDir,
  };
};
