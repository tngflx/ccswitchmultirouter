import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";

export function devRecoveryLogPath(markerPath) {
  if (typeof markerPath !== "string" || markerPath.trim() === "") {
    throw new Error(
      "Development recovery requires its configured marker path.",
    );
  }
  return path.join(path.dirname(path.resolve(markerPath)), "dev-recovery.log");
}

/**
 * A recovery launcher must survive its owner and preserve its child's output.
 * In particular, detached Windows processes cannot rely on an inherited TTY.
 * Give the child a durable append handle instead of a pipe owned by this
 * launcher. The caller continues to own publication checks and unref().
 */
export async function spawnDevRecoveryProcess(
  specification,
  { spawnProcess = spawn } = {},
) {
  const logPath = devRecoveryLogPath(specification.markerPath);
  mkdirSync(path.dirname(logPath), { recursive: true });
  let descriptor;
  let child;
  try {
    descriptor = openSync(logPath, "a");
    writeSync(
      descriptor,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "dev-recovery-launch",
        pid: process.pid,
      })}\n`,
    );
    child = spawnProcess(specification.executable, specification.args, {
      ...specification.options,
      stdio: ["ignore", descriptor, descriptor],
      detached: true,
      windowsHide: true,
    });
  } finally {
    // spawn duplicates the handles for the child synchronously. Do not retain
    // an output handle in the detached watchdog or wait for the child's exit.
    if (descriptor !== undefined) closeSync(descriptor);
  }
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
