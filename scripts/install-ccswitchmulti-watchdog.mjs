import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  parseWindowsJsonQueryOutput,
  runWindowsJsonQuery,
  windowsJsonQueryCommand,
} from "./windows-json-query.mjs";

const VALUE_OPTIONS = new Map(
  [
    ["GuardianRoot", "guardianRoot"],
    ["TaskName", "taskName"],
    ["InstalledExecutable", "installedExecutable"],
    ["Port", "port"],
    ["PollSeconds", "pollSeconds"],
    ["FailureThresholdSeconds", "failureThresholdSeconds"],
    ["ConfigPath", "configPath"],
  ].flatMap(([legacy, key]) => [
    [`-${legacy.toLowerCase()}`, key],
    [`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, key],
  ]),
);
const SWITCH_OPTIONS = new Map([
  ["-uninstall", "uninstall"],
  ["--uninstall", "uninstall"],
  ["-nostart", "noStart"],
  ["--no-start", "noStart"],
  ["-dryrun", "dryRun"],
  ["--dry-run", "dryRun"],
  ["-help", "help"],
  ["--help", "help"],
]);

export function parseGuardianInstallerArguments(arguments_) {
  const result = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index].toLowerCase();
    const key = VALUE_OPTIONS.get(argument) ?? SWITCH_OPTIONS.get(argument);
    if (!key) throw new Error("Unknown watchdog installer option.");
    if (Object.hasOwn(result, key))
      throw new Error("A watchdog installer option was specified twice.");
    if (SWITCH_OPTIONS.has(argument)) {
      result[key] = true;
    } else {
      if (index + 1 >= arguments_.length)
        throw new Error("A watchdog installer option requires a value.");
      result[key] = arguments_[++index];
    }
  }
  return result;
}

function safeString(value, label) {
  if (typeof value !== "string" || !value || /[\0\r\n]/u.test(value))
    throw new Error(`A valid ${label} is required.`);
  return value;
}

export function normalizeGuardianInstallerOptions(
  options,
  { environment = process.env, executable = process.execPath } = {},
) {
  const localAppData = environment.LOCALAPPDATA;
  const userProfile = environment.USERPROFILE;
  const resolvePath = (value, label) => {
    safeString(value, label);
    if (!path.win32.isAbsolute(value))
      throw new Error(`The ${label} must be an absolute Windows path.`);
    return path.win32.normalize(value);
  };
  const positiveInteger = (value, label, maximum = Number.MAX_SAFE_INTEGER) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum)
      throw new Error(`The ${label} must be a positive integer.`);
    return parsed;
  };
  const guardianRoot = resolvePath(
    options.guardianRoot ??
      (localAppData && path.win32.join(localAppData, "CCSwitchMultiGuardian")),
    "guardian root",
  );
  if (guardianRoot === path.win32.parse(guardianRoot).root)
    throw new Error("The guardian root must not be a filesystem root.");
  const taskName = safeString(
    options.taskName ?? "CCSwitchMulti-Watchdog",
    "task name",
  );
  if (/[\\/<>:"|?*]/u.test(taskName) || taskName.length > 238)
    throw new Error("The watchdog task must be a single task name.");
  const nodeExecutable = resolvePath(executable, "Node executable");
  if (path.win32.basename(nodeExecutable).toLowerCase() !== "node.exe")
    throw new Error("The watchdog requires an installed Node.js executable.");
  return {
    guardianRoot,
    taskName,
    installedExecutable: resolvePath(
      options.installedExecutable ??
        (localAppData &&
          path.win32.join(localAppData, "CCSwitchMulti", "cc-switch.exe")),
      "installed executable",
    ),
    configPath: resolvePath(
      options.configPath ??
        (userProfile && path.win32.join(userProfile, ".cc-switch")),
      "configuration path",
    ),
    nodeExecutable,
    port: positiveInteger(options.port ?? 15721, "port", 65535),
    pollSeconds: positiveInteger(options.pollSeconds ?? 5, "poll interval"),
    failureThresholdSeconds: positiveInteger(
      options.failureThresholdSeconds ?? 60,
      "failure threshold",
    ),
    uninstall: options.uninstall === true,
    noStart: options.noStart === true,
    dryRun: options.dryRun === true,
  };
}

export function quoteWindowsArgument(value) {
  if (!/[\s"]/u.test(value) && value) return value;
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;
}

// CommandLineToArgvW's quote/backslash rules. Path ownership is checked against
// complete argument tokens, never a substring in another process's arguments.
export function splitWindowsArguments(commandLine) {
  const arguments_ = [];
  let index = 0;
  while (index < commandLine.length) {
    while (/\s/u.test(commandLine[index] ?? "") && index < commandLine.length)
      index += 1;
    if (index === commandLine.length) break;
    let value = "";
    let quoted = false;
    while (index < commandLine.length) {
      if (!quoted && /\s/u.test(commandLine[index])) break;
      let slashes = 0;
      while (commandLine[index] === "\\") {
        slashes += 1;
        index += 1;
      }
      if (commandLine[index] === '"') {
        value += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) value += '"';
        else quoted = !quoted;
        index += 1;
      } else {
        value += "\\".repeat(slashes);
        if (!quoted && /\s/u.test(commandLine[index] ?? "")) break;
        if (index < commandLine.length) value += commandLine[index++];
      }
    }
    if (quoted)
      throw new Error("A watchdog command line has unmatched quotes.");
    arguments_.push(value);
  }
  return arguments_;
}

function sameWindowsPath(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    path.win32.isAbsolute(left) &&
    path.win32.isAbsolute(right) &&
    path.win32.normalize(left).toLowerCase() ===
      path.win32.normalize(right).toLowerCase()
  );
}

export function ownsGuardianAction(action, options) {
  if (
    !action ||
    typeof action.execute !== "string" ||
    typeof action.arguments !== "string"
  )
    return false;
  let arguments_;
  try {
    arguments_ = splitWindowsArguments(action.arguments);
  } catch {
    return false;
  }
  const host = path.win32.basename(action.execute).toLowerCase();
  const script = path.win32.join(
    options.guardianRoot,
    "watch-ccswitchmulti.mjs",
  );
  const legacy = path.win32.join(
    options.guardianRoot,
    "watch-ccswitchmulti.ps1",
  );
  if (host === "node.exe") return sameWindowsPath(arguments_[0], script);
  if (!["pwsh.exe", "powershell.exe"].includes(host)) return false;
  const fileIndex = arguments_.findIndex(
    (value) => value.toLowerCase() === "-file",
  );
  return (
    fileIndex >= 0 &&
    !arguments_.some((value) =>
      ["-command", "-encodedcommand", "-c", "-ec"].includes(
        value.toLowerCase(),
      ),
    ) &&
    arguments_.filter((value) => value.toLowerCase() === "-file").length ===
      1 &&
    sameWindowsPath(arguments_[fileIndex + 1], legacy)
  );
}

export function ownedGuardianProcesses(snapshot, options) {
  return (snapshot.processes ?? []).filter((identity) => {
    if (
      identity.ownerSid !== snapshot.currentSid ||
      !Number.isSafeInteger(identity.pid) ||
      identity.pid <= 0 ||
      typeof identity.commandLine !== "string" ||
      typeof identity.startedAtUtc !== "string"
    )
      return false;
    let arguments_;
    try {
      arguments_ = splitWindowsArguments(identity.commandLine);
    } catch {
      return false;
    }
    return (
      sameWindowsPath(arguments_[0], identity.executablePath) &&
      ownsGuardianAction(
        {
          execute: identity.executablePath,
          arguments: arguments_.slice(1).map(quoteWindowsArgument).join(" "),
        },
        options,
      )
    );
  });
}

export function guardianTaskArguments(options) {
  return [
    path.win32.join(options.guardianRoot, "watch-ccswitchmulti.mjs"),
    "--installed-executable",
    options.installedExecutable,
    "--port",
    String(options.port),
    "--poll-seconds",
    String(options.pollSeconds),
    "--failure-threshold-seconds",
    String(options.failureThresholdSeconds),
    "--config-path",
    options.configPath,
    "--lock-path",
    path.win32.join(options.guardianRoot, "guardian.lock"),
    "--log-path",
    path.win32.join(options.guardianRoot, "guardian.jsonl"),
    "--maintenance-marker",
    path.win32.join(options.guardianRoot, "maintenance.lock"),
  ]
    .map(quoteWindowsArgument)
    .join(" ");
}

function encodedConfiguration(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function taskCommandPrelude(configuration) {
  return windowsJsonQueryCommand(`
$ErrorActionPreference = 'Stop'
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedConfiguration(configuration)}')) | ConvertFrom-Json
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Read-WatchdogTask {
  $task = @(Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop | Where-Object { $_.TaskName -ieq $config.taskName })
  if ($task.Count -eq 0) { return $null }
  if ($task.Count -ne 1) { throw 'Ambiguous watchdog task identity.' }
  if ([string]$task[0].Principal.UserId -match '^S-1-') { $ownerSid = [string]$task[0].Principal.UserId }
  else { $ownerSid = ([Security.Principal.NTAccount]::new([string]$task[0].Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value }
  return [pscustomobject]@{ ownerSid=$ownerSid; actions=@($task[0].Actions | ForEach-Object { [pscustomobject]@{execute=[string]$_.Execute; arguments=[string]$_.Arguments} }); state=[string]$task[0].State }
}
function Assert-UnchangedWatchdogTask {
  $current = Read-WatchdogTask
  if ($null -eq $config.expectedTask) {
    if ($null -ne $current) { throw 'Watchdog task ownership changed.' }
  } else {
    if ($null -eq $current -or $current.ownerSid -cne $currentSid -or $current.ownerSid -cne $config.expectedTask.ownerSid) { throw 'Watchdog task ownership changed.' }
    if (($current.actions | ConvertTo-Json -Compress -Depth 5) -cne ($config.expectedTask.actions | ConvertTo-Json -Compress -Depth 5)) { throw 'Watchdog task action changed.' }
  }
}
`);
}

export function guardianSnapshotCommand(options) {
  return `${taskCommandPrelude(options)}
$paths = @([IO.Path]::Combine($config.guardianRoot, 'watch-ccswitchmulti.mjs'), [IO.Path]::Combine($config.guardianRoot, 'watch-ccswitchmulti.ps1'))
$processes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='pwsh.exe' OR Name='powershell.exe'" -ErrorAction Stop | Where-Object {
  $line = [string]$_.CommandLine
  @($paths | Where-Object { $line.Contains($_, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
} | ForEach-Object {
  $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop
  if ($owner.ReturnValue -ne 0 -or -not $owner.Sid) { throw 'Cannot establish watchdog process ownership.' }
  $handle = Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop
  try {
    $null = $handle.Handle
    if (-not [string]::Equals([string]$handle.Path, [string]$_.ExecutablePath, [StringComparison]::OrdinalIgnoreCase) -or
        [Math]::Abs(($handle.StartTime.ToUniversalTime() - $_.CreationDate.ToUniversalTime()).Ticks) -ge 10) { throw 'Watchdog process identity changed during inspection.' }
    [pscustomobject]@{pid=[int]$_.ProcessId; executablePath=[string]$_.ExecutablePath; commandLine=[string]$_.CommandLine; startedAtUtc=$handle.StartTime.ToUniversalTime().ToString('o'); cimStartedAtUtc=$_.CreationDate.ToUniversalTime().ToString('o'); ownerSid=[string]$owner.Sid}
  } finally { $handle.Dispose() }
})
[pscustomobject]@{currentSid=$currentSid; task=(Read-WatchdogTask); processes=$processes} | ConvertTo-Json -Compress -Depth 8
`;
}

export function guardianTaskMutationCommand(operation, options, expectedTask) {
  // This compatibility boundary may retire an owned legacy task, never create
  // or start another production recovery owner. Refuse before even serializing
  // configuration so direct imports have the same fail-closed contract.
  if (operation !== "unregister")
    throw new Error("Legacy watchdog task migration only supports unregister.");
  if (expectedTask !== null) {
    validateSnapshot(
      {
        currentSid: expectedTask?.ownerSid,
        task: expectedTask,
        processes: [],
      },
      options,
    );
  }
  const prelude = taskCommandPrelude({ ...options, expectedTask });
  const body = `if ($null -ne $config.expectedTask) { Unregister-ScheduledTask -TaskPath '\\' -TaskName $config.taskName -Confirm:$false -ErrorAction Stop }`;
  return `${prelude}\nAssert-UnchangedWatchdogTask\n${body}\n[pscustomobject]@{ok=$true} | ConvertTo-Json -Compress`;
}

function queryWindows(script, name, queryOptions) {
  return parseWindowsJsonQueryOutput(
    runWindowsJsonQuery(windowsJsonQueryCommand(script), name, queryOptions),
    name,
  );
}

function validateSnapshot(snapshot, options) {
  if (
    !snapshot ||
    typeof snapshot.currentSid !== "string" ||
    !snapshot.currentSid.startsWith("S-1-")
  )
    throw new Error("Cannot establish the current Windows user identity.");
  if (
    !Array.isArray(snapshot.processes) ||
    !Object.hasOwn(snapshot, "task") ||
    snapshot.processes.some(
      (identity) =>
        !identity ||
        !Number.isSafeInteger(identity.pid) ||
        identity.pid <= 0 ||
        typeof identity.executablePath !== "string" ||
        !path.win32.isAbsolute(identity.executablePath) ||
        typeof identity.commandLine !== "string" ||
        !identity.commandLine ||
        typeof identity.ownerSid !== "string" ||
        !identity.ownerSid.startsWith("S-1-") ||
        typeof identity.startedAtUtc !== "string" ||
        !Number.isFinite(Date.parse(identity.startedAtUtc)),
    )
  )
    throw new Error("The watchdog ownership inspection is incomplete.");
  if (
    snapshot.task &&
    (snapshot.task.ownerSid !== snapshot.currentSid ||
      !Array.isArray(snapshot.task.actions) ||
      snapshot.task.actions.length !== 1 ||
      !ownsGuardianAction(snapshot.task.actions[0], options))
  )
    throw new Error(
      "The named scheduled task is not owned by this user and guardian directory.",
    );
}

export async function installGuardian(options_ = {}, dependencies = {}) {
  if (options_?.help) throw new Error("Help is a CLI-only option.");
  // Enforce singular Rust production ownership for imports as well as the CLI.
  // Check the raw option before normalization or observing any dependency;
  // only an explicit boolean uninstall request may touch legacy task state.
  assertProductionGuardianInstallSupported(options_);
  const options = normalizeGuardianInstallerOptions(options_, dependencies);
  const query = dependencies.query ?? queryWindows;
  const inspect =
    dependencies.inspect ??
    (() =>
      query(guardianSnapshotCommand(options), "watchdog installer inspection"));
  const mutate =
    dependencies.mutate ??
    ((operation, expectedTask) =>
      query(
        guardianTaskMutationCommand(
          operation,
          { ...options, taskArguments: guardianTaskArguments(options) },
          expectedTask,
        ),
        "watchdog scheduled task",
      ));
  const stop =
    dependencies.stop ??
    (async (identity) => {
      const { stopVerifiedWindowsProcess } =
        await import("./watch-ccswitchmulti.mjs");
      return stopVerifiedWindowsProcess(
        {
          ProcessId: identity.pid,
          Path: identity.executablePath,
          CommandLine: identity.commandLine,
          StartTimeUtc: identity.startedAtUtc,
          CimStartTimeUtc: identity.cimStartedAtUtc,
        },
        {
          query,
          expectedExecutable: identity.executablePath,
          expectedOwnerSid: identity.ownerSid,
          expectedCommandLine: identity.commandLine,
        },
      );
    });
  const snapshot = await inspect();
  validateSnapshot(snapshot, options);
  const ownedProcesses = ownedGuardianProcesses(snapshot, options);
  const baseResult = {
    taskName: options.taskName,
    taskPresent: Boolean(snapshot.task),
    guardianRoot: options.guardianRoot,
    nodeExecutable: options.nodeExecutable,
    taskArguments: guardianTaskArguments(options),
    stoppedProcesses: [],
    dryRun: options.dryRun,
  };
  if (options.dryRun)
    return {
      ...baseResult,
      operation: "uninstall",
      matchingProcesses: ownedProcesses.map(({ pid }) => pid),
      runtimeFiles: [],
    };
  await mutate("unregister", snapshot.task);
  for (const identity of ownedProcesses) {
    await stop(identity);
    baseResult.stoppedProcesses.push(identity.pid);
  }
  // Keep lock, logs, maintenance leases, and unrelated files. Uninstall owns
  // the task and exact process identities, never a recursive directory delete.
  return { ...baseResult, taskRemoved: Boolean(snapshot.task) };
}

export function assertProductionGuardianInstallSupported(options) {
  if (options?.uninstall !== true) {
    throw new Error(
      "Production recovery now uses the built-in Rust watchdog. Enable it in Settings > Connections > Crash recovery. The legacy scheduled guardian cannot be installed; use --uninstall to remove an existing task.",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const cliOptions = parseGuardianInstallerArguments(process.argv.slice(2));
    if (cliOptions.help) {
      process.stdout.write(
        "Usage: node scripts/install-ccswitchmulti-watchdog.mjs [options]\n\nLegacy scheduled watchdog migration tool. New installs are disabled: production recovery is controlled by the built-in Rust watchdog in Settings > Connections > Crash recovery. Existing owned tasks can be removed with --uninstall. Node.js 22.12 or newer is needed for legacy inspection.\nWindows task and identity APIs use inline PowerShell 7 commands.\n\n  --guardian-root PATH\n  --task-name NAME\n  --installed-executable PATH\n  --config-path PATH\n  --port NUMBER\n  --poll-seconds NUMBER\n  --failure-threshold-seconds NUMBER\n  --no-start\n  --uninstall\n  --dry-run\n  --help\n\nLegacy -GuardianRoot/-TaskName/-InstalledExecutable/-ConfigPath/-Port/\n-PollSeconds/-FailureThresholdSeconds/-NoStart/-Uninstall are accepted.\n",
      );
    } else {
      assertProductionGuardianInstallSupported(cliOptions);
      if (process.platform !== "win32")
        throw new Error("The scheduled watchdog installer requires Windows.");
      const result = await installGuardian(cliOptions, {
        executable: realpathSync(process.execPath),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
