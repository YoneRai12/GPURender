import fs from "node:fs";
import path from "node:path";

import {bundledSchemaPath} from "./paths.js";
import type {ValidationIssue} from "./types.js";

type JsonObject = Record<string, unknown>;

export const loadSchemaAt = (schemaPath: string) =>
  JSON.parse(fs.readFileSync(path.resolve(schemaPath), "utf8")) as JsonObject;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (value: unknown, fieldPath: string, issues: ValidationIssue[]) => {
  if (typeof value !== "string" || value.length === 0) {
    issues.push({
      severity: "error",
      path: fieldPath,
      message: "Expected a non-empty string",
    });
  }
};

const requireNumber = (value: unknown, fieldPath: string, issues: ValidationIssue[]) => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    issues.push({
      severity: "error",
      path: fieldPath,
      message: "Expected a number",
    });
  }
};

const requireBoolean = (value: unknown, fieldPath: string, issues: ValidationIssue[]) => {
  if (typeof value !== "boolean") {
    issues.push({
      severity: "error",
      path: fieldPath,
      message: "Expected a boolean",
    });
  }
};

export const validateProjectShape = (
  project: unknown,
  schemaPath = bundledSchemaPath,
): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const schema = loadSchemaAt(schemaPath);

  if (!isObject(schema) || schema.type !== "object") {
    issues.push({
      severity: "error",
      path: "$schema",
      message: "Schema file could not be read as an object schema",
    });
    return issues;
  }

  if (!isObject(project)) {
    issues.push({
      severity: "error",
      path: "/",
      message: "Project file must be a JSON object",
    });
    return issues;
  }

  const requiredTopLevel =
    Array.isArray(schema.required) && schema.required.length > 0
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : ["schemaVersion", "project", "timeline", "characters", "style", "sources", "renderTargets"];

  for (const key of requiredTopLevel) {
    if (!(key in project)) {
      issues.push({
        severity: "error",
        path: key,
        message: "Missing required top-level field",
      });
    }
  }

  if (project.schemaVersion !== "1.0.0") {
    issues.push({
      severity: "error",
      path: "schemaVersion",
      message: "schemaVersion must be 1.0.0",
    });
  }

  const projectMeta = project.project;
  if (!isObject(projectMeta)) {
    issues.push({severity: "error", path: "project", message: "project must be an object"});
  } else {
    requireString(projectMeta.id, "project.id", issues);
    requireString(projectMeta.title, "project.title", issues);
    requireString(projectMeta.language, "project.language", issues);
    requireString(projectMeta.description, "project.description", issues);
  }

  const timeline = project.timeline;
  if (!isObject(timeline)) {
    issues.push({severity: "error", path: "timeline", message: "timeline must be an object"});
  } else {
    requireNumber(timeline.fps, "timeline.fps", issues);
    requireNumber(timeline.width, "timeline.width", issues);
    requireNumber(timeline.height, "timeline.height", issues);
    requireNumber(timeline.durationFrames, "timeline.durationFrames", issues);

    const audioMix = timeline.audioMix;
    if (!isObject(audioMix)) {
      issues.push({
        severity: "error",
        path: "timeline.audioMix",
        message: "timeline.audioMix must be an object",
      });
    } else {
      requireString(audioMix.combinedNarrationPath, "timeline.audioMix.combinedNarrationPath", issues);
      requireString(audioMix.finalMixPath, "timeline.audioMix.finalMixPath", issues);
    }
  }

  if (!Array.isArray(project.characters) || project.characters.length === 0) {
    issues.push({
      severity: "error",
      path: "characters",
      message: "characters must be a non-empty array",
    });
  }

  const style = project.style;
  if (!isObject(style)) {
    issues.push({severity: "error", path: "style", message: "style must be an object"});
  } else {
    requireString(style.layout, "style.layout", issues);
    const subtitleBand = style.subtitleBand;
    if (!isObject(subtitleBand)) {
      issues.push({
        severity: "error",
        path: "style.subtitleBand",
        message: "style.subtitleBand must be an object",
      });
    } else {
      requireBoolean(subtitleBand.alwaysVisible, "style.subtitleBand.alwaysVisible", issues);
      requireBoolean(subtitleBand.showSpeakerName, "style.subtitleBand.showSpeakerName", issues);
    }
  }

  const sources = project.sources;
  if (!isObject(sources)) {
    issues.push({severity: "error", path: "sources", message: "sources must be an object"});
  } else {
    for (const key of [
      "projectRoot",
      "scriptJsonPath",
      "conversationManifestPath",
      "remotionSceneSourcePath",
      "cueDataPath",
      "mouthDataPath",
      "publicConversationDir",
    ]) {
      requireString(sources[key], `sources.${key}`, issues);
    }
  }

  const renderTargets = project.renderTargets;
  if (!isObject(renderTargets)) {
    issues.push({
      severity: "error",
      path: "renderTargets",
      message: "renderTargets must be an object",
    });
  } else {
    const remotion = renderTargets.remotion;
    const resolve = renderTargets.resolve;
    const gpu = renderTargets.gpu;

    if (!isObject(remotion)) {
      issues.push({
        severity: "error",
        path: "renderTargets.remotion",
        message: "renderTargets.remotion must be an object",
      });
    } else {
      requireString(remotion.compositionId, "renderTargets.remotion.compositionId", issues);
      requireString(remotion.projectDir, "renderTargets.remotion.projectDir", issues);
    }

    if (!isObject(resolve)) {
      issues.push({
        severity: "error",
        path: "renderTargets.resolve",
        message: "renderTargets.resolve must be an object",
      });
    } else {
      requireString(resolve.exportDir, "renderTargets.resolve.exportDir", issues);
      if (!Array.isArray(resolve.timelineFormatPreference)) {
        issues.push({
          severity: "error",
          path: "renderTargets.resolve.timelineFormatPreference",
          message: "Expected an array",
        });
      }
    }

    if (!isObject(gpu)) {
      issues.push({
        severity: "error",
        path: "renderTargets.gpu",
        message: "renderTargets.gpu must be an object",
      });
    } else {
      requireString(gpu.rendererProjectDir, "renderTargets.gpu.rendererProjectDir", issues);
      requireString(gpu.sceneTemplate, "renderTargets.gpu.sceneTemplate", issues);
    }
  }

  return issues;
};
