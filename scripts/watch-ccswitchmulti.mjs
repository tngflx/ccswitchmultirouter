import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DEV_RECOVERY_POLICY } from "./dev-watchdog-policy.mjs";
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
    MaxRestartsPerWindow: 6,
    RestartWindowMinutes: 30,
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
  let resolveLost;
  const lost = new Promise((resolve) => {
    resolveLost = resolve;
  });
  child.once("exit", () => {
    exited = true;
    held = false;
    if (!releasing) resolveLost();
  });
  child.on("error", () => {
    held = false;
    if (!releasing) resolveLost();
  });
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
        child.stdin?.end();
        if (!exited) child.kill();
        reject(error);
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
      if (exited) return;
      const completion = new Promise((resolve) => child.once("exit", resolve));
      child.stdin.end();
      let timer;
      try {
        await Promise.race([
          completion,
          new Promise((resolve) => {
            timer = setTimeout(resolve, 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (!exited) child.kill();
    },
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function inspectDevWatchdogProcesses(plan, processes) {
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
  const start = async (executable, args, options = {}) => {
    assertHeld();
    const child = spawnProcess(executable, args, {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
      ...options,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () =>
        reject(new Error("Guardian process launch failed.")),
      );
    });
    child.unref();
    return safePid(child.pid);
  };
  return {
    assertHeld,
    getProcessIdentity,
    getListenerOwner,
    isExpectedProductIdentity,
    inspectWatchdogOwnership,
    watchdogEnabled: async () =>
      (await import("./ccswitchmulti-guardian-core.mjs")).watchdogEnabled({
        configPath: plan.ConfigPath,
      }),
    isMaintenance: async () => {
      const core = await import("./ccswitchmulti-guardian-core.mjs");
      if (
        (await core.maintenanceLeaseActive({
          markerPath: plan.MaintenanceMarker,
          nowUtc: new Date(now()),
          getProcessIdentity,
        })) ||
        upgradeActive() ||
        !(await core.watchdogEnabled({ configPath: plan.ConfigPath }))
      )
        return true;
      if (!plan.DevelopmentMode) return false;
      const session = await core.devSessionRecoveryPlan({
        configPath: plan.ConfigPath,
        getProcessIdentity,
        inspectWatchdogOwnership,
      });
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
    installedExecutableExists: () => existsSync(plan.InstalledExecutable),
    getExpectedProductProcesses: () =>
      queryProcesses("Name='cc-switch.exe'").flatMap((item) => {
        const identity = getProcessIdentity(item.ProcessId);
        return isExpectedProductIdentity(identity) ? [identity] : [];
      }),
    stopVerifiedProductProcess: (identity) => {
      if (!isExpectedProductIdentity(identity))
        throw new Error("Unexpected product process identity.");
      return stopVerifiedWindowsProcess(identity, {
        query,
        expectedExecutable: identity.Path,
        assertHeld,
      });
    },
    waitPortFree: async () => {
      const deadline = now() + 20_000;
      while (now() < deadline) {
        if (getListenerOwner() === null) return true;
        await wait(500);
      }
      return false;
    },
    startProduct: () => start(plan.InstalledExecutable, []),
    startDevSession: async (devPlan) => {
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
    waitReady: async (expectedPid) => {
      const deadline = now() + plan.ReadyTimeoutSeconds * 1000;
      while (now() < deadline) {
        const identity = getProcessIdentity(expectedPid);
        if (!isExpectedProductIdentity(identity)) return false;
        if (getListenerOwner() === expectedPid && (await health())) return true;
        await wait(1000);
      }
      return false;
    },
    writeEvent: (level, event, detail = null) =>
      appendFileSync(
        plan.LogPath,
        `${JSON.stringify({ timestamp: new Date(now()).toISOString(), level, event, detail })}\n`,
        "utf8",
      ),
  };
}

export async function guardianRecoveryPolicy({
  plan,
  runtime,
  restartTimesUtc,
  core,
  nowUtc = new Date(),
}) {
  core ??= await import("./ccswitchmulti-guardian-core.mjs");
  runtime.assertHeld?.();
  const { writeEvent } = runtime;
  if (!(await runtime.watchdogEnabled()))
    return writeEvent("info", "restart-skipped-watchdog-disabled", {
      Port: plan.Port,
    });
  if (plan.NoRestart)
    return writeEvent("warning", "restart-suppressed", { Port: plan.Port });
  let devSession;
  if (plan.DevelopmentMode) {
    devSession = await core.devSessionRecoveryPlan({
      configPath: plan.ConfigPath,
      getProcessIdentity: runtime.getProcessIdentity,
      inspectWatchdogOwnership: runtime.inspectWatchdogOwnership,
    });
    if (devSession.PreventInstalledFallback && !devSession.Recoverable)
      return core.devSessionRecovery({
        plan: devSession,
        isMaintenance: runtime.isMaintenance,
        getListenerOwner: runtime.getListenerOwner,
        getProcessIdentity: runtime.getProcessIdentity,
        inspectWatchdogOwnership: runtime.inspectWatchdogOwnership,
        startDevSession: () => {
          throw new Error("Inactive development plan cannot start a process.");
        },
        assertHeld: runtime.assertHeld,
        writeEvent,
      });
  }
  if (
    (!plan.DevelopmentMode || !devSession.Recoverable) &&
    !plan.RestartOnCleanExit &&
    !(await core.guardianUncleanExit({
      configPath: plan.ConfigPath,
      getProcessIdentity: runtime.getProcessIdentity,
      expectedExecutable: plan.InstalledExecutable,
    }))
  )
    return writeEvent("info", "restart-skipped-clean-exit", {
      Port: plan.Port,
    });
  if (plan.DevelopmentMode && devSession.Recoverable)
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
  if (
    !(await core.guardianRestartBudget({
      restartTimesUtc,
      nowUtc,
      windowMinutes: plan.RestartWindowMinutes,
      maxRestarts: plan.MaxRestartsPerWindow,
    }))
  )
    return writeEvent("warning", "restart-rate-limited", {
      Port: plan.Port,
      WindowMinutes: plan.RestartWindowMinutes,
      MaxRestarts: plan.MaxRestartsPerWindow,
      RestartsInWindow: restartTimesUtc.length,
    });
  runtime.assertHeld?.();
  restartTimesUtc.push(nowUtc);
  return core.guardianRecovery({
    installedExecutable: plan.InstalledExecutable,
    ...runtime,
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
  core ??= await import("./ccswitchmulti-guardian-core.mjs");
  mkdirSync(path.dirname(plan.LockPath), { recursive: true });
  mkdirSync(path.dirname(plan.LogPath), { recursive: true });
  const lock = await acquireLock(plan.LockPath);
  runtime ??= createGuardianRuntime(plan, {
    assertHeld: () => lock.assertHeld(),
  });
  const state = { FailureSinceUtc: null };
  const restartTimesUtc = [];
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
                  restartTimesUtc,
                  core,
                  nowUtc: new Date(now()),
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

export async function guardianMain(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ["--help", "-Help", "-h"].includes(argv[0])) {
    process.stdout.write(
      "Usage: node scripts/watch-ccswitchmulti.mjs [--installed-executable PATH] [--config-path PATH] [--port PORT] [--development-mode] [--plan-only]\nProduction monitors the installed executable. Development recovery requires --development-mode. PowerShell-style named options remain accepted.\n",
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
