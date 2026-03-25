import * as fs from "node:fs";
import * as path from "node:path";
import vm from "node:vm";

import {resolveFromProject} from "@gpu-render/shared";
import type {SpeakerId, TalkVideoProject} from "@gpu-render/shared";

export type CueRuntime = {
  index: number;
  speaker: SpeakerId;
  text: string;
  subtitleText: string;
  startFrame: number;
  durationFrames: number;
  cardAssetPath?: string;
  topAssetPath?: string;
  subtitleAssetPath?: string;
};

type ScriptJson = {
  lines: Array<{
    speaker: SpeakerId;
    text: string;
  }>;
};

type ConversationManifest = {
  fps: number;
  lines: Array<{
    durationFrames: number;
    speaker: SpeakerId;
  }>;
};

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

export const formatSubtitleText = (text: string): string => {
  const normalized = text.trim();
  if (!normalized || normalized.includes("\n") || normalized.length <= 16) {
    return normalized;
  }

  const findBreakIndex = (source: string, minRatio: number, maxRatio: number) => {
    const target = Math.floor(source.length / 2);
    const minIndex = Math.floor(source.length * minRatio);
    const maxIndex = Math.ceil(source.length * maxRatio);

    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let index = minIndex; index < Math.min(maxIndex, source.length - 1); index += 1) {
      const char = source[index];
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

    return bestIndex;
  };

  const lines: string[] = [];
  let remaining = normalized;

  while (remaining.length > 16 && lines.length < 3) {
    const breakIndex = findBreakIndex(remaining, 0.24, 0.6);
    lines.push(remaining.slice(0, breakIndex).trim());
    remaining = remaining.slice(breakIndex).trim();
  }

  if (remaining) {
    lines.push(remaining);
  }

  return lines.join("\n");
};

const readJson = <T>(filePath: string): T =>
  JSON.parse(fs.readFileSync(filePath, "utf8")) as T;

const loadMouthTiming = (projectPath: string, project: TalkVideoProject): string[][] => {
  const mouthDataPath = resolveFromProject(projectPath, project.sources.mouthDataPath);
  const source = fs.readFileSync(mouthDataPath, "utf8");
  const match = source.match(/mouthTimingByCue\s*=\s*(\[[\s\S]*\])\s*as const/);
  if (!match) {
    throw new Error(`Could not parse mouth timing data from ${mouthDataPath}`);
  }

  return vm.runInNewContext(match[1]) as string[][];
};

export const loadCueRuntime = (projectPath: string, project: TalkVideoProject): {
  cues: CueRuntime[];
  mouthTimingByCue: string[][];
} => {
  const scriptPath = resolveFromProject(projectPath, project.sources.scriptJsonPath);
  const manifestPath = resolveFromProject(projectPath, project.sources.conversationManifestPath);
  const assetRoot = path.resolve(path.dirname(projectPath), "gpu-assets");
  const script = readJson<ScriptJson>(scriptPath);
  const manifest = readJson<ConversationManifest>(manifestPath);
  const mouthTimingByCue = loadMouthTiming(projectPath, project);

  let startFrame = 0;
  const cues = manifest.lines.map((line, index) => {
    const scriptLine = script.lines[index];
    const cue: CueRuntime = {
      index,
      speaker: scriptLine?.speaker ?? line.speaker,
      text: scriptLine?.text ?? "",
      subtitleText: formatSubtitleText(scriptLine?.text ?? ""),
      startFrame,
      durationFrames: line.durationFrames,
      cardAssetPath: path.join(assetRoot, "cards", `card-${String(index + 1).padStart(2, "0")}.png`),
      topAssetPath: path.join(assetRoot, "top", `top-${String(index + 1).padStart(2, "0")}.png`),
      subtitleAssetPath: path.join(
        assetRoot,
        "subtitles",
        `subtitle-${String(index + 1).padStart(2, "0")}.png`,
      ),
    };
    startFrame += line.durationFrames;
    return cue;
  });

  const actualDuration = cues.reduce((sum, cue) => sum + cue.durationFrames, 0);
  if (cues.length > 0 && project.timeline.durationFrames > actualDuration) {
    cues[cues.length - 1].durationFrames += project.timeline.durationFrames - actualDuration;
  }

  return {cues, mouthTimingByCue};
};

type BlinkWindow = {
  duration: number;
  start: number;
};

const createBlinkWindows = (seed: number, totalFrames: number): BlinkWindow[] => {
  const windows: BlinkWindow[] = [];
  let current = 54 + (seed % 36);
  let state = seed >>> 0;

  while (current < totalFrames - 4) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const duration = 2 + ((state >>> 29) % 2);
    windows.push({start: current, duration});

    if (((state >>> 9) & 0b111) === 0) {
      const secondStart = current + 7 + (state % 4);
      if (secondStart < totalFrames - 2) {
        windows.push({start: secondStart, duration: 2});
      }
    }

    current += 88 + (state % 88);
  }

  return windows.sort((left, right) => left.start - right.start);
};

export const createBlinkWindowsBySpeaker = (totalFrames: number) => ({
  metan: createBlinkWindows(911, totalFrames),
  zundamon: createBlinkWindows(137, totalFrames),
});
