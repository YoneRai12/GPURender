import {execFile} from "node:child_process";
import * as fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {
  createBlinkWindowsBySpeaker,
  loadCueRuntime,
  type CueRuntime,
} from "@gpu-render/gpu-renderer";
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

type ImageRun = {
  frameCount: number;
  path: string;
};

export type ResolveManifestItem = {
  durationFrames: number;
  id: string;
  path: string;
  recordFrame: number;
  trackIndex: number;
  trackType: "audio" | "video";
};

export type ResolveExportManifest = {
  audioTracks: Array<{index: number; name: string}>;
  exportDir: string;
  fps: number;
  generatedAt: string;
  height: number;
  items: ResolveManifestItem[];
  loaderScriptPath: string;
  projectId: string;
  projectName: string;
  startTimecode: string;
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

const runFfmpeg = async (args: string[], log: (message: string) => void) => {
  log(`ffmpeg ${args.join(" ")}`);
  await execFileAsync("ffmpeg", ["-y", ...args], {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 16,
  });
};

const escapeConcatPath = (filePath: string) =>
  filePath.replace(/\\/g, "/").replace(/'/g, "'\\''");

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

const writeMediaConcatList = async (filePaths: string[], listPath: string) => {
  const lines = filePaths.map((filePath) => `file '${escapeConcatPath(filePath)}'`);
  await fsPromises.writeFile(listPath, `${lines.join("\n")}\n`, "utf8");
};

const concatLayerFiles = async (
  filePaths: string[],
  outputPath: string,
  tempDir: string,
  fps: number,
  mode: "background" | "alpha",
  log: (message: string) => void,
) => {
  if (filePaths.length === 0) {
    throw new Error(`No media files were provided for concat: ${outputPath}`);
  }

  const listPath = path.join(
    tempDir,
    `${path.basename(outputPath, path.extname(outputPath))}.concat.txt`,
  );
  await writeMediaConcatList(filePaths, listPath);

  await runFfmpeg(
    mode === "background"
      ? [
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listPath,
          "-map",
          "0:v:0",
          "-r",
          `${fps}`,
          "-an",
          "-c:v",
          "h264_nvenc",
          "-preset",
          "p5",
          "-cq",
          "18",
          "-pix_fmt",
          "yuv420p",
          outputPath,
        ]
      : [
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listPath,
          "-map",
          "0:v:0",
          "-r",
          `${fps}`,
          "-an",
          "-c:v",
          "prores_ks",
          "-profile:v",
          "4",
          "-pix_fmt",
          "yuva444p10le",
          outputPath,
        ],
    log,
  );
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

const buildAmplitudeExpression = (
  startAmplitude: number,
  targetAmplitude: number,
  endAmplitude: number,
  frameCount: number,
) => {
  const easingFrames = Math.max(2, Math.min(10, Math.floor(frameCount / 6)));
  const easeOutStart = Math.max(easingFrames, frameCount - easingFrames);

  if (easingFrames <= 0 || (startAmplitude === targetAmplitude && targetAmplitude === endAmplitude)) {
    return `${targetAmplitude}`;
  }

  const startExpr =
    startAmplitude === targetAmplitude
      ? `${targetAmplitude}`
      : `${startAmplitude}+(${targetAmplitude - startAmplitude})*(n/${easingFrames})`;
  const endExpr =
    endAmplitude === targetAmplitude
      ? `${targetAmplitude}`
      : `${targetAmplitude}+(${endAmplitude - targetAmplitude})*((n-${easeOutStart})/${easingFrames})`;

  return `if(lt(n\\,${easingFrames})\\,${startExpr}\\,if(gte(n\\,${easeOutStart})\\,${endExpr}\\,${targetAmplitude}))`;
};

const buildBobYExpression = (
  baseY: number,
  cueStartFrame: number,
  radiansDivisor: number,
  startAmplitude: number,
  targetAmplitude: number,
  endAmplitude: number,
  frameCount: number,
) => {
  const amplitudeExpr = buildAmplitudeExpression(
    startAmplitude,
    targetAmplitude,
    endAmplitude,
    frameCount,
  );
  return `${baseY + 1}+(${amplitudeExpr})*sin((${cueStartFrame}+n)/${radiansDivisor})`;
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

const exportBackgroundClip = async (
  cue: CueRuntime,
  fps: number,
  outputPath: string,
  log: (message: string) => void,
) => {
  if (!cue.topAssetPath || !cue.cardAssetPath) {
    throw new Error(`Cue ${cue.index + 1} is missing background assets.`);
  }

  const durationSeconds = cue.durationFrames / fps;
  await runFfmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      `color=c=0x9eb7f2:s=1920x1080:r=${fps}:d=${durationSeconds}`,
      "-loop",
      "1",
      "-t",
      `${durationSeconds}`,
      "-i",
      cue.topAssetPath,
      "-loop",
      "1",
      "-t",
      `${durationSeconds}`,
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
      "-an",
      "-frames:v",
      `${cue.durationFrames}`,
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

const exportSubtitleClip = async (
  cue: CueRuntime,
  fps: number,
  outputPath: string,
  log: (message: string) => void,
) => {
  if (!cue.subtitleAssetPath || !fs.existsSync(cue.subtitleAssetPath)) {
    throw new Error(`Cue ${cue.index + 1} is missing subtitle asset.`);
  }

  const durationSeconds = cue.durationFrames / fps;
  await runFfmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      `color=c=black@0.0:s=1920x1080:r=${fps}:d=${durationSeconds}`,
      "-loop",
      "1",
      "-t",
      `${durationSeconds}`,
      "-i",
      cue.subtitleAssetPath,
      "-filter_complex",
      [
        "[0:v]format=rgba,colorchannelmixer=aa=0[base]",
        "[1:v]format=rgba[sub]",
        "[base][sub]overlay=0:852:shortest=1:eof_action=pass[v]",
      ].join(";"),
      "-map",
      "[v]",
      "-an",
      "-frames:v",
      `${cue.durationFrames}`,
      "-c:v",
      "prores_ks",
      "-profile:v",
      "4",
      "-pix_fmt",
      "yuva444p10le",
      outputPath,
    ],
    log,
  );
};

const exportCharacterClip = async (
  projectPath: string,
  project: TalkVideoProject,
  cue: CueRuntime,
  previousCue: CueRuntime | undefined,
  nextCue: CueRuntime | undefined,
  speaker: SpeakerId,
  mouthTimingByCue: string[][],
  blinkWindowsBySpeaker: Record<SpeakerId, Array<{start: number; duration: number}>>,
  tempDir: string,
  outputPath: string,
  log: (message: string) => void,
) => {
  const fps = project.timeline.fps;
  const durationSeconds = cue.durationFrames / fps;
  const frameCount = cue.durationFrames;
  const listPath = path.join(tempDir, `${speaker}-cue-${String(cue.index + 1).padStart(2, "0")}.txt`);
  const runs = buildCharacterRuns(
    projectPath,
    project,
    speaker,
    cue.index,
    cue.startFrame,
    cue.durationFrames,
    mouthTimingByCue,
    blinkWindowsBySpeaker,
    cue.speaker,
  );
  await writeConcatList(runs, fps, listPath);

  const isZundamon = speaker === "zundamon";
  const dims = isZundamon ? zundamonDims : metanDims;
  const startAmplitude = previousCue?.speaker === speaker ? 7 : 3;
  const targetAmplitude = cue.speaker === speaker ? 7 : 3;
  const endAmplitude = nextCue?.speaker === speaker ? 7 : 3;
  const bobY = buildBobYExpression(
    dims.y,
    cue.startFrame,
    isZundamon ? 28 : 31,
    startAmplitude,
    targetAmplitude,
    endAmplitude,
    frameCount,
  );

  const charFilter = isZundamon
    ? `[1:v]fps=${fps},scale=${dims.width}:${dims.height}:flags=lanczos,format=rgba,hflip[char]`
    : `[1:v]fps=${fps},scale=${dims.width}:${dims.height}:flags=lanczos,format=rgba[char]`;

  await runFfmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      `color=c=black@0.0:s=1920x1080:r=${fps}:d=${durationSeconds}`,
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-filter_complex",
      [
        "[0:v]format=rgba,colorchannelmixer=aa=0[base]",
        charFilter,
        `[base][char]overlay=${dims.x}:${bobY}:shortest=1:eof_action=pass[v]`,
      ].join(";"),
      "-map",
      "[v]",
      "-an",
      "-frames:v",
      `${cue.durationFrames}`,
      "-c:v",
      "prores_ks",
      "-profile:v",
      "4",
      "-pix_fmt",
      "yuva444p10le",
      outputPath,
    ],
    log,
  );
};

const copyAudio = async (
  projectPath: string,
  project: TalkVideoProject,
  outputPath: string,
  log: (message: string) => void,
) => {
  const audioPath = resolveFromProject(projectPath, project.timeline.audioMix.finalMixPath);
  await runFfmpeg(
    [
      "-i",
      audioPath,
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
  const tempDir = path.join(exportDir, ".tmp");
  const backgroundsDir = path.join(exportDir, "media", "backgrounds");
  const subtitlesDir = path.join(exportDir, "media", "subtitles");
  const zundamonDir = path.join(exportDir, "media", "characters", "zundamon");
  const metanDir = path.join(exportDir, "media", "characters", "metan");
  const audioDir = path.join(exportDir, "media", "audio");
  const tracksDir = path.join(exportDir, "media", "tracks");

  await fsPromises.mkdir(backgroundsDir, {recursive: true});
  await fsPromises.mkdir(subtitlesDir, {recursive: true});
  await fsPromises.mkdir(zundamonDir, {recursive: true});
  await fsPromises.mkdir(metanDir, {recursive: true});
  await fsPromises.mkdir(audioDir, {recursive: true});
  await fsPromises.mkdir(tracksDir, {recursive: true});
  await fsPromises.mkdir(tempDir, {recursive: true});

  const {cues, mouthTimingByCue} = loadCueRuntime(absoluteProjectPath, project);
  const blinkWindowsBySpeaker = createBlinkWindowsBySpeaker(project.timeline.durationFrames);
  const manifestItems: ResolveManifestItem[] = [];
  const backgroundCuePaths: string[] = [];
  const zundamonCuePaths: string[] = [];
  const metanCuePaths: string[] = [];
  const subtitleCuePaths: string[] = [];

  const audioPath = path.join(audioDir, "final-mix.wav");
  await copyAudio(absoluteProjectPath, project, audioPath, log);

  for (const cue of cues) {
    const suffix = String(cue.index + 1).padStart(2, "0");
    const backgroundPath = path.join(backgroundsDir, `cue-${suffix}.mp4`);
    const zundamonPath = path.join(zundamonDir, `cue-${suffix}.mov`);
    const metanPath = path.join(metanDir, `cue-${suffix}.mov`);
    const subtitlePath = path.join(subtitlesDir, `cue-${suffix}.mov`);

    await exportBackgroundClip(cue, project.timeline.fps, backgroundPath, log);
    await exportCharacterClip(
      absoluteProjectPath,
      project,
      cue,
      cues[cue.index - 1],
      cues[cue.index + 1],
      "zundamon",
      mouthTimingByCue,
      blinkWindowsBySpeaker,
      tempDir,
      zundamonPath,
      log,
    );
    await exportCharacterClip(
      absoluteProjectPath,
      project,
      cue,
      cues[cue.index - 1],
      cues[cue.index + 1],
      "metan",
      mouthTimingByCue,
      blinkWindowsBySpeaker,
      tempDir,
      metanPath,
      log,
    );
    await exportSubtitleClip(cue, project.timeline.fps, subtitlePath, log);

    backgroundCuePaths.push(backgroundPath);
    zundamonCuePaths.push(zundamonPath);
    metanCuePaths.push(metanPath);
    subtitleCuePaths.push(subtitlePath);
  }

  const backgroundTrackPath = path.join(tracksDir, "background.mp4");
  const zundamonTrackPath = path.join(tracksDir, "zundamon.mov");
  const metanTrackPath = path.join(tracksDir, "metan.mov");
  const subtitleTrackPath = path.join(tracksDir, "subtitle.mov");

  await concatLayerFiles(
    backgroundCuePaths,
    backgroundTrackPath,
    tempDir,
    project.timeline.fps,
    "background",
    log,
  );
  await concatLayerFiles(
    zundamonCuePaths,
    zundamonTrackPath,
    tempDir,
    project.timeline.fps,
    "alpha",
    log,
  );
  await concatLayerFiles(
    metanCuePaths,
    metanTrackPath,
    tempDir,
    project.timeline.fps,
    "alpha",
    log,
  );
  await concatLayerFiles(
    subtitleCuePaths,
    subtitleTrackPath,
    tempDir,
    project.timeline.fps,
    "alpha",
    log,
  );

  manifestItems.push(
    {
      durationFrames: project.timeline.durationFrames,
      id: "background-track",
      path: backgroundTrackPath,
      recordFrame: 0,
      trackIndex: 4,
      trackType: "video",
    },
    {
      durationFrames: project.timeline.durationFrames,
      id: "zundamon-track",
      path: zundamonTrackPath,
      recordFrame: 0,
      trackIndex: 3,
      trackType: "video",
    },
    {
      durationFrames: project.timeline.durationFrames,
      id: "metan-track",
      path: metanTrackPath,
      recordFrame: 0,
      trackIndex: 2,
      trackType: "video",
    },
    {
      durationFrames: project.timeline.durationFrames,
      id: "subtitle-track",
      path: subtitleTrackPath,
      recordFrame: 0,
      trackIndex: 1,
      trackType: "video",
    },
    {
      durationFrames: project.timeline.durationFrames,
      id: "audio-final-mix",
      path: audioPath,
      recordFrame: 0,
      trackIndex: 1,
      trackType: "audio",
    },
  );

  const manifest: ResolveExportManifest = {
    audioTracks: [{index: 1, name: "Mix"}],
    exportDir,
    fps: project.timeline.fps,
    generatedAt: new Date().toISOString(),
    height: project.timeline.height,
    items: manifestItems,
    loaderScriptPath,
    projectId: project.project.id,
    projectName: `${project.project.title} Resolve Auto`,
    startTimecode: project.timeline.startTimecode ?? "01:00:00:00",
    timelineName: `${project.project.title} Timeline`,
    videoTracks: [
      {index: 1, name: "Subtitle"},
      {index: 2, name: "Metan"},
      {index: 3, name: "Zundamon"},
      {index: 4, name: "Background"},
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
