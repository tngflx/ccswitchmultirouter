import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
      JSON.stringify({
        bundle: {
          createUpdaterArtifacts: false,
          windows: { wix: { enableElevatedUpdateTask: false } },
        },
      }),
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

export function localReleaseCargoTargetOwnerPid(name) {
  const runName =
    /^run-([1-9]\d*)-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
  const match = runName.exec(name);
  const pid = Number(match?.[1]);
  return Number.isInteger(pid) && pid <= 0x7fffffff ? pid : null;
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
    localReleaseCargoTargetOwnerPid(path.basename(target)) === null
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

/**
 * Resolve the Cargo target directory using the same rules as the legacy
 * release helpers. A relative override is rooted at the repository (the
 * parent of the Tauri directory); an empty override uses src-tauri/target.
 */
export function resolveCargoTargetDir(tauriDir, requestedTargetDir = "") {
  const tauri = path.resolve(tauriDir);
  if (!String(requestedTargetDir).trim()) return path.resolve(tauri, "target");
  if (path.isAbsolute(requestedTargetDir))
    return path.resolve(requestedTargetDir);
  return path.resolve(path.dirname(tauri), requestedTargetDir);
}

/**
 * Run a release action with a repository-owned isolated Cargo target. The
 * caller's CARGO_TARGET_DIR is restored even when the action throws, and a
 * failed cleanup is reported without hiding the original build/export error.
 */
export function withLocalReleaseCargoTarget(
  repoRoot,
  enabled,
  action,
  {
    environment = process.env,
    warn = console.warn,
    cleanup = cleanupLocalReleaseCargoTarget,
  } = {},
) {
  if (!enabled) return action(null);

  const hadPreviousTarget = Object.prototype.hasOwnProperty.call(
    environment,
    "CARGO_TARGET_DIR",
  );
  const previousTarget = environment.CARGO_TARGET_DIR;
  const target = createLocalReleaseCargoTarget(repoRoot);
  try {
    environment.CARGO_TARGET_DIR = target;
    return action(target);
  } finally {
    if (hadPreviousTarget) environment.CARGO_TARGET_DIR = previousTarget;
    else delete environment.CARGO_TARGET_DIR;
    try {
      cleanup(repoRoot, target, { environment });
    } catch (error) {
      warn(
        `local release Cargo target cleanup failed for '${target}': ${error.message}`,
      );
    }
  }
}

export function releaseFileSha256(filePath) {
  return createHash("sha256")
    .update(readFileSync(filePath))
    .digest("hex")
    .toUpperCase();
}

export function tauriNsisInstalledExeSha256(filePath) {
  const bytes = readFileSync(filePath);
  const unknownMarker = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK", "ascii");
  const nsisMarker = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS", "ascii");
  const markerOffset = bytes.indexOf(unknownMarker);
  if (
    markerOffset < 0 ||
    bytes.indexOf(unknownMarker, markerOffset + unknownMarker.length) >= 0
  ) {
    throw new Error(
      "raw Tauri executable must contain exactly one restored UNK bundle marker",
    );
  }
  const projected = Buffer.from(bytes);
  nsisMarker.copy(projected, markerOffset);
  return createHash("sha256").update(projected).digest("hex").toUpperCase();
}

function gitText(repoRoot, args, run = runBuildCommand) {
  const result = run("git", ["-C", repoRoot, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
  if (result?.error)
    throw new Error(`git ${args.join(" ")} could not start`, {
      cause: result.error,
    });
  if (result?.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with exit code ${result?.status ?? "unknown"}`,
    );
  }
  return String(result.stdout ?? "").trim();
}

export function resolveReleaseRoot(
  repoRoot,
  requestedRoot = "",
  {
    gitCommonDir,
    run = runBuildCommand,
    environment = process.env,
    cargoTargetDir,
  } = {},
) {
  if (String(requestedRoot).trim())
    return assertReleaseOutputRoot(
      repoRoot,
      path.resolve(repoRoot, requestedRoot),
      { environment, cargoTargetDir },
    );
  let commonDir = gitCommonDir;
  if (commonDir === undefined) {
    try {
      commonDir = gitText(
        repoRoot,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        run,
      );
    } catch {
      commonDir = "";
    }
  }
  if (!String(commonDir).trim())
    throw new Error(
      "cannot resolve the CCSwitchMulti main repository from Git common-dir metadata",
    );

  const resolvedCommonDir = path.resolve(
    path.isAbsolute(commonDir) ? commonDir : path.join(repoRoot, commonDir),
  );
  if (path.basename(resolvedCommonDir).toLowerCase() !== ".git")
    throw new Error(
      "cannot resolve the CCSwitchMulti main repository: Git common-dir is not a .git directory",
    );
  const mainRepositoryRoot = path.dirname(resolvedCommonDir);
  const workspaceRoot = path.dirname(mainRepositoryRoot);
  if (!workspaceRoot)
    throw new Error(
      "cannot resolve the CCSwitchMulti workspace root from Git common-dir metadata",
    );
  return assertReleaseOutputRoot(
    repoRoot,
    path.join(workspaceRoot, "最新版ccswitchmulti"),
    { environment, cargoTargetDir },
  );
}

export function getReleaseSourceIdentity(
  repoRoot,
  { run = runBuildCommand } = {},
) {
  const commit = gitText(repoRoot, ["rev-parse", "HEAD"], run);
  const branch = gitText(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], run);
  const status = gitText(
    repoRoot,
    ["status", "--porcelain=v1", "--untracked-files=no"],
    run,
  );
  const packagePath = path.join(repoRoot, "package.json");
  if (!existsSync(packagePath))
    throw new Error(
      `package.json is missing while resolving release source identity: ${packagePath}`,
    );
  const version = JSON.parse(readFileSync(packagePath, "utf8")).version;
  if (!String(version ?? "").trim())
    throw new Error(
      "package.json version is empty while resolving release source identity",
    );
  return {
    commit,
    branch,
    version: String(version),
    trackedWorktree: status ? "dirty" : "clean",
  };
}

export function assertReleaseSourceIdentity(expected, actual) {
  const fields = ["commit", "branch", "version", "trackedWorktree"];
  const differences = fields.filter(
    (field) =>
      String(expected?.[field] ?? "") !== String(actual?.[field] ?? ""),
  );
  if (differences.length) {
    const details = differences
      .map((field) => `${field}='${expected?.[field]}' -> '${actual?.[field]}'`)
      .join("; ");
    throw new Error(`release source identity changed: ${details}`);
  }
}

export const RELEASE_OUTPUT_OWNER_FILE = ".ccswitchmulti-release-owner.json";
const RELEASE_OUTPUT_OWNER = "ccswitchmulti.release-output";
const RELEASE_REPOSITORY = "tngflx/ccswitchmultirouter";
const MAX_OWNERSHIP_BYTES = 2 * 1024 * 1024;
const MAX_OWNERSHIP_FILES = 50_000;

function containsPath(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep))
  );
}

function pathsOverlap(left, right) {
  return containsPath(left, right) || containsPath(right, left);
}

function assertReleaseOutputLocation(
  repoRoot,
  releaseRoot,
  { environment = process.env, cargoTargetDir } = {},
) {
  if (
    typeof repoRoot !== "string" ||
    !repoRoot.trim() ||
    /[\0\r\n]/u.test(repoRoot)
  )
    throw new Error("release output validation requires a repository path");
  if (
    typeof releaseRoot !== "string" ||
    !releaseRoot.trim() ||
    /[\0\r\n]/u.test(releaseRoot)
  )
    throw new Error("release output requires a valid path");
  const repo = path.resolve(repoRoot);
  const output = path.resolve(repo, releaseRoot);
  if (samePath(output, path.parse(output).root))
    throw new Error("release output must not be a filesystem root");
  const allowedOutputs = path.join(repo, "output");
  if (
    containsPath(output, repo) ||
    (containsPath(repo, output) &&
      (!containsPath(allowedOutputs, output) ||
        samePath(allowedOutputs, output)))
  )
    throw new Error(
      "release output must not overlap repository source; inside a repository use a child of its output directory",
    );

  const requestedTarget = cargoTargetDir ?? environment?.CARGO_TARGET_DIR ?? "";
  if (typeof requestedTarget !== "string" || /[\0\r\n]/u.test(requestedTarget))
    throw new Error("release output has an invalid Cargo target context");
  const tauri = path.join(repo, "src-tauri");
  const targets = [
    path.join(tauri, "target"),
    localReleaseCargoTargetRoot(repo),
    resolveCargoTargetDir(tauri, requestedTarget),
  ];
  if (targets.some((target) => pathsOverlap(output, target)))
    throw new Error(
      "release output must not overlap a source or active Cargo target directory",
    );
  assertUnlinkedDirectories(repo);
  assertUnlinkedDirectories(output);
  return output;
}

function normalizedArtifactPath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    /[\0\r\n:]/u.test(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.isAbsolute(value)
  )
    throw new Error("invalid release ownership inventory path");
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("invalid release ownership inventory path");
  return normalized;
}

function releaseOutputInventory(root, { includeOwner = false } = {}) {
  const artifacts = [];
  const directories = [];
  const visit = (current, relative = "") => {
    const item = lstatSync(current);
    if (item.isSymbolicLink())
      throw new Error(
        "release output inventory must not contain a symbolic link or reparse point",
      );
    if (item.isDirectory()) {
      if (relative) directories.push(normalizedArtifactPath(relative));
      for (const name of readdirSync(current).sort()) {
        if (!relative && !includeOwner && name === RELEASE_OUTPUT_OWNER_FILE)
          continue;
        visit(
          path.join(current, name),
          relative ? relative + "/" + name : name,
        );
      }
      return;
    }
    if (!item.isFile())
      throw new Error(
        "release output inventory must contain only regular files and directories",
      );
    artifacts.push({
      path: normalizedArtifactPath(relative),
      sha256: releaseFileSha256(current),
    });
    if (artifacts.length + directories.length > MAX_OWNERSHIP_FILES)
      throw new Error("release ownership inventory is too large");
  };
  visit(root);
  return {
    artifacts: artifacts.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
    directories: directories.sort(),
  };
}

function readBoundedOwnershipFile(filename) {
  const item = lstatSync(filename);
  if (item.isSymbolicLink() || !item.isFile())
    throw new Error(
      "release ownership marker must be a regular file, not a link",
    );
  if (item.size > MAX_OWNERSHIP_BYTES)
    throw new Error("release ownership marker is too large");
  return readFileSync(filename, "utf8");
}

function assertInventoryEqual(expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error(
      "release ownership inventory changed or contains unrelated files",
    );
}

function assertCanonicalOwnership(root, inventory) {
  let marker;
  let markerSource;
  try {
    markerSource = readBoundedOwnershipFile(
      path.join(root, RELEASE_OUTPUT_OWNER_FILE),
    );
    marker = JSON.parse(markerSource.replace(/^\uFEFF/u, ""));
  } catch {
    throw new Error("canonical release ownership marker is invalid");
  }
  if (
    !marker ||
    Array.isArray(marker) ||
    typeof marker !== "object" ||
    marker.schemaVersion !== 1 ||
    marker.owner !== RELEASE_OUTPUT_OWNER ||
    marker.repository !== RELEASE_REPOSITORY ||
    !["release", "local-build"].includes(marker.layout) ||
    !Array.isArray(marker.artifacts) ||
    !Array.isArray(marker.directories) ||
    !marker.artifacts.length ||
    marker.artifacts.length + marker.directories.length > MAX_OWNERSHIP_FILES
  )
    throw new Error("canonical release ownership marker is invalid");
  let expected;
  try {
    expected = {
      artifacts: marker.artifacts.map((entry) => {
        if (
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          !/^[0-9A-F]{64}$/u.test(entry.sha256)
        )
          throw new Error("invalid ownership hash");
        const relative = normalizedArtifactPath(entry.path);
        if (relative === RELEASE_OUTPUT_OWNER_FILE)
          throw new Error("self-referencing ownership marker");
        return { path: relative, sha256: entry.sha256 };
      }),
      directories: marker.directories.map(normalizedArtifactPath),
    };
  } catch {
    throw new Error("canonical release ownership inventory is invalid");
  }
  assertInventoryEqual(expected, inventory);
  return {
    layout: marker.layout,
    markerSha256: createHash("sha256")
      .update(markerSource, "utf8")
      .digest("hex")
      .toUpperCase(),
  };
}

function assertLegacyReleaseOwnership(root, inventory) {
  const allowedRoots = new Set(["windows", "tools", "linux", "macos"]);
  const allowedFiles = new Set([
    "README.md",
    "RELEASE-METADATA.md",
    "SHA256SUMS.txt",
    "latest.json",
    "linux-build-note.md",
    "macos-build-note.md",
  ]);
  if (
    inventory.directories.some(
      (directory) => !allowedRoots.has(directory.split("/")[0]),
    ) ||
    inventory.artifacts.some(
      (entry) => !entry.path.includes("/") && !allowedFiles.has(entry.path),
    )
  )
    throw new Error(
      "release output is not owned: unrelated legacy output files",
    );
  const manifestPath = path.join(root, "SHA256SUMS.txt");
  if (!existsSync(manifestPath))
    throw new Error(
      "nonempty release output has no verified ownership; preserve it and choose a new or empty output directory",
    );
  const source = readBoundedOwnershipFile(manifestPath).replace(/^\uFEFF/u, "");
  const entries = [];
  const seen = new Set();
  for (const line of source.split(/\r?\n/u).filter((value) => value.trim())) {
    const match = /^([0-9A-Fa-f]{64})[ \t]{2}(.+)$/u.exec(line);
    if (!match) throw new Error("legacy release checksum inventory is invalid");
    const relative = normalizedArtifactPath(match[2]);
    const key =
      process.platform === "win32" ? relative.toLowerCase() : relative;
    if (
      relative === "SHA256SUMS.txt" ||
      relative === RELEASE_OUTPUT_OWNER_FILE ||
      seen.has(key)
    )
      throw new Error("legacy release checksum inventory is invalid");
    seen.add(key);
    entries.push({ path: relative, sha256: match[1].toUpperCase() });
  }
  entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  assertInventoryEqual(
    { artifacts: entries, directories: inventory.directories },
    {
      artifacts: inventory.artifacts.filter(
        (entry) => entry.path !== "SHA256SUMS.txt",
      ),
      directories: inventory.directories,
    },
  );

  // Hash manifests alone may describe arbitrary user data. A legacy output must
  // additionally link this application's versioned raw executable, stable alias,
  // installer and exact Tauri UNK-to-NSS installed-executable projection.
  const versioned = inventory.artifacts.filter((entry) =>
    /^windows\/raw-exe\/CCSwitchMulti_[0-9A-Za-z][0-9A-Za-z.+-]{0,95}_x64\.exe$/u.test(
      entry.path,
    ),
  );
  if (versioned.length !== 1)
    throw new Error(
      "legacy release application identity cannot be independently verified",
    );
  const version = /^windows\/raw-exe\/CCSwitchMulti_(.+)_x64\.exe$/u.exec(
    versioned[0].path,
  )[1];
  const byPath = new Map(
    inventory.artifacts.map((entry) => [entry.path, entry]),
  );
  const stable = byPath.get("windows/raw-exe/CCSwitchMulti.exe");
  const installer = byPath.get(
    "windows/installer/CCSwitchMulti_" + version + "_x64-setup.exe",
  );
  const projected = byPath.get(
    "windows/installer/CCSwitchMulti_" + version + "_x64-installed-exe.sha256",
  );
  if (
    !stable ||
    stable.sha256 !== versioned[0].sha256 ||
    !installer ||
    !projected
  )
    throw new Error(
      "legacy release application identity cannot be independently verified",
    );
  let expectedInstalled;
  try {
    expectedInstalled = tauriNsisInstalledExeSha256(
      path.join(root, ...stable.path.split("/")),
    );
  } catch {
    throw new Error(
      "legacy release executable identity cannot be independently verified",
    );
  }
  const recordedInstalled = readBoundedOwnershipFile(
    path.join(root, ...projected.path.split("/")),
  ).trim();
  if (recordedInstalled !== expectedInstalled)
    throw new Error(
      "legacy release installed executable identity does not match its raw application",
    );
  return "release";
}

function ownershipMarkerPresent(root) {
  try {
    lstatSync(path.join(root, RELEASE_OUTPUT_OWNER_FILE));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function inspectReleaseOutput(root) {
  if (!existsSync(root)) return { exists: false, inventory: null };
  const inventory = releaseOutputInventory(root);
  // Presence is authoritative even when malformed; never fall back to a stale
  // legacy checksum manifest to authorize deletion.
  if (ownershipMarkerPresent(root)) {
    const { layout, markerSha256 } = assertCanonicalOwnership(root, inventory);
    const snapshot = {
      ...inventory,
      artifacts: [
        ...inventory.artifacts,
        { path: RELEASE_OUTPUT_OWNER_FILE, sha256: markerSha256 },
      ].sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      ),
    };
    return { exists: true, inventory, snapshot, layout };
  }
  if (!inventory.artifacts.length && !inventory.directories.length)
    return { exists: true, inventory, snapshot: inventory, layout: null };
  const layout = assertLegacyReleaseOwnership(root, inventory);
  return { exists: true, inventory, snapshot: inventory, layout };
}

export function assertReleaseOutputRoot(repoRoot, releaseRoot, options = {}) {
  const output = assertReleaseOutputLocation(repoRoot, releaseRoot, options);
  inspectReleaseOutput(output);
  return output;
}

/** Explicitly stamp a newly generated, validated staging tree, never a fallback
 * used to adopt an arbitrary existing destination. Callers own creation of the
 * stage and must call the normal output guard before any build/export work. */
export function stampReleaseOutputOwner(
  stageRoot,
  { repoRoot, layout, ...options } = {},
) {
  const stage = assertReleaseOutputLocation(repoRoot, stageRoot, options);
  const inventory = releaseOutputInventory(stage);
  if (!inventory.artifacts.length)
    throw new Error(
      "cannot record release ownership for an empty staging tree",
    );
  const markerPath = path.join(stage, RELEASE_OUTPUT_OWNER_FILE);
  if (ownershipMarkerPresent(stage)) {
    assertCanonicalOwnership(stage, inventory);
    return markerPath;
  }
  const resolvedLayout =
    layout ??
    (existsSync(path.join(stage, "LOCAL-BUILD.json"))
      ? "local-build"
      : "release");
  if (!["release", "local-build"].includes(resolvedLayout))
    throw new Error("unknown release ownership layout");
  const marker = {
    schemaVersion: 1,
    owner: RELEASE_OUTPUT_OWNER,
    repository: RELEASE_REPOSITORY,
    layout: resolvedLayout,
    ...inventory,
  };
  const serialized = JSON.stringify(marker, null, 2) + "\n";
  if (Buffer.byteLength(serialized) > MAX_OWNERSHIP_BYTES)
    throw new Error("release ownership inventory is too large");
  writeFileSync(markerPath, serialized, { encoding: "utf8", flag: "wx" });
  return markerPath;
}

export function createReleaseStage(releaseRoot) {
  const parent = path.dirname(path.resolve(releaseRoot));
  assertUnlinkedDirectories(parent);
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(
    path.join(parent, `.ccswitchmulti-release-staging-${process.pid}-`),
  );
}

export function assertReleaseStagePair(
  stageRoot,
  releaseRoot,
  { repoRoot, ...options } = {},
) {
  assertReleaseOutputLocation(repoRoot, releaseRoot, options);
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
  { rename = renameSync, warn = console.warn, repoRoot, ...options } = {},
) {
  const stage = path.resolve(stageRoot);
  const release = path.resolve(releaseRoot);
  assertReleaseStagePair(stage, release, { repoRoot, ...options });
  const previous = inspectReleaseOutput(release);
  if (!existsSync(stage)) throw new Error("release staging root is missing");
  stampReleaseOutputOwner(stage, { repoRoot, ...options });
  const backup = `${release}.previous-${process.pid}-${randomUUID()}`;
  let movedPrevious = false;
  try {
    if (existsSync(release)) {
      rename(release, backup);
      movedPrevious = true;
    }
    // The previous-output rename is another observable boundary: recheck the
    // staged inventory so a late file/link cannot be promoted or cost us the
    // intact previous output. A failure below enters the same rollback path.
    assertCanonicalOwnership(stage, releaseOutputInventory(stage));
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
      assertUnlinkedDirectories(backup);
      assertInventoryEqual(
        previous.snapshot,
        releaseOutputInventory(backup, { includeOwner: true }),
      );
      rmSync(backup, { recursive: true, force: true });
    } catch {
      warn(
        `release backup was preserved because its ownership changed or cleanup failed: ${backup}. The new release root is active.`,
      );
    }
  }
}
