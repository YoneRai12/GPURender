import * as path from "node:path";
import {fileURLToPath} from "node:url";

export const sharedDir = path.dirname(fileURLToPath(import.meta.url));

export const repoRootFrom = (startDir: string): string =>
  path.resolve(startDir, "..", "..", "..");

export const getRepoRoot = (): string => repoRootFrom(sharedDir);

export const resolveFromProject = (projectPath: string, targetPath: string): string =>
  path.resolve(path.dirname(projectPath), targetPath);

export const bundledSchemaPath = path.resolve(
  getRepoRoot(),
  "schema",
  "talk-video-project.schema.json",
);
