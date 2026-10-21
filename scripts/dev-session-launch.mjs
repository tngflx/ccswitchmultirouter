import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEV_RECOVERY_POLICY, recentDevRestartTimesMs } from "./dev-watchdog-policy.mjs";
import { runWindowsJsonQuery, windowsJsonQueryCommand } from "./windows-json-query.mjs";

export const DEV_RECOVERY_FLAG = DEV_RECOVERY_POLICY.recoveryLaunchFlag;

const samePath = (left, right) =>
  typeof left === "string" &&
  typeof right === "string" &&
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

function startedAtMilliseconds(identity) {
  const value = String(identity?.CreationDate ?? "");
  const epoch = /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/.exec(value);
  return epoch ? Number(epoch[1]) : Date.parse(value);
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function supervisorCommandMatches(identity, { scriptPath, repoRoot }) {
  const command = String(identity.CommandLine ?? "").replaceAll("/", "\\");
  const absolute = escapeRegex(scriptPath.replaceAll("/", "\\"));
  const relative = escapeRegex(path.relative(repoRoot, scriptPath).replaceAll("/", "\\"));
  return (
    new RegExp(`^\\s*(?:"[^"\\r\\n]+"|[^\\s]+)\\s+(?:"(?:${absolute}|${relative})"|(?:${absolute}|${relative}))(?=\\s|$)`, "i").test(command) &&
    !/(?:^|\s)--ccsm-dev-(?:worker|watchdog)(?:\s|$)/.test(command)
  );
}

function markerMatches(session, { repoRoot, scriptPath, executable }) {
  return (
    session?.schemaVersion === 1 &&
    ["running", "stopping"].includes(session.state) &&
    Number.isInteger(session.supervisorPid) && session.supervisorPid > 0 &&
    samePath(session.repoRoot, repoRoot) &&
    samePath(session.scriptPath, scriptPath) &&
    samePath(session.supervisorExecutablePath, executable) &&
    Number.isFinite(Date.parse(session.supervisorStartedAtUtc)) &&
    Array.isArray(session.args) && session.args.every((arg) => typeof arg === "string") &&
    Array.isArray(session.roots)
  );
}

function supervisorMatches(identity, session, ownership) {
  if (!identity) return false;
  if (typeof identity.ExecutablePath !== "string" || typeof identity.CommandLine !== "string" ||
      typeof identity.CreationDate !== "string") throw new Error("Development supervisor process identity is incomplete.");
  return Number(identity.ProcessId) === session.supervisorPid &&
    samePath(identity.ExecutablePath, ownership.executable) &&
    startedAtMilliseconds(identity) === Date.parse(session.supervisorStartedAtUtc) &&
    supervisorCommandMatches(identity, ownership);
}

function ownedWatchdogs(processes, supervisor, { scriptPath, executable }) {
  const script = escapeRegex(scriptPath.replaceAll("/", "\\"));
  const exe = escapeRegex(executable.replaceAll("/", "\\"));
  const pattern = new RegExp(`^\\s*(?:"${exe}"|${exe})\\s+(?:"${script}"|${script})\\s+--ccsm-dev-watchdog\\s+(?:"${supervisor.ProcessId}"|${supervisor.ProcessId})\\s*$`, "i");
  const matches = [];
  for (const identity of processes) {
    if (Number(identity.ParentProcessId) !== Number(supervisor.ProcessId)) continue;
    const command = String(identity.CommandLine ?? "").replaceAll("/", "\\");
    if (!command.includes("--ccsm-dev-watchdog")) continue;
    if (!pattern.test(command) || !samePath(identity.ExecutablePath, executable) ||
        !Number.isFinite(startedAtMilliseconds(identity)) ||
        startedAtMilliseconds(identity) < startedAtMilliseconds(supervisor)) {
      throw new Error("Development watchdog ownership is uncertain; replacement was refused.");
    }
    matches.push(identity);
  }
  if (matches.length > 1) throw new Error("Multiple development watchdogs own the previous supervisor.");
  return matches;
}

function readStoredSession(markerPath) {
  try { return JSON.parse(readFileSync(markerPath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error("Development session marker is unreadable; replacement was refused.");
  }
}

function persistStoredSession(markerPath, session) {
  const temporary = `${markerPath}.${process.pid}.takeover.tmp`;
  writeFileSync(temporary, JSON.stringify(session));
  renameSync(temporary, markerPath);
}

export function parseDevSupervisorLaunchArgs(args) {
  if (args[0] !== DEV_RECOVERY_FLAG) return { args, mode: "explicit" };
  const expectedSupervisorPid = Number(args[1]);
  if (!Number.isInteger(expectedSupervisorPid) || expectedSupervisorPid < 1) {
    throw new Error("Automatic development recovery requires the previous supervisor PID.");
  }
  return { args: args.slice(2), mode: "recovery", expectedSupervisorPid };
}

export async function prepareDevSessionLaunch({
  markerPath, repoRoot, scriptPath, executable = process.execPath,
  mode = "explicit", expectedSupervisorPid, queryProcesses,
  stopOwnedSession = stopOwnedWindowsDevSession,
  readSession = () => readStoredSession(markerPath),
  persistSession = (session) => persistStoredSession(markerPath, session),
  assertLaunchHeld = () => {},
  now = Date.now,
  platform = process.platform,
}) {
  assertLaunchHeld();
  const previous = markerPath ? readSession() : undefined;
  if (!previous) {
    if (mode === "recovery") throw new Error("Automatic development recovery no longer owns the recorded session.");
    return { previous: undefined, restartTimesMs: [] };
  }
  const ownership = { repoRoot, scriptPath, executable };
  if (!markerMatches(previous, ownership)) throw new Error("The recorded development session belongs to a different repository or has invalid ownership metadata.");
  if (mode === "recovery" && previous.supervisorPid !== expectedSupervisorPid) {
    throw new Error("Automatic development recovery was superseded by a different session.");
  }
  const processes = queryProcesses();
  const supervisor = processes.find((candidate) => Number(candidate.ProcessId) === previous.supervisorPid);
  if (supervisor && !supervisorMatches(supervisor, previous, ownership)) {
    throw new Error("The previous development supervisor PID was reused or its process identity changed.");
  }
  if (supervisorMatches(supervisor, previous, ownership)) {
    if (mode === "recovery") throw new Error("Automatic development recovery cannot replace a healthy supervisor.");
    if (platform !== "win32") throw new Error("An existing development supervisor owns this configuration; safe replacement requires Windows process handles.");
    const watchdogs = ownedWatchdogs(processes, supervisor, ownership);
    // Stop and await every old writer before publishing a replacement marker.
    const current = readSession();
    if (!markerMatches(current, ownership) || current.supervisorPid !== previous.supervisorPid ||
        current.supervisorStartedAtUtc !== previous.supervisorStartedAtUtc) {
      throw new Error("Development session ownership changed before replacement.");
    }
    assertLaunchHeld();
    await stopOwnedSession({ markerPath, session: current, supervisor, watchdogs,
      markStopping: () => { assertLaunchHeld(); persistSession({ ...current, state: "stopping" }); } });
    assertLaunchHeld();
    const remaining = queryProcesses();
    for (const stopped of [supervisor, ...watchdogs]) {
      const live = remaining.find((candidate) => Number(candidate.ProcessId) === Number(stopped.ProcessId));
      if (live && samePath(live.ExecutablePath, stopped.ExecutablePath) &&
          startedAtMilliseconds(live) === startedAtMilliseconds(stopped)) {
        throw new Error("A previous development owner remains alive; replacement was refused.");
      }
    }
  }
  return {
    previous,
    restartTimesMs: mode === "recovery" ? recentDevRestartTimesMs(previous.restartTimesMs, now()) : [],
  };
}

export function stopOwnedWindowsDevSession({ markerPath, session, supervisor, watchdogs }) {
  const payload = Buffer.from(JSON.stringify({ markerPath, session, supervisor, watchdogs })).toString("base64");
  const script = windowsJsonQueryCommand(`
$ErrorActionPreference = 'Stop'
$proof = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$handles = [Collections.Generic.List[Diagnostics.Process]]::new()
try {
  foreach ($identity in @($proof.watchdogs) + @($proof.supervisor)) {
    $handle = Get-Process -Id $identity.ProcessId -ErrorAction Stop
    $null = $handle.Handle
    $handles.Add($handle)
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($identity.ProcessId)" -ErrorAction Stop
    $expectedCreated = ([DateTimeOffset]$identity.CreationDate).UtcTicks
    $currentCreated = ([DateTimeOffset]$current.CreationDate).UtcTicks
    $handleCreated = $handle.StartTime.ToUniversalTime().Ticks
    if ($null -eq $current -or $current.ExecutablePath -ine $identity.ExecutablePath -or
        $current.CommandLine -cne $identity.CommandLine -or
        [long]$current.ParentProcessId -ne [long]$identity.ParentProcessId -or
        $currentCreated -ne $expectedCreated -or
        ($handleCreated - ($handleCreated % 10)) -ne ($expectedCreated - ($expectedCreated % 10)) -or
        $handle.Path -ine $identity.ExecutablePath) {
      throw 'The retained development owner identity changed.'
    }
  }
  $marker = [IO.File]::ReadAllText($proof.markerPath) | ConvertFrom-Json
  if ($marker.supervisorPid -ne $proof.session.supervisorPid -or
      $marker.supervisorStartedAtUtc -ne $proof.session.supervisorStartedAtUtc -or
      $marker.repoRoot -ine $proof.session.repoRoot -or $marker.scriptPath -ine $proof.session.scriptPath -or
      $marker.state -cnotin @('running', 'stopping')) { throw 'Development marker ownership changed before stopping.' }
  $marker.state = 'stopping'
  $temporary = "$($proof.markerPath).$PID.takeover.tmp"
  [IO.File]::WriteAllText($temporary, ($marker | ConvertTo-Json -Depth 15), [Text.UTF8Encoding]::new($false))
  [IO.File]::Move($temporary, $proof.markerPath, $true)
  foreach ($handle in $handles) {
    if (-not $handle.HasExited) { $handle.Kill() }
    if (-not $handle.WaitForExit(5000)) { throw 'A retained development owner did not exit.' }
  }
  '{"stopped":true}'
} finally { foreach ($handle in $handles) { $handle.Dispose() } }
`);
  return JSON.parse(runWindowsJsonQuery(script, "development replacement", { timeoutMs: 30_000 }));
}

export async function acquireDevSessionLaunchLock({ markerPath, platform = process.platform, spawnProcess = spawn, timeoutMs = 120_000 } = {}) {
  if (!markerPath || platform !== "win32") {
    const release = async () => {};
    release.assertHeld = () => {};
    return release;
  }
  const key = createHash("sha256").update(path.resolve(markerPath).toLowerCase()).digest("hex");
  const script = windowsJsonQueryCommand(`
$ErrorActionPreference = 'Stop'
$mutex = [Threading.Mutex]::new($false, 'Local\\CCSwitchDevLaunch_${key}')
$acquired = $false
try {
  try { $acquired = $mutex.WaitOne(${timeoutMs}) } catch [Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { throw 'Timed out waiting for another development launcher.' }
  [Console]::Out.WriteLine('CCSM_LOCK_ACQUIRED')
  [Console]::Out.Flush()
  $null = [Console]::In.ReadLine()
} finally { if ($acquired) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
`);
  const child = spawnProcess("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
  });
  let acquired = false;
  let lost = false;
  let output = "";
  const completed = new Promise((resolve) => child.once("close", () => { lost = true; resolve(); }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Development launch serialization timed out.")); }, timeoutMs + 10_000);
    const done = (error) => { clearTimeout(timer); child.off("error", failed); child.stdout.off("data", read); child.off("close", closed); error ? reject(error) : resolve(); };
    const failed = () => done(new Error("PowerShell 7 (pwsh.exe) is required to serialize development launches."));
    const closed = () => { if (!acquired) done(new Error("PowerShell 7 could not acquire development launch ownership.")); };
    const read = (chunk) => { output += chunk; if (output.includes("CCSM_LOCK_ACQUIRED\n") || output.includes("CCSM_LOCK_ACQUIRED\r\n")) { acquired = true; done(); } };
    child.once("error", failed); child.once("close", closed); child.stdout.on("data", read);
  });
  child.stdin.on("error", () => {});
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    child.stdin.end("release\n");
    await completed;
  };
  release.assertHeld = () => {
    if (!acquired || lost || child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Development launch serialization ownership was lost.");
    }
  };
  return release;
}

export async function withDevSessionLaunchLock(options, action) {
  const release = await acquireDevSessionLaunchLock(options);
  try { release.assertHeld(); return await action(release.assertHeld); } finally { await release(); }
}
