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

const cardLayout = {targetX: 255, targetY: 138};
const characterLayoutDefaults = {
  bottomMargin: 126,
  targetHeight: 424,
  visibleWidth: 280,
};
const speakerTrackMap = {
  metan: {index: 2, name: "四国めたん"},
  zundamon: {index: 1, name: "ずんだもん"},
} as const satisfies Record<SpeakerId, {index: number; name: string}>;

type SubtitleMode = "auto-from-audio";
type SubtitleLineBreak = "single" | "double";
type ResolveTimelinePropertyValue = boolean | number | string;

export type ResolveTimelineProperties = Record<string, ResolveTimelinePropertyValue>;

export type ResolveManifestItem = {
  durationFrames: number;
  id: string;
  path: string;
  properties?: ResolveTimelineProperties;
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

type ImageDimensions = {
  height: number;
  width: number;
};

const resolveExportAudioMode = {
  includeBgm: false,
  narrationTrackType: "stereo" as const,
};

const runFfmpeg = async (args: string[], log: (message: string) => void) => {
  log(`ffmpeg ${args.join(" ")}`);
  await execFileAsync("ffmpeg", ["-y", ...args], {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 16,
  });
};

const readImageDimensions = async (filePath: string, log: (message: string) => void) => {
  if (path.extname(filePath).toLowerCase() === ".png") {
    const buffer = await fsPromises.readFile(filePath);
    if (buffer.length < 24) {
      throw new Error(`PNG file is too small to read dimensions: ${filePath}`);
    }
    return {
      height: buffer.readUInt32BE(20),
      width: buffer.readUInt32BE(16),
    } satisfies ImageDimensions;
  }

  log(`ffprobe ${filePath}`);
  const {stdout} = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  const parsed = JSON.parse(stdout) as {streams?: Array<{height?: number; width?: number}>};
  const stream = parsed.streams?.[0];
  if (!stream?.width || !stream.height) {
    throw new Error(`Could not read image dimensions for ${filePath}`);
  }
  return {
    height: stream.height,
    width: stream.width,
  } satisfies ImageDimensions;
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

const getConversationAudioPath = (
  projectPath: string,
  project: TalkVideoProject,
  cueIndex: number,
  speaker: SpeakerId,
) => {
  const conversationDir = resolveFromProject(projectPath, project.sources.publicConversationDir);
  return path.join(conversationDir, "audio", `${String(cueIndex + 1).padStart(2, "0")}-${speaker}.wav`);
};

const copyAsset = async (sourcePath: string, outputPath: string) => {
  await fsPromises.mkdir(path.dirname(outputPath), {recursive: true});
  await fsPromises.copyFile(sourcePath, outputPath);
};

const exportStillVideoClip = async ({
  durationFrames,
  fps,
  inputPath,
  log,
  outputPath,
  withAlpha = false,
}: {
  durationFrames: number;
  fps: number;
  inputPath: string;
  log: (message: string) => void;
  outputPath: string;
  withAlpha?: boolean;
}) => {
  const codecArgs = withAlpha
    ? ["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le"]
    : ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", "18", "-pix_fmt", "yuv420p"];

  await runFfmpeg(
    [
      "-loop",
      "1",
      "-framerate",
      String(fps),
      "-i",
      inputPath,
      "-frames:v",
      String(durationFrames),
      ...codecArgs,
      outputPath,
    ],
    log,
  );
};

const exportBackgroundBaseStill = async (outputPath: string, log: (message: string) => void) => {
  await runFfmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      "color=c=0x9eb7f2:s=1920x1080:r=1:d=1",
      "-vf",
      buildBackgroundFilter(),
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgba",
      outputPath,
    ],
    log,
  );
};

const exportBackgroundCueClip = async ({
  backgroundBasePath,
  cardPath,
  durationFrames,
  fps,
  log,
  outputPath,
  topPath,
}: {
  backgroundBasePath: string;
  cardPath: string;
  durationFrames: number;
  fps: number;
  log: (message: string) => void;
  outputPath: string;
  topPath: string;
}) => {
  await runFfmpeg(
    [
      "-loop",
      "1",
      "-framerate",
      String(fps),
      "-i",
      backgroundBasePath,
      "-loop",
      "1",
      "-framerate",
      String(fps),
      "-i",
      topPath,
      "-loop",
      "1",
      "-framerate",
      String(fps),
      "-i",
      cardPath,
      "-filter_complex",
      [
        "[0:v]format=rgba[base]",
        "[1:v]format=rgba[top]",
        "[2:v]format=rgba[card]",
        "[base][top]overlay=0:0[tmp1]",
        `[tmp1][card]overlay=${cardLayout.targetX}:${cardLayout.targetY},format=yuv420p[v]`,
      ].join(";"),
      "-map",
      "[v]",
      "-frames:v",
      String(durationFrames),
      "-c:v",
      "h264_nvenc",
      "-preset",
      "p5",
      "-cq",
      "18",
      "-pix_fmt",
      "yuv420p",
      outputPath,
    ],
    log,
  );
};

const roundProperty = (value: number) => Number(value.toFixed(6));

const createPlacedStillProperties = ({
  flipX = false,
  frameHeight,
  frameWidth,
  sourceHeight,
  sourceWidth,
  targetHeight,
  targetWidth,
  targetX,
  targetY,
}: {
  flipX?: boolean;
  frameHeight: number;
  frameWidth: number;
  sourceHeight: number;
  sourceWidth: number;
  targetHeight: number;
  targetWidth: number;
  targetX: number;
  targetY: number;
}): ResolveTimelineProperties => ({
  FlipX: flipX,
  Pan: roundProperty(targetX + targetWidth / 2 - frameWidth / 2),
  Tilt: roundProperty(targetY + targetHeight / 2 - frameHeight / 2),
  ZoomX: roundProperty(targetWidth / sourceWidth),
  ZoomY: roundProperty(targetHeight / sourceHeight),
});

const normalizeStereoDialogueAudio = async (
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
      "-af",
      "pan=stereo|c0=c0|c1=c0",
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

const prepareExportDir = async (requestedDir: string) => {
  try {
    await fsPromises.rm(requestedDir, {force: true, recursive: true});
    return requestedDir;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "EBUSY" && nodeError.code !== "EPERM") {
      throw error;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `${requestedDir}-${timestamp}`;
  }
};

const createAutoCharacterLayout = ({
  flipX,
  frameHeight,
  frameWidth,
  sourceHeight,
  sourceWidth,
  speaker,
}: {
  flipX: boolean;
  frameHeight: number;
  frameWidth: number;
  sourceHeight: number;
  sourceWidth: number;
  speaker: SpeakerId;
}) => {
  const targetHeight = characterLayoutDefaults.targetHeight;
  const targetWidth = Math.round((sourceWidth / sourceHeight) * targetHeight);
  const visibleWidth = Math.min(targetWidth - 12, characterLayoutDefaults.visibleWidth);
  const targetX =
    speaker === "zundamon" ? visibleWidth - targetWidth : frameWidth - visibleWidth;
  const targetY = frameHeight - characterLayoutDefaults.bottomMargin - targetHeight;

  return {
    flipX,
    targetHeight,
    targetWidth,
    targetX,
    targetY,
  };
};

export const exportProjectForResolve = async (
  projectPath: string,
  project: TalkVideoProject,
  options?: ExportOptions,
): Promise<ResolveExportResult> => {
  const log = options?.log ?? (() => {});
  const absoluteProjectPath = path.resolve(projectPath);
  const requestedExportDir = resolveFromProject(
    absoluteProjectPath,
    project.renderTargets.resolve.exportDir,
  );
  const exportDir = await prepareExportDir(requestedExportDir);

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

  const backgroundBasePath = path.join(backgroundsDir, "background-base.png");
  await exportBackgroundBaseStill(backgroundBasePath, log);

  const zundamonUpperPath = getClosedUpperBodyPath(absoluteProjectPath, project, "zundamon");
  const metanUpperPath = getClosedUpperBodyPath(absoluteProjectPath, project, "metan");
  const zundamonStillPath = path.join(charactersDir, "zundamon-upper.png");
  const metanStillPath = path.join(charactersDir, "metan-upper.png");
  const zundamonClipPath = path.join(charactersDir, "zundamon-upper.mov");
  const metanClipPath = path.join(charactersDir, "metan-upper.mov");
  await copyAsset(zundamonUpperPath, zundamonStillPath);
  await copyAsset(metanUpperPath, metanStillPath);
  await exportStillVideoClip({
    durationFrames: project.timeline.durationFrames,
    fps,
    inputPath: zundamonStillPath,
    log,
    outputPath: zundamonClipPath,
    withAlpha: true,
  });
  await exportStillVideoClip({
    durationFrames: project.timeline.durationFrames,
    fps,
    inputPath: metanStillPath,
    log,
    outputPath: metanClipPath,
    withAlpha: true,
  });

  const zundamonSize = await readImageDimensions(zundamonStillPath, log);
  const metanSize = await readImageDimensions(metanStillPath, log);

  const zundamonPlacement = createAutoCharacterLayout({
    flipX: true,
    frameHeight: project.timeline.height,
    frameWidth: project.timeline.width,
    sourceHeight: zundamonSize.height,
    sourceWidth: zundamonSize.width,
    speaker: "zundamon",
  });
  const metanPlacement = createAutoCharacterLayout({
    flipX: false,
    frameHeight: project.timeline.height,
    frameWidth: project.timeline.width,
    sourceHeight: metanSize.height,
    sourceWidth: metanSize.width,
    speaker: "metan",
  });

  manifestItems.push(
    {
      durationFrames: project.timeline.durationFrames,
      id: "zundamon-full",
      path: zundamonClipPath,
      properties: createPlacedStillProperties({
        flipX: zundamonPlacement.flipX,
        frameHeight: project.timeline.height,
        frameWidth: project.timeline.width,
        sourceHeight: zundamonSize.height,
        sourceWidth: zundamonSize.width,
        targetHeight: zundamonPlacement.targetHeight,
        targetWidth: zundamonPlacement.targetWidth,
        targetX: zundamonPlacement.targetX,
        targetY: zundamonPlacement.targetY,
      }),
      recordFrame: 0,
      trackIndex: 2,
      trackType: "video",
    },
    {
      durationFrames: project.timeline.durationFrames,
      id: "metan-full",
      path: metanClipPath,
      properties: createPlacedStillProperties({
        flipX: metanPlacement.flipX,
        frameHeight: project.timeline.height,
        frameWidth: project.timeline.width,
        sourceHeight: metanSize.height,
        sourceWidth: metanSize.width,
        targetHeight: metanPlacement.targetHeight,
        targetWidth: metanPlacement.targetWidth,
        targetX: metanPlacement.targetX,
        targetY: metanPlacement.targetY,
      }),
      recordFrame: 0,
      trackIndex: 3,
      trackType: "video",
    },
  );

  for (const cue of cues) {
    if (!cue.topAssetPath || !cue.cardAssetPath) {
      throw new Error(`Cue ${cue.index + 1} is missing top/card assets.`);
    }

    const suffix = String(cue.index + 1).padStart(2, "0");
    const cueDir = path.join(backgroundsDir, `cue-${suffix}`);
    const topPath = path.join(cueDir, "top.png");
    const cardPath = path.join(cueDir, "card.png");
    const backgroundCueClipPath = path.join(cueDir, "background.mp4");
    await copyAsset(cue.topAssetPath, topPath);
    await copyAsset(cue.cardAssetPath, cardPath);
    await exportBackgroundCueClip({
      backgroundBasePath,
      cardPath,
      durationFrames: cue.durationFrames,
      fps,
      log,
      outputPath: backgroundCueClipPath,
      topPath,
    });

    manifestItems.push({
      durationFrames: cue.durationFrames,
      id: `background-${suffix}`,
      path: backgroundCueClipPath,
      recordFrame: cue.startFrame,
      trackIndex: 1,
      trackType: "video",
    });
  }

  for (const cue of cues) {
    const cueAudioPath = getConversationAudioPath(absoluteProjectPath, project, cue.index, cue.speaker);
    if (!fs.existsSync(cueAudioPath)) {
      throw new Error(`Cue audio was not found: ${cueAudioPath}`);
    }

    const cueAudioOutputPath = path.join(
      audioDir,
      `${String(cue.index + 1).padStart(2, "0")}-${cue.speaker}.wav`,
    );
    await normalizeStereoDialogueAudio(cueAudioPath, cueAudioOutputPath, log);
    manifestItems.push({
      durationFrames: cue.durationFrames,
      id: `audio-${String(cue.index + 1).padStart(2, "0")}-${cue.speaker}`,
      path: cueAudioOutputPath,
      recordFrame: cue.startFrame,
      trackIndex: speakerTrackMap[cue.speaker].index,
      trackType: "audio",
    });
  }

  const srtPath = path.join(subtitlesDir, "timeline.srt");
  await fsPromises.writeFile(srtPath, `${buildSrt(cues, fps)}\n`, "utf8");

  const manifest: ResolveExportManifest = {
    audioTracks: [
      {
        audioType: resolveExportAudioMode.narrationTrackType,
        index: speakerTrackMap.zundamon.index,
        name: speakerTrackMap.zundamon.name,
      },
      {
        audioType: resolveExportAudioMode.narrationTrackType,
        index: speakerTrackMap.metan.index,
        name: speakerTrackMap.metan.name,
      },
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
