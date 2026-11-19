import { spawn } from "node:child_process";
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export const DEV_RECOVERY_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const DEV_WATCHDOG_LOG_MAX_BYTES = 1024 * 1024;
export const RECOVERY_PRELOAD_OPTION = `--import=${new URL("./dev-recovery-output-preload.mjs", import.meta.url).href}`;
export const RECOVERY_LOG_ENV = "CCSM_DEV_RECOVERY_LOG_PATH";

let installedRecoveryLogPath;

export function devRecoveryLogPath(markerPath) {
  if (typeof markerPath !== "string" || markerPath.trim() === "") {
    throw new Error(
      "Development recovery requires its configured marker path.",
    );
  }
  return path.join(path.dirname(path.resolve(markerPath)), "dev-recovery.log");
}

// Explicit positions cap the file even when two generations briefly overlap.
// Using an append descriptor would let a concurrent writer defeat the cap.
export function appendBoundedDevLog(logPath, bytes, maxBytes) {
  let descriptor;
  try {
    try {
      descriptor = openSync(logPath, "wx+");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!lstatSync(logPath).isFile()) return;
      descriptor = openSync(logPath, "r+");
    }
    const file = fstatSync(descriptor);
    if (!file.isFile() || file.nlink !== 1) return;
    const data = bytes.subarray(Math.max(0, bytes.length - maxBytes));
    let offset = file.size;
    if (offset + data.length > maxBytes) {
      ftruncateSync(descriptor, 0);
      offset = 0;
    }
    let written = 0;
    while (written < data.length) {
      const length = writeSync(
        descriptor,
        data,
        written,
        data.length - written,
        offset + written,
      );
      if (length < 1) break;
      written += length;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function appendDevRecoveryOutput(logPath, chunk, encoding) {
  const data =
    typeof chunk === "string"
      ? Buffer.from(chunk.slice(-DEV_RECOVERY_LOG_MAX_BYTES), encoding)
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (data.length > 0) {
    appendBoundedDevLog(logPath, data, DEV_RECOVERY_LOG_MAX_BYTES);
  }
}

export function installDevRecoveryOutput() {
  const logPath = process.env[RECOVERY_LOG_ENV];
  const options = process.env.NODE_OPTIONS ?? "";
  const suffix = ` ${RECOVERY_PRELOAD_OPTION}`;
  if (
    !logPath ||
    !(options === RECOVERY_PRELOAD_OPTION || options.endsWith(suffix))
  )
    return;
  const originalOptions = options.slice(0, -suffix.length);
  if (originalOptions) process.env.NODE_OPTIONS = originalOptions;
  else delete process.env.NODE_OPTIONS;
  delete process.env[RECOVERY_LOG_ENV];
  installedRecoveryLogPath = logPath;

  for (const stream of [process.stdout, process.stderr]) {
    stream.write = (chunk, encoding, callback) => {
      try {
        appendDevRecoveryOutput(
          logPath,
          chunk,
          typeof encoding === "string" ? encoding : undefined,
        );
      } catch {
        // Full or unavailable diagnostic storage must not stop recovery.
      }
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") queueMicrotask(() => done());
      return true;
    };
  }
}

export function devRecoveryOutputInstalled() {
  return installedRecoveryLogPath !== undefined;
}

export async function spawnDevRecoveryProcess(
  specification,
  { spawnProcess = spawn } = {},
) {
  const logPath = devRecoveryLogPath(specification.markerPath);
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendDevRecoveryOutput(
      logPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "dev-recovery-launch",
        pid: process.pid,
      })}\n`,
    );
  } catch {
    // Continue launching even when diagnostics are unavailable.
  }
  const environment = specification.options?.env ?? process.env;
  // Keep the executable and exact command line the ownership probes already
  // verify. The output sink lives in the recovered process, not in its launcher.
  const child = spawnProcess(specification.executable, specification.args, {
    ...specification.options,
    env: {
      ...environment,
      NODE_OPTIONS: [environment.NODE_OPTIONS, RECOVERY_PRELOAD_OPTION]
        .filter(Boolean)
        .join(" "),
      [RECOVERY_LOG_ENV]: logPath,
    },
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("spawn", spawned);
      child.off("error", failed);
    };
    const spawned = () => {
      cleanup();
      resolve();
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    child.once("spawn", spawned);
    child.once("error", failed);
  });
  return { child, output: { mode: "log", logPath } };
}
