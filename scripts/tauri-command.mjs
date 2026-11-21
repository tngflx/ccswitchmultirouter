import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createBuildApprovalScope,
  removeBuildApprovalFlag,
  requireBuildApproval,
} from "./build-approval.mjs";

const SCRIPT_REPO = fileURLToPath(new URL("../", import.meta.url));
const TAURI_CLI = path.join(
  SCRIPT_REPO,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);

export function isTauriCompile(args = []) {
  return args.includes("build") || args.includes("dev");
}

export function prepareTauriCommand(args, environment = process.env) {
  if (!isTauriCompile(args)) {
    return { args, environment };
  }
  requireBuildApproval({
    args,
    environment,
    operation: args.includes("build")
      ? "the Tauri build"
      : "the Tauri development compile",
  });
  const approval = createBuildApprovalScope(environment);
  return {
    args: removeBuildApprovalFlag(args),
    environment: approval.environment,
    cleanup: approval.cleanup,
  };
}

export function main(
  args = process.argv.slice(2),
  { environment = process.env, run = spawnSync } = {},
) {
  const prepared = prepareTauriCommand(args, environment);
  try {
    const result = run(process.execPath, [TAURI_CLI, ...prepared.args], {
      cwd: SCRIPT_REPO,
      env: prepared.environment,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return result.status;
  } finally {
    prepared.cleanup?.();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
