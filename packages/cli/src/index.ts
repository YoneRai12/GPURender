#!/usr/bin/env node
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {renderProjectGpuDemo} from "@gpu-render/gpu-renderer";
import {
  ensureResolveReady,
  exportProjectForResolve,
  installResolveMenuLoader,
  loadResolveManifest,
  renderResolveCurrent,
  syncResolveAudioFolder,
} from "@gpu-render/resolve-exporter";
import {createDryRunRenderPlan, loadProject, validateProjectFile} from "@gpu-render/shared";

type CommandArgs = {
  bin?: string;
  customName?: string;
  folder?: string;
  manifest?: string;
  noStart?: boolean;
  outDir?: string;
  preset?: string;
  project?: string;
  projectName?: string;
  recursive?: boolean;
  out?: string;
  cpuTempLimit?: number;
  cooldownMs?: number;
  segmentSeconds?: number;
  renderFps?: number;
  timelineName?: string;
  wait?: boolean;
};

const parseArgs = (argv: string[]): {command?: string; args: CommandArgs} => {
  const [command, ...rest] = argv;
  const args: CommandArgs = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    const next = rest[index + 1];

    if (token === "--project" && next) {
      args.project = next;
      index += 1;
      continue;
    }

    if (token === "--manifest" && next) {
      args.manifest = next;
      index += 1;
      continue;
    }

    if (token === "--out" && next) {
      args.out = next;
      index += 1;
      continue;
    }

    if (token === "--out-dir" && next) {
      args.outDir = next;
      index += 1;
      continue;
    }

    if (token === "--folder" && next) {
      args.folder = next;
      index += 1;
      continue;
    }

    if (token === "--bin" && next) {
      args.bin = next;
      index += 1;
      continue;
    }

    if (token === "--project-name" && next) {
      args.projectName = next;
      index += 1;
      continue;
    }

    if (token === "--timeline-name" && next) {
      args.timelineName = next;
      index += 1;
      continue;
    }

    if (token === "--preset" && next) {
      args.preset = next;
      index += 1;
      continue;
    }

    if (token === "--custom-name" && next) {
      args.customName = next;
      index += 1;
      continue;
    }

    if (token === "--cpu-temp-limit" && next) {
      args.cpuTempLimit = Number.parseFloat(next);
      index += 1;
      continue;
    }

    if (token === "--cooldown-ms" && next) {
      args.cooldownMs = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (token === "--segment-seconds" && next) {
      args.segmentSeconds = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (token === "--render-fps" && next) {
      args.renderFps = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (token === "--wait") {
      args.wait = true;
      continue;
    }

    if (token === "--recursive") {
      args.recursive = true;
      continue;
    }

    if (token === "--no-start") {
      args.noStart = true;
    }
  }

  return {command, args};
};

const printUsage = () => {
  console.log("Usage:");
  console.log("  gpu-render validate --project ./examples/public-safe-sample/project.json");
  console.log(
    "  gpu-render render --project ./examples/public-safe-sample/project.json --out ./out/public-safe-sample-gpu.mp4 --render-fps 60 --cpu-temp-limit 85 --cooldown-ms 3000",
  );
  console.log(
    "  gpu-render resolve-export --project ./examples/public-safe-sample/project.json",
  );
  console.log(
    "  gpu-render resolve-load --manifest ./tmp/resolve-export/project/resolve-export.manifest.json",
  );
  console.log("  gpu-render resolve-open");
  console.log("  gpu-render resolve-sync-audio --folder ./voices --bin Voices");
  console.log(
    "  gpu-render resolve-render-current --preset YouTube --out-dir ./renders --custom-name take-01 --wait",
  );
};

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const requireProject = (project?: string): string => {
  if (typeof project !== "string" || project.length === 0) {
    fail("Missing required --project argument.");
  }
  return project as string;
};

const requireManifest = (manifest?: string): string => {
  if (typeof manifest !== "string" || manifest.length === 0) {
    fail("Missing required --manifest argument.");
  }
  return manifest as string;
};

const requireFolder = (folder?: string): string => {
  if (typeof folder !== "string" || folder.length === 0) {
    fail("Missing required --folder argument.");
  }
  return folder as string;
};

const handleValidate = (projectPath: string) => {
  const result = validateProjectFile(projectPath);

  if (!result.ok) {
    console.error(`Validation failed for ${result.projectPath}`);
    for (const issue of result.issues) {
      const location = issue.path ? ` (${issue.path})` : "";
      console.error(`- [${issue.severity}]${location} ${issue.message}`);
    }
    process.exit(1);
  }

  console.log(`Validation passed for ${result.projectPath}`);
  console.log(`Schema: ${result.schemaPath}`);
};

const handleRender = async (projectPath: string, args: CommandArgs) => {
  const result = validateProjectFile(projectPath);
  if (!result.ok) {
    handleValidate(projectPath);
  }

  const project = loadProject(projectPath);
  const outputPath = args.out
    ? path.resolve(args.out)
    : path.resolve(
        path.dirname(path.resolve(projectPath)),
        project.renderTargets.gpu.outputPath ?? "./out/render.mp4",
      );

  const dryRun = createDryRunRenderPlan(result, outputPath, args.renderFps);
  const planPath = `${outputPath}.plan.json`;

  await mkdir(path.dirname(planPath), {recursive: true});
  await writeFile(planPath, `${JSON.stringify(dryRun, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(dryRun, null, 2));
  console.log(`Dry-run plan written to ${planPath}`);

  const renderResult = await renderProjectGpuDemo(project, {
    projectPath,
    outputPath,
    cpuTempLimitC: args.cpuTempLimit ?? null,
    cooldownMs: args.cooldownMs,
    segmentSeconds: args.segmentSeconds,
    renderFps: args.renderFps,
    log: (message) => console.log(`[render] ${message}`),
  });

  const reportPath = `${outputPath}.report.json`;
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        outputPath: renderResult.outputPath,
        renderFps: args.renderFps ?? project.timeline.fps,
        tempSamples: renderResult.tempSamples,
        segmentCount: renderResult.segmentFiles.length,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(`GPU render complete: ${renderResult.outputPath}`);
  console.log(`Render report written to ${reportPath}`);
};

const handleResolveExport = async (projectPath: string) => {
  const result = validateProjectFile(projectPath);
  if (!result.ok) {
    handleValidate(projectPath);
  }

  const project = loadProject(projectPath);
  const exportResult = await exportProjectForResolve(projectPath, project, {
    log: (message: string) => console.log(`[resolve-export] ${message}`),
  });

  console.log(`Resolve export complete: ${exportResult.exportDir}`);
  console.log(`Manifest: ${exportResult.manifestPath}`);
  console.log(`Loader: ${exportResult.loaderScriptPath}`);
};

const handleResolveLoad = async (manifestPath: string) => {
  try {
    await loadResolveManifest(manifestPath, {
      log: (message: string) => console.log(`[resolve-load] ${message}`),
    });
    console.log(`Resolve load complete: ${path.resolve(manifestPath)}`);
    return;
  } catch (error) {
    const menuInstall = await installResolveMenuLoader(manifestPath);
    console.error(
      `External Resolve scripting was unavailable. Installed menu loader: ${menuInstall.loaderPath}`,
    );
    console.error(`Request file: ${menuInstall.requestPath}`);
    console.error(`Result file: ${menuInstall.resultPath}`);
    throw error;
  }
};

const handleResolveOpen = async () => {
  const result = await ensureResolveReady({
    autoLaunch: true,
    log: (message: string) => console.log(`[resolve-open] ${message}`),
    timeoutMs: 15000,
  });
  console.log(`Resolve is ready: ${result.productName ?? "DaVinci Resolve"}`);
};

const handleResolveSyncAudio = async (args: CommandArgs) => {
  const result = await syncResolveAudioFolder({
    binName: args.bin,
    folderPath: requireFolder(args.folder),
    log: (message: string) => console.log(`[resolve-sync-audio] ${message}`),
    projectName: args.projectName,
    recursive: args.recursive,
  });
  console.log(
    `Resolve audio sync complete: ${result.importedCount}/${result.discoveredCount} imported into ${result.binName}`,
  );
};

const handleResolveRenderCurrent = async (args: CommandArgs) => {
  const result = await renderResolveCurrent({
    customName: args.customName,
    log: (message: string) => console.log(`[resolve-render-current] ${message}`),
    outputDir: args.outDir,
    presetName: args.preset,
    projectName: args.projectName,
    start: !args.noStart,
    timelineName: args.timelineName,
    wait: args.wait,
  });
  console.log(`Resolve render job queued for ${result.timelineName}`);
};

const main = async () => {
  const {command, args} = parseArgs(process.argv.slice(2));

  if (!command) {
    printUsage();
    process.exit(1);
  }

  switch (command) {
    case "validate":
      handleValidate(requireProject(args.project));
      return;
    case "render":
      await handleRender(requireProject(args.project), args);
      return;
    case "resolve-export":
      await handleResolveExport(requireProject(args.project));
      return;
    case "resolve-load":
      await handleResolveLoad(requireManifest(args.manifest));
      return;
    case "resolve-open":
      await handleResolveOpen();
      return;
    case "resolve-sync-audio":
      await handleResolveSyncAudio(args);
      return;
    case "resolve-render-current":
      await handleResolveRenderCurrent(args);
      return;
    default:
      printUsage();
      fail(`Unknown command: ${command}`);
  }
};

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
