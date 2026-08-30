import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_DELAY_MS = 50_000;
const DEFAULT_FRONTEND_PORT = 3000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const TAURI_DIR = path.join(REPO_ROOT, "src-tauri");
const WATCH_EVENT_BATCH_MS = 100;
const CHILD_EXIT_TIMEOUT_MS = 10_000;
const WINDOWS_PROCESS_EXIT_TIMEOUT_MS = 2_000;
const WINDOWS_GRACEFUL_APP_EXIT_TIMEOUT_MS = 10_000;
const WINDOWS_LISTENER_RELEASE_TIMEOUT_MS = 60_000;
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

export function parseDelayMs(args, environment = process.env) {
  let unsupportedArgument;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--delay" || argument === "-d") {
      index += 1;
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

export function parsePort(environment = process.env) {
  const rawPort = environment.TAURI_DEV_PORT ?? DEFAULT_FRONTEND_PORT;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid development port "${rawPort}".`);
  }
  return port;
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

function snapshotBackendFileFingerprints() {
  const entries = [];
  const addFile = (relativePath) => {
    const fingerprint = fingerprintBackendFile(
      path.join(TAURI_DIR, relativePath),
    );
    if (fingerprint !== null) {
      entries.push([relativePath, fingerprint]);
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
  return entries;
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
  environment = process.env,
) {
  const tauriRoot = path.join(path.resolve(repoRoot), "src-tauri");
  const targetRoot = environment.CARGO_TARGET_DIR
    ? path.resolve(tauriRoot, environment.CARGO_TARGET_DIR)
    : path.join(tauriRoot, "target");
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

function queryWindowsProcesses() {
  const script = [
    "Get-CimInstance Win32_Process |",
    "Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate |",
    "ConvertTo-Json -Compress",
  ].join(" ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? "").trim();
    throw new Error(
      stderr || `PowerShell process query exited with status ${result.status}.`,
    );
  }
  if (!result.stdout.trim()) {
    return [];
  }
  const parsed = JSON.parse(result.stdout);
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
}

export function parseWindowsListeners(stdout) {
  if (!String(stdout ?? "").trim()) {
    return [];
  }
  const parsed = JSON.parse(stdout);
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
  const script = [
    `Get-NetTCPConnection -State Listen -OwningProcess ${processId} -ErrorAction SilentlyContinue |`,
    "Select-Object LocalAddress,LocalPort |",
    "Sort-Object LocalAddress,LocalPort -Unique |",
    "ConvertTo-Json -Compress",
  ].join(" ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? "").trim();
    throw new Error(
      stderr ||
        `PowerShell listener query exited with status ${result.status}.`,
    );
  }
  return parseWindowsListeners(result.stdout);
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
  return (
    Number(left?.ProcessId) === Number(right?.ProcessId) &&
    String(left?.Name ?? "").toLowerCase() ===
      String(right?.Name ?? "").toLowerCase() &&
    path.resolve(leftExecutable).toLowerCase() ===
      path.resolve(rightExecutable).toLowerCase() &&
    leftCreationDate === rightCreationDate
  );
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

function runTaskkill(processId, force) {
  return spawnSync(
    "taskkill",
    ["/PID", String(processId), ...(force ? ["/F"] : [])],
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
    prepareGracefulShutdown = () => undefined,
    gracefulTimeoutMs = WINDOWS_GRACEFUL_APP_EXIT_TIMEOUT_MS,
    forcedTimeoutMs = WINDOWS_PROCESS_EXIT_TIMEOUT_MS,
    log = console.log,
  } = {},
) {
  const listeners = queryListeners(processInfo);
  const clearGracefulShutdownRequest = prepareGracefulShutdown();
  try {
    log(
      `[dev] Waiting for authenticated self-shutdown of ${processInfo.Name} PID ${processInfo.ProcessId}.`,
    );
    try {
      await waitForProcessExit(processInfo, queryProcesses, gracefulTimeoutMs);
      log(
        `[dev] ${processInfo.Name} PID ${processInfo.ProcessId} exited gracefully.`,
      );
    } catch (gracefulError) {
      const current = queryProcesses().find(
        (candidate) =>
          Number(candidate.ProcessId) === Number(processInfo.ProcessId),
      );
      if (sameWindowsProcess(processInfo, current)) {
        log(
          `[dev] Authenticated self-shutdown timed out for ${processInfo.Name} PID ${processInfo.ProcessId}; using verified forced fallback.`,
        );
        const forcedResult = terminate(processInfo.ProcessId, true);
        if (forcedResult?.error) {
          throw forcedResult.error;
        }
        try {
          await waitForProcessExit(
            processInfo,
            queryProcesses,
            forcedTimeoutMs,
          );
        } catch (error) {
          throw new Error(
            `Could not stop owned ${processInfo.Name} PID ${processInfo.ProcessId}: ${String(forcedResult?.stderr ?? "").trim() || error.message}`,
          );
        }
      } else if (current) {
        throw new Error(
          `PID ${processInfo.ProcessId} was reused while waiting for ${processInfo.Name} to exit.`,
        );
      } else {
        log(
          `[dev] ${processInfo.Name} PID ${processInfo.ProcessId} exited while graceful shutdown was being checked.`,
        );
      }
    }
  } finally {
    clearGracefulShutdownRequest?.();
  }

  if (listeners.length > 0) {
    log(
      `[dev] Waiting for ${listeners.length} owned listener(s) to become reusable.`,
    );
    await waitForListenersReleased(listeners);
  }
}

async function stopWindowsProcess(
  child,
  selectDescendants,
  {
    queryProcesses = queryWindowsProcesses,
    queryListeners = queryWindowsListeners,
    terminate = runTaskkill,
    waitForProcessExit = waitForWindowsProcessExit,
    waitForListenersReleased = waitForWindowsListenersReleased,
    prepareGracefulShutdown = () => undefined,
    log = console.log,
  } = {},
) {
  const descendants = selectDescendants(queryProcesses(), child.pid);

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
    if (descendant.kind === "app") {
      await stopVerifiedWindowsApp(descendant, {
        queryProcesses,
        queryListeners,
        terminate,
        waitForProcessExit,
        waitForListenersReleased,
        prepareGracefulShutdown,
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

  // Never use taskkill /T: the debug app may have launched Codex Desktop,
  // which is an independent user application despite its inherited parent.
  if (child.exitCode === null && child.signalCode === null) {
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

async function run() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: pnpm dev:delayed -- [--delay milliseconds]

Runs Vite with immediate frontend HMR and rebuilds the Tauri backend only after
backend files have remained unchanged for the configured quiet period.

Options:
  -d, --delay <ms>  Quiet period before a backend rebuild (default: 50000)

Environment:
  TAURI_DEV_REBUILD_DELAY_MS  Same setting as --delay; CLI option takes priority

Use "pnpm dev:immediate" for Tauri's native backend watcher.`);
    return;
  }

  const delayMs = parseDelayMs(args);
  const frontendPort = parsePort();
  const devShutdownToken = randomBytes(32).toString("hex");
  const devShutdownMarker = path.join(
    tmpdir(),
    `ccswitch-dev-shutdown-${process.pid}-${randomBytes(8).toString("hex")}.token`,
  );
  const prepareGracefulShutdown = () => {
    writeFileSync(devShutdownMarker, devShutdownToken, {
      encoding: "utf8",
      flag: "w",
    });
    return () => rmSync(devShutdownMarker, { force: true });
  };
  if (await isPortOpen(frontendPort)) {
    throw new Error(
      `Port ${frontendPort} is already in use. Stop the existing dev session before running pnpm dev:delayed.`,
    );
  }

  console.log(
    `[dev] Frontend HMR is immediate; backend rebuilds after ${delayMs}ms without changes.`,
  );

  const vite = startProcess(process.execPath, [
    "./node_modules/vite/bin/vite.js",
    "--port",
    String(frontendPort),
    "--strictPort",
  ]);
  let tauri;
  let backendWatchers = [];
  let shuttingDown = false;
  let shutdownPromise;
  const expectedTauriExits = createExpectedExitRegistry();
  const backendContentTracker = createBackendContentTracker();

  const reportScheduledRebuild = (changedPaths, scheduleResult) => {
    const displayedPaths = changedPaths.slice(0, 3).join(", ");
    const extraCount = changedPaths.length - 3;
    const summary = `${displayedPaths}${extraCount > 0 ? ` (+${extraCount} more)` : ""}`;
    if (scheduleResult === "deferred") {
      console.log(
        `[dev] Backend changed while building: ${summary}; one follow-up rebuild will run after this build settles.`,
      );
      return;
    }
    console.log(
      `[dev] Backend changed: ${summary}; rebuilding after ${delayMs}ms without further backend edits.`,
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

    addWatcher(TAURI_DIR, { recursive: false }, (filename) => {
      if (!filename) {
        return null;
      }
      const relativePath = filename.toString();
      return BACKEND_ROOT_FILES.has(relativePath) ? relativePath : null;
    });
    console.log("[dev] Backend watcher armed.");
  };

  const startTauri = () => {
    let outputTail = "";
    let appStarted = false;
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
          CCSWITCH_DEV_SHUTDOWN_MARKER: devShutdownMarker,
          CCSWITCH_DEV_SHUTDOWN_TOKEN: devShutdownToken,
        },
      },
    );
    tauri = child;
    child.once("error", (error) => {
      if (!shuttingDown && tauri === child) {
        void shutdownWithError(
          new Error(`Could not start the Tauri backend: ${error.message}`),
        );
      }
    });

    const observeOutput = (chunk, destination) => {
      destination.write(chunk);
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

    child.once("exit", (code, signal) => {
      if (expectedTauriExits.consume(child)) {
        return;
      }
      if (!shuttingDown && tauri === child) {
        if (code === 0) {
          void shutdown(0);
          return;
        }
        if (rebuildGate.markFailed()) {
          console.log(
            "[dev] Build failed after an edit arrived; one follow-up rebuild remains queued.",
          );
        }
        console.log(
          `[dev] Tauri backend exited (${signal ?? `code ${code}`}); waiting for the next backend edit.`,
        );
      }
    });
  };

  const restartTauri = async () => {
    rebuildGate.markBuilding();
    backendContentTracker.beginBuild(snapshotBackendFileFingerprints());
    console.log(`[dev] Backend quiet for ${delayMs}ms; rebuilding once.`);
    const previousTauri = tauri;
    try {
      if (previousTauri) {
        expectedTauriExits.mark(previousTauri);
      }
      await stopProcessTree(previousTauri, windowsDevDescendants, {
        prepareGracefulShutdown,
      });
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
    rebuildGate.cancel();
    closeBackendWatchers();
    process.exitCode = exitCode;
    shutdownPromise = Promise.allSettled([
      stopProcessTree(tauri, windowsDevDescendants, {
        prepareGracefulShutdown,
      }),
      stopProcessTree(vite, windowsFrontendDescendants),
    ]).then((results) => {
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason?.message ?? String(result.reason));
      if (failures.length > 0) {
        process.exitCode = 1;
        console.error(`[dev] Shutdown failed: ${failures.join("; ")}`);
      }
    });
    return shutdownPromise;
  };

  const shutdownWithError = async (error) => {
    console.error(`[dev] ${error.message}`);
    await shutdown(1);
  };

  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));
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
  run().catch((error) => {
    console.error(`[dev] ${error.message}`);
    process.exitCode = 1;
  });
}
