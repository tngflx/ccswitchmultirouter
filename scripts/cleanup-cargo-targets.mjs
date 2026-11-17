import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  parseWindowsJsonQueryOutput,
  runWindowsJsonQuery,
  windowsJsonQueryCommand,
} from "./windows-json-query.mjs";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_MINIMUM_AGE_HOURS = 6;

function assertUnlinkedAncestors(directory) {
  let current = path.resolve(directory);
  while (true) {
    let item;
    try {
      item = lstatSync(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (item && (item.isSymbolicLink() || !item.isDirectory()))
      throw new Error(
        "Cargo cleanup path must not traverse a link, junction, reparse point, or non-directory.",
      );
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(String(value));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}
function isDirectory(pathname) {
  try {
    return lstatSync(pathname).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
function isReparsePoint(pathname) {
  return lstatSync(pathname).isSymbolicLink();
}
function isSupportedTargetName(name) {
  return name === "target" || /^target-/i.test(name);
}
export function parseCleanupOptions(args, { environment = process.env } = {}) {
  const options = {
    repoRoot: "",
    minimumAgeHours: DEFAULT_MINIMUM_AGE_HOURS,
    dryRun: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["--dry-run", "-DryRun"].includes(argument)) {
      options.dryRun = true;
      continue;
    }
    if (["--repo-root", "-RepoRoot"].includes(argument)) {
      const value = args[++index];
      if (
        !value ||
        [
          "--dry-run",
          "-DryRun",
          "--repo-root",
          "-RepoRoot",
          "--minimum-age-hours",
          "-MinimumAgeHours",
        ].includes(value)
      ) {
        throw new Error(`Missing value after ${argument}.`);
      }
      options.repoRoot = value;
      continue;
    }
    if (["--minimum-age-hours", "-MinimumAgeHours"].includes(argument)) {
      const value = args[++index];
      if (
        !value ||
        [
          "--dry-run",
          "-DryRun",
          "--repo-root",
          "-RepoRoot",
          "--minimum-age-hours",
          "-MinimumAgeHours",
        ].includes(value)
      ) {
        throw new Error(`Missing value after ${argument}.`);
      }
      options.minimumAgeHours = Number(value);
      continue;
    }
    throw new Error(`Unknown cleanup option: ${argument}`);
  }
  if (
    !Number.isFinite(options.minimumAgeHours) ||
    options.minimumAgeHours < 0
  ) {
    throw new Error("MinimumAgeHours must be zero or greater");
  }
  if (options.repoRoot.trim() === "") {
    options.repoRoot = environment.CCSM_REPO_ROOT ?? "";
  }
  return options;
}
export function parseRegisteredWorktreeRoots(porcelainLines) {
  return porcelainLines
    .map((line) => String(line))
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((value) => value.trim() !== "")
    .map((value) => path.resolve(value));
}
export function listRegisteredWorktreeRoots(
  repoRoot,
  { run = spawnSync } = {},
) {
  const result = run(
    "git",
    ["-C", path.resolve(repoRoot), "worktree", "list", "--porcelain"],
    { encoding: "utf8", windowsHide: true },
  );
  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    throw new Error(
      `cannot enumerate registered Git worktrees from: ${path.resolve(repoRoot)}`,
    );
  }
  const roots = parseRegisteredWorktreeRoots(
    String(result?.stdout ?? "").split(/\r?\n/),
  );
  if (roots.length === 0) {
    throw new Error(
      `Git returned no registered worktrees from: ${path.resolve(repoRoot)}`,
    );
  }
  return roots;
}
function inspectDirectory(pathname, label) {
  let item;
  try {
    item = lstatSync(pathname);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} is missing: ${path.resolve(pathname)}`);
    }
    throw error;
  }
  if (!item.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path.resolve(pathname)}`);
  }
  if (item.isSymbolicLink()) {
    throw new Error(
      `${label} must not be a reparse point: ${path.resolve(pathname)}`,
    );
  }
  return item;
}
export function assertCargoTargetPath(worktreeRoot, targetDir) {
  const worktree = path.resolve(worktreeRoot);
  const target = path.resolve(targetDir);
  const targetParent = path.dirname(target);
  const targetName = path.basename(target);
  const srcTauri = path.join(worktree, "src-tauri");
  const targetNameSupported = isSupportedTargetName(targetName);
  const isSrcTauriTarget =
    targetNameSupported && samePath(targetParent, srcTauri);
  const isReleaseTarget =
    targetName === ".release-target" && samePath(targetParent, worktree);
  const sddRoot = path.join(worktree, ".superpowers", "sdd");
  const sddTaskRoot = targetParent;
  const isSddTarget =
    targetNameSupported && samePath(path.dirname(sddTaskRoot), sddRoot);
  if (!(isSrcTauriTarget || isReleaseTarget || isSddTarget)) {
    throw new Error(
      `Cargo cleanup target must be a direct child of the worktree src-tauri directory or a supported release/SDD Cargo target: ${target}`,
    );
  }
  if (!isReleaseTarget && !targetNameSupported) {
    throw new Error(
      `Cargo cleanup target name must be target or target-*: ${target}`,
    );
  }
  assertUnlinkedAncestors(target);
  inspectDirectory(target, "Cargo cleanup target directory");
  if (isSddTarget) {
    inspectDirectory(sddRoot, "Cargo cleanup SDD parent");
    inspectDirectory(sddTaskRoot, "Cargo cleanup SDD parent");
  }
  return target;
}
function directChildDirectories(root) {
  assertUnlinkedAncestors(root);
  if (!isDirectory(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
}
function candidateFromPath(worktreeRoot, targetPath, now, cutoff) {
  let item;
  try {
    item = lstatSync(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!item.isDirectory() || item.isSymbolicLink()) return null;
  const lastWriteTime = statSync(targetPath).mtime;
  if (lastWriteTime > cutoff) return null;
  return {
    fullName: path.resolve(targetPath),
    worktreeRoot: path.resolve(worktreeRoot),
    lastWriteTime,
  };
}
export function findStaleCargoTargetDirectories(
  worktreeRoots,
  minimumAgeHours = DEFAULT_MINIMUM_AGE_HOURS,
  now = new Date(),
) {
  if (!Number.isFinite(minimumAgeHours) || minimumAgeHours < 0) {
    throw new Error("MinimumAgeHours must be zero or greater");
  }
  const cutoff = new Date(now.getTime() - minimumAgeHours * 60 * 60 * 1000);
  const candidates = [];
  for (const root of worktreeRoots) {
    const worktree = path.resolve(root);
    assertUnlinkedAncestors(worktree);
    const srcTauri = path.join(worktree, "src-tauri");
    for (const target of directChildDirectories(srcTauri)) {
      if (!isSupportedTargetName(path.basename(target))) continue;
      const candidate = candidateFromPath(worktree, target, now, cutoff);
      if (candidate) candidates.push(candidate);
    }
    const releaseTarget = path.join(worktree, ".release-target");
    if (isDirectory(releaseTarget)) {
      const candidate = candidateFromPath(worktree, releaseTarget, now, cutoff);
      if (candidate) candidates.push(candidate);
    }
    const sddRoot = path.join(worktree, ".superpowers", "sdd");
    if (!isDirectory(sddRoot) || isReparsePoint(sddRoot)) continue;
    for (const taskRoot of directChildDirectories(sddRoot)) {
      if (isReparsePoint(taskRoot)) continue;
      for (const target of directChildDirectories(taskRoot)) {
        if (!isSupportedTargetName(path.basename(target))) continue;
        const candidate = candidateFromPath(worktree, target, now, cutoff);
        if (candidate) candidates.push(candidate);
      }
    }
  }
  return candidates.sort((left, right) =>
    left.fullName.localeCompare(right.fullName),
  );
}
export function hasActiveCargoBuild(buildProcesses = []) {
  return buildProcesses.some((candidate) =>
    /^(cargo|rustc)(\.exe)?$/i.test(
      String(candidate?.Name ?? candidate?.name ?? ""),
    ),
  );
}
export function windowsCargoBuildProcesses({ run = spawnSync } = {}) {
  const script = windowsJsonQueryCommand(
    [
      "Get-CimInstance Win32_Process -ErrorAction Stop",
      "Where-Object { $_.Name -match '^(cargo|rustc)(\\.exe)?$' }",
      "Select-Object Name,ProcessId,ExecutablePath,CommandLine",
      "ConvertTo-Json -Compress",
    ].join(" | "),
  );
  const text = runWindowsJsonQuery(script, "Cargo process", { run }).trim();
  if (!text) return [];
  const parsed = parseWindowsJsonQueryOutput(text, "Cargo process");
  return Array.isArray(parsed) ? parsed : [parsed];
}
function unixCargoBuildProcesses() {
  const result = spawnSync("ps", ["-eo", "comm=,args="], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr ?? "").trim() ||
        `ps exited with status ${result.status}.`,
    );
  }
  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name = "", ...command] = line.trim().split(/\s+/);
      return { Name: name, CommandLine: command.join(" ") };
    });
}
export function queryCargoBuildProcesses({ run = spawnSync } = {}) {
  return process.platform === "win32"
    ? windowsCargoBuildProcesses({ run })
    : unixCargoBuildProcesses();
}
export function removeCargoTargetDir(
  worktreeRoot,
  targetDir,
  { run = spawnSync } = {},
) {
  const target = assertCargoTargetPath(worktreeRoot, targetDir);
  const manifest = path.join(
    path.resolve(worktreeRoot),
    "src-tauri",
    "Cargo.toml",
  );
  let manifestItem;
  try {
    manifestItem = lstatSync(manifest);
  } catch (error) {
    if (error?.code === "ENOENT") manifestItem = null;
    else throw error;
  }
  if (!manifestItem?.isFile()) {
    throw new Error(
      `Cargo manifest is missing for cleanup target: ${manifest}`,
    );
  }
  const result = run(
    "cargo",
    ["clean", "--manifest-path", manifest, "--target-dir", target],
    { cwd: path.resolve(worktreeRoot), stdio: "inherit", windowsHide: true },
  );
  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    throw new Error(
      `cargo clean failed with exit code ${result?.status ?? "unknown"} for target: ${target}`,
    );
  }
}
export function cleanupCargoCache({
  worktreeRoots,
  minimumAgeHours = DEFAULT_MINIMUM_AGE_HOURS,
  buildProcesses = [],
  dryRun = false,
  now = new Date(),
  remove = removeCargoTargetDir,
  warn = console.warn,
  log = console.log,
}) {
  const candidates = findStaleCargoTargetDirectories(
    worktreeRoots,
    minimumAgeHours,
    now,
  );
  if (!dryRun && hasActiveCargoBuild(buildProcesses)) {
    return {
      skippedForActiveBuild: true,
      candidateCount: candidates.length,
      removedCount: 0,
      failedCount: 0,
      candidates,
    };
  }
  let removedCount = 0;
  let failedCount = 0;
  if (!dryRun) {
    for (const candidate of candidates) {
      try {
        remove(candidate.worktreeRoot, candidate.fullName);
        removedCount += 1;
      } catch (error) {
        failedCount += 1;
        warn(error?.message ?? String(error));
      }
    }
  }
  return {
    skippedForActiveBuild: false,
    candidateCount: candidates.length,
    removedCount,
    failedCount,
    candidates,
  };
}
export function main(
  args = process.argv.slice(2),
  {
    repoRoot = DEFAULT_REPO_ROOT,
    run = spawnSync,
    now = new Date(),
    queryProcesses = queryCargoBuildProcesses,
    log = console.log,
    warn = console.warn,
  } = {},
) {
  if (args.some((argument) => ["--help", "-h", "-?"].includes(argument))) {
    log(
      "Usage: node scripts/cleanup-cargo-targets.mjs [--repo-root PATH] [--minimum-age-hours HOURS] [--dry-run]",
    );
    return;
  }
  const options = parseCleanupOptions(args);
  const resolvedRepoRoot = path.resolve(options.repoRoot || repoRoot);
  const worktreeRoots = listRegisteredWorktreeRoots(resolvedRepoRoot, { run });
  const buildProcesses = options.dryRun ? [] : queryProcesses({ run });
  const result = cleanupCargoCache({
    worktreeRoots,
    minimumAgeHours: options.minimumAgeHours,
    buildProcesses,
    dryRun: options.dryRun,
    now,
    remove: (worktree, target) =>
      removeCargoTargetDir(worktree, target, { run }),
    warn,
    log,
  });
  for (const candidate of result.candidates) {
    const mode = options.dryRun
      ? "DRY-RUN"
      : result.skippedForActiveBuild
        ? "SKIPPED"
        : "SELECTED";
    log(`${mode} ${candidate.fullName}`);
  }
  if (result.skippedForActiveBuild) {
    warn(
      "Cargo/rustc is active; the entire destructive cleanup pass was skipped.",
    );
  }
  log(
    `Cargo cache cleanup summary: worktrees=${worktreeRoots.length} candidates=${result.candidateCount} removed=${result.removedCount} failed=${result.failedCount} dryRun=${options.dryRun} skippedForActiveBuild=${result.skippedForActiveBuild}`,
  );
  if (result.failedCount > 0) {
    throw new Error(
      "one or more Cargo target directories could not be cleaned",
    );
  }
  return result;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
