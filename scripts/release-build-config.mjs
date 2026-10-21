import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

function samePath(left, right) {
  const normalize = (value) => {
    const full = path.resolve(value);
    return process.platform === "win32" ? full.toLowerCase() : full;
  };
  return normalize(left) === normalize(right);
}

// A junction anywhere above a mutation target can redirect staging, promotion,
// or Cargo cleanup. lstat also recognizes Windows directory junctions.
export function assertUnlinkedDirectories(
  target,
  stopAt = path.parse(path.resolve(target)).root,
) {
  let current = path.resolve(target);
  const stop = path.resolve(stopAt);
  for (;;) {
    let item;
    try {
      item = lstatSync(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (item?.isSymbolicLink()) {
      throw new Error(
        `local build path must not contain a reparse point: ${current}`,
      );
    }
    if (item && !item.isDirectory()) {
      throw new Error(
        `local build path must contain only directories: ${current}`,
      );
    }
    if (samePath(current, stop)) return;
    const parent = path.dirname(current);
    if (samePath(parent, current)) return;
    current = parent;
  }
}

export function runBuildCommand(executable, args, options = {}) {
  return spawnSync(executable, args, { windowsHide: true, ...options });
}

export function requireBuildCommandSuccess(result, name) {
  if (result?.error) {
    throw new Error(`${name} could not start.`, { cause: result.error });
  }
  if (result?.status !== 0) {
    throw new Error(
      `${name} failed with exit code ${result?.status ?? "unknown"}`,
    );
  }
  return result;
}

export function createTauriBuildConfig() {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "ccswitch-local-build-"),
  );
  const configPath = path.join(directory, "tauri-config.json");
  try {
    writeFileSync(
      configPath,
      JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
      "utf8",
    );
    return {
      path: configPath,
      remove: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function assertLocalTauriCliVersion(
  repoRoot,
  { run = runBuildCommand, environment = process.env } = {},
) {
  const packagePath = path.join(repoRoot, "package.json");
  const installedRoot = path.join(
    repoRoot,
    "node_modules",
    "@tauri-apps",
    "cli",
  );
  const installedPackagePath = path.join(installedRoot, "package.json");
  if (!existsSync(packagePath))
    throw new Error(
      "package.json is missing while validating the local Tauri CLI",
    );
  if (!existsSync(installedPackagePath)) {
    throw new Error(
      "local Tauri CLI package is not installed; run pnpm install --frozen-lockfile",
    );
  }
  const expected = JSON.parse(readFileSync(packagePath, "utf8"))
    .devDependencies?.["@tauri-apps/cli"];
  const installed = JSON.parse(
    readFileSync(installedPackagePath, "utf8"),
  ).version;
  if (typeof expected !== "string" || !/^\d+\.\d+\.\d+$/.test(expected)) {
    throw new Error(
      "@tauri-apps/cli must be pinned to an exact version for local release builds",
    );
  }
  if (installed !== expected)
    throw new Error(
      "installed Tauri CLI package version mismatch; run pnpm install --frozen-lockfile",
    );
  const cliPath = path.join(installedRoot, "tauri.js");
  const result = requireBuildCommandSuccess(
    run(process.execPath, [cliPath, "--version"], {
      cwd: repoRoot,
      env: environment,
      encoding: "utf8",
      stdio: "pipe",
    }),
    "local Tauri CLI version command",
  );
  const reported = /^tauri-cli (\d+\.\d+\.\d+)\s*$/m.exec(
    String(result.stdout ?? ""),
  )?.[1];
  if (!reported)
    throw new Error("local Tauri CLI returned an unrecognized version");
  if (reported !== expected)
    throw new Error("local Tauri CLI binary version mismatch");
  return cliPath;
}

export function localReleaseCargoTargetRoot(repoRoot) {
  return path.resolve(repoRoot, ".tmp", "local-release-cargo");
}

export function createLocalReleaseCargoTarget(repoRoot) {
  const root = localReleaseCargoTargetRoot(repoRoot);
  assertUnlinkedDirectories(root);
  mkdirSync(root, { recursive: true });
  const target = path.join(root, `run-${process.pid}-${randomUUID()}`);
  mkdirSync(target);
  return target;
}

export function cleanupLocalReleaseCargoTarget(
  repoRoot,
  targetDir,
  { run = runBuildCommand, environment = process.env } = {},
) {
  const target = path.resolve(targetDir);
  const root = localReleaseCargoTargetRoot(repoRoot);
  if (
    !samePath(path.dirname(target), root) ||
    !/^run-\d+-[\da-f-]+$/i.test(path.basename(target))
  ) {
    throw new Error(
      "local release Cargo target is outside the repository-owned local release Cargo cache root",
    );
  }
  assertUnlinkedDirectories(target);
  if (!existsSync(target)) return;
  const manifest = path.join(path.resolve(repoRoot), "src-tauri", "Cargo.toml");
  if (!existsSync(manifest) || !lstatSync(manifest).isFile()) {
    throw new Error("Cargo manifest is missing for local release cleanup");
  }
  requireBuildCommandSuccess(
    run(
      "cargo",
      ["clean", "--manifest-path", manifest, "--target-dir", target],
      {
        cwd: repoRoot,
        env: { ...environment, CARGO_TARGET_DIR: target },
        stdio: "inherit",
      },
    ),
    "cargo clean",
  );
}

export function createReleaseStage(releaseRoot) {
  const parent = path.dirname(path.resolve(releaseRoot));
  assertUnlinkedDirectories(parent);
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(
    path.join(parent, `.ccswitchmulti-release-staging-${process.pid}-`),
  );
}

export function assertReleaseStagePair(stageRoot, releaseRoot) {
  if (!samePath(path.dirname(stageRoot), path.dirname(releaseRoot))) {
    throw new Error(
      "release staging path must be a sibling of the final release root",
    );
  }
  if (samePath(stageRoot, releaseRoot))
    throw new Error(
      "release staging path must differ from the final release root",
    );
  assertUnlinkedDirectories(stageRoot);
  assertUnlinkedDirectories(releaseRoot);
}

export function replaceReleaseRootFromStage(
  stageRoot,
  releaseRoot,
  { rename = renameSync, warn = console.warn } = {},
) {
  const stage = path.resolve(stageRoot);
  const release = path.resolve(releaseRoot);
  assertReleaseStagePair(stage, release);
  if (!existsSync(stage)) throw new Error("release staging root is missing");
  const backup = `${release}.previous-${process.pid}-${randomUUID()}`;
  let movedPrevious = false;
  try {
    if (existsSync(release)) {
      rename(release, backup);
      movedPrevious = true;
    }
    rename(stage, release);
  } catch (error) {
    if (movedPrevious && !existsSync(release) && existsSync(backup)) {
      try {
        rename(backup, release);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `release replacement and rollback failed; previous output remains at ${backup}`,
        );
      }
    }
    throw error;
  }
  if (movedPrevious) {
    try {
      rmSync(backup, { recursive: true, force: true });
    } catch {
      warn(
        `release backup could not be removed: ${backup}. The new release root is active.`,
      );
    }
  }
}
