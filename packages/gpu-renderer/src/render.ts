import {execFile} from "node:child_process";
import * as fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {promisify} from "node:util";

import {resolveFromProject} from "@gpu-render/shared";
import type {SpeakerId, TalkVideoProject} from "@gpu-render/shared";

import {createBlinkWindowsBySpeaker, loadCueRuntime} from "./cue-data.js";
import {waitForCpuCooling} from "./thermal.js";

const execFileAsync = promisify(execFile);

export type RenderOptions = {
  projectPath: string;
  outputPath: string;
  cpuTempLimitC?: number | null;
  cooldownMs?: number;
  segmentSeconds?: number;
  renderFps?: number;
  log?: (message: string) => void;
};

export type RenderResult = {
  outputPath: string;
  tempSamples: number[];
  segmentFiles: string[];
};

type ImageRun = {
  frameCount: number;
  path: string;
};

const fontPath = "C\\:/Windows/Fonts/meiryob.ttc";
const supersampleScale = 3;

const zundamonDims = {height: 424, width: 348, x: -66, y: 530};
const metanDims = {height: 424, width: 364, x: 1642, y: 530};

const scaleValue = (value: number) => Math.round(value * supersampleScale);

const buildAmplitudeExpression = (
  startAmplitude: number,
  targetAmplitude: number,
  endAmplitude: number,
  renderFrameCount: number,
) => {
  const scaledStart = startAmplitude * supersampleScale;
  const scaledTarget = targetAmplitude * supersampleScale;
  const scaledEnd = endAmplitude * supersampleScale;
  const easingFrames = Math.max(2, Math.min(10, Math.floor(renderFrameCount / 6)));
  const easeOutStart = Math.max(easingFrames, renderFrameCount - easingFrames);

  if (
    easingFrames <= 0 ||
    (scaledStart === scaledTarget && scaledTarget === scaledEnd)
  ) {
    return `${scaledTarget}`;
  }

  const startExpr =
    scaledStart === scaledTarget
      ? `${scaledTarget}`
      : `${scaledStart}+(${scaledTarget - scaledStart})*(n/${easingFrames})`;
  const endExpr =
    scaledEnd === scaledTarget
      ? `${scaledTarget}`
      : `${scaledTarget}+(${scaledEnd - scaledTarget})*((n-${easeOutStart})/${easingFrames})`;

  return `if(lt(n\\,${easingFrames})\\,${startExpr}\\,if(gte(n\\,${easeOutStart})\\,${endExpr}\\,${scaledTarget}))`;
};

const buildBobYExpression = (
  baseY: number,
  cueStartFrame: number,
  sourceFps: number,
  renderFps: number,
  radiansDivisor: number,
  startAmplitude: number,
  targetAmplitude: number,
  endAmplitude: number,
  renderFrameCount: number,
) => {
  const midpoint = 1;
  const sourceFramesPerRenderFrame = sourceFps / renderFps;
  const scaledBaseY = scaleValue(baseY + midpoint);
  const amplitudeExpr = buildAmplitudeExpression(
    startAmplitude,
    targetAmplitude,
    endAmplitude,
    renderFrameCount,
  );
  return `${scaledBaseY}+(${amplitudeExpr})*sin((${cueStartFrame}+n*${sourceFramesPerRenderFrame.toFixed(
    6,
  )})/${radiansDivisor})`;
};

const runFfmpeg = async (args: string[], log: (message: string) => void) => {
  log(`ffmpeg ${args.join(" ")}`);
  await execFileAsync("ffmpeg", ["-y", ...args], {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 16,
  });
};

const escapeConcatPath = (filePath: string) =>
  filePath.replace(/\\/g, "/").replace(/'/g, "'\\''");

const escapeFilterPath = (filePath: string) =>
  filePath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

const escapeDrawtext = (text: string) =>
  text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n");

const buildRuns = (paths: string[]): ImageRun[] => {
  const runs: ImageRun[] = [];
  for (const framePath of paths) {
    const previous = runs[runs.length - 1];
    if (previous && previous.path === framePath) {
      previous.frameCount += 1;
      continue;
    }

    runs.push({path: framePath, frameCount: 1});
  }
  return runs;
};

const writeConcatList = async (
  runs: ImageRun[],
  fps: number,
  listPath: string,
) => {
  const lines: string[] = [];
  for (const run of runs) {
    lines.push(`file '${escapeConcatPath(run.path)}'`);
    lines.push(`duration ${(run.frameCount / fps).toFixed(6)}`);
  }
  if (runs.length > 0) {
    lines.push(`file '${escapeConcatPath(runs[runs.length - 1].path)}'`);
  }
  await fsPromises.writeFile(listPath, `${lines.join("\n")}\n`, "utf8");
};

const getCharacterDefinition = (project: TalkVideoProject, speaker: SpeakerId) => {
  const character = project.characters.find((item) => item.id === speaker);
  if (!character) {
    throw new Error(`Character definition for ${speaker} was not found.`);
  }
  return character;
};

const getUpperBodyPath = (
  projectPath: string,
  project: TalkVideoProject,
  speaker: SpeakerId,
  mouth: string,
  blink: boolean,
) => {
  const character = getCharacterDefinition(project, speaker);
  if (blink) {
    return resolveFromProject(projectPath, character.visual.blinkUpperPath);
  }

  const upperDir = resolveFromProject(projectPath, character.visual.upperDir);
  const expression = character.visual.defaultExpression ?? "normal";
  return path.join(upperDir, `${expression}-${mouth}.png`);
};

const isBlinking = (
  absoluteFrame: number,
  speaker: SpeakerId,
  blinkWindowsBySpeaker: Record<SpeakerId, Array<{start: number; duration: number}>>,
) =>
  blinkWindowsBySpeaker[speaker].some(
    (window) => absoluteFrame >= window.start && absoluteFrame < window.start + window.duration,
  );

const buildCharacterRuns = (
  projectPath: string,
  project: TalkVideoProject,
  speaker: SpeakerId,
  cueIndex: number,
  cueStartFrame: number,
  sourceDurationFrames: number,
  mouthTimingByCue: string[][],
  blinkWindowsBySpeaker: Record<SpeakerId, Array<{start: number; duration: number}>>,
  activeSpeaker: SpeakerId,
) => {
  const paths: string[] = [];
  const mouthFrames = mouthTimingByCue[cueIndex] ?? [];

  for (let localFrame = 0; localFrame < sourceDurationFrames; localFrame += 1) {
    const absoluteFrame = cueStartFrame + localFrame;
    const blink = isBlinking(absoluteFrame, speaker, blinkWindowsBySpeaker);
    const mouth =
      speaker === activeSpeaker ? mouthFrames[localFrame] ?? "closed" : "closed";
    paths.push(getUpperBodyPath(projectPath, project, speaker, mouth, blink));
  }

  return buildRuns(paths);
};

const buildBackgroundFilter = () =>
  [
    "format=rgba",
    "drawbox=x=0:y=0:w=iw:h=ih:color=0x9eb7f2:t=fill",
    "drawbox=x=0:y=0:w=iw:h=ih:color=0xb4c7fb@0.35:t=fill",
    `drawgrid=width=${scaleValue(34)}:height=${scaleValue(34)}:thickness=${scaleValue(1)}:color=white@0.12`,
    `drawbox=x=${scaleValue(1420)}:y=${scaleValue(704)}:w=${scaleValue(270)}:h=${scaleValue(210)}:color=0xffffff@0.14:t=fill`,
    `drawbox=x=${scaleValue(104)}:y=${scaleValue(824)}:w=${scaleValue(400)}:h=${scaleValue(150)}:color=0xffd2ee@0.16:t=fill`,
  ].join(",");

const buildSubtitleDrawtext = (textFilePath: string, color: string, y: number) =>
  [
    `drawtext=fontfile='${fontPath}'`,
    `textfile='${escapeFilterPath(textFilePath)}'`,
    `fontsize=${scaleValue(50)}`,
    `fontcolor=${color}`,
    `borderw=${scaleValue(16)}`,
    "bordercolor=white@0.96",
    `line_spacing=${scaleValue(6)}`,
    "x=(w-text_w)/2",
    `y=${y}`,
    "text_align=center",
    "shadowcolor=white@0.35",
    "shadowx=0",
    `shadowy=${scaleValue(8)}`,
  ].join(":");

const createFallbackSegment = async (
  segmentPath: string,
  durationSeconds: number,
  width: number,
  height: number,
  fps: number,
  primaryColor: string,
  secondaryColor: string,
  log: (message: string) => void,
) => {
  const filter = [
    `drawbox=x=200:y=120:w=${Math.max(width - 400, 200)}:h=${Math.max(height - 370, 200)}:color=white:t=fill`,
    `drawbox=x=0:y=${height - 240}:w=${width}:h=240:color=0xf7f0ff:t=fill`,
    `drawbox=x=40:y=${height - 520}:w=320:h=520:color=${primaryColor.replace("#", "0x")}@0.55:t=fill`,
    `drawbox=x=${width - 360}:y=${height - 520}:w=320:h=520:color=${secondaryColor.replace("#", "0x")}@0.55:t=fill`,
  ].join(",");

  await runFfmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      `color=c=0xb8c8ff:s=${width}x${height}:r=${fps}:d=${durationSeconds}`,
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=48000:cl=stereo:d=${durationSeconds}`,
      "-vf",
      filter,
      "-c:v",
      "h264_nvenc",
      "-preset",
      "p5",
      "-cq",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      segmentPath,
    ],
    log,
  );
};

const createAgiDiscussionSegment = async (
  projectPath: string,
  project: TalkVideoProject,
  cue: ReturnType<typeof loadCueRuntime>["cues"][number],
  previousCue: ReturnType<typeof loadCueRuntime>["cues"][number] | undefined,
  nextCue: ReturnType<typeof loadCueRuntime>["cues"][number] | undefined,
  mouthTimingByCue: string[][],
  blinkWindowsBySpeaker: Record<SpeakerId, Array<{start: number; duration: number}>>,
  tempRoot: string,
  segmentPath: string,
  renderFps: number,
  log: (message: string) => void,
) => {
  const sourceFps = project.timeline.fps;
  const fps = renderFps;
  const compositeFps = fps;
  const durationSeconds = cue.durationFrames / sourceFps;
  const renderFrameCount = Math.max(1, Math.round(durationSeconds * fps));
  const zListPath = path.join(tempRoot, `cue-${String(cue.index + 1).padStart(2, "0")}-z.txt`);
  const mListPath = path.join(tempRoot, `cue-${String(cue.index + 1).padStart(2, "0")}-m.txt`);
  const subtitleTextPath = path.join(
    tempRoot,
    `cue-${String(cue.index + 1).padStart(2, "0")}-subtitle.txt`,
  );
  const zRuns = buildCharacterRuns(
    projectPath,
    project,
    "zundamon",
    cue.index,
    cue.startFrame,
    cue.durationFrames,
    mouthTimingByCue,
    blinkWindowsBySpeaker,
    cue.speaker,
  );
  const mRuns = buildCharacterRuns(
    projectPath,
    project,
    "metan",
    cue.index,
    cue.startFrame,
    cue.durationFrames,
    mouthTimingByCue,
    blinkWindowsBySpeaker,
    cue.speaker,
  );

  await writeConcatList(zRuns, sourceFps, zListPath);
  await writeConcatList(mRuns, sourceFps, mListPath);
  await fsPromises.writeFile(subtitleTextPath, cue.subtitleText, "utf8");

  const primaryColor = getCharacterDefinition(project, cue.speaker).visual.accent;
  const topPath = cue.topAssetPath && fs.existsSync(cue.topAssetPath) ? cue.topAssetPath : undefined;
  const cardPath =
    cue.cardAssetPath && fs.existsSync(cue.cardAssetPath) ? cue.cardAssetPath : undefined;
  const compositeWidth = scaleValue(project.timeline.width);
  const compositeHeight = scaleValue(project.timeline.height);
  const subtitleBandY = scaleValue(852);
  const subtitleTextY = scaleValue(860);
  const zundamonStartAmplitude = previousCue?.speaker === "zundamon" ? 7 : 3;
  const zundamonTargetAmplitude = cue.speaker === "zundamon" ? 7 : 3;
  const zundamonEndAmplitude = nextCue?.speaker === "zundamon" ? 7 : 3;
  const metanStartAmplitude = previousCue?.speaker === "metan" ? 7 : 3;
  const metanTargetAmplitude = cue.speaker === "metan" ? 7 : 3;
  const metanEndAmplitude = nextCue?.speaker === "metan" ? 7 : 3;
  const zundamonBobY = buildBobYExpression(
    zundamonDims.y,
    cue.startFrame,
    sourceFps,
    compositeFps,
    28,
    zundamonStartAmplitude,
    zundamonTargetAmplitude,
    zundamonEndAmplitude,
    renderFrameCount,
  );
  const metanBobY = buildBobYExpression(
    metanDims.y,
    cue.startFrame,
    sourceFps,
    compositeFps,
    31,
    metanStartAmplitude,
    metanTargetAmplitude,
    metanEndAmplitude,
    renderFrameCount,
  );

  if (!topPath || !cardPath) {
    await createFallbackSegment(
      segmentPath,
      durationSeconds,
      project.timeline.width,
      project.timeline.height,
      fps,
      project.style.subtitleBand.speakerColors?.zundamon ?? "#8adf47",
      project.style.subtitleBand.speakerColors?.metan ?? "#9a6cff",
      log,
    );
    return;
  }

  const filterComplex = [
    `[0:v]${buildBackgroundFilter()}[bg]`,
    `[1:v]scale=iw*${supersampleScale}:ih*${supersampleScale}:flags=lanczos,format=rgba[top]`,
    `[2:v]scale=iw*${supersampleScale}:ih*${supersampleScale}:flags=lanczos,format=rgba[card]`,
    `[3:v]fps=${sourceFps},scale=${scaleValue(zundamonDims.width)}:${scaleValue(zundamonDims.height)}:flags=lanczos,format=rgba,hflip,minterpolate=fps=${fps}:mi_mode=blend[z]`,
    `[4:v]fps=${sourceFps},scale=${scaleValue(metanDims.width)}:${scaleValue(metanDims.height)}:flags=lanczos,format=rgba,minterpolate=fps=${fps}:mi_mode=blend[m]`,
    `[bg][top]overlay=0:0:shortest=1:eof_action=pass[bg1]`,
    `[bg1][card]overlay=${scaleValue(255)}:${scaleValue(138)}:shortest=1:eof_action=pass[bg2]`,
    `[bg2]drawbox=x=0:y=${subtitleBandY}:w=${compositeWidth}:h=${scaleValue(228)}:color=0xf7eef7@0.96:t=fill,drawbox=x=0:y=${subtitleBandY}:w=${compositeWidth}:h=${scaleValue(6)}:color=white@0.65:t=fill[bg2a]`,
    `[bg2a][z]overlay=${scaleValue(zundamonDims.x)}:${zundamonBobY}:shortest=1:eof_action=pass[bg3]`,
    `[bg3][m]overlay=${scaleValue(metanDims.x)}:${metanBobY}:shortest=1:eof_action=pass[bg4]`,
    `[bg4]${buildSubtitleDrawtext(subtitleTextPath, primaryColor, subtitleTextY)},scale=${project.timeline.width}:${project.timeline.height}:flags=lanczos[v]`,
  ].join(";");

  const ffmpegArgs = [
    "-f",
    "lavfi",
    "-i",
    `color=c=0x9eb7f2:s=${compositeWidth}x${compositeHeight}:r=${compositeFps}:d=${durationSeconds}`,
    "-loop",
    "1",
    "-t",
    `${durationSeconds}`,
    "-i",
    topPath,
    "-loop",
    "1",
    "-t",
    `${durationSeconds}`,
    "-i",
    cardPath,
  ];

  ffmpegArgs.push(
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    zListPath,
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    mListPath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[v]",
    "-an",
    "-frames:v",
    `${renderFrameCount}`,
    "-fps_mode",
    "cfr",
    "-r",
    `${fps}`,
    "-g",
    `${fps}`,
    "-bf",
    "0",
    "-c:v",
    "h264_nvenc",
    "-preset",
    "p5",
    "-cq",
    "18",
    "-pix_fmt",
    "yuv420p",
    segmentPath,
  );

  await runFfmpeg(ffmpegArgs, log);
};

const muxFinalAudio = async (
  videoOnlyPath: string,
  audioPath: string,
  outputPath: string,
  log: (message: string) => void,
) => {
  await runFfmpeg(
    [
      "-i",
      videoOnlyPath,
      "-i",
      audioPath,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-shortest",
      outputPath,
    ],
    log,
  );
};

export const renderProjectGpuDemo = async (
  project: TalkVideoProject,
  options: RenderOptions,
): Promise<RenderResult> => {
  const log = options.log ?? (() => {});
  const outputPath = path.resolve(options.outputPath);
  const outputDir = path.dirname(outputPath);
  const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "gpu-render-"));
  const segmentFiles: string[] = [];
  const tempSamples: number[] = [];
  const projectPath = path.resolve(options.projectPath);
  const cooldownMs = options.cooldownMs ?? 3000;
  const sourceFps = project.timeline.fps;
  const renderFps = options.renderFps ?? sourceFps;
  const totalDurationSeconds = project.timeline.durationFrames / sourceFps;
  const totalRenderFrames = Math.max(1, Math.round(totalDurationSeconds * renderFps));

  await fsPromises.mkdir(outputDir, {recursive: true});

  const {cues, mouthTimingByCue} = loadCueRuntime(projectPath, project);
  const blinkWindowsBySpeaker = createBlinkWindowsBySpeaker(project.timeline.durationFrames);

  for (const cue of cues) {
    const sampled = await waitForCpuCooling(options.cpuTempLimitC ?? null, cooldownMs, log);
    tempSamples.push(...sampled);

    const segmentPath = path.join(
      tempRoot,
      `segment-${String(cue.index + 1).padStart(3, "0")}.mp4`,
    );
    log(`Rendering cue ${cue.index + 1}/${cues.length} -> ${segmentPath}`);
    await createAgiDiscussionSegment(
      projectPath,
      project,
      cue,
      cues[cue.index - 1],
      cues[cue.index + 1],
      mouthTimingByCue,
      blinkWindowsBySpeaker,
      tempRoot,
      segmentPath,
      renderFps,
      log,
    );
    segmentFiles.push(segmentPath);
  }

  const concatListPath = path.join(tempRoot, "segments.txt");
  await fsPromises.writeFile(
    concatListPath,
    `${segmentFiles.map((filePath) => `file '${escapeConcatPath(filePath)}'`).join("\n")}\n`,
    "utf8",
  );

  const videoOnlyPath = path.join(tempRoot, "video-only.mp4");
  await runFfmpeg(
    [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListPath,
      "-vf",
      `fps=${renderFps}`,
      "-fps_mode",
      "cfr",
      "-r",
      `${renderFps}`,
      "-frames:v",
      `${totalRenderFrames}`,
      "-g",
      `${renderFps}`,
      "-bf",
      "0",
      "-c:v",
      "h264_nvenc",
      "-preset",
      "p5",
      "-cq",
      "18",
      "-pix_fmt",
      "yuv420p",
      videoOnlyPath,
    ],
    log,
  );

  const finalAudioPath = resolveFromProject(projectPath, project.timeline.audioMix.finalMixPath);
  await muxFinalAudio(videoOnlyPath, finalAudioPath, outputPath, log);

  return {
    outputPath,
    tempSamples,
    segmentFiles,
  };
};
