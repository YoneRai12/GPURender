import {execFile, spawn} from "node:child_process";
import * as fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resolveRuntimeScriptPath = path.join(packageRoot, "scripts", "resolve_runtime.py");

export type ResolveRuntimeOptions = {
  log?: (message: string) => void;
};

export type ResolvePingResult = {
  currentProjectName?: string | null;
  currentTimelineName?: string | null;
  ok: boolean;
  productName?: string | null;
};

export type ResolveLaunchResult = {
  executablePath: string;
  launched: boolean;
};

export type ResolveAudioSyncResult = {
  binName: string;
  discoveredCount: number;
  folderPath: string;
  importedCount: number;
  ok: boolean;
  projectName: string;
};

export type ResolveRenderCurrentResult = {
  customName?: string | null;
  jobId?: string | number | null;
  ok: boolean;
  outputDir?: string | null;
  presetName?: string | null;
  projectName: string;
  started: boolean;
  timelineName: string;
  waited?: boolean;
};

type ResolveRuntimeAction = "ping" | "render-current" | "sync-audio-folder";

type EnsureResolveReadyOptions = ResolveRuntimeOptions & {
  autoLaunch?: boolean;
  pollMs?: number;
  timeoutMs?: number;
};

type SyncResolveAudioFolderOptions = ResolveRuntimeOptions & {
  binName?: string;
  folderPath: string;
  projectName?: string;
  recursive?: boolean;
};

type RenderResolveCurrentOptions = ResolveRuntimeOptions & {
  customName?: string;
  outputDir?: string;
  presetName?: string;
  projectName?: string;
  start?: boolean;
  timelineName?: string;
  wait?: boolean;
};

const defaultResolveExecutableCandidates = () => {
  const baseDirs = [
    process.env.DAVINCI_RESOLVE_EXE ? "" : null,
    process.env.PROGRAMFILES,
    process.env.PROGRAMW6432,
    process.env["PROGRAMFILES(X86)"],
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  const candidates = new Set<string>();
  if (process.env.DAVINCI_RESOLVE_EXE) {
    candidates.add(path.resolve(process.env.DAVINCI_RESOLVE_EXE));
  }

  for (const baseDir of baseDirs) {
    candidates.add(path.join(baseDir, "Blackmagic Design", "DaVinci Resolve", "Resolve.exe"));
    candidates.add(
      path.join(baseDir, "Blackmagic Design", "DaVinci Resolve Studio", "Resolve.exe"),
    );
  }

  return Array.from(candidates);
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const writeTempPayload = async (action: ResolveRuntimeAction, payload: object) => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `gpu-render-${action}-`));
  const payloadPath = path.join(tempDir, "payload.json");
  await fsPromises.writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return {payloadPath, tempDir};
};

const runResolveRuntime = async <T>(
  action: ResolveRuntimeAction,
  payload: object,
  options?: ResolveRuntimeOptions,
): Promise<T> => {
  const log = options?.log ?? (() => {});
  if (!fs.existsSync(resolveRuntimeScriptPath)) {
    throw new Error(`Resolve runtime script was not found: ${resolveRuntimeScriptPath}`);
  }

  const {payloadPath, tempDir} = await writeTempPayload(action, payload);
  try {
    log(`python ${resolveRuntimeScriptPath} ${action} ${payloadPath}`);
    const {stdout} = await execFileAsync("python", [resolveRuntimeScriptPath, action, payloadPath], {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 8,
    });
    return JSON.parse(stdout) as T;
  } finally {
    await fsPromises.rm(tempDir, {force: true, recursive: true});
  }
};

export const findResolveExecutable = () => {
  for (const candidate of defaultResolveExecutableCandidates()) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

export const launchResolve = async (options?: ResolveRuntimeOptions): Promise<ResolveLaunchResult> => {
  const log = options?.log ?? (() => {});
  const executablePath = findResolveExecutable();
  if (!executablePath) {
    throw new Error("DaVinci Resolve executable was not found. Set DAVINCI_RESOLVE_EXE if needed.");
  }

  log(`launch ${executablePath}`);
  const child = spawn(executablePath, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  return {
    executablePath,
    launched: true,
  };
};

export const pingResolve = (options?: ResolveRuntimeOptions) =>
  runResolveRuntime<ResolvePingResult>("ping", {}, options);

export const ensureResolveReady = async (
  options?: EnsureResolveReadyOptions,
): Promise<ResolvePingResult> => {
  const log = options?.log ?? (() => {});
  const autoLaunch = options?.autoLaunch ?? true;
  const pollMs = options?.pollMs ?? 1500;
  const timeoutMs = options?.timeoutMs ?? 60_000;

  try {
    return await pingResolve(options);
  } catch (firstError) {
    if (!autoLaunch) {
      throw firstError;
    }
    await launchResolve(options);
  }

  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const result = await pingResolve(options);
      log("Resolve scripting is ready.");
      return result;
    } catch (error) {
      lastError = error;
      await sleep(pollMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("DaVinci Resolve did not become ready before timeout.");
};

export const syncResolveAudioFolder = async (
  options: SyncResolveAudioFolderOptions,
): Promise<ResolveAudioSyncResult> => {
  await ensureResolveReady(options);
  return runResolveRuntime<ResolveAudioSyncResult>(
    "sync-audio-folder",
    {
      binName: options.binName ?? null,
      folderPath: path.resolve(options.folderPath),
      projectName: options.projectName ?? null,
      recursive: options.recursive ?? false,
    },
    options,
  );
};

export const renderResolveCurrent = async (
  options?: RenderResolveCurrentOptions,
): Promise<ResolveRenderCurrentResult> => {
  await ensureResolveReady(options);
  return runResolveRuntime<ResolveRenderCurrentResult>(
    "render-current",
    {
      customName: options?.customName ?? null,
      outputDir: options?.outputDir ? path.resolve(options.outputDir) : null,
      presetName: options?.presetName ?? null,
      projectName: options?.projectName ?? null,
      start: options?.start ?? true,
      timelineName: options?.timelineName ?? null,
      wait: options?.wait ?? false,
    },
    options,
  );
};
