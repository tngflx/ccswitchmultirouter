import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertLocalTauriCliVersion,
  assertReleaseOutputRoot,
  assertUnlinkedDirectories,
  createReleaseStage,
  createTauriBuildConfig,
  replaceReleaseRootFromStage,
  requireBuildCommandSuccess,
  resolveCargoTargetDir,
  resolveReleaseRoot,
  runBuildCommand,
} from "./release-build-config.mjs";
import { buildHistoryRepairSidecar } from "./local-build-pipeline.mjs";
import {
  exportReleaseArtifacts,
  parseLocalReleaseOptions,
  writeReleaseChecksums,
} from "./local-release-pipeline.mjs";
import {
  createBuildApprovalScope,
  requireBuildApproval,
} from "./build-approval.mjs";

const SCRIPT_REPO = fileURLToPath(new URL("../", import.meta.url));

export function parseExportOptions(args) {
  const local = parseLocalReleaseOptions(args);
  if (local.noTypecheck || local.reason !== "manual")
    throw new Error("--no-typecheck and --reason are not valid export options");
  return {
    releaseRoot: local.releaseRoot,
    skipBuild: local.skipBuild,
    confirmBuild: local.confirmBuild,
    help: local.help,
  };
}

function checkedRun(executable, args, { run, cwd, environment }) {
  return requireBuildCommandSuccess(
    run(executable, args, {
      cwd,
      env: environment,
      stdio: "inherit",
      windowsHide: true,
    }),
    `${executable} ${args.join(" ")}`,
  );
}

export function runExport(
  options,
  {
    repoRoot = SCRIPT_REPO,
    environment = process.env,
    run = runBuildCommand,
    warn = console.warn,
    log = console.log,
    resolveRoot = (root, requested) =>
      resolveReleaseRoot(root, requested, { run, environment }),
  } = {},
) {
  const repo = path.resolve(repoRoot);
  if (!options.skipBuild) {
    requireBuildApproval({
      args: [],
      environment,
      operation: "the release export build",
      allowEnvironmentApproval: true,
    });
  }
  const releaseRoot = assertReleaseOutputRoot(
    repo,
    path.resolve(resolveRoot(repo, options.releaseRoot)),
    { environment },
  );
  const packageJson = JSON.parse(
    readFileSync(path.join(repo, "package.json"), "utf8"),
  );
  const version = String(packageJson.version || "");
  if (!version)
    throw new Error("package.json version is empty while exporting release");
  if (options.skipBuild)
    checkedRun("pnpm", ["catalog:verify"], { run, cwd: repo, environment });
  const cargoTargetDir = resolveCargoTargetDir(
    path.join(repo, "src-tauri"),
    environment.CARGO_TARGET_DIR || "",
  );
  let config;
  const stage = createReleaseStage(releaseRoot);
  try {
    if (!options.skipBuild) {
      assertLocalTauriCliVersion(repo, { run, environment });
      config = createTauriBuildConfig();
      buildHistoryRepairSidecar(repo, cargoTargetDir, {
        run,
        environment,
      });
      checkedRun(
        "pnpm",
        [
          "tauri",
          "build",
          "--confirm-build",
          "--bundles",
          "nsis",
          "--config",
          config.path,
        ],
        { run, cwd: repo, environment },
      );
    }
    exportReleaseArtifacts(repo, cargoTargetDir, stage, version, {
      run,
      environment,
      warn,
      log,
    });
    writeReleaseChecksums(stage);
    replaceReleaseRootFromStage(stage, releaseRoot, {
      warn,
      repoRoot: repo,
      environment,
      cargoTargetDir,
    });
    log(`Exported CCSwitchMulti release artifacts to: ${releaseRoot}`);
    return releaseRoot;
  } finally {
    try {
      config?.remove();
    } catch {
      warn(
        "release build configuration cleanup failed; its temporary file may remain.",
      );
    }
    if (existsSync(stage)) {
      try {
        assertUnlinkedDirectories(stage);
        rmSync(stage, { recursive: true, force: true });
      } catch {
        warn(
          "release staging cleanup failed; its temporary output may remain.",
        );
      }
    }
  }
}

export function main(args = process.argv.slice(2), dependencies = {}) {
  const options = parseExportOptions(args);
  if (options.help) {
    console.log(
      "Usage: node scripts/export-latest-ccswitchmulti.mjs [--confirm-build] [--release-root PATH] [--skip-build]",
    );
    return;
  }
  if (!options.skipBuild) {
    requireBuildApproval({
      args,
      operation: "the release export build",
    });
    const approval = createBuildApprovalScope(dependencies.environment);
    try {
      return runExport(options, {
        ...dependencies,
        environment: approval.environment,
      });
    } finally {
      approval.cleanup();
    }
  }
  return runExport(options, dependencies);
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
