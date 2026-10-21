import { spawnSync } from "node:child_process";

const WINDOWS_JSON_QUERY_TIMEOUT_MS = 10_000;

export function windowsJsonQueryCommand(script) {
  return [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [Console]::OutputEncoding",
    "if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 or newer is required.' }",
    script,
  ].join("\n");
}

export function parseWindowsJsonQueryOutput(stdout, queryName) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`PowerShell ${queryName} query returned malformed JSON.`);
  }
}

export function runWindowsJsonQuery(
  script,
  queryName,
  {
    run = spawnSync,
    executable = "pwsh.exe",
    timeoutMs = WINDOWS_JSON_QUERY_TIMEOUT_MS,
  } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("A Windows JSON query requires a positive timeout.");
  }
  const result = run(
    executable,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: timeoutMs },
  );
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(
      `PowerShell 7 ${queryName} query timed out after ${timeoutMs}ms.`,
    );
  }
  if (result.error) {
    throw new Error(
      `PowerShell 7 (pwsh.exe) is required for the development ${queryName} query.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `PowerShell 7 ${queryName} query failed with status ${result.status}.`,
    );
  }
  return String(result.stdout ?? "");
}
