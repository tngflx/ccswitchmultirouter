import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DEV_RECOVERY_POLICY } from "./dev-watchdog-policy.mjs";
import { inspectCanonicalDevWatchdog } from "./dev-watchdog-identity.mjs";
import { spawnDevRecoveryProcess } from "./dev-recovery-output.mjs";
import {
  devSessionEnvironment,
  samePath,
} from "./ccswitchmulti-guardian-core.mjs";
import {
  parseWindowsJsonQueryOutput,
  runWindowsJsonQuery,
  windowsJsonQueryCommand,
} from "./windows-json-query.mjs";

const booleanOptions = new Set([
  "RestartOnCleanExit",
  "NoRestart",
  "DevelopmentMode",
  "PlanOnly",
]);
const numberOptions = new Set([
  "Port",
  "FailureThresholdSeconds",
  "PollSeconds",
  "ReadyTimeoutSeconds",
  "MaxRestartsPerWindow",
  "RestartWindowMinutes",
  "MaxCycles",
]);
const optionKey = (name) =>
  name.replace(/^-+/, "").replaceAll("-", "").toLowerCase();
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const GUARDIAN_LOG_MAX_BYTES = 1024 * 1024;
const GUARDIAN_LOG_RETAIN_BYTES = 512 * 1024;
const GUARDIAN_LOG_MAX_RECORD_BYTES = 64 * 1024;

function readBoundedGuardianLogTail(descriptor, size) {
  const start = Math.max(0, size - GUARDIAN_LOG_RETAIN_BYTES);
  const offset = Math.max(0, start - 1);
  const buffer = Buffer.alloc(size - offset);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const count = readSync(
      descriptor,
      buffer,
      bytesRead,
      buffer.length - bytesRead,
      offset + bytesRead,
    );
    if (count === 0) break;
    bytesRead += count;
  }
  const retained = buffer.subarray(0, bytesRead);
  // Include the preceding byte so a record starting at the cutoff is kept.
  const separator = start > 0 ? retained.indexOf(0x0a) : -1;
  return start > 0 && separator === -1
    ? retained.subarray(bytesRead)
    : retained.subarray(separator + 1);
}

function appendBoundedGuardianLog(logPath, record) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const recordBytes = Buffer.from(`${record}\n`, "utf8");
  const descriptor = openSync(logPath, "a+");
  let compacted;
  try {
    const size = fstatSync(descriptor).size;
    if (size + recordBytes.length + 1 > GUARDIAN_LOG_MAX_BYTES) {
      const retained = readBoundedGuardianLogTail(descriptor, size);
      const parts = [retained];
      if (retained.length > 0 && retained.at(-1) !== 0x0a)
        parts.push(Buffer.from("\n"));
      parts.push(recordBytes);
      compacted = Buffer.concat(parts);
    } else {
      const last = Buffer.alloc(1);
      const torn =
        size > 0 &&
        readSync(descriptor, last, 0, 1, size - 1) === 1 &&
        last[0] !== 0x0a;
      appendFileSync(
        descriptor,
        torn ? Buffer.concat([Buffer.from("\n"), recordBytes]) : recordBytes,
      );
    }
  } finally {
    closeSync(descriptor);
  }
  // Windows append handles cannot truncate. Only the lock owner writes here.
  if (compacted) writeFileSync(logPath, compacted);
}

function serializeGuardianLogRecord(timestamp, level, event, detail) {
  const record = JSON.stringify({ timestamp, level, event, detail });
  if (Buffer.byteLength(record, "utf8") + 1 <= GUARDIAN_LOG_MAX_RECORD_BYTES)
    return record;
  return JSON.stringify({
    timestamp,
    level,
    event,
    detail: "[detail truncated: guardian record exceeded 64 KiB]",
  });
}

function waitForGuardianChild(child, timeoutMs, stop) {
  if (child.exitCode != null || child.signalCode != null)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("close", onExit);
    try {
      stop();
    } catch {
      // A stop error does not prove the process is gone. Wait for an exit
      // or close event, but do not hold up recovery past the deadline.
    }
  });
}
const psString = (value) => `'${String(value).replaceAll("'", "''")}'`;
const safePid = (value) => {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid process identity.");
  return value;
};

export function parseGuardianArgs(argv, { environment = process.env } = {}) {
  const guardianRoot = path.join(
    environment.LOCALAPPDATA ?? "",
    "CCSwitchMultiGuardian",
  );
  const plan = {
    InstalledExecutable: path.resolve(
      environment.LOCALAPPDATA ?? "",
      "CCSwitchMulti",
      "cc-switch.exe",
    ),
    Port: 15721,
    HealthUri: "http://127.0.0.1:15721/health",
    FailureThresholdSeconds: 60,
    PollSeconds: 5,
    ReadyTimeoutSeconds: 45,
    MaintenanceMarker: path.resolve(guardianRoot, "maintenance.lock"),
    LogPath: path.resolve(guardianRoot, "guardian.jsonl"),
    LockPath: path.resolve(guardianRoot, "guardian.lock"),
    ConfigPath: path.resolve(
      environment.USERPROFILE ?? environment.HOME ?? "",
      ".cc-switch",
    ),
    // Keep compatibility mode on the same bounded budget as the canonical
    // dev supervisor policy. The Rust supervisor is the release owner; this
    // JS guardian is only a legacy fallback when explicitly enabled.
    MaxRestartsPerWindow: DEV_RECOVERY_POLICY.maxRestarts,
    RestartWindowMinutes: DEV_RECOVERY_POLICY.restartWindowMs / 60_000,
    RestartOnCleanExit: false,
    NoRestart: false,
    DevelopmentMode: false,
    PlanOnly: false,
    MaxCycles: 0,
  };
  const names = new Map(
    Object.keys(plan).map((name) => [optionKey(name), name]),
  );
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const match = /^(--?[^=:]+)(?:[=:](.*))?$/.exec(argv[index]);
    if (!match) throw new Error("Unexpected guardian argument.");
    const key = names.get(optionKey(match[1]));
    if (!key || seen.has(key))
      throw new Error("Unknown or duplicate guardian option.");
    seen.add(key);
    let value = match[2];
    if (booleanOptions.has(key)) {
      if (
        value === undefined &&
        /^(?:\$?(?:true|false)|0|1)$/i.test(argv[index + 1] ?? "")
      )
        value = argv[++index];
      if (value === undefined) value = "true";
      if (!/^(?:\$?(?:true|false)|0|1)$/i.test(value))
        throw new Error("Invalid guardian switch value.");
      plan[key] = /^(?:\$?true|1)$/i.test(value);
    } else {
      if (value === undefined) value = argv[++index];
      if (value === undefined || value === "" || value.includes("\0"))
        throw new Error("Missing guardian option value.");
      plan[key] = numberOptions.has(key) ? Number(value) : value;
    }
  }
  for (const key of numberOptions) {
    if (
      !Number.isSafeInteger(plan[key]) ||
      plan[key] < (key === "MaxCycles" ? 0 : 1)
    )
      throw new Error(
        "Guardian timing, port, and budget values must be positive integers.",
      );
  }
  if (plan.Port > 65535) throw new Error("Invalid guardian port.");
  if (!seen.has("HealthUri"))
    plan.HealthUri = `http://127.0.0.1:${plan.Port}/health`;
  for (const key of [
    "InstalledExecutable",
    "MaintenanceMarker",
    "LogPath",
    "LockPath",
    "ConfigPath",
  ])
    plan[key] = path.resolve(plan[key]);
  return plan;
}

export function windowsGuardianQuery(script, queryName, options) {
  return parseWindowsJsonQueryOutput(
    runWindowsJsonQuery(windowsJsonQueryCommand(script), queryName, options),
    queryName,
  );
}

export function guardianProcessIdentity(
  processId,
  { query = windowsGuardianQuery } = {},
) {
  const pid = safePid(processId);
  return query(
    `try { $h = Get-Process -Id ${pid} -ErrorAction Stop } catch {
  if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { 'null'; return }
  throw
}
try {
  $null = $h.Handle
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop
  if ($null -eq $p -or [string]::IsNullOrWhiteSpace([string]$h.Path) -or
      -not [string]::Equals([string]$h.Path, [string]$p.ExecutablePath, [StringComparison]::OrdinalIgnoreCase) -or
      [Math]::Abs(($h.StartTime.ToUniversalTime() - $p.CreationDate.ToUniversalTime()).Ticks) -ge 10) { throw 'Process observation changed.' }
  [pscustomobject]@{ProcessId=[int]$p.ProcessId; ParentProcessId=[int]$p.ParentProcessId; Path=$p.ExecutablePath; CommandLine=$p.CommandLine; StartTimeUtc=$h.StartTime.ToUniversalTime().ToString('o'); CimStartTimeUtc=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress
} finally { $h.Dispose() }`,
    "guardian process identity",
  );
}

export function stopVerifiedWindowsProcess(
  expected,
  {
    query = windowsGuardianQuery,
    expectedExecutable = expected?.Path,
    expectedCommandLine,
    expectedOwnerSid,
    assertHeld = () => {},
  } = {},
) {
  const pid = safePid(expected?.ProcessId);
  if (
    typeof expected.StartTimeUtc !== "string" ||
    !expected.StartTimeUtc ||
    typeof expectedExecutable !== "string" ||
    !path.isAbsolute(expectedExecutable)
  )
    throw new Error("Incomplete verified process identity.");
  assertHeld();
  const commandCheck =
    expectedCommandLine === undefined
      ? ""
      : `if (-not [string]::Equals([string]$p.CommandLine, ${psString(expectedCommandLine)}, [StringComparison]::Ordinal)) { throw 'Process command identity changed.' }`;
  const ownerCheck =
    expectedOwnerSid === undefined
      ? ""
      : `$owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop
if ($owner.ReturnValue -ne 0 -or -not [string]::Equals([string]$owner.Sid, ${psString(expectedOwnerSid)}, [StringComparison]::Ordinal)) { throw 'Process owner identity changed.' }`;
  return query(
    `$h = Get-Process -Id ${pid} -ErrorAction Stop
try {
  $null = $h.Handle
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop
  if ($null -eq $p -or -not [string]::Equals([string]$h.Path, ${psString(expectedExecutable)}, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([string]$p.ExecutablePath, ${psString(expectedExecutable)}, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals($h.StartTime.ToUniversalTime().ToString('o'), ${psString(expected.StartTimeUtc)}, [StringComparison]::Ordinal)) { throw 'Process identity changed before stop.' }
  ${commandCheck}
  ${ownerCheck}
  $null = $h.CloseMainWindow()
  if (-not $h.WaitForExit(10000)) {
    $h.Kill()
    if (-not $h.WaitForExit(10000)) { throw 'Verified process did not exit.' }
  }
  'true'
} finally { $h.Dispose() }`,
    "verified guardian process stop",
    { timeoutMs: 25_000 },
  );
}

export async function acquireGuardianLock(
  lockPath,
  { spawnProcess = spawn, executable = "pwsh.exe", timeoutMs = 10_000 } = {},
) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  // FileShare.None preserves the same native lock used by older installed guardians.
  // The child owns only this Windows API boundary; JavaScript owns all recovery policy.
  const script = windowsJsonQueryCommand(`$lock = $null
try {
  $lock = [IO.File]::Open(${psString(lockPath)}, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  [Console]::Out.WriteLine('locked'); [Console]::Out.Flush()
  while ($null -ne [Console]::In.ReadLine()) {}
} finally { if ($null -ne $lock) { $lock.Dispose() } }`);
  const child = spawnProcess(
    executable,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let held = false;
  let releasing = false;
  let exited = false;
  const cleanupTimeoutMs = Math.min(timeoutMs, 5_000);
  let resolveLost;
  const lost = new Promise((resolve) => {
    resolveLost = resolve;
  });
  const markExited = () => {
    child.off("exit", markExited);
    child.off("close", markExited);
    exited = true;
    held = false;
    if (!releasing) resolveLost();
  };
  const markChildError = () => {
    held = false;
    if (!releasing) resolveLost();
  };
  const detachChildObservers = () => {
    child.off("exit", markExited);
    child.off("close", markExited);
    child.off("error", markChildError);
  };
  child.once("exit", markExited);
  child.once("close", markExited);
  child.on("error", markChildError);
  child.stdin?.on("error", () => {});
  child.stderr?.resume();
  await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => finish(new Error("Guardian lock acquisition timed out.")),
      timeoutMs,
    );
    const onError = () =>
      finish(
        new Error("PowerShell 7 is required to acquire the guardian lock."),
      );
    const onExit = () =>
      finish(
        new Error("Another guardian owns the lock or lock access failed."),
      );
    const onData = (data) => {
      buffer += String(data);
      if (buffer.trim() === "locked") {
        held = true;
        finish();
      } else if (buffer.length > 256)
        finish(new Error("Invalid guardian lock response."));
    };
    function finish(error) {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdout.off("data", onData);
      if (error) {
        void (async () => {
          const stopped =
            exited ||
            (await waitForGuardianChild(child, cleanupTimeoutMs, () => {
              child.stdin?.end();
              if (!exited) child.kill();
            }));
          reject(
            stopped
              ? error
              : new Error(
                  `${error.message} Guardian lock keeper did not exit after termination.`,
                  { cause: error },
                ),
          );
          detachChildObservers();
        })();
      } else resolve();
    }
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout.on("data", onData);
  });
  return {
    lost,
    assertHeld() {
      if (!held || exited)
        throw new Error("Guardian native lock ownership was lost.");
    },
    async release() {
      releasing = true;
      held = false;
      if (exited) {
        detachChildObservers();
        return;
      }
      try {
        if (
          !(await waitForGuardianChild(child, cleanupTimeoutMs, () =>
            child.stdin.end(),
          )) &&
          !(await waitForGuardianChild(child, cleanupTimeoutMs, () =>
            child.kill(),
          ))
        ) {
          throw new Error(
            "Guardian lock keeper did not exit after termination.",
          );
        }
      } finally {
        detachChildObservers();
      }
    },
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function inspectDevWatchdogProcesses(plan, processes) {
  const canonical = inspectCanonicalDevWatchdog(plan.Session, processes, {
    executable: plan.Executable,
    scriptPath: plan.ScriptPath,
    supervisorPid: plan.SupervisorPid,
  });
  if (canonical.canonical)
    return {
      Active: canonical.identity !== null,
      Unknown: canonical.unknown,
    };
  const ownership = { Active: false, Unknown: false };
  const executable = escapeRegex(plan.Executable.replaceAll("/", "\\"));
  const script = escapeRegex(plan.ScriptPath.replaceAll("/", "\\"));
  const pattern = new RegExp(
    `^\\s*(?:"${executable}"|${executable})\\s+(?:"${script}"|${script})\\s+--ccsm-dev-watchdog\\s+(?:"${plan.SupervisorPid}"|${plan.SupervisorPid})\\s*$`,
    "i",
  );
  for (const item of processes) {
    if (
      typeof item.ExecutablePath === "string" &&
      item.ExecutablePath &&
      !samePath(item.ExecutablePath, plan.Executable)
    )
      continue;
    if (
      typeof item.CommandLine === "string" &&
      item.CommandLine &&
      !pattern.test(item.CommandLine.replaceAll("/", "\\"))
    )
      continue;
    if (
      Number.isSafeInteger(item.ParentProcessId) &&
      item.ParentProcessId > 0 &&
      item.ParentProcessId !== plan.SupervisorPid
    )
      continue;
    if (
      !item.ExecutablePath ||
      !item.CommandLine ||
      !Number.isSafeInteger(item.ParentProcessId) ||
      item.ParentProcessId < 1 ||
      !Number.isSafeInteger(item.ProcessId) ||
      item.ProcessId < 1 ||
      !Number.isFinite(Date.parse(item.CreationDate))
    ) {
      ownership.Unknown = true;
      continue;
    }
    if (
      Date.parse(item.CreationDate) <
      Date.parse(plan.Session.supervisorStartedAtUtc)
    )
      continue;
    ownership.Active = true;
    return ownership;
  }
  return ownership;
}

export function createGuardianRuntime(
  plan,
  {
    query = windowsGuardianQuery,
    spawnProcess = spawn,
    fetchHealth = fetch,
    now = Date.now,
    wait = sleep,
    assertHeld = () => {},
    environment = process.env,
  } = {},
) {
  const getProcessIdentity = (pid) => guardianProcessIdentity(pid, { query });
  const getListenerOwner = () => {
    const owner = query(
      `$connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq ${plan.Port} -and $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::','::1') })
if ($connections.Count -eq 0) { 'null' } else { [int]$connections[0].OwningProcess | ConvertTo-Json -Compress }`,
      "guardian listener",
    );
    return owner === null ? null : safePid(owner);
  };
  const isExpectedProductIdentity = (identity) =>
    identity != null &&
    samePath(identity.Path, plan.InstalledExecutable) &&
    path.basename(identity.Path).toLowerCase() === "cc-switch.exe";
  const health = async () => {
    try {
      const response = await fetchHealth(plan.HealthUri, {
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      await response.body?.cancel();
      return response.status >= 200 && response.status < 300;
    } catch {
      return false;
    }
  };
  const queryProcesses = (filter) =>
    query(
      `$items = @(Get-CimInstance Win32_Process -Filter ${psString(filter)} -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ProcessId=[int]$_.ProcessId; ParentProcessId=[int]$_.ParentProcessId; ExecutablePath=$_.ExecutablePath; CommandLine=$_.CommandLine; CreationDate=$_.CreationDate.ToUniversalTime().ToString('o')} })
ConvertTo-Json -InputObject $items -Compress`,
      "guardian owned processes",
    );
  const inspectWatchdogOwnership = (devPlan) => {
    try {
      return inspectDevWatchdogProcesses(
        devPlan,
        queryProcesses("Name='node.exe'"),
      );
    } catch {
      return { Active: false, Unknown: true };
    }
  };
  const upgradeActive = () => {
    const items = queryProcesses(
      "Name='powershell.exe' OR Name='pwsh.exe' OR Name='node.exe' OR Name='uninstall.exe' OR Name LIKE 'CCSwitchMulti%setup.exe'",
    );
    return items.some(
      (item) =>
        /(?:^|[\s"\\/])install-ccswitchmulti-transaction\.(?:ps1|mjs)(?=$|[\s"])/i.test(
          item.CommandLine ?? "",
        ) ||
        samePath(
          item.ExecutablePath,
          path.join(path.dirname(plan.InstalledExecutable), "uninstall.exe"),
        ) ||
        /^CCSwitchMulti.*setup\.exe$/i.test(
          path.basename(item.ExecutablePath ?? ""),
        ),
    );
  };
  const readDevSession = async (core) =>
    plan.DevelopmentMode
      ? core.devSessionRecoveryPlan({
          configPath: plan.ConfigPath,
          getProcessIdentity,
          inspectWatchdogOwnership,
        })
      : null;
  const effectiveWatchdogEnabled = (core, session) =>
    core.watchdogEnabled({
      configPath: plan.ConfigPath,
      // Match the active owner's contract: release recovery ignores dev-only
      // variables; a detached dev guardian honors its owner's saved override.
      environment: plan.DevelopmentMode
        ? { ...environment, ...session?.Environment }
        : {},
    });
  return {
    assertHeld,
    getProcessIdentity,
    getListenerOwner,
    isExpectedProductIdentity,
    inspectWatchdogOwnership,
    watchdogEnabled: async () => {
      const core = await import("./ccswitchmulti-guardian-core.mjs");
      return effectiveWatchdogEnabled(core, await readDevSession(core));
    },
    isMaintenance: async () => {
      const core = await import("./ccswitchmulti-guardian-core.mjs");
      const session = await readDevSession(core);
      if (
        (await core.maintenanceLeaseActive({
          markerPath: plan.MaintenanceMarker,
          nowUtc: new Date(now()),
          getProcessIdentity,
        })) ||
        upgradeActive() ||
        !effectiveWatchdogEnabled(core, session)
      )
        return true;
      if (!session) return false;
      return (
        session.Active ||
        session.WatchdogActive ||
        session.WatchdogOwnershipUnknown ||
        session.State === "stopping"
      );
    },
    inspectRuntime: async () => {
      const owner = getListenerOwner();
      if (owner === null) return { Healthy: false, ListenerOwner: null };
      try {
        return {
          Healthy:
            isExpectedProductIdentity(getProcessIdentity(owner)) &&
            (await health()),
          ListenerOwner: owner,
        };
      } catch {
        return { Healthy: false, ListenerOwner: owner };
      }
    },
    startDevSession: async (devPlan) => {
      if (plan.DevelopmentMode !== true || plan.NoRestart === true)
        throw new Error(
          "Native launch requires explicit development recovery without --no-restart.",
        );
      assertHeld();
      const { child } = await spawnDevRecoveryProcess(
        {
          executable: devPlan.Executable,
          markerPath: path.join(plan.ConfigPath, "logs", "dev-session.json"),
          args: [
            devPlan.ScriptPath,
            DEV_RECOVERY_POLICY.recoveryLaunchFlag,
            String(safePid(devPlan.SupervisorPid)),
            ...devPlan.Args,
          ],
          options: {
            cwd: devPlan.RepoRoot,
            env: {
              ...process.env,
              ...devSessionEnvironment(devPlan.Environment),
            },
          },
        },
        { spawnProcess },
      );
      child.unref();
      return safePid(child.pid);
    },
    writeEvent: (level, event, detail = null) => {
      const timestamp = new Date(now()).toISOString();
      const record = serializeGuardianLogRecord(
        timestamp,
        level,
        event,
        detail,
      );
      appendBoundedGuardianLog(plan.LogPath, record);
    },
  };
}

export async function guardianRecoveryPolicy({ plan, runtime, core }) {
  // Enforce ownership here too, not only in the CLI. Imported callers cannot
  // authorize production recovery or consume an independent restart budget.
  if (plan.DevelopmentMode !== true)
    return runtime.writeEvent("info", "production-recovery-owned-by-rust", {
      Port: plan.Port,
    });
  core ??= await import("./ccswitchmulti-guardian-core.mjs");
  runtime.assertHeld?.();
  const { writeEvent } = runtime;
  if (!(await runtime.watchdogEnabled()))
    return writeEvent("info", "restart-skipped-watchdog-disabled", {
      Port: plan.Port,
    });
  if (plan.NoRestart)
    return writeEvent("warning", "restart-suppressed", { Port: plan.Port });
  const devSession = await core.devSessionRecoveryPlan({
    configPath: plan.ConfigPath,
    getProcessIdentity: runtime.getProcessIdentity,
    inspectWatchdogOwnership: runtime.inspectWatchdogOwnership,
  });
  // Missing or invalid dev evidence must never reach installed-app recovery.
  return core.devSessionRecovery({
    plan: devSession,
    isMaintenance: runtime.isMaintenance,
    getListenerOwner: runtime.getListenerOwner,
    getProcessIdentity: runtime.getProcessIdentity,
    inspectWatchdogOwnership: runtime.inspectWatchdogOwnership,
    startDevSession: runtime.startDevSession,
    assertHeld: runtime.assertHeld,
    writeEvent,
  });
}

export async function runGuardian(
  plan,
  {
    runtime,
    core,
    acquireLock = acquireGuardianLock,
    now = Date.now,
    wait = sleep,
  } = {},
) {
  if (!legacyProductionGuardianAllowed(plan))
    throw new Error(
      "Production recovery is owned by the built-in Rust watchdog. Use --no-restart for read-only diagnostics or --development-mode for a recorded dev session.",
    );
  core ??= await import("./ccswitchmulti-guardian-core.mjs");
  mkdirSync(path.dirname(plan.LockPath), { recursive: true });
  mkdirSync(path.dirname(plan.LogPath), { recursive: true });
  const lock = await acquireLock(plan.LockPath);
  runtime ??= createGuardianRuntime(plan, {
    assertHeld: () => lock.assertHeld(),
  });
  const state = { FailureSinceUtc: null };
  let cycles = 0;
  let cancelled = false;
  const runtimeAssertHeld = runtime.assertHeld;
  runtime = {
    ...runtime,
    assertHeld: () => {
      if (cancelled)
        throw new Error("Guardian native lock ownership was lost.");
      lock.assertHeld();
      runtimeAssertHeld?.();
    },
  };
  try {
    lock.assertHeld();
    const ownIdentity = await runtime.getProcessIdentity(process.pid);
    if (
      ownIdentity?.ProcessId !== process.pid ||
      !samePath(ownIdentity.Path, process.execPath) ||
      typeof ownIdentity.StartTimeUtc !== "string" ||
      !Number.isFinite(Date.parse(ownIdentity.StartTimeUtc))
    )
      throw new Error("Cannot verify guardian process ownership.");
    runtime.assertHeld();
    runtime.writeEvent("info", "guardian-started", {
      ...plan,
      GuardianProcessId: process.pid,
      GuardianStartTimeUtc: ownIdentity.StartTimeUtc,
    });
    const loop = async () => {
      while (true) {
        if (cancelled) return;
        lock.assertHeld();
        cycles++;
        await core.guardianSafeIteration({
          writeEvent: runtime.writeEvent,
          action: () =>
            core.guardianIteration({
              state,
              nowUtc: new Date(now()),
              failureThresholdSeconds: plan.FailureThresholdSeconds,
              isMaintenance: runtime.isMaintenance,
              inspectRuntime: runtime.inspectRuntime,
              recover: () =>
                guardianRecoveryPolicy({
                  plan,
                  runtime,
                  core,
                }),
              writeEvent: runtime.writeEvent,
            }),
        });
        if (cancelled) return;
        lock.assertHeld();
        if (plan.MaxCycles > 0 && cycles >= plan.MaxCycles) return;
        await wait(plan.PollSeconds * 1000);
      }
    };
    await Promise.race([
      loop(),
      lock.lost.then(() => {
        cancelled = true;
        throw new Error("Guardian native lock ownership was lost.");
      }),
    ]);
  } catch (error) {
    runtime.writeEvent("error", "guardian-exiting", {
      Error: error.message,
      Cycles: cycles,
    });
    throw error;
  } finally {
    cancelled = true;
    await lock.release();
  }
}

export function legacyProductionGuardianAllowed(plan) {
  // The release app owns its own recovery. Keep this script available for
  // bounded, read-only production diagnostics and explicit dev recovery only.
  return plan.DevelopmentMode === true || plan.NoRestart === true;
}

export async function guardianMain(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ["--help", "-Help", "-h"].includes(argv[0])) {
    process.stdout.write(
      "Usage: node scripts/watch-ccswitchmulti.mjs [--installed-executable PATH] [--config-path PATH] [--port PORT] [--no-restart | --development-mode] [--plan-only]\nProduction diagnostics require --no-restart; release recovery is owned by the built-in Rust watchdog. Development recovery requires --development-mode and a valid recorded dev session, and never falls back to the installed app. PowerShell-style named options remain accepted.\n",
    );
    return;
  }
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12))
    throw new Error(
      "The guardian requires Node.js 22.12 or newer for exact process identity JSON.",
    );
  const plan = parseGuardianArgs(argv);
  if (plan.PlanOnly) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (process.platform !== "win32")
    throw new Error("The installed guardian requires Windows.");
  // Release recovery is owned by the built-in Rust supervisor. Refuse old
  // scheduled restart entry points so a stale port or independent restart
  // budget cannot race the app's settings-controlled recovery owner.
  if (!legacyProductionGuardianAllowed(plan)) {
    process.stdout.write(
      "Production recovery is owned by the built-in Rust watchdog. Use Settings > Connections > Crash recovery; this JavaScript guardian supports --no-restart diagnostics or explicit --development-mode only.\n",
    );
    return;
  }
  await runGuardian(plan);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  guardianMain().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
