import {execFile} from "node:child_process";
import * as fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {loadCueRuntime, type CueRuntime} from "@gpu-render/gpu-renderer";
import {resolveFromProject, type SpeakerId, type TalkVideoProject} from "@gpu-render/shared";

import {ensureResolveReady} from "./runtime.js";

const execFileAsync = promisify(execFile);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loaderScriptPath = path.join(packageRoot, "scripts", "load_resolve_timeline.py");
const trimAlphaPngSetScriptPath = path.join(packageRoot, "scripts", "trim_alpha_png_set.py");
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
const speakerTrackMap = {
  metan: {index: 2, name: "\u3081\u305f\u3093"},
  zundamon: {index: 1, name: "\u305a\u3093\u3060\u3082\u3093"},
} as const satisfies Record<SpeakerId, {index: number; name: string}>;
const subtitleBandLayout = {
  backgroundColor: "0xf7eef7@0.96",
  borderColor: "white@0.65",
  borderHeight: 6,
  fontColorFallback: {
    metan: "#9a6cff",
    zundamon: "#8adf47",
  } as const satisfies Record<SpeakerId, string>,
  fontFile: "C:/Windows/Fonts/YuGothB.ttc",
  fontSize: 58,
  height: 228,
  shadowColor: "white@0.35",
  strokeColor: "white@0.96",
  strokeWidth: 16,
  textInsetY: 22,
};
const characterCornerLayout = {
  bottom: 118,
  containerHeight: 420,
  containerWidth: 400,
  imageBottom: -4,
  imageHeight: 430,
  sideOffsets: {
    metan: -96,
    zundamon: -72,
  } as const satisfies Record<SpeakerId, number>,
} as const;

type SubtitleMode = "auto-from-audio" | "import-srt";
type SubtitleLineBreak = "single" | "double";
type ResolveSubtitleDeliveryMode = "overlay-video" | "native-srt";
type ResolveTimelinePropertyValue = boolean | number | string;
type ResolveMouthState = "closed" | "mid" | "open";

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
  color?: string;
  lineBreak: SubtitleLineBreak;
  mode: SubtitleMode;
  speaker?: SpeakerId;
  srtPath: string;
  trackIndex: number;
  trackName: string;
};

export type ResolveCharacterAnimationConfig = {
  assets: {
    blink: string;
    closed: string;
    mid: string;
    open: string;
  };
  blinkByFrame: boolean[];
  bob: {
    amplitude: number;
    frequencyHz: number;
    phaseOffset: number;
  };
  itemId: string;
  mouthByFrame: ResolveMouthState[];
  speaker: SpeakerId;
};

export type ResolveExportManifest = {
  audioTracks: Array<{audioType?: string; index: number; name: string}>;
  characterAnimations?: ResolveCharacterAnimationConfig[];
  exportDir: string;
  fps: number;
  generatedAt: string;
  height: number;
  items: ResolveManifestItem[];
  loaderScriptPath: string;
  projectId: string;
  projectName: string;
  startTimecode: string;
  subtitles?: ResolveSubtitleConfig[];
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

const buildSpeakerSrt = ({
  cues,
  fps,
  speaker,
}: {
  cues: CueRuntime[];
  fps: number;
  speaker: SpeakerId;
}) =>
  buildSrt(
    cues.filter((cue) => cue.speaker === speaker),
    fps,
  );

const subtitleBreakCandidates = new Set([
  "\u3001",
  "\u3002",
  "\uff01",
  "\uff1f",
  "!",
  "?",
  " ",
  "\u3000",
]);

const formatSubtitleOverlayText = (text: string) => {
  const normalized = text.replace(/\s*\r?\n\s*/g, "").trim();
  if (!normalized || normalized.length <= 24) {
    return normalized;
  }

  const target = Math.floor(normalized.length / 2);
  const minIndex = Math.floor(normalized.length * 0.35);
  const maxIndex = Math.ceil(normalized.length * 0.72);

  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let index = minIndex; index < Math.min(maxIndex, normalized.length - 1); index += 1) {
    const char = normalized[index];
    if (!subtitleBreakCandidates.has(char)) {
      continue;
    }

    let score = Math.abs(index - target);
    if (char === "\u3001") {
      score += 3;
    }
    if (char === " " || char === "\u3000") {
      score += 6;
    }
    if (
      char === "\u3002" ||
      char === "\uff01" ||
      char === "\uff1f" ||
      char === "!" ||
      char === "?"
    ) {
      score -= 2;
    }

    if (score < bestScore) {
      bestScore = score;
      bestIndex = index + 1;
    }
  }

  if (bestIndex === -1) {
    bestIndex = target;
  }

  return `${normalized.slice(0, bestIndex).trim()}\n${normalized.slice(bestIndex).trim()}`;
};

const splitSubtitleOverlayLines = (text: string) =>
  formatSubtitleOverlayText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2);

const pickSubtitleFontSize = (lines: string[]) => {
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  if (longest >= 30) {
    return 48;
  }
  if (longest >= 26) {
    return 52;
  }
  if (longest >= 22) {
    return 54;
  }
  return subtitleBandLayout.fontSize;
};

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

const getUpperBodyAssetPaths = (
  projectPath: string,
  project: TalkVideoProject,
  speaker: SpeakerId,
) => {
  const character = getCharacterDefinition(project, speaker);
  const upperDir = resolveFromProject(projectPath, character.visual.upperDir);
  const expression = character.visual.defaultExpression ?? "normal";
  return {
    blink: resolveFromProject(projectPath, character.visual.blinkUpperPath),
    closed: path.join(upperDir, `${expression}-closed.png`),
    mid: path.join(upperDir, `${expression}-mid.png`),
    open: path.join(upperDir, `${expression}-open.png`),
  } as const;
};

const parseMouthTimingByCue = async (
  projectPath: string,
  project: TalkVideoProject,
): Promise<ResolveMouthState[][]> => {
  const mouthDataPath = resolveFromProject(projectPath, project.sources.mouthDataPath);
  const source = await fsPromises.readFile(mouthDataPath, "utf8");
  const start = source.indexOf("[");
  const end = source.lastIndexOf("] as const");
  if (start < 0 || end < 0) {
    throw new Error(`Could not parse mouth timing source: ${mouthDataPath}`);
  }
  const literal = source.slice(start, end + 1);
  return Function(`"use strict"; return (${literal});`)() as ResolveMouthState[][];
};

const buildCharacterMouthByFrame = ({
  cues,
  mouthByCue,
  speaker,
  timelineDurationFrames,
}: {
  cues: CueRuntime[];
  mouthByCue: ResolveMouthState[][];
  speaker: SpeakerId;
  timelineDurationFrames: number;
}) => {
  const mouthByFrame = Array.from({length: timelineDurationFrames}, () => "closed" as ResolveMouthState);
  for (const cue of cues) {
    if (cue.speaker !== speaker) {
      continue;
    }

    const cueMouth = mouthByCue[cue.index] ?? [];
    for (let offset = 0; offset < cue.durationFrames; offset += 1) {
      const frame = cue.startFrame + offset;
      if (frame >= timelineDurationFrames) {
        break;
      }
      mouthByFrame[frame] = cueMouth[offset] ?? "closed";
    }
  }
  return mouthByFrame;
};

const buildBlinkByFrame = ({
  seedOffset,
  timelineDurationFrames,
}: {
  seedOffset: number;
  timelineDurationFrames: number;
}) => {
  const blinkByFrame = Array.from({length: timelineDurationFrames}, () => false);
  let currentFrame = 48 + seedOffset * 19;
  while (currentFrame < timelineDurationFrames) {
    const blinkLength = 3 + ((currentFrame + seedOffset) % 3);
    for (let index = 0; index < blinkLength; index += 1) {
      const frame = currentFrame + index;
      if (frame < timelineDurationFrames) {
        blinkByFrame[frame] = true;
      }
    }
    const gap = 90 + ((currentFrame * 7 + seedOffset * 17) % 80);
    currentFrame += gap;
  }
  return blinkByFrame;
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

const trimAlphaPngSet = async ({
  inputPaths,
  log,
  outputDir,
}: {
  inputPaths: string[];
  log: (message: string) => void;
  outputDir: string;
}) => {
  await fsPromises.mkdir(outputDir, {recursive: true});
  log(`python ${trimAlphaPngSetScriptPath} ${outputDir} ${inputPaths.join(" ")}`);
  await execFileAsync("python", [trimAlphaPngSetScriptPath, outputDir, ...inputPaths], {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 4,
  });
};

const escapeFilterPath = (inputPath: string) =>
  inputPath.replace(/\\/g, "/").replace(/:/g, "\\:");

const toFfmpegColor = (color: string) => {
  if (color.startsWith("#")) {
    return `0x${color.slice(1)}`;
  }
  return color;
};

const renderSubtitleOverlayStill = async ({
  color,
  fps,
  frameHeight,
  frameWidth,
  log,
  outputPath,
  text,
  textPath,
}: {
  color: string;
  fps: number;
  frameHeight: number;
  frameWidth: number;
  log: (message: string) => void;
  outputPath: string;
  text: string;
  textPath: string;
}) => {
  const bandTop = frameHeight - subtitleBandLayout.height;
  await fsPromises.mkdir(path.dirname(textPath), {recursive: true});
  await fsPromises.writeFile(textPath, `${text}\n`, "utf8");

  const filter = [
    "format=rgba",
    `drawbox=x=0:y=${bandTop}:w=${frameWidth}:h=${subtitleBandLayout.height}:color=${subtitleBandLayout.backgroundColor}:t=fill`,
    `drawbox=x=0:y=${bandTop}:w=${frameWidth}:h=${subtitleBandLayout.borderHeight}:color=${subtitleBandLayout.borderColor}:t=fill`,
    [
      "drawtext",
      `fontfile='${escapeFilterPath(subtitleBandLayout.fontFile)}'`,
      `textfile='${escapeFilterPath(textPath)}'`,
      `fontcolor=${toFfmpegColor(color)}`,
      `fontsize=${subtitleBandLayout.fontSize}`,
      `borderw=${subtitleBandLayout.strokeWidth}`,
      `bordercolor=${subtitleBandLayout.strokeColor}`,
      "shadowx=0",
      "shadowy=8",
      `shadowcolor=${subtitleBandLayout.shadowColor}`,
      "line_spacing=8",
      "x=(w-text_w)/2",
      `y=${bandTop + subtitleBandLayout.textInsetY}`,
    ].join(":"),
  ].join(",");

  await runFfmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      `color=c=black@0.0:s=${frameWidth}x${frameHeight}:r=${fps}:d=1`,
      "-vf",
      filter,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgba",
      outputPath,
    ],
    log,
  );
};

const createExactCharacterPlacement = ({
  frameHeight,
  frameWidth,
  project,
  sourceHeight,
  sourceWidth,
  speaker,
}: {
  frameHeight: number;
  frameWidth: number;
  project: TalkVideoProject;
  sourceHeight: number;
  sourceWidth: number;
  speaker: SpeakerId;
}) => {
  const characterLayout = project.style.characterLayout ?? {};
  const activeScale = characterLayout.activeScale ?? 1;
  const speakerScale =
    speaker === "zundamon"
      ? characterLayout.zundamonScale ?? 1
      : characterLayout.metanScale ?? 1;
  const scale = activeScale * speakerScale;
  const targetHeight = Math.round(characterCornerLayout.imageHeight * scale);
  const targetWidth = Math.round((sourceWidth / sourceHeight) * targetHeight);
  const offsetX =
    speaker === "zundamon"
      ? characterLayout.zundamonOffsetX ?? 0
      : characterLayout.metanOffsetX ?? 0;
  const offsetY =
    speaker === "zundamon"
      ? characterLayout.zundamonOffsetY ?? 0
      : characterLayout.metanOffsetY ?? 0;
  const containerOffset = characterCornerLayout.sideOffsets[speaker];
  const containerLeft =
    speaker === "zundamon"
      ? containerOffset
      : frameWidth - characterCornerLayout.containerWidth - containerOffset;
  const targetX =
    speaker === "zundamon"
      ? containerLeft + offsetX
      : containerLeft + characterCornerLayout.containerWidth - targetWidth + offsetX;
  const targetY =
    frameHeight -
    (characterCornerLayout.bottom + characterCornerLayout.imageBottom) -
    targetHeight +
    offsetY;

  return {
    flipX: speaker === "zundamon",
    targetHeight,
    targetWidth,
    targetX,
    targetY,
  };
};

const renderCharacterBoardStill = async ({
  flipX,
  frameWidth,
  imagePath,
  log,
  outputPath,
  targetHeight,
  targetWidth,
  targetX,
  targetY,
}: {
  flipX: boolean;
  frameWidth: number;
  imagePath: string;
  log: (message: string) => void;
  outputPath: string;
  targetHeight: number;
  targetWidth: number;
  targetX: number;
  targetY: number;
}) => {
  const visibleX = Math.max(0, targetX);
  const visibleY = Math.max(0, targetY);
  const cropX = Math.max(0, -targetX);
  const cropY = Math.max(0, -targetY);
  const visibleWidth = Math.max(1, Math.min(frameWidth - visibleX, targetWidth - cropX));
  const visibleHeight = Math.max(1, Math.min(1080 - visibleY, targetHeight - cropY));
  const characterFilter = [
    "format=rgba",
    `scale=${targetWidth}:${targetHeight}`,
    flipX ? "hflip" : null,
    `crop=${visibleWidth}:${visibleHeight}:${cropX}:${cropY}`,
  ]
    .filter(Boolean)
    .join(",");

  await runFfmpeg(
    [
      "-i",
      imagePath,
      "-vf",
      `${characterFilter},pad=${frameWidth}:1080:${visibleX}:${visibleY}:color=black@0`,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgba",
      outputPath,
    ],
    log,
  );
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

const exportBackgroundCueStill = async ({
  backgroundBasePath,
  cardPath,
  log,
  outputPath,
  topPath,
}: {
  backgroundBasePath: string;
  cardPath: string;
  log: (message: string) => void;
  outputPath: string;
  topPath: string;
}) => {
  await runFfmpeg(
    [
      "-loop",
      "1",
      "-framerate",
      "1",
      "-i",
      backgroundBasePath,
      "-loop",
      "1",
      "-framerate",
      "1",
      "-i",
      topPath,
      "-loop",
      "1",
      "-framerate",
      "1",
      "-i",
      cardPath,
      "-filter_complex",
      [
        "[0:v]format=rgba[base]",
        "[1:v]format=rgba[top]",
        "[2:v]format=rgba[card]",
        "[base][top]overlay=0:0[tmp1]",
        `[tmp1][card]overlay=${cardLayout.targetX}:${cardLayout.targetY},format=rgba[v]`,
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

const exportSubtitleOverlayStill = async ({
  color,
  height,
  log,
  outputPath,
  text,
  width,
}: {
  color: string;
  height: number;
  log: (message: string) => void;
  outputPath: string;
  text: string;
  width: number;
}) => {
  const lines = splitSubtitleOverlayLines(text);
  const fontSize = pickSubtitleFontSize(lines);
  const lineHeight = Math.round(fontSize * 1.14);
  const bandTop = height - subtitleBandLayout.height;

  const drawTextFilters = lines.map((line, index) => {
    const textPath = outputPath.replace(/\.png$/i, `-${index + 1}.txt`);
    return fsPromises.writeFile(textPath, line, "utf8").then(() =>
      [
        `drawtext=fontfile='${escapeFilterPath(subtitleBandLayout.fontFile)}'`,
        `textfile='${escapeFilterPath(textPath)}'`,
        `fontsize=${fontSize}`,
        `fontcolor=${toFfmpegColor(color)}`,
        `borderw=${subtitleBandLayout.strokeWidth}`,
        `bordercolor=${subtitleBandLayout.strokeColor}`,
        "x=(w-text_w)/2",
        `y=${bandTop + subtitleBandLayout.textInsetY + index * lineHeight}`,
        `shadowcolor=${subtitleBandLayout.shadowColor}`,
        "shadowx=0",
        "shadowy=8",
      ].join(":"),
    );
  });

  const resolvedDrawTextFilters = await Promise.all(drawTextFilters);

  await runFfmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${width}x${height}:r=1:d=1`,
      "-vf",
      [
        `drawbox=x=0:y=${bandTop}:w=${width}:h=${subtitleBandLayout.height}:color=${subtitleBandLayout.backgroundColor}:t=fill`,
        `drawbox=x=0:y=${bandTop}:w=${width}:h=${subtitleBandLayout.borderHeight}:color=${subtitleBandLayout.borderColor}:t=fill`,
        ...resolvedDrawTextFilters,
        "format=rgba",
        "colorkey=0x000000:0.01:0.0",
      ].join(","),
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
  const subtitleOverlayDir = path.join(exportDir, "media", "subtitle-overlays");

  await fsPromises.mkdir(backgroundsDir, {recursive: true});
  await fsPromises.mkdir(charactersDir, {recursive: true});
  await fsPromises.mkdir(audioDir, {recursive: true});
  await fsPromises.mkdir(subtitlesDir, {recursive: true});
  await fsPromises.mkdir(subtitleOverlayDir, {recursive: true});

  const {cues} = loadCueRuntime(absoluteProjectPath, project);
  const mouthByCue = await parseMouthTimingByCue(absoluteProjectPath, project);
  const manifestItems: ResolveManifestItem[] = [];
  const fps = project.timeline.fps;
  const subtitleDeliveryMode: ResolveSubtitleDeliveryMode =
    project.renderTargets.resolve.subtitleMode ?? "overlay-video";
  const subtitleTrackNames = project.style.subtitleBand.trackNames ?? {};
  const subtitleCharsPerLine = project.style.subtitleBand.charsPerLine ?? 24;
  const subtitleLineBreak: SubtitleLineBreak =
    (project.style.subtitleBand.maxLines ?? 2) > 1 ? "double" : "single";

  const backgroundBasePath = path.join(backgroundsDir, "background-base.png");
  await exportBackgroundBaseStill(backgroundBasePath, log);

  const zundamonAssets = getUpperBodyAssetPaths(absoluteProjectPath, project, "zundamon");
  const metanAssets = getUpperBodyAssetPaths(absoluteProjectPath, project, "metan");
  const trimmedCharacterDir = path.join(charactersDir, "trimmed");
  const trimmedZundamonDir = path.join(trimmedCharacterDir, "zundamon");
  const trimmedMetanDir = path.join(trimmedCharacterDir, "metan");
  await trimAlphaPngSet({
    inputPaths: [
      zundamonAssets.closed,
      zundamonAssets.mid,
      zundamonAssets.open,
      zundamonAssets.blink,
    ],
    log,
    outputDir: trimmedZundamonDir,
  });
  await trimAlphaPngSet({
    inputPaths: [metanAssets.closed, metanAssets.mid, metanAssets.open, metanAssets.blink],
    log,
    outputDir: trimmedMetanDir,
  });
  const trimmedZundamonAssets = {
    blink: path.join(trimmedZundamonDir, path.basename(zundamonAssets.blink)),
    closed: path.join(trimmedZundamonDir, path.basename(zundamonAssets.closed)),
    mid: path.join(trimmedZundamonDir, path.basename(zundamonAssets.mid)),
    open: path.join(trimmedZundamonDir, path.basename(zundamonAssets.open)),
  } as const;
  const trimmedMetanAssets = {
    blink: path.join(trimmedMetanDir, path.basename(metanAssets.blink)),
    closed: path.join(trimmedMetanDir, path.basename(metanAssets.closed)),
    mid: path.join(trimmedMetanDir, path.basename(metanAssets.mid)),
    open: path.join(trimmedMetanDir, path.basename(metanAssets.open)),
  } as const;
  const [zundamonTrimmedDimensions, metanTrimmedDimensions] = await Promise.all([
    readImageDimensions(trimmedZundamonAssets.closed, log),
    readImageDimensions(trimmedMetanAssets.closed, log),
  ]);

  const zundamonPlacement = createExactCharacterPlacement({
    frameHeight: project.timeline.height,
    frameWidth: project.timeline.width,
    project,
    sourceHeight: zundamonTrimmedDimensions.height,
    sourceWidth: zundamonTrimmedDimensions.width,
    speaker: "zundamon",
  });
  const metanPlacement = createExactCharacterPlacement({
    frameHeight: project.timeline.height,
    frameWidth: project.timeline.width,
    project,
    sourceHeight: metanTrimmedDimensions.height,
    sourceWidth: metanTrimmedDimensions.width,
    speaker: "metan",
  });

  const characterBoardAssets = {
    zundamon: {
      blink: path.join(charactersDir, "zundamon-blink-board.png"),
      closed: path.join(charactersDir, "zundamon-closed-board.png"),
      mid: path.join(charactersDir, "zundamon-mid-board.png"),
      open: path.join(charactersDir, "zundamon-open-board.png"),
    },
    metan: {
      blink: path.join(charactersDir, "metan-blink-board.png"),
      closed: path.join(charactersDir, "metan-closed-board.png"),
      mid: path.join(charactersDir, "metan-mid-board.png"),
      open: path.join(charactersDir, "metan-open-board.png"),
    },
  } as const;

  await Promise.all([
    renderCharacterBoardStill({
      flipX: zundamonPlacement.flipX,
      frameWidth: project.timeline.width,
      imagePath: trimmedZundamonAssets.closed,
      log,
      outputPath: characterBoardAssets.zundamon.closed,
      targetHeight: zundamonPlacement.targetHeight,
      targetWidth: zundamonPlacement.targetWidth,
      targetX: zundamonPlacement.targetX,
      targetY: zundamonPlacement.targetY,
    }),
    renderCharacterBoardStill({
      flipX: zundamonPlacement.flipX,
      frameWidth: project.timeline.width,
      imagePath: trimmedZundamonAssets.mid,
      log,
      outputPath: characterBoardAssets.zundamon.mid,
      targetHeight: zundamonPlacement.targetHeight,
      targetWidth: zundamonPlacement.targetWidth,
      targetX: zundamonPlacement.targetX,
      targetY: zundamonPlacement.targetY,
    }),
    renderCharacterBoardStill({
      flipX: zundamonPlacement.flipX,
      frameWidth: project.timeline.width,
      imagePath: trimmedZundamonAssets.open,
      log,
      outputPath: characterBoardAssets.zundamon.open,
      targetHeight: zundamonPlacement.targetHeight,
      targetWidth: zundamonPlacement.targetWidth,
      targetX: zundamonPlacement.targetX,
      targetY: zundamonPlacement.targetY,
    }),
    renderCharacterBoardStill({
      flipX: zundamonPlacement.flipX,
      frameWidth: project.timeline.width,
      imagePath: trimmedZundamonAssets.blink,
      log,
      outputPath: characterBoardAssets.zundamon.blink,
      targetHeight: zundamonPlacement.targetHeight,
      targetWidth: zundamonPlacement.targetWidth,
      targetX: zundamonPlacement.targetX,
      targetY: zundamonPlacement.targetY,
    }),
    renderCharacterBoardStill({
      flipX: metanPlacement.flipX,
      frameWidth: project.timeline.width,
      imagePath: trimmedMetanAssets.closed,
      log,
      outputPath: characterBoardAssets.metan.closed,
      targetHeight: metanPlacement.targetHeight,
      targetWidth: metanPlacement.targetWidth,
      targetX: metanPlacement.targetX,
      targetY: metanPlacement.targetY,
    }),
    renderCharacterBoardStill({
      flipX: metanPlacement.flipX,
      frameWidth: project.timeline.width,
      imagePath: trimmedMetanAssets.mid,
      log,
      outputPath: characterBoardAssets.metan.mid,
      targetHeight: metanPlacement.targetHeight,
      targetWidth: metanPlacement.targetWidth,
      targetX: metanPlacement.targetX,
      targetY: metanPlacement.targetY,
    }),
    renderCharacterBoardStill({
      flipX: metanPlacement.flipX,
      frameWidth: project.timeline.width,
      imagePath: trimmedMetanAssets.open,
      log,
      outputPath: characterBoardAssets.metan.open,
      targetHeight: metanPlacement.targetHeight,
      targetWidth: metanPlacement.targetWidth,
      targetX: metanPlacement.targetX,
      targetY: metanPlacement.targetY,
    }),
    renderCharacterBoardStill({
      flipX: metanPlacement.flipX,
      frameWidth: project.timeline.width,
      imagePath: trimmedMetanAssets.blink,
      log,
      outputPath: characterBoardAssets.metan.blink,
      targetHeight: metanPlacement.targetHeight,
      targetWidth: metanPlacement.targetWidth,
      targetX: metanPlacement.targetX,
      targetY: metanPlacement.targetY,
    }),
  ]);

  manifestItems.push(
    {
      durationFrames: project.timeline.durationFrames,
      id: "zundamon-full",
      path: characterBoardAssets.zundamon.closed,
      recordFrame: 0,
      trackIndex: 2,
      trackType: "video",
    },
    {
      durationFrames: project.timeline.durationFrames,
      id: "metan-full",
      path: characterBoardAssets.metan.closed,
      recordFrame: 0,
      trackIndex: 3,
      trackType: "video",
    },
  );

  const subtitles: ResolveSubtitleConfig[] = [];
  if (subtitleDeliveryMode === "native-srt") {
    for (const speaker of Object.keys(speakerTrackMap) as SpeakerId[]) {
      const srtText = buildSpeakerSrt({cues, fps, speaker}).trim();
      if (!srtText) {
        continue;
      }

      const srtPath = path.join(subtitlesDir, `${speaker}.srt`);
      await fsPromises.writeFile(srtPath, `${srtText}\n`, "utf8");
      subtitles.push({
        charsPerLine: subtitleCharsPerLine,
        color: getCharacterDefinition(project, speaker).visual.accent,
        lineBreak: subtitleLineBreak,
        mode: "import-srt",
        speaker,
        srtPath,
        trackIndex: subtitles.length + 1,
        trackName: subtitleTrackNames[speaker] ?? `${speakerTrackMap[speaker].name}字幕`,
      });
    }
  }

  for (const cue of cues) {
    if (!cue.topAssetPath || !cue.cardAssetPath) {
      throw new Error(`Cue ${cue.index + 1} is missing top/card assets.`);
    }

    const suffix = String(cue.index + 1).padStart(2, "0");
    const cueDir = path.join(backgroundsDir, `cue-${suffix}`);
    const topPath = path.join(cueDir, "top.png");
    const cardPath = path.join(cueDir, "card.png");
    const scenePath = path.join(cueDir, "scene.png");
    const subtitlePath = path.join(cueDir, "subtitle.png");
    await copyAsset(cue.topAssetPath, topPath);
    await copyAsset(cue.cardAssetPath, cardPath);
    await exportBackgroundCueStill({
      backgroundBasePath,
      cardPath,
      log,
      outputPath: scenePath,
      topPath,
    });

    manifestItems.push({
      durationFrames: cue.durationFrames,
      id: `scene-${suffix}`,
      path: scenePath,
      recordFrame: cue.startFrame,
      trackIndex: 1,
      trackType: "video",
    });

    if (subtitleDeliveryMode === "overlay-video") {
      await exportSubtitleOverlayStill({
        color: getCharacterDefinition(project, cue.speaker).visual.accent,
        height: project.timeline.height,
        log,
        outputPath: subtitlePath,
        text: formatSubtitleOverlayText(cue.text),
        width: project.timeline.width,
      });

      manifestItems.push({
        durationFrames: cue.durationFrames,
        id: `subtitle-${suffix}`,
        path: subtitlePath,
        recordFrame: cue.startFrame,
        trackIndex: 4,
        trackType: "video",
      });
    }
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

  const characterAnimations: ResolveCharacterAnimationConfig[] = [
    {
      assets: characterBoardAssets.zundamon,
      blinkByFrame: buildBlinkByFrame({
        seedOffset: 1,
        timelineDurationFrames: project.timeline.durationFrames,
      }),
      bob: {
        amplitude: 0.0064,
        frequencyHz: project.timeline.fps / (Math.PI * 2 * 28),
        phaseOffset: 0.0,
      },
      itemId: "zundamon-full",
      mouthByFrame: buildCharacterMouthByFrame({
        cues,
        mouthByCue,
        speaker: "zundamon",
        timelineDurationFrames: project.timeline.durationFrames,
      }),
      speaker: "zundamon",
    },
    {
      assets: characterBoardAssets.metan,
      blinkByFrame: buildBlinkByFrame({
        seedOffset: 2,
        timelineDurationFrames: project.timeline.durationFrames,
      }),
      bob: {
        amplitude: 0.0058,
        frequencyHz: project.timeline.fps / (Math.PI * 2 * 31),
        phaseOffset: 0.0,
      },
      itemId: "metan-full",
      mouthByFrame: buildCharacterMouthByFrame({
        cues,
        mouthByCue,
        speaker: "metan",
        timelineDurationFrames: project.timeline.durationFrames,
      }),
      speaker: "metan",
    },
  ];

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
    characterAnimations,
    exportDir,
    fps,
    generatedAt: new Date().toISOString(),
    height: project.timeline.height,
    items: manifestItems,
    loaderScriptPath,
    projectId: project.project.id,
    projectName: `${project.project.title} Resolve Auto`,
    startTimecode: project.timeline.startTimecode ?? "01:00:00:00",
    subtitles: subtitles.length > 0 ? subtitles : undefined,
    timelineName: `${project.project.title} Timeline ${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}`,
    videoTracks:
      subtitleDeliveryMode === "overlay-video"
        ? [
            {index: 1, name: "Scene"},
            {index: 2, name: "Zundamon"},
            {index: 3, name: "Metan"},
            {index: 4, name: "Subtitle"},
          ]
        : [
            {index: 1, name: "Scene"},
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

  await ensureResolveReady({autoLaunch: true, log});
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
