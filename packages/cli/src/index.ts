#!/usr/bin/env node
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {renderProjectGpuDemo} from "@gpu-render/gpu-renderer";
import {createDryRunRenderPlan, loadProject, validateProjectFile} from "@gpu-render/shared";

type CommandArgs = {
  project?: string;
  out?: string;
  cpuTempLimit?: number;
  cooldownMs?: number;
  segmentSeconds?: number;
  renderFps?: number;
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

    if (token === "--out" && next) {
      args.out = next;
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
    default:
      printUsage();
      fail(`Unknown command: ${command}`);
  }
};

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
