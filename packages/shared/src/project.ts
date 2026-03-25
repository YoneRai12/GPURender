import * as fs from "node:fs";
import * as path from "node:path";

import {bundledSchemaPath, resolveFromProject} from "./paths.js";
import {validateProjectShape} from "./schema.js";
import type {TalkVideoProject, ValidationIssue, ValidationResult} from "./types.js";

const readJson = <T>(filePath: string): T =>
  JSON.parse(fs.readFileSync(filePath, "utf8")) as T;

const resolveSchemaPath = (projectPath: string, rawProject: {$schema?: string}): string =>
  rawProject.$schema ? resolveFromProject(projectPath, rawProject.$schema) : bundledSchemaPath;

const checkPath = (
  projectPath: string,
  label: string,
  candidate: string,
  options?: {allowMissing?: boolean},
): ValidationIssue[] => {
  const resolved = resolveFromProject(projectPath, candidate);
  if (fs.existsSync(resolved) || options?.allowMissing) {
    return [];
  }

  return [
    {
      severity: "error",
      path: label,
      message: `Referenced path does not exist: ${candidate}`,
    },
  ];
};

export const loadProject = (projectPath: string): TalkVideoProject => {
  const absolutePath = path.resolve(projectPath);
  return readJson<TalkVideoProject>(absolutePath);
};

export const validateProjectFile = (projectPath: string): ValidationResult => {
  const absolutePath = path.resolve(projectPath);
  const raw = readJson<unknown>(absolutePath);
  const schemaPath = resolveSchemaPath(absolutePath, raw as {$schema?: string});
  const issues = validateProjectShape(raw, schemaPath);
  const fallbackProject = raw as TalkVideoProject;

  if (issues.length > 0) {
    return {
      ok: false,
      projectPath: absolutePath,
      schemaPath,
      project: fallbackProject,
      issues,
    };
  }

  const project = raw as TalkVideoProject;
  const pathIssues = [
    ...checkPath(absolutePath, "sources.scriptJsonPath", project.sources.scriptJsonPath),
    ...checkPath(
      absolutePath,
      "sources.conversationManifestPath",
      project.sources.conversationManifestPath,
    ),
    ...checkPath(
      absolutePath,
      "sources.remotionSceneSourcePath",
      project.sources.remotionSceneSourcePath,
    ),
    ...checkPath(absolutePath, "sources.cueDataPath", project.sources.cueDataPath),
    ...checkPath(absolutePath, "sources.mouthDataPath", project.sources.mouthDataPath),
    ...checkPath(
      absolutePath,
      "sources.publicConversationDir",
      project.sources.publicConversationDir,
    ),
    ...checkPath(
      absolutePath,
      "timeline.audioMix.combinedNarrationPath",
      project.timeline.audioMix.combinedNarrationPath,
    ),
    ...checkPath(
      absolutePath,
      "timeline.audioMix.finalMixPath",
      project.timeline.audioMix.finalMixPath,
    ),
    ...(project.timeline.audioMix.bgmPath
      ? checkPath(absolutePath, "timeline.audioMix.bgmPath", project.timeline.audioMix.bgmPath)
      : []),
    ...project.characters.flatMap((character: TalkVideoProject["characters"][number]) => [
      ...checkPath(
        absolutePath,
        `characters.${character.id}.visual.avatarPath`,
        character.visual.avatarPath,
      ),
      ...checkPath(
        absolutePath,
        `characters.${character.id}.visual.blinkUpperPath`,
        character.visual.blinkUpperPath,
      ),
      ...checkPath(
        absolutePath,
        `characters.${character.id}.visual.upperDir`,
        character.visual.upperDir,
      ),
    ]),
    ...checkPath(
      absolutePath,
      "renderTargets.remotion.projectDir",
      project.renderTargets.remotion.projectDir,
    ),
    ...checkPath(
      absolutePath,
      "renderTargets.resolve.exportDir",
      project.renderTargets.resolve.exportDir,
      {allowMissing: true},
    ),
    ...checkPath(
      absolutePath,
      "renderTargets.gpu.rendererProjectDir",
      project.renderTargets.gpu.rendererProjectDir,
    ),
    ...(project.renderTargets.remotion.outputPath
      ? checkPath(
          absolutePath,
          "renderTargets.remotion.outputPath",
          project.renderTargets.remotion.outputPath,
          {allowMissing: true},
        )
      : []),
    ...(project.renderTargets.resolve.outputPath
      ? checkPath(
          absolutePath,
          "renderTargets.resolve.outputPath",
          project.renderTargets.resolve.outputPath,
          {allowMissing: true},
        )
      : []),
    ...(project.renderTargets.gpu.outputPath
      ? checkPath(
          absolutePath,
          "renderTargets.gpu.outputPath",
          project.renderTargets.gpu.outputPath,
          {allowMissing: true},
        )
      : []),
  ];

  const allIssues = [...issues, ...pathIssues];
  return {
    ok: allIssues.length === 0,
    projectPath: absolutePath,
    schemaPath,
    project,
    issues: allIssues,
  };
};
