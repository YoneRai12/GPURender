import * as path from "node:path";

import type {RenderPlan, ValidationResult} from "./types.js";

export const createDryRunRenderPlan = (
  validation: ValidationResult,
  outputPath: string,
  renderFps?: number,
): RenderPlan => {
  if (!validation.project) {
    throw new Error("Cannot build a render plan from an invalid project.");
  }

  const project = validation.project;
  const resolvedOutputPath = path.resolve(process.cwd(), outputPath);
  const outputFps = renderFps ?? project.timeline.fps;
  const estimatedSeconds = project.timeline.durationFrames / project.timeline.fps;

  return {
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    projectPath: validation.projectPath,
    schemaPath: validation.schemaPath,
    outputPath: resolvedOutputPath,
    title: project.project.title,
    composition: {
      width: project.timeline.width,
      height: project.timeline.height,
      fps: outputFps,
      durationFrames: Math.round(estimatedSeconds * outputFps),
      estimatedSeconds,
    },
    renderer: {
      target: "gpu",
      template: project.renderTargets.gpu.sceneTemplate,
      colorProfile: project.timeline.colorProfile,
      randomSeed: project.timeline.randomSeed,
      sourceFps: project.timeline.fps,
    },
    assets: {
      characterCount: project.characters.length,
      narrationPath: project.timeline.audioMix.combinedNarrationPath,
      finalMixPath: project.timeline.audioMix.finalMixPath,
      bgmPath: project.timeline.audioMix.bgmPath,
    },
  };
};
