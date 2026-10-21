import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createDevReconnectTracker,
  createDevWatchdogOutputReader,
  DEV_RECOVERY_POLICY,
  devRestartDecision,
  readDevWatchdogOverride,
  readWatchdogEnabledSetting,
  recentDevRestartTimesMs,
} from "./dev-watchdog-policy.mjs";
import {
  windowsJsonQueryCommand,
  parseWindowsJsonQueryOutput,
  runWindowsJsonQuery,
} from "./windows-json-query.mjs";
export {
  windowsJsonQueryCommand,
  parseWindowsJsonQueryOutput,
  runWindowsJsonQuery,
} from "./windows-json-query.mjs";

// A four-hour quiet period keeps the running Tauri binary stable during normal
// development while still rebuilding automatically after sustained backend
// editing. Use --delay 0 when an immediate backend rebuild is intentional.
const DEFAULT_DELAY_MS = 14_400_000;
const DEFAULT_FRONTEND_PORT = 3000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const TAURI_DIR = path.join(REPO_ROOT, "src-tauri");
const CARGO_TARGET_MAINTENANCE_SCRIPT = path.join(
  SCRIPT_DIR,
  "prune-cargo-target.mjs",
);
const WATCH_EVENT_BATCH_MS = 100;
const CHILD_EXIT_TIMEOUT_MS = 10_000;
const DEV_CHILD_STDIO_DRAIN_TIMEOUT_MS = 250;
const WINDOWS_PROCESS_EXIT_TIMEOUT_MS = 2_000;
const WINDOWS_LISTENER_RELEASE_TIMEOUT_MS = 60_000;
const DEV_AUTO_RESTART_DELAY_MS = 1_000;
const DEV_SUPERVISOR_PUBLICATION_TIMEOUT_MS = 30_000;
const DEV_SUPERVISOR_ENV = "CC_SWITCH_DEV_SUPERVISOR";
const DEV_WORKER_FLAG = "--ccsm-dev-worker";
const DEV_WATCHDOG_FLAG = "--ccsm-dev-watchdog";
const DEV_SESSION_ENV_KEYS = DEV_RECOVERY_POLICY.sessionEnvironmentKeys;
const BACKEND_WATCH_DIRECTORIES = [
  "src",
  "capabilities",
  "icons",
  "resources",
  "vendor/tao",
];
const BACKEND_ROOT_FILES = new Set([
  "Cargo.lock",
  "Cargo.toml",
  "build.rs",
  "tauri.conf.json",
  "tauri.windows.conf.json",
  "common-controls.manifest",
  "Info.plist",
]);
const BACKEND_REPO_ROOT_FILES = new Set([
  "rust-toolchain.toml",
  path.join("contracts", "openai-responses.v1.json"),
]);

export function normalizeCliArgs(args) {
  return args[0] === "--" ? args.slice(1) : args;
}

export function parseDelayMs(args, environment = process.env) {
  let unsupportedArgument;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--delay" || argument === "-d") {
      index += 1;
      continue;
    }
    if (argument === "--no-rebuild") {
      continue;
    }
    if (argument !== "--help" && argument !== "-h") {
      unsupportedArgument = argument;
      break;
    }
  }
  const delayArgumentIndexes = args.flatMap((argument, index) =>
    argument === "--delay" || argument === "-d" ? [index] : [],
  );
  if (delayArgumentIndexes.length > 1) {
    throw new Error("Rebuild delay may only be specified once.");
  }
  const delayArgumentIndex = delayArgumentIndexes[0] ?? -1;
  const rawDelay =
    delayArgumentIndex >= 0
      ? args[delayArgumentIndex + 1]
      : environment.TAURI_DEV_REBUILD_DELAY_MS;

  if (unsupportedArgument !== undefined) {
    throw new Error(`Unknown argument "${unsupportedArgument}".`);
  }

  if (
    delayArgumentIndex >= 0 &&
    (rawDelay === undefined ||
      ["--delay", "-d", "--help", "-h"].includes(rawDelay))
  ) {
    throw new Error("Missing milliseconds after --delay.");
  }

  if (rawDelay === undefined) {
    return DEFAULT_DELAY_MS;
  }

  if (String(rawDelay).trim() === "") {
    throw new Error("Invalid rebuild delay: the value cannot be empty.");
  }
  const delayMs = Number(rawDelay);
  if (
    !Number.isSafeInteger(delayMs) ||
    delayMs < 0 ||
    delayMs > 2_147_483_647
  ) {
    throw new Error(
      `Invalid rebuild delay "${rawDelay}". Use a whole number from 0 to 2147483647 milliseconds.`,
    );
  }

  return delayMs;
}

export function parseNoRebuild(args, environment = process.env) {
  const flagCount = args.filter(
    (argument) => argument === "--no-rebuild",
  ).length;
  if (flagCount > 1) {
    throw new Error("The --no-rebuild flag may only be specified once.");
  }
  if (flagCount > 0) {
    return true;
  }

  const rawValue = environment.TAURI_DEV_NO_REBUILD;
  if (rawValue === undefined) {
    return false;
  }
  const normalized = String(rawValue).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(
    `Invalid TAURI_DEV_NO_REBUILD value "${rawValue}". Use 1/true or 0/false.`,
  );
}

export function parsePort(environment = process.env) {
  const rawPort = environment.TAURI_DEV_PORT ?? DEFAULT_FRONTEND_PORT;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid development port "${rawPort}".`);
  }
  return port;
}

/**
 * Development uses the same persisted watchdog toggle as the packaged app.
 * A missing settings file is treated as enabled for backwards compatibility;
 * malformed JSON disables recovery so a broken preference cannot cause a
 * restart loop.
 */
export function resolveDevSettingsPath(environment = process.env) {
  const home =
    environment.CC_SWITCH_TEST_HOME ||
    (process.platform === "win32"
      ? environment.USERPROFILE
      : environment.HOME || environment.USERPROFILE);
  return home ? path.join(home, ".cc-switch", "settings.json") : null;
}

export function resolveDevRunMarkerPath(environment = process.env) {
  const settingsPath = resolveDevSettingsPath(environment);
  return settingsPath
    ? path.join(path.dirname(settingsPath), "logs", "app-run-marker.json")
    : null;
}

export function readDevRunMarkerPresent(
  environment = process.env,
  read = readFileSync,
  expected,
) {
  if (!expected) {
    return false;
  }
  const markerPath =
    expected.markerPath ?? resolveDevRunMarkerPath(environment);
  if (!markerPath) {
    return false;
  }
  try {
    const marker = JSON.parse(read(markerPath, "utf8"));
    return (
      marker.pid === expected.pid &&
      marker.processStartedAtTicks === expected.processStartedAtTicks &&
      path.resolve(marker.executablePath).toLowerCase() ===
        path.resolve(expected.executablePath).toLowerCase()
    );
  } catch {
    return false;
  }
}

export function readDevWatchdogEnabled(
  environment = process.env,
  read = readFileSync,
) {
  const override = readDevWatchdogOverride(environment);
  if (override !== undefined) return override;

  const settingsPath = resolveDevSettingsPath(environment);
  if (!settingsPath) {
    return true;
  }
  let content;
  try {
    content = read(settingsPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return true;
    }
    return false;
  }
  let settings;
  try {
    settings = JSON.parse(content);
  } catch {
    return false;
  }
  return readWatchdogEnabledSetting(settings);
}

export function devAutoRestartDecision({
  appStarted,
  appRunning = false,
  exitCode,
  signal,
  uncleanExit = false,
  runMarkerPresent = false,
  watchdogEnabled,
  nowMs = Date.now(),
  restartTimesMs = [],
}) {
  // The exact app marker distinguishes a crash from an intentional live quit.
  // Before startup, code zero still means the dev session failed to launch.
  return devRestartDecision({
    intentionalExitReason: ["SIGINT", "SIGTERM"].includes(signal)
      ? "signal"
      : undefined,
    cleanExit:
      (appRunning ||
        (exitCode === 0 && signal === null && appStarted !== false)) &&
      !uncleanExit &&
      !runMarkerPresent,
    watchdogEnabled,
    nowMs,
    restartTimesMs,
  });
}

export function readDevRunMarker(
  environment = process.env,
  read = readFileSync,
) {
  const settingsPath = resolveDevSettingsPath(environment);
  if (!settingsPath) return null;
  try {
    return JSON.parse(
      read(
        path.join(path.dirname(settingsPath), "logs", "app-run-marker.json"),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
}

export function isDevCrashMarker(
  marker,
  sessionStartedAt,
  repoRoot = REPO_ROOT,
) {
  const executable = marker?.executablePath ?? marker?.executable_path;
  const startedAt = Date.parse(marker?.startedAt ?? marker?.started_at ?? "");
  return (
    Number.isInteger(marker?.pid) &&
    marker.pid > 0 &&
    typeof executable === "string" &&
    isPathInside(path.join(repoRoot, "src-tauri", "target"), executable) &&
    path.basename(executable).toLowerCase() ===
      (process.platform === "win32" ? "cc-switch.exe" : "cc-switch") &&
    Number.isFinite(startedAt) &&
    startedAt >= sessionStartedAt
  );
}

/**
 * The process started by `pnpm dev` is the long-lived supervisor. The actual
 * Vite/Tauri session runs in a child so a crash can restart the complete dev
 * lifecycle (including the initial Cargo build), instead of only relaunching
 * the already-built cc-switch executable.
 */
export function devWorkerRestartDecision({
  exitCode,
  signal,
  expectedExit = false,
  watchdogEnabled,
  nowMs = Date.now(),
  restartTimesMs = [],
}) {
  return devRestartDecision({
    intentionalExitReason: expectedExit ? "expected-exit" : undefined,
    cleanExit: exitCode === 0 && signal === null,
    watchdogEnabled,
    nowMs,
    restartTimesMs,
  });
}

export function readDevRestartTimesMs(session, nowMs = Date.now()) {
  const history = Array.isArray(session?.restartTimesMs)
    ? session.restartTimesMs
    : session?.supervisorRestartTimesMs;
  return recentDevRestartTimesMs(history, nowMs);
}

export function createDevWorkerRecovery({
  isCurrent,
  readEnabled = readDevWatchdogEnabled,
  readMarkerPresent,
  isRecoveryNeeded = () => true,
  recover,
  schedule = setTimeout,
  cancelScheduled = clearTimeout,
}) {
  let timer;
  let queued = false;
  let generation = 0;
  return {
    request(reason) {
      if (queued || !isCurrent() || !readEnabled() || !readMarkerPresent()) {
        return false;
      }
      queued = true;
      const requestedGeneration = ++generation;
      timer = schedule(() => {
        if (requestedGeneration !== generation) return;
        timer = undefined;
        if (!isCurrent()) return;
        if (!readEnabled() || !readMarkerPresent()) {
          queued = false;
          return;
        }
        let recoveryNeeded = false;
        try {
          recoveryNeeded = isRecoveryNeeded(reason) === true;
        } catch {
          // An unavailable identity probe is not proof of a current crash.
        }
        // Identity probes can block while the app clears its quit marker.
        if (
          !recoveryNeeded ||
          !isCurrent() ||
          !readEnabled() ||
          !readMarkerPresent()
        ) {
          queued = false;
          return;
        }
        // Only the outer supervisor owns restarts and their shared budget.
        recover(reason);
      }, DEV_AUTO_RESTART_DELAY_MS);
      return true;
    },
    cancel() {
      generation += 1;
      if (timer !== undefined) cancelScheduled(timer);
      timer = undefined;
      queued = false;
    },
  };
}

export function assertNormalCargoTargetDirectory(
  actualTargetDirectory,
  environment = process.env,
  tauriDirectory = TAURI_DIR,
) {
  if (environment.CARGO_TARGET_DIR !== undefined) {
    throw new Error(
      "CARGO_TARGET_DIR is not supported for development. Use the repository's normal src-tauri/target directory.",
    );
  }
  const expected = path.resolve(tauriDirectory, "target");
  const actual = path.resolve(String(actualTargetDirectory ?? ""));
  const normalize = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  if (normalize(actual) !== normalize(expected)) {
    throw new Error(
      `Cargo target directory must be ${expected}, but Cargo resolved ${actual}. Remove custom target-dir configuration before starting development.`,
    );
  }
}

export function createQuietPeriodScheduler(delayMs, callback) {
  let timer;
  let generation = 0;

  return {
    schedule() {
      generation += 1;
      const scheduledGeneration = generation;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (scheduledGeneration !== generation) {
          return;
        }
        timer = undefined;
        callback();
      }, delayMs);
    },
    cancel() {
      generation += 1;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

export function createChangeEventBatcher(batchMs, callback) {
  const changedPaths = new Set();
  const scheduler = createQuietPeriodScheduler(batchMs, () => {
    const paths = [...changedPaths];
    changedPaths.clear();
    callback(paths);
  });

  return {
    add(changedPath) {
      changedPaths.add(changedPath);
      scheduler.schedule();
    },
    cancel() {
      changedPaths.clear();
      scheduler.cancel();
    },
  };
}

export function createExpectedExitRegistry() {
  const expectedChildren = new WeakSet();

  return {
    mark(child) {
      expectedChildren.add(child);
    },
    unmark(child) {
      expectedChildren.delete(child);
    },
    consume(child) {
      if (!expectedChildren.has(child)) {
        return false;
      }
      expectedChildren.delete(child);
      return true;
    },
  };
}

export function createBackendRebuildGate(delayMs, callback) {
  let phase = "building";
  let changedDuringBuild = false;
  let quietPeriodElapsedDuringBuild = false;
  const scheduler = createQuietPeriodScheduler(delayMs, () => {
    if (phase === "building") {
      quietPeriodElapsedDuringBuild = true;
      return;
    }
    callback();
  });

  const settleBuild = (nextPhase) => {
    if (phase === "cancelled") {
      return false;
    }
    phase = nextPhase;
    if (!changedDuringBuild) {
      return false;
    }
    changedDuringBuild = false;
    if (quietPeriodElapsedDuringBuild) {
      quietPeriodElapsedDuringBuild = false;
      callback();
    }
    return true;
  };

  return {
    markReady() {
      return settleBuild("ready");
    },
    markBuilding() {
      if (phase === "cancelled") {
        return false;
      }
      phase = "building";
      changedDuringBuild = false;
      quietPeriodElapsedDuringBuild = false;
      scheduler.cancel();
      return true;
    },
    markFailed() {
      return settleBuild("failed");
    },
    scheduleChange() {
      if (phase === "cancelled") {
        return "ignored";
      }
      if (phase === "building") {
        changedDuringBuild = true;
        quietPeriodElapsedDuringBuild = false;
        scheduler.schedule();
        return "deferred";
      }
      scheduler.schedule();
      return "scheduled";
    },
    clearChange() {
      if (phase === "cancelled") {
        return false;
      }
      changedDuringBuild = false;
      quietPeriodElapsedDuringBuild = false;
      scheduler.cancel();
      return true;
    },
    cancel() {
      phase = "cancelled";
      changedDuringBuild = false;
      quietPeriodElapsedDuringBuild = false;
      scheduler.cancel();
    },
  };
}

function backendPathKey(relativePath) {
  const normalized = path.normalize(relativePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function fingerprintBackendFile(filePath) {
  try {
    const metadata = statSync(filePath);
    if (!metadata.isFile()) {
      return null;
    }
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function snapshotBackendFileFingerprints() {
  const entries = [];
  const addFile = (relativePath, baseDirectory = TAURI_DIR) => {
    const absolutePath = path.join(baseDirectory, relativePath);
    const trackedPath = path.relative(TAURI_DIR, absolutePath);
    const fingerprint = fingerprintBackendFile(absolutePath);
    if (fingerprint !== null) {
      entries.push([trackedPath, fingerprint]);
    }
  };
  const addDirectory = (relativeDirectory) => {
    const pending = [relativeDirectory];
    while (pending.length > 0) {
      const currentDirectory = pending.pop();
      const absoluteDirectory = path.join(TAURI_DIR, currentDirectory);
      for (const entry of readdirSync(absoluteDirectory, {
        withFileTypes: true,
      })) {
        const relativePath = path.join(currentDirectory, entry.name);
        if (entry.isDirectory()) {
          pending.push(relativePath);
        } else if (entry.isFile()) {
          addFile(relativePath);
        }
      }
    }
  };

  for (const relativeDirectory of BACKEND_WATCH_DIRECTORIES) {
    const absoluteDirectory = path.join(TAURI_DIR, relativeDirectory);
    if (
      existsSync(absoluteDirectory) &&
      statSync(absoluteDirectory).isDirectory()
    ) {
      addDirectory(relativeDirectory);
    }
  }
  for (const relativePath of BACKEND_ROOT_FILES) {
    addFile(relativePath);
  }
  for (const relativePath of BACKEND_REPO_ROOT_FILES) {
    addFile(relativePath, REPO_ROOT);
  }
  return entries;
}

export function resolveTauriRootBackendInput(filename) {
  if (!filename) {
    return null;
  }
  const relativePath = filename.toString();
  return BACKEND_ROOT_FILES.has(relativePath) ? relativePath : null;
}

export function resolveRepoRootBackendInput(filename) {
  if (!filename) {
    return null;
  }
  const relativePath = filename.toString();
  return BACKEND_REPO_ROOT_FILES.has(relativePath)
    ? path.join("..", relativePath)
    : null;
}

export function createBackendContentTracker(
  initialEntries = [],
  readFingerprint = fingerprintBackendFile,
) {
  let baseline = new Map();
  const current = new Map();
  const dirty = new Map();

  const replaceCurrent = (entries) => {
    current.clear();
    for (const [relativePath, fingerprint] of entries) {
      current.set(backendPathKey(relativePath), fingerprint);
    }
  };

  replaceCurrent(initialEntries);
  baseline = new Map(current);

  return {
    beginBuild(entries) {
      replaceCurrent(entries);
      baseline = new Map(current);
      dirty.clear();
    },
    record(relativePath, absolutePath) {
      const key = backendPathKey(relativePath);
      const nextFingerprint = readFingerprint(absolutePath);
      const hadCurrent = current.has(key);
      const previousFingerprint = current.get(key);
      const hasCurrent = nextFingerprint !== null;
      if (
        hadCurrent === hasCurrent &&
        (!hasCurrent || previousFingerprint === nextFingerprint)
      ) {
        return false;
      }

      if (hasCurrent) {
        current.set(key, nextFingerprint);
      } else {
        current.delete(key);
      }

      const hadBaseline = baseline.has(key);
      const baselineFingerprint = baseline.get(key);
      if (
        hadBaseline === hasCurrent &&
        (!hasCurrent || baselineFingerprint === nextFingerprint)
      ) {
        dirty.delete(key);
      } else {
        dirty.set(key, relativePath);
      }
      return true;
    },
    dirtyPaths() {
      return [...dirty.values()];
    },
  };
}

export function isTauriAppStartedOutput(output) {
  const withoutAnsi = output.replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  return /Running\s+[`']?[^`'\r\n]*[\\/]cc-switch(?:\.exe)?(?:[`']|\s|$)/i.test(
    withoutAnsi,
  );
}

function startProcess(command, args, options = {}) {
  return spawn(command, args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "inherit",
    detached: process.platform !== "win32",
    ...options,
  });
}

export function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(
    path.resolve(parentPath),
    path.resolve(candidatePath),
  );
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function windowsDevDescendants(
  processes,
  rootPid,
  repoRoot = REPO_ROOT,
) {
  const tauriRoot = path.join(path.resolve(repoRoot), "src-tauri");
  const targetRoot = path.join(tauriRoot, "target");
  const byParent = new Map();
  for (const candidate of processes) {
    const parentPid = Number(candidate.ParentProcessId);
    const siblings = byParent.get(parentPid) ?? [];
    siblings.push(candidate);
    byParent.set(parentPid, siblings);
  }

  const classifyOwnedChild = (candidate, parentKind) => {
    const name = String(candidate.Name ?? "").toLowerCase();
    const executablePath = String(candidate.ExecutablePath ?? "");
    const commandLine = String(candidate.CommandLine ?? "");
    const normalizedCommand = commandLine.toLowerCase();

    if (parentKind === "tauri" && name === "cargo.exe") {
      return "cargo";
    }
    if (parentKind === "cargo") {
      if (name === "cargo.exe") return "cargo";
      if (name === "rustc.exe") return "compiler";
      if (
        name === "cc-switch.exe" &&
        executablePath &&
        isPathInside(targetRoot, executablePath)
      ) {
        return "app";
      }
      if (name === "cc-switch.exe") {
        return "unverified-app";
      }
    }
    if (
      parentKind === "tauri" &&
      name === "node.exe" &&
      normalizedCommand.includes("@tauri-apps/cli/tauri.js")
    ) {
      return "tauri";
    }
    return null;
  };

  const descendants = [];
  const pending = [{ pid: Number(rootPid), depth: 0, kind: "tauri" }];
  const visited = new Set([Number(rootPid)]);
  while (pending.length > 0) {
    const current = pending.shift();
    for (const candidate of byParent.get(current.pid) ?? []) {
      const pid = Number(candidate.ProcessId);
      if (!Number.isInteger(pid) || visited.has(pid)) {
        continue;
      }
      visited.add(pid);
      const kind = classifyOwnedChild(candidate, current.kind);
      if (!kind) {
        continue;
      }
      const entry = { ...candidate, depth: current.depth + 1, kind };
      descendants.push(entry);
      if (kind !== "app" && kind !== "unverified-app" && kind !== "compiler") {
        pending.push({ pid, depth: entry.depth, kind });
      }
    }
  }

  return descendants.sort((left, right) => right.depth - left.depth);
}

export function windowsFrontendDescendants(
  processes,
  rootPid,
  repoRoot = REPO_ROOT,
) {
  const nodeModulesRoot = path.join(path.resolve(repoRoot), "node_modules");
  const descendants = [];
  const pending = [{ pid: Number(rootPid), depth: 0 }];
  const visited = new Set([Number(rootPid)]);

  while (pending.length > 0) {
    const current = pending.shift();
    for (const candidate of processes.filter(
      (processInfo) =>
        Number(processInfo.ParentProcessId) === Number(current.pid),
    )) {
      const pid = Number(candidate.ProcessId);
      if (!Number.isInteger(pid) || visited.has(pid)) {
        continue;
      }
      visited.add(pid);
      const name = String(candidate.Name ?? "").toLowerCase();
      const executablePath = String(candidate.ExecutablePath ?? "");
      if (
        !["esbuild.exe", "node.exe"].includes(name) ||
        !executablePath ||
        !isPathInside(nodeModulesRoot, executablePath)
      ) {
        continue;
      }
      const entry = {
        ...candidate,
        depth: current.depth + 1,
        kind: "frontend-helper",
      };
      descendants.push(entry);
      pending.push({ pid, depth: entry.depth });
    }
  }

  return descendants.sort((left, right) => right.depth - left.depth);
}

export function windowsDevWorkerDescendants(
  processes,
  rootPid,
  repoRoot = REPO_ROOT,
) {
  const children = processes.filter(
    (candidate) => Number(candidate.ParentProcessId) === Number(rootPid),
  );
  const descendants = [];
  for (const child of children) {
    if (String(child.Name).toLowerCase() !== "node.exe") continue;
    const command = String(child.CommandLine ?? "")
      .replaceAll("\\", "/")
      .toLowerCase();
    // The runner launches scripts relative to cwd. Match the exact script
    // suffix, while descendants remain bound to this worker's PID.
    if (command.includes("node_modules/@tauri-apps/cli/tauri.js")) {
      descendants.push(
        ...windowsDevDescendants(processes, child.ProcessId, repoRoot).map(
          (entry) => ({ ...entry, depth: entry.depth + 1 }),
        ),
        { ...child, kind: "tauri", depth: 1 },
      );
    } else if (command.includes("node_modules/vite/bin/vite.js")) {
      descendants.push(
        ...windowsFrontendDescendants(processes, child.ProcessId, repoRoot).map(
          (entry) => ({ ...entry, depth: entry.depth + 1 }),
        ),
        { ...child, kind: "frontend", depth: 1 },
      );
    }
  }
  return descendants.sort((left, right) => right.depth - left.depth);
}

function queryWindowsProcesses(processId) {
  if (processId !== undefined && !Number.isInteger(processId)) {
    throw new Error("A process query requires an integer PID.");
  }
  const script = windowsJsonQueryCommand(
    [
      `Get-CimInstance Win32_Process${processId === undefined ? "" : ` -Filter 'ProcessId = ${processId}'`} -ErrorAction Stop |`,
      "Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate |",
      "ConvertTo-Json -Compress",
    ].join(" "),
  );
  const stdout = runWindowsJsonQuery(script, "process");
  if (!stdout.trim()) {
    return [];
  }
  const parsed = parseWindowsJsonQueryOutput(stdout, "process");
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
}

export function parseWindowsListeners(stdout) {
  if (!String(stdout ?? "").trim()) {
    return [];
  }
  const parsed = parseWindowsJsonQueryOutput(stdout, "listener");
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter(Boolean)
    .map((listener) => ({
      address: String(listener.LocalAddress),
      port: Number(listener.LocalPort),
    }))
    .filter(
      (listener) =>
        listener.address &&
        Number.isInteger(listener.port) &&
        listener.port >= 1 &&
        listener.port <= 65_535,
    );
}

function queryWindowsListeners(processInfo) {
  const processId = Number(processInfo.ProcessId);
  const script = windowsJsonQueryCommand(
    [
      `Get-NetTCPConnection -State Listen -OwningProcess ${processId} -ErrorAction SilentlyContinue |`,
      "Select-Object LocalAddress,LocalPort |",
      "Sort-Object LocalAddress,LocalPort -Unique |",
      "ConvertTo-Json -Compress",
    ].join(" "),
  );
  return parseWindowsListeners(runWindowsJsonQuery(script, "listener"));
}

export function sameWindowsProcess(left, right) {
  const leftExecutable = String(left?.ExecutablePath ?? "");
  const rightExecutable = String(right?.ExecutablePath ?? "");
  const leftCreationDate = String(left?.CreationDate ?? "");
  const rightCreationDate = String(right?.CreationDate ?? "");
  if (
    !leftExecutable ||
    !rightExecutable ||
    !leftCreationDate ||
    !rightCreationDate
  ) {
    return false;
  }
  let leftStartedAtUtc;
  let rightStartedAtUtc;
  try {
    leftStartedAtUtc = windowsProcessStartedAtUtc(left);
    rightStartedAtUtc = windowsProcessStartedAtUtc(right);
  } catch {
    return false;
  }
  return (
    Number(left?.ProcessId) === Number(right?.ProcessId) &&
    String(left?.Name ?? "").toLowerCase() ===
      String(right?.Name ?? "").toLowerCase() &&
    path.resolve(leftExecutable).toLowerCase() ===
      path.resolve(rightExecutable).toLowerCase() &&
    leftStartedAtUtc === rightStartedAtUtc
  );
}

export function windowsProcessObservationCrashed(observed, current) {
  const completeIdentity = (identity) =>
    Number.isInteger(identity?.ProcessId) &&
    identity.ProcessId > 0 &&
    [identity.Name, identity.ExecutablePath, identity.CreationDate].every(
      (value) => typeof value === "string" && value.trim().length > 0,
    ) &&
    sameWindowsProcess(identity, identity);
  if (!completeIdentity(observed) || (current && !completeIdentity(current))) {
    return false;
  }
  return !sameWindowsProcess(observed, current);
}

export function windowsProcessStartedAtUtc(processInfo) {
  const value = String(processInfo?.CreationDate ?? "");
  const epoch = /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/.exec(value);
  if (epoch) return new Date(Number(epoch[1])).toISOString();
  const wmi =
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,6}))?([+-])(\d{3})$/.exec(
      value,
    );
  if (wmi) {
    const milliseconds = Number((wmi[7] ?? "").padEnd(3, "0").slice(0, 3));
    const local = Date.UTC(
      Number(wmi[1]),
      Number(wmi[2]) - 1,
      Number(wmi[3]),
      Number(wmi[4]),
      Number(wmi[5]),
      Number(wmi[6]),
      milliseconds,
    );
    const offsetMinutes = Number(wmi[9]);
    const offsetMilliseconds =
      (wmi[8] === "+" ? 1 : -1) * offsetMinutes * 60 * 1_000;
    return new Date(local - offsetMilliseconds).toISOString();
  }
  return new Date(value).toISOString();
}

export async function waitForWindowsProcessExit(
  processInfo,
  queryProcesses,
  timeoutMs = WINDOWS_PROCESS_EXIT_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const current = queryProcesses().find(
      (candidate) =>
        Number(candidate.ProcessId) === Number(processInfo.ProcessId),
    );
    if (!sameWindowsProcess(processInfo, current)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${processInfo.Name} PID ${processInfo.ProcessId} did not exit within ${timeoutMs}ms.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function waitForChildExit(child, timeoutMs = CHILD_EXIT_TIMEOUT_MS) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`PID ${child.pid} did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit();
    }
  });
}

export function observeDevChildTermination(
  child,
  classifyExit,
  {
    drainTimeoutMs = DEV_CHILD_STDIO_DRAIN_TIMEOUT_MS,
    schedule = setTimeout,
    cancelScheduled = clearTimeout,
  } = {},
) {
  let timer;
  let classified = false;
  const classifyOnce = (code, signal) => {
    if (classified) return;
    classified = true;
    if (timer !== undefined) cancelScheduled(timer);
    child.off("exit", onExit);
    child.off("close", onClose);
    classifyExit(code, signal);
  };
  const onExit = (code, signal) => {
    // Orphaned Cargo/app children can hold inherited pipes open after CLI exit.
    timer = schedule(() => classifyOnce(code, signal), drainTimeoutMs);
  };
  const onClose = (code, signal) => classifyOnce(code, signal);
  child.once("exit", onExit);
  child.once("close", onClose);
}

export function isListenerBindable(listener) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (bindable) => {
      server.removeAllListeners();
      resolve(bindable);
    };
    server.once("error", () => finish(false));
    server.once("listening", () => {
      server.close((error) => finish(!error));
    });
    server.listen({
      host: listener.address,
      port: listener.port,
      exclusive: true,
    });
  });
}

export async function waitForWindowsListenersReleased(
  listeners,
  probeListener = isListenerBindable,
  timeoutMs = WINDOWS_LISTENER_RELEASE_TIMEOUT_MS,
) {
  if (listeners.length === 0) {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const results = await Promise.all(listeners.map(probeListener));
    if (results.every(Boolean)) {
      return;
    }
    if (Date.now() >= deadline) {
      const endpoints = listeners
        .map(({ address, port }) => `${address}:${port}`)
        .join(", ");
      throw new Error(
        `Owned listener(s) ${endpoints} were not reusable within ${timeoutMs}ms.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function runTaskkill(processId, force, tree = false) {
  return spawnSync(
    "taskkill",
    [
      "/PID",
      String(processId),
      ...(tree ? ["/T"] : []),
      ...(force ? ["/F"] : []),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
}

export async function stopVerifiedWindowsApp(
  processInfo,
  {
    queryProcesses = queryWindowsProcesses,
    queryListeners = queryWindowsListeners,
    terminate = runTaskkill,
    waitForProcessExit = waitForWindowsProcessExit,
    waitForListenersReleased = waitForWindowsListenersReleased,
    forcedTimeoutMs = WINDOWS_PROCESS_EXIT_TIMEOUT_MS,
    log = console.log,
  } = {},
) {
  const listeners = queryListeners(processInfo);
  const current = queryProcesses().find(
    (candidate) =>
      Number(candidate.ProcessId) === Number(processInfo.ProcessId),
  );
  if (current && !sameWindowsProcess(processInfo, current)) {
    throw new Error(
      `PID ${processInfo.ProcessId} was reused before ${processInfo.Name} shutdown.`,
    );
  }

  if (current) {
    log(
      `[dev] Force-terminating verified ${processInfo.Name} PID ${processInfo.ProcessId} process tree before rebuild.`,
    );
    const forcedResult = terminate(processInfo.ProcessId, true, true);
    if (forcedResult?.error) {
      throw forcedResult.error;
    }
    try {
      await waitForProcessExit(processInfo, queryProcesses, forcedTimeoutMs);
    } catch (error) {
      throw new Error(
        `Could not stop owned ${processInfo.Name} process tree at PID ${processInfo.ProcessId}: ${String(forcedResult?.stderr ?? "").trim() || error.message}`,
      );
    }
  }

  if (listeners.length > 0) {
    log(
      `[dev] Waiting for ${listeners.length} owned listener(s) to become reusable.`,
    );
    await waitForListenersReleased(listeners);
  }
}

export async function stopWindowsProcess(
  child,
  selectDescendants,
  {
    queryProcesses = queryWindowsProcesses,
    queryListeners = queryWindowsListeners,
    terminate = runTaskkill,
    waitForProcessExit = waitForWindowsProcessExit,
    waitForListenersReleased = waitForWindowsListenersReleased,
    terminateRoot = false,
    expectedRootIdentity,
    log = console.log,
  } = {},
) {
  const processes = queryProcesses();
  const initialRoot = processes.find(
    (candidate) => Number(candidate.ProcessId) === Number(child.pid),
  );
  // Recorded roots may already be gone, leaving owned descendants behind.
  // A reused root PID belongs to a different tree and must never be selected.
  if (
    expectedRootIdentity &&
    initialRoot &&
    !sameWindowsProcess(expectedRootIdentity, initialRoot)
  ) {
    return;
  }
  const rootIdentity = expectedRootIdentity ?? initialRoot;
  const descendants = selectDescendants(processes, child.pid);

  for (const descendant of descendants) {
    if (descendant.kind === "unverified-app") {
      const current = queryProcesses().find(
        (candidate) =>
          Number(candidate.ProcessId) === Number(descendant.ProcessId),
      );
      if (!current) {
        continue;
      }
      throw new Error(
        `Refusing to restart because cc-switch.exe PID ${descendant.ProcessId} is outside the verified Cargo target directory or has no executable path.`,
      );
    }
    const current = queryProcesses().find(
      (candidate) =>
        Number(candidate.ProcessId) === Number(descendant.ProcessId),
    );
    if (!sameWindowsProcess(descendant, current)) {
      continue;
    }
    if (descendant.kind === "app" || descendant.kind === "frontend") {
      await stopVerifiedWindowsApp(descendant, {
        queryProcesses,
        queryListeners,
        terminate,
        waitForProcessExit,
        waitForListenersReleased,
        log,
      });
      continue;
    }
    const result = terminate(descendant.ProcessId, true);
    if (result.error) {
      throw result.error;
    }
    try {
      await waitForProcessExit(descendant, queryProcesses);
    } catch (error) {
      throw new Error(
        `Could not stop owned ${descendant.Name} PID ${descendant.ProcessId}: ${String(result.stderr ?? "").trim() || error.message}`,
      );
    }
  }

  if (terminateRoot) {
    const currentRoot = queryProcesses().find(
      (candidate) => Number(candidate.ProcessId) === Number(child.pid),
    );
    // Descendant/listener cleanup can await for a minute. Recheck the original
    // identity immediately before taskkill so a recycled PID cannot be killed.
    if (sameWindowsProcess(rootIdentity, currentRoot)) {
      const rootResult = terminate(child.pid, true, true);
      if (rootResult?.error) throw rootResult.error;
      await waitForProcessExit(currentRoot, queryProcesses);
    }
  } else if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill();
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
  await waitForChildExit(child);
}

async function stopProcessTree(child, selectWindowsDescendants, options) {
  if (!child) {
    return;
  }

  if (process.platform === "win32") {
    await stopWindowsProcess(child, selectWindowsDescendants, options);
  } else {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
    await waitForChildExit(child);
  }
}

function isPortOpenOnHost(port, host) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (isOpen) => {
      socket.destroy();
      resolve(isOpen);
    };
    socket.setTimeout(500);
    socket.once("connect", () => {
      finish(true);
    });
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function isPortOpen(port) {
  const results = await Promise.all([
    isPortOpenOnHost(port, "127.0.0.1"),
    isPortOpenOnHost(port, "::1"),
  ]);
  return results.some(Boolean);
}

async function waitForPort(port, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Vite exited before its development server was ready.");
    }
    if (await isPortOpen(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Vite did not open port ${port} within ${timeoutMs}ms.`);
}

function queryCargoTargetDirectory() {
  const result = spawnSync(
    "cargo",
    [
      "metadata",
      "--manifest-path",
      path.join(TAURI_DIR, "Cargo.toml"),
      "--no-deps",
      "--format-version",
      "1",
    ],
    {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr ?? "").trim() ||
        `cargo metadata exited with status ${result.status}.`,
    );
  }
  const metadata = JSON.parse(result.stdout);
  return metadata.target_directory;
}

export function runCargoTargetMaintenance({
  executable = process.execPath,
  scriptPath = CARGO_TARGET_MAINTENANCE_SCRIPT,
  cwd = REPO_ROOT,
  environment = process.env,
  run = spawnSync,
} = {}) {
  const result = run(executable, [scriptPath], {
    cwd,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Cargo target maintenance exited with status ${result.status}.`,
    );
  }
}

export function reportDevSupervisorDecision(
  decision,
  outcome,
  logger = console,
) {
  if (decision.restart)
    logger.log(
      `[dev watchdog] pnpm dev session exited (${outcome.signal ?? `code ${outcome.exitCode}`}); restarting the complete Vite + Cargo/Tauri dev build.`,
    );
  else if (decision.reason === "rate-limited")
    logger.error(
      `[dev watchdog] Restart limit reached (${DEV_RECOVERY_POLICY.maxRestarts} in ${DEV_RECOVERY_POLICY.restartWindowMs / 60_000} minutes).`,
    );
}

export async function superviseDevSessions({
  spawnSession,
  cleanSession,
  readEnabled = readDevWatchdogEnabled,
  isStopping = () => false,
  waitToRestart = () =>
    new Promise((resolve) => setTimeout(resolve, DEV_AUTO_RESTART_DELAY_MS)),
  now = Date.now,
  restartTimesMs = [],
  onRestart = () => {},
  onEvent = () => {},
}) {
  while (!isStopping()) {
    const child = spawnSession();
    const outcome = await new Promise((resolve) => {
      const onExit = (exitCode, signal) => {
        child.off("error", onError);
        resolve({ exitCode, signal });
      };
      const onError = (error) => {
        child.off("exit", onExit);
        resolve({ exitCode: 1, signal: null, error });
      };
      child.once("exit", onExit);
      child.once("error", onError);
    });
    // Cleanup finishes before a new worker starts; orphaned Cargo, cc-switch
    // and Vite processes must not retain listeners or the debug executable.
    await cleanSession(child);
    const decisionAtMs = now();
    const decision = devWorkerRestartDecision({
      ...outcome,
      expectedExit: isStopping(),
      watchdogEnabled: readEnabled(),
      nowMs: decisionAtMs,
      restartTimesMs,
    });
    const watchdogEvent =
      decision.reason === "rate-limited"
        ? {
            event: "dev-session-restart-limited",
            detail: {
              supervisorPid: process.pid,
              restartCount: readDevRestartTimesMs(
                { restartTimesMs },
                decisionAtMs,
              ).length,
            },
          }
        : null;
    onEvent(decision, outcome, watchdogEvent);
    if (!decision.restart) return outcome.exitCode ?? 1;
    const restartAtMs = now();
    restartTimesMs.splice(
      0,
      restartTimesMs.length,
      ...readDevRestartTimesMs({ restartTimesMs }, restartAtMs),
      restartAtMs,
    );
    // Persist before waiting so launcher recovery cannot reset this budget.
    onRestart();
    await waitToRestart();
    if (!readEnabled()) return outcome.exitCode ?? 1;
  }
  return 0;
}

export function devWorkerCommand(args, environment = process.env) {
  return {
    executable: process.execPath,
    args: [fileURLToPath(import.meta.url), DEV_WORKER_FLAG, ...args],
    options: {
      cwd: REPO_ROOT,
      env: { ...environment, [DEV_SUPERVISOR_ENV]: "1" },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      detached: process.platform !== "win32",
      windowsHide: true,
    },
  };
}

function devSessionPath() {
  const settingsPath = resolveDevSettingsPath();
  return settingsPath
    ? path.join(path.dirname(settingsPath), "logs", "dev-session.json")
    : null;
}

export function devSessionEnvironment(environment) {
  return Object.fromEntries(
    DEV_SESSION_ENV_KEYS.filter(
      (key) => typeof environment?.[key] === "string",
    ).map((key) => [key, environment[key]]),
  );
}

function writeDevWatchdogEvent(event, detail) {
  const markerPath = devSessionPath();
  if (!markerPath) return;
  try {
    appendFileSync(
      path.join(path.dirname(markerPath), "dev-watchdog.jsonl"),
      `${JSON.stringify({ timestamp: new Date().toISOString(), event, detail })}\n`,
    );
  } catch {}
}

function devSupervisorIsAlive(session, processes) {
  if (!Number.isInteger(session?.supervisorPid) || session.supervisorPid < 1)
    return false;
  if (process.platform === "win32") {
    const identity = processes.find(
      (candidate) => Number(candidate.ProcessId) === session.supervisorPid,
    );
    return Boolean(
      identity &&
      path.resolve(identity.ExecutablePath).toLowerCase() ===
        path.resolve(session.supervisorExecutablePath).toLowerCase() &&
      windowsProcessStartedAtUtc(identity) === session.supervisorStartedAtUtc,
    );
  }
  try {
    process.kill(session.supervisorPid, 0);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}

export async function waitForDevSupervisorPublication({
  expected,
  readSession,
  isRunning,
  verifyOwnership = () => expected.supervisorStartedAtUtc !== undefined,
  timeoutMs = DEV_SUPERVISOR_PUBLICATION_TIMEOUT_MS,
  onTimeout = () => {},
  now = Date.now,
  wait = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const deadline = now() + timeoutMs;
  let timeoutReported = false;
  const normalizeExecutable = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  while (true) {
    if (!isRunning()) {
      throw new Error(
        `Replacement dev supervisor PID ${expected.supervisorPid} exited before publishing its session.`,
      );
    }
    let session;
    try {
      session = readSession();
    } catch {
      // An in-progress or unreadable marker is not a confirmed handoff.
    }
    const matchesReplacement =
      session?.schemaVersion === 1 &&
      session.state === "running" &&
      session.supervisorPid === expected.supervisorPid &&
      typeof session.supervisorExecutablePath === "string" &&
      normalizeExecutable(session.supervisorExecutablePath) ===
        normalizeExecutable(expected.supervisorExecutablePath) &&
      session.repoRoot === expected.repoRoot &&
      session.scriptPath === expected.scriptPath &&
      Number.isFinite(Date.parse(session.supervisorStartedAtUtc)) &&
      (expected.supervisorStartedAtUtc === undefined ||
        session.supervisorStartedAtUtc === expected.supervisorStartedAtUtc) &&
      Date.parse(session.startedAtUtc) >= expected.launchedAtMs;
    if (matchesReplacement) {
      try {
        if (verifyOwnership(session)) return session;
      } catch {
        // Transient identity-query failures cannot release recovery ownership.
      }
    }
    if (!timeoutReported && now() >= deadline) {
      timeoutReported = true;
      // A live unpublished child still owns this attempt; never race fallback.
      onTimeout(
        new Error(
          `Replacement dev supervisor PID ${expected.supervisorPid} did not publish its owned session within ${timeoutMs}ms.`,
        ),
      );
    }
    await wait(100);
  }
}

function persistDetachedDevSession(markerPath, session) {
  const temporary = `${markerPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(session));
  renameSync(temporary, markerPath);
}

export async function handoffDetachedDevSupervisor({
  supervisorPid,
  markerPath,
  session,
  now = Date.now,
  readEnabled = readDevWatchdogEnabled,
  persistSession = (nextSession) =>
    persistDetachedDevSession(markerPath, nextSession),
  readSession = () => JSON.parse(readFileSync(markerPath, "utf8")),
  spawnReplacement = async ({ executable, args, options }) => {
    const replacement = spawn(executable, args, options);
    await new Promise((resolve, reject) => {
      replacement.once("spawn", resolve);
      replacement.once("error", reject);
    });
    return replacement;
  },
  waitForPublication = waitForDevSupervisorPublication,
  queryProcesses = queryWindowsProcesses,
  writeEvent = writeDevWatchdogEvent,
  executable = process.execPath,
  scriptPath = fileURLToPath(import.meta.url),
  repoRoot = REPO_ROOT,
  environment = process.env,
}) {
  const nowMs = now();
  const restartTimesMs = readDevRestartTimesMs(session, nowMs);
  const decision = devWorkerRestartDecision({
    exitCode: 1,
    signal: null,
    watchdogEnabled: readEnabled(),
    nowMs,
    restartTimesMs,
  });
  if (!decision.restart) {
    writeEvent("dev-supervisor-restart-skipped", {
      supervisorPid,
      reason: decision.reason,
      restartCount: restartTimesMs.length,
    });
    return { restarted: false, decision };
  }

  session.restartTimesMs = [...restartTimesMs, nowMs];
  delete session.supervisorRestartTimesMs;
  persistSession(session);

  // Relaunch the entry point of pnpm dev, not the compiled application.
  const launchedAtMs = now();
  const replacement = await spawnReplacement({
    executable,
    args: [scriptPath, ...session.args],
    options: {
      cwd: repoRoot,
      env: {
        ...environment,
        ...devSessionEnvironment(session.environment),
      },
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    },
  });
  try {
    await waitForPublication({
      expected: {
        supervisorPid: replacement.pid,
        supervisorExecutablePath: executable,
        repoRoot,
        scriptPath,
        launchedAtMs,
      },
      readSession,
      isRunning: () =>
        replacement.exitCode === null && replacement.signalCode === null,
      verifyOwnership: (recorded) =>
        process.platform !== "win32" ||
        devSupervisorIsAlive(recorded, queryProcesses(replacement.pid)),
      onTimeout: (error) =>
        writeEvent("dev-supervisor-publication-timeout", {
          oldPid: supervisorPid,
          newPid: replacement.pid,
          error: error.message,
        }),
    });
    writeEvent("dev-supervisor-restarted", {
      oldPid: supervisorPid,
      newPid: replacement.pid,
    });
  } catch (error) {
    writeEvent("dev-supervisor-publication-failed", {
      oldPid: supervisorPid,
      newPid: replacement.pid,
      error: error.message,
    });
    return {
      restarted: false,
      retry: true,
      decision,
      replacementPid: replacement.pid,
    };
  } finally {
    replacement.unref();
  }
  return { restarted: true, decision, replacementPid: replacement.pid };
}

export async function runDetachedDevWatchdog(
  supervisorPid,
  {
    markerPath = devSessionPath(),
    readSession = () => JSON.parse(readFileSync(markerPath, "utf8")),
    wait = () => new Promise((resolve) => setTimeout(resolve, 2_000)),
    queryProcesses = queryWindowsProcesses,
    handoff = handoffDetachedDevSupervisor,
    writeEvent = writeDevWatchdogEvent,
  } = {},
) {
  if (!markerPath) return;
  while (true) {
    await wait();
    try {
      let session;
      try {
        session = readSession();
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      if (
        session.supervisorPid !== supervisorPid ||
        session.state !== "running" ||
        session.repoRoot !== REPO_ROOT ||
        session.scriptPath !== fileURLToPath(import.meta.url)
      )
        return;
      const alive = devSupervisorIsAlive(
        session,
        process.platform === "win32" ? queryProcesses(supervisorPid) : [],
      );
      if (alive) continue;
      const result = await handoff({
        supervisorPid,
        markerPath,
        session,
        readSession,
        queryProcesses,
      });
      if (result.retry) continue;
      return;
    } catch (error) {
      writeEvent("dev-watchdog-iteration-failed", {
        error: error.message,
      });
    }
  }
}

function sendDevRoot(role, child) {
  if (process.connected)
    process.send({ type: "dev-root", role, pid: child.pid });
}

async function cleanRecordedDevRoots(roots) {
  for (const root of roots) {
    const select =
      root.role === "tauri"
        ? windowsDevDescendants
        : windowsFrontendDescendants;
    if (process.platform === "win32") {
      const current = queryWindowsProcesses().find(
        (candidate) => Number(candidate.ProcessId) === root.pid,
      );
      if (current && !sameWindowsProcess(root.identity, current)) continue;
      const child = { pid: root.pid, exitCode: 0, signalCode: null };
      await stopWindowsProcess(
        child,
        (processes, pid) => [
          ...select(processes, pid),
          ...(current
            ? [
                {
                  ...current,
                  depth: 0,
                  kind: root.role === "vite" ? "frontend" : "tauri",
                },
              ]
            : []),
        ],
        { terminateRoot: true, expectedRootIdentity: root.identity },
      );
    } else {
      try {
        process.kill(-root.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
}

async function cleanRecordedDevWorker(session) {
  if (!Number.isInteger(session?.workerPid)) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-session.workerPid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    return;
  }
  const current = queryWindowsProcesses().find(
    (candidate) => Number(candidate.ProcessId) === session.workerPid,
  );
  if (!current) return;
  const command = String(current.CommandLine ?? "");
  const matchesIdentity = session.workerIdentity
    ? sameWindowsProcess(session.workerIdentity, current)
    : String(current.Name).toLowerCase() === "node.exe" &&
      command.includes(fileURLToPath(import.meta.url)) &&
      command.includes(DEV_WORKER_FLAG) &&
      Date.parse(windowsProcessStartedAtUtc(current)) >=
        Date.parse(session.startedAtUtc);
  if (!matchesIdentity) return;
  await stopWindowsProcess(
    { pid: session.workerPid, exitCode: 0, signalCode: null },
    windowsDevWorkerDescendants,
    { terminateRoot: true, expectedRootIdentity: current },
  );
}

async function runDevSupervisor(args) {
  // Reject bad options once, before the recovery loop can retry them.
  parseDelayMs(args);
  parseNoRebuild(args);
  parsePort();
  const markerPath = devSessionPath();
  let previous;
  if (markerPath) {
    try {
      previous = JSON.parse(readFileSync(markerPath, "utf8"));
    } catch {}
  }
  let supervisorIdentity;
  const processes = process.platform === "win32" ? queryWindowsProcesses() : [];
  if (devSupervisorIsAlive(previous, processes)) {
    throw new Error(
      `An existing pnpm dev supervisor (PID ${previous.supervisorPid}) owns this configuration.`,
    );
  }
  if (process.platform === "win32") {
    supervisorIdentity = processes.find(
      (candidate) => Number(candidate.ProcessId) === process.pid,
    );
  }
  const ownsPrevious =
    previous?.repoRoot === REPO_ROOT &&
    previous?.scriptPath === fileURLToPath(import.meta.url);
  let worker;
  let workerIdentity;
  let stopping = false;
  let roots = new Map(
    (ownsPrevious ? (previous.roots ?? []) : []).map((root) => [
      root.role,
      root,
    ]),
  );
  let restartTimer;
  let finishRestartWait;
  const session = {
    schemaVersion: 1,
    supervisorPid: process.pid,
    supervisorExecutablePath: process.execPath,
    supervisorStartedAtUtc: supervisorIdentity
      ? windowsProcessStartedAtUtc(supervisorIdentity)
      : new Date(Date.now() - process.uptime() * 1000).toISOString(),
    repoRoot: REPO_ROOT,
    scriptPath: fileURLToPath(import.meta.url),
    args,
    environment: devSessionEnvironment(process.env),
    startedAtUtc: new Date().toISOString(),
    restartTimesMs: readDevRestartTimesMs(previous),
    state: "running",
  };
  const lockPath = markerPath ? `${markerPath}.lock` : null;
  if (lockPath) {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    let lock;
    try {
      lock = openSync(lockPath, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {}
      if (
        devSupervisorIsAlive(
          owner,
          process.platform === "win32" ? queryWindowsProcesses() : [],
        ) ||
        (!owner && Date.now() - statSync(lockPath).mtimeMs < 5_000)
      )
        throw new Error("Another pnpm dev supervisor is starting or running.");
      rmSync(lockPath);
      lock = openSync(lockPath, "wx");
    }
    try {
      writeFileSync(lock, JSON.stringify(session));
    } finally {
      closeSync(lock);
    }
  }
  const saveSession = () => {
    if (!markerPath) return;
    mkdirSync(path.dirname(markerPath), { recursive: true });
    const temporary = `${markerPath}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({
        ...session,
        workerPid: worker?.pid,
        workerIdentity,
        roots: [...roots.values()],
      }),
    );
    renameSync(temporary, markerPath);
  };
  const stop = (exitCode) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = exitCode;
    session.state = "stopping";
    saveSession();
    clearTimeout(restartTimer);
    finishRestartWait?.();
    if (worker?.connected) worker.send({ type: "dev-shutdown", exitCode });
  };
  const onInterrupt = () => stop(130);
  const onTerminate = () => stop(143);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  saveSession();
  const detachedWatchdog = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), DEV_WATCHDOG_FLAG, String(process.pid)],
    {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    },
  );
  detachedWatchdog.unref();
  detachedWatchdog.once("error", (error) =>
    writeDevWatchdogEvent("dev-watchdog-spawn-failed", {
      error: error.message,
    }),
  );
  let completed = false;
  try {
    // Claim recovery before cleanup, which can wait up to a minute for a
    // listener to release. The product guardian must see the live owner.
    if (ownsPrevious) {
      await cleanRecordedDevWorker(previous);
      await cleanRecordedDevRoots(previous.roots ?? []);
    }
    const code = await superviseDevSessions({
      spawnSession() {
        roots = new Map();
        const command = devWorkerCommand(args);
        worker = spawn(command.executable, command.args, command.options);
        workerIdentity = null;
        saveSession();
        if (process.platform === "win32" && worker.pid) {
          workerIdentity = queryWindowsProcesses().find(
            (candidate) => Number(candidate.ProcessId) === worker.pid,
          );
          saveSession();
        }
        worker.on("message", (message) => {
          if (
            message?.type !== "dev-root" ||
            !["tauri", "vite"].includes(message.role) ||
            !Number.isInteger(message.pid)
          )
            return;
          const identity =
            process.platform === "win32"
              ? queryWindowsProcesses().find(
                  (candidate) => Number(candidate.ProcessId) === message.pid,
                )
              : null;
          if (process.platform === "win32" && !identity) return;
          roots.set(message.role, {
            pid: message.pid,
            role: message.role,
            identity,
          });
          saveSession();
        });
        return worker;
      },
      async cleanSession(child) {
        if (!child.pid) return;
        if (process.platform === "win32") {
          await stopProcessTree(child, windowsDevWorkerDescendants, {
            expectedRootIdentity: workerIdentity,
          });
        } else {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        await cleanRecordedDevRoots([...roots.values()]);
      },
      isStopping: () => stopping,
      restartTimesMs: session.restartTimesMs,
      onRestart: saveSession,
      waitToRestart: () =>
        new Promise((resolve) => {
          finishRestartWait = resolve;
          restartTimer = setTimeout(resolve, DEV_AUTO_RESTART_DELAY_MS);
        }),
      onEvent(decision, outcome, watchdogEvent) {
        if (watchdogEvent) {
          writeDevWatchdogEvent(watchdogEvent.event, watchdogEvent.detail);
        }
        reportDevSupervisorDecision(decision, outcome);
      },
    });
    if (!stopping) process.exitCode = code;
    completed = true;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    clearTimeout(restartTimer);
    if (markerPath && completed) {
      let recorded;
      try {
        recorded = JSON.parse(readFileSync(markerPath, "utf8"));
      } catch {}
      if (
        recorded?.supervisorPid === process.pid &&
        recorded?.supervisorStartedAtUtc === session.supervisorStartedAtUtc
      )
        rmSync(markerPath, { force: true });
      let owner;
      try {
        owner = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {}
      if (
        owner?.supervisorPid === process.pid &&
        owner?.supervisorStartedAtUtc === session.supervisorStartedAtUtc
      )
        rmSync(lockPath, { force: true });
    }
  }
}

async function runDevWorker(args) {
  const hadParent = typeof process.send === "function";
  let parentLost = hadParent && !process.connected;
  let requestedExitCode;
  if (hadParent) {
    process.once("disconnect", () => {
      parentLost = true;
    });
    process.on("message", (message) => {
      if (message?.type === "dev-shutdown")
        requestedExitCode = message.exitCode ?? 0;
    });
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: pnpm dev:delayed -- [--delay milliseconds] [--no-rebuild]

Runs Vite with immediate frontend HMR and rebuilds the Tauri backend only after
backend files have remained unchanged for the configured quiet period.

Options:
  -d, --delay <ms>  Quiet period before a backend rebuild (default: 14400000 / 4 hours)
  --no-rebuild      Disable source-edit rebuilds (watchdog crash recovery still applies)

Watchdog:
  watchdogEnabled recovers crashes and sustained reconnect loops immediately,
  without the source-edit delay (maximum 5 automatic restarts / 30 minutes).

Environment:
  TAURI_DEV_REBUILD_DELAY_MS  Same setting as --delay; CLI option takes priority
  TAURI_DEV_NO_REBUILD         Same setting as --no-rebuild (1/true or 0/false)

Use "pnpm dev:immediate" for the same verified lifecycle with no quiet delay.`);
    return;
  }

  const delayMs = parseDelayMs(args);
  const noRebuild = parseNoRebuild(args);
  const frontendPort = parsePort();
  assertNormalCargoTargetDirectory(path.join(TAURI_DIR, "target"));
  assertNormalCargoTargetDirectory(queryCargoTargetDirectory(), {});
  if (await isPortOpen(frontendPort)) {
    throw new Error(
      `Port ${frontendPort} is already in use. Stop the existing dev session before running pnpm dev:delayed.`,
    );
  }
  runCargoTargetMaintenance();
  // Drain parent-disconnect/shutdown events after synchronous Cargo preflight.
  await new Promise((resolve) => setImmediate(resolve));
  if (
    parentLost ||
    (hadParent && !process.connected) ||
    requestedExitCode !== undefined
  ) {
    process.exitCode = requestedExitCode ?? 1;
    if (process.connected) process.disconnect();
    return;
  }

  console.log(
    `[dev] Frontend HMR is immediate; backend ${noRebuild ? "rebuilds are disabled (--no-rebuild)" : `rebuilds after ${delayMs}ms without changes`}.`,
  );

  const vite = startProcess(process.execPath, [
    "./node_modules/vite/bin/vite.js",
    "--port",
    String(frontendPort),
    "--strictPort",
  ]);
  sendDevRoot("vite", vite);
  let tauri;
  let backendWatchers = [];
  let shuttingDown = false;
  let restartInProgress = false;
  let shutdownPromise;
  let tauriRecovery;
  const expectedTauriExits = createExpectedExitRegistry();
  const backendContentTracker = createBackendContentTracker();
  let lastBackendEditAt;
  let lastBackendEditPaths = [];

  const logBackendEvent = (message) => {
    console.log(`[dev ${new Date().toISOString()}] ${message}`);
  };

  const reportScheduledRebuild = (changedPaths, scheduleResult) => {
    const displayedPaths = changedPaths.slice(0, 3).join(", ");
    const extraCount = changedPaths.length - 3;
    const summary = `${displayedPaths}${extraCount > 0 ? ` (+${extraCount} more)` : ""}`;
    const lastEdit = lastBackendEditAt
      ? `; last edit detected at ${lastBackendEditAt}`
      : "";
    if (scheduleResult === "deferred") {
      logBackendEvent(
        `Backend changed while building: ${summary}; one follow-up rebuild will run after this build settles${lastEdit}.`,
      );
      return;
    }
    logBackendEvent(
      `Backend changed: ${summary}; rebuilding after ${delayMs}ms without further backend edits${lastEdit}.`,
    );
  };

  const changeBatcher = createChangeEventBatcher(
    WATCH_EVENT_BATCH_MS,
    (changedPaths) => {
      if (shuttingDown || changedPaths.length === 0) {
        return;
      }
      let contentStateChanged = false;
      for (const changedPath of changedPaths) {
        if (
          backendContentTracker.record(
            changedPath,
            path.join(TAURI_DIR, changedPath),
          )
        ) {
          contentStateChanged = true;
        }
      }
      if (!contentStateChanged) {
        return;
      }

      const dirtyPaths = backendContentTracker.dirtyPaths();
      if (dirtyPaths.length === 0) {
        rebuildGate.clearChange();
        logBackendEvent(
          "Backend edit reverted to the current build baseline; pending rebuild cancelled.",
        );
        lastBackendEditAt = new Date().toISOString();
        lastBackendEditPaths = [];
        return;
      }
      lastBackendEditAt = new Date().toISOString();
      lastBackendEditPaths = dirtyPaths;
      const displayedPaths = dirtyPaths.slice(0, 8).join(", ");
      const extraCount = dirtyPaths.length - 8;
      logBackendEvent(
        `Backend edit detected: ${displayedPaths}${extraCount > 0 ? ` (+${extraCount} more)` : ""}.`,
      );
      if (noRebuild) {
        logBackendEvent(
          `Backend rebuild suppressed; latest detected edit is ${lastBackendEditAt}.`,
        );
        return;
      }
      reportScheduledRebuild(dirtyPaths, rebuildGate.scheduleChange());
    },
  );

  const closeBackendWatchers = () => {
    changeBatcher.cancel();
    for (const backendWatcher of backendWatchers) {
      backendWatcher.close();
    }
    backendWatchers = [];
  };

  const startBackendWatchers = () => {
    if (backendWatchers.length > 0) {
      return;
    }

    const addWatcher = (watchedPath, options, resolveChangedPath) => {
      const backendWatcher = watch(
        watchedPath,
        options,
        (_eventType, filename) => {
          const changedPath = resolveChangedPath(filename);
          if (changedPath) {
            changeBatcher.add(changedPath);
          }
        },
      );
      backendWatcher.on("error", (error) => {
        if (shuttingDown) {
          return;
        }
        void shutdownWithError(
          new Error(
            `Backend watcher failed for ${watchedPath}: ${error.message}`,
          ),
        );
      });
      backendWatchers.push(backendWatcher);
    };

    for (const relativePath of BACKEND_WATCH_DIRECTORIES) {
      const watchedPath = path.join(TAURI_DIR, relativePath);
      if (!existsSync(watchedPath)) {
        continue;
      }
      if (!statSync(watchedPath).isDirectory()) {
        throw new Error(
          `Backend watch path is not a directory: ${watchedPath}`,
        );
      }
      addWatcher(watchedPath, { recursive: true }, (filename) =>
        filename ? path.join(relativePath, filename.toString()) : null,
      );
    }

    addWatcher(TAURI_DIR, { recursive: false }, resolveTauriRootBackendInput);
    addWatcher(REPO_ROOT, { recursive: false }, resolveRepoRootBackendInput);
    addWatcher(
      path.join(REPO_ROOT, "contracts"),
      { recursive: false },
      (filename) =>
        filename
          ? resolveRepoRootBackendInput(
              path.join("contracts", filename.toString()),
            )
          : null,
    );
    console.log("[dev] Backend watcher armed.");
  };

  const startTauri = () => {
    let outputTail = "";
    let appStarted = false;
    const sessionStartedAt = Date.now();
    let appIdentity;
    let observedAppProcess;
    let processQueryFailed = false;
    const reconnectTracker = createDevReconnectTracker();
    const child = startProcess(
      process.execPath,
      [
        "./node_modules/@tauri-apps/cli/tauri.js",
        "dev",
        "--no-watch",
        "--config",
        JSON.stringify({
          build: {
            beforeDevCommand: "",
            devUrl: `http://localhost:${frontendPort}`,
          },
        }),
      ],
      {
        stdio: ["inherit", "pipe", "pipe"],
        env: {
          ...process.env,
          CARGO_INCREMENTAL: "0",
          // In a `pnpm dev` session this Node process owns the Tauri child.
          // The Rust supervisor stays disabled here so both layers cannot
          // relaunch the same app after one crash.
          [DEV_SUPERVISOR_ENV]: "1",
        },
      },
    );
    tauri = child;
    sendDevRoot("tauri", child);
    child.once("error", (error) => {
      if (!shuttingDown && tauri === child) {
        void shutdownWithError(
          new Error(`Could not start the Tauri backend: ${error.message}`),
        );
      }
    });

    const packetReader = createDevWatchdogOutputReader((packet) => {
      if (tauri !== child || shuttingDown) {
        return;
      }
      if (
        packet.event === "ready" &&
        Number.isInteger(packet.pid) &&
        packet.pid > 0 &&
        typeof packet.executablePath === "string" &&
        isPathInside(path.join(TAURI_DIR, "target"), packet.executablePath) &&
        Number.isFinite(packet.processStartedAtTicks) &&
        typeof packet.markerPath === "string"
      ) {
        appIdentity = packet;
        if (process.platform === "win32") {
          try {
            observedAppProcess = queryWindowsProcesses(packet.pid).find(
              (candidate) => Number(candidate.ProcessId) === packet.pid,
            );
          } catch {
            // A failed OS query is not proof that the app crashed.
          }
        }
      }
      reconnectTracker.observe(packet);
    });

    const backendProcessCrashed = () => {
      if (process.platform !== "win32" || !observedAppProcess || !appIdentity) {
        return false;
      }
      const current = queryWindowsProcesses(appIdentity.pid).find(
        (candidate) => Number(candidate.ProcessId) === appIdentity.pid,
      );
      return windowsProcessObservationCrashed(observedAppProcess, current);
    };
    const recovery = createDevWorkerRecovery({
      isCurrent: () => !shuttingDown && !restartInProgress && tauri === child,
      readMarkerPresent: () =>
        readDevRunMarkerPresent(process.env, readFileSync, appIdentity),
      isRecoveryNeeded: (reason) =>
        reason === "reconnect-loop"
          ? reconnectTracker.recoveryReason() === reason
          : reason === "backend-process-crashed" && backendProcessCrashed(),
      recover: (reason) => {
        void shutdownWithError(
          new Error(
            `${reason}; handing recovery to the complete pnpm dev session watchdog.`,
          ),
        );
      },
    });
    tauriRecovery = recovery;
    const reconnectTimer = setInterval(() => {
      if (!shuttingDown && process.platform === "win32" && observedAppProcess) {
        try {
          const crashed = backendProcessCrashed();
          processQueryFailed = false;
          if (
            crashed &&
            readDevRunMarkerPresent(process.env, readFileSync, appIdentity)
          ) {
            recovery.request("backend-process-crashed");
          }
        } catch {
          if (!processQueryFailed) {
            console.warn(
              "[dev-watchdog] Process observation unavailable; recovery remains fail-closed.",
            );
            processQueryFailed = true;
          }
        }
      }
      const reason = reconnectTracker.recoveryReason();
      if (reason) {
        recovery.request(reason);
      }
    }, 5_000);
    reconnectTimer.unref();
    child.once("exit", () => {
      clearInterval(reconnectTimer);
      recovery.cancel();
    });

    const observeOutput = (chunk, destination) => {
      destination.write(chunk);
      if (destination === process.stdout) {
        packetReader.push(chunk);
      }
      if (appStarted || tauri !== child) {
        return;
      }

      outputTail = `${outputTail}${chunk.toString()}`.slice(-4_096);
      if (isTauriAppStartedOutput(outputTail)) {
        appStarted = true;
        const followUpRebuildQueued = rebuildGate.markReady();
        if (followUpRebuildQueued) {
          console.log(
            "[dev] Backend changed during the build; one follow-up rebuild remains queued.",
          );
        }
      }
    };
    child.stdout.on("data", (chunk) => observeOutput(chunk, process.stdout));
    child.stderr.on("data", (chunk) => observeOutput(chunk, process.stderr));

    observeDevChildTermination(child, (code, signal) => {
      if (expectedTauriExits.consume(child)) {
        return;
      }
      if (!shuttingDown && tauri === child) {
        const uncleanExit = appIdentity
          ? readDevRunMarkerPresent(process.env, readFileSync, appIdentity)
          : isDevCrashMarker(readDevRunMarker(), sessionStartedAt);
        const outcome = devAutoRestartDecision({
          appStarted,
          exitCode: code,
          signal,
          uncleanExit,
          // The outer supervisor reads the persisted toggle at the restart
          // boundary. Here we only classify the worker's exit as clean/crashed.
          watchdogEnabled: true,
        });
        if (outcome.reason === "clean-exit" || outcome.reason === "signal") {
          void shutdown(0);
          return;
        }
        void shutdownWithError(
          new Error(
            `Tauri backend exited unexpectedly (${signal ?? `code ${code}`}${uncleanExit ? "; crash marker remains" : ""}); handing recovery to the pnpm dev watchdog.`,
          ),
        );
      }
    });
  };

  const restartTauri = async (reason = "backend-edit") => {
    if (restartInProgress || shuttingDown) {
      return;
    }
    restartInProgress = true;
    tauriRecovery?.cancel();
    const rebuildStartedAt = new Date().toISOString();
    const triggeringPaths = lastBackendEditPaths;
    const triggeringSummary = triggeringPaths.slice(0, 8).join(", ");
    const extraCount = triggeringPaths.length - 8;
    const previousTauri = tauri;
    try {
      rebuildGate.markBuilding();
      backendContentTracker.beginBuild(snapshotBackendFileFingerprints());
      logBackendEvent(
        `Backend rebuild triggered at ${rebuildStartedAt}; reason=${reason}; last edit detected at ${lastBackendEditAt ?? "unknown"}; paths: ${triggeringSummary || "unknown"}${extraCount > 0 ? ` (+${extraCount} more)` : ""}.`,
      );
      if (previousTauri) {
        expectedTauriExits.mark(previousTauri);
      }
      await stopProcessTree(previousTauri, windowsDevDescendants);
      // Detach only after verified cleanup. Until then shutdown must retain
      // the handle so it can retry cleanup after an intermediate failure.
      if (tauri === previousTauri) {
        tauri = undefined;
      }
      if (!shuttingDown) {
        startTauri();
      }
    } catch (error) {
      if (previousTauri) {
        expectedTauriExits.unmark(previousTauri);
      }
      await shutdownWithError(
        new Error(
          `Could not safely restart the Tauri backend: ${error.message}`,
        ),
      );
    } finally {
      restartInProgress = false;
    }
  };

  const rebuildGate = createBackendRebuildGate(delayMs, () => {
    void restartTauri();
  });

  const shutdown = (exitCode = 0) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shuttingDown = true;
    tauriRecovery?.cancel();
    rebuildGate.cancel();
    closeBackendWatchers();
    process.exitCode = exitCode;
    shutdownPromise = Promise.allSettled([
      stopProcessTree(tauri, windowsDevDescendants),
      stopProcessTree(vite, windowsFrontendDescendants),
    ]).then((results) => {
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason?.message ?? String(result.reason));
      if (failures.length > 0) {
        process.exitCode = 1;
        console.error(`[dev] Shutdown failed: ${failures.join("; ")}`);
      }
      if (process.connected) process.disconnect();
    });
    return shutdownPromise;
  };

  const shutdownWithError = async (error) => {
    console.error(`[dev] ${error.message}`);
    await shutdown(1);
  };

  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));
  if (process.connected) {
    process.on("message", (message) => {
      if (message?.type === "dev-shutdown")
        void shutdown(message.exitCode ?? 0);
    });
    process.once("disconnect", () => void shutdown(1));
  }
  vite.once("error", (error) => {
    if (!shuttingDown) {
      void shutdownWithError(
        new Error(`Could not start Vite: ${error.message}`),
      );
    }
  });
  vite.once("exit", (code) => {
    if (!shuttingDown) {
      void shutdownWithError(
        new Error(`Vite exited unexpectedly with code ${code}.`),
      );
    }
  });

  try {
    await waitForPort(frontendPort, vite);
    startBackendWatchers();
    backendContentTracker.beginBuild(snapshotBackendFileFingerprints());
    startTauri();
  } catch (error) {
    await shutdown(1);
    throw error;
  }
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
  const cliArgs = normalizeCliArgs(process.argv.slice(2));
  const isWorker = cliArgs[0] === DEV_WORKER_FLAG;
  const isDetachedWatchdog = cliArgs[0] === DEV_WATCHDOG_FLAG;
  const task = isDetachedWatchdog
    ? runDetachedDevWatchdog(Number(cliArgs[1]))
    : isWorker
      ? runDevWorker(cliArgs.slice(1))
      : cliArgs.includes("--help") || cliArgs.includes("-h")
        ? runDevWorker(cliArgs)
        : runDevSupervisor(cliArgs);
  task.catch((error) => {
    console.error(`[dev] ${error.message}`);
    process.exitCode = 1;
  });
}
