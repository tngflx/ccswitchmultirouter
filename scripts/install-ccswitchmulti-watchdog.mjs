import { randomUUID } from "node:crypto";
import {
  existsSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseWindowsJsonQueryOutput,
  runWindowsJsonQuery,
  windowsJsonQueryCommand,
} from "./windows-json-query.mjs";

const SCRIPT_ROOT = fileURLToPath(new URL(".", import.meta.url));
export const GUARDIAN_RUNTIME_FILES = Object.freeze([
  "watch-ccswitchmulti.mjs",
  "ccswitchmulti-guardian-core.mjs",
  "windows-json-query.mjs",
  "dev-watchdog-policy.mjs",
  "dev-recovery-policy.json",
]);

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

export function assertGuardianNodeVersion(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map(Number);
  if (
    !Number.isInteger(major) ||
    !Number.isInteger(minor) ||
    major < 22 ||
    (major === 22 && minor < 12)
  )
    throw new Error("The JavaScript watchdog requires Node.js 22.12 or newer.");
}

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
  const prelude = taskCommandPrelude({ ...options, expectedTask });
  if (!["register", "unregister", "start"].includes(operation))
    throw new Error("Unknown watchdog task operation.");
  const body =
    operation === "register"
      ? `$action = New-ScheduledTaskAction -Execute $config.nodeExecutable -Argument $config.taskArguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentSid
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $currentSid -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskPath '\\' -TaskName $config.taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`
      : operation === "unregister"
        ? `if ($null -ne $config.expectedTask) { Unregister-ScheduledTask -TaskPath '\\' -TaskName $config.taskName -Confirm:$false -ErrorAction Stop }`
        : `Start-ScheduledTask -TaskPath '\\' -TaskName $config.taskName -ErrorAction Stop`;
  return `${prelude}\nAssert-UnchangedWatchdogTask\n${body}\n[pscustomobject]@{ok=$true} | ConvertTo-Json -Compress`;
}

export function assertGuardianRootSafe(root) {
  let current = root;
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error(
        "The guardian directory must not traverse a symbolic link or junction.",
      );
    if (existsSync(current) && !lstatSync(current).isDirectory())
      throw new Error("The guardian directory must contain directories only.");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function stageGuardianRuntime({
  sourceRoot = SCRIPT_ROOT,
  guardianRoot,
}) {
  assertGuardianRootSafe(guardianRoot);
  const files = GUARDIAN_RUNTIME_FILES.map((name) => {
    const source = path.join(sourceRoot, name);
    const target = path.join(guardianRoot, name);
    if (
      !existsSync(source) ||
      !lstatSync(source).isFile() ||
      lstatSync(source).isSymbolicLink()
    )
      throw new Error(
        "A required JavaScript guardian runtime file is missing.",
      );
    if (
      existsSync(target) &&
      (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink())
    )
      throw new Error("A guardian runtime target is not a regular file.");
    return {
      target,
      content: readFileSync(source),
      previous: existsSync(target) ? readFileSync(target) : null,
    };
  });
  return () => {
    assertGuardianRootSafe(guardianRoot);
    mkdirSync(guardianRoot, { recursive: true });
    const applied = [];
    const rollback = () => {
      for (const file of applied.toReversed()) {
        if (file.previous === null) rmSync(file.target, { force: true });
        else writeFileSync(file.target, file.previous);
      }
    };
    try {
      for (const file of files) {
        const temporary = `${file.target}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, file.content, { flag: "wx" });
          renameSync(temporary, file.target);
          applied.push(file);
        } finally {
          rmSync(temporary, { force: true });
        }
      }
      return rollback;
    } catch (error) {
      rollback();
      throw error;
    }
  };
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

export function guardianStartupReceiptMatches(logPath, identity, startedAtMs) {
  let descriptor;
  try {
    descriptor = openSync(logPath, "r");
    const length = fstatSync(descriptor).size;
    const offset = Math.max(0, length - 65_536);
    const bytes = Buffer.alloc(Math.min(length, 65_536));
    const read = readSync(descriptor, bytes, 0, bytes.length, offset);
    const lines = bytes.subarray(0, read).toString("utf8").split(/\r?\n/u);
    if (offset > 0) lines.shift();
    return lines.some((line) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        return false;
      }
      return (
        record?.event === "guardian-started" &&
        Date.parse(record.timestamp) >= startedAtMs &&
        record.detail?.GuardianProcessId === identity.pid &&
        record.detail?.GuardianStartTimeUtc === identity.startedAtUtc
      );
    });
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw new Error("Cannot read the JavaScript guardian startup receipt.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export async function waitForGuardianStartup(
  options,
  {
    inspect,
    startedAtMs,
    now = Date.now,
    wait = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    lockExists = (value) => existsSync(value),
    startupReceiptMatches = guardianStartupReceiptMatches,
    timeoutMs = 45_000,
  } = {},
) {
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    const snapshot = await inspect();
    validateSnapshot(snapshot, options);
    if (
      !snapshot.task ||
      !sameWindowsPath(
        snapshot.task.actions[0].execute,
        options.nodeExecutable,
      ) ||
      snapshot.task.actions[0].arguments !== guardianTaskArguments(options)
    )
      throw new Error(
        "The JavaScript watchdog task action changed while waiting for startup.",
      );
    const processes = ownedGuardianProcesses(snapshot, options).filter(
      (identity) =>
        path.win32.basename(identity.executablePath).toLowerCase() ===
          "node.exe" &&
        sameWindowsPath(identity.executablePath, options.nodeExecutable) &&
        Date.parse(identity.startedAtUtc) >= startedAtMs,
    );
    if (processes.length > 1)
      throw new Error("More than one owned JavaScript watchdog started.");
    if (
      processes.length === 1 &&
      lockExists(path.win32.join(options.guardianRoot, "guardian.lock")) &&
      startupReceiptMatches(
        path.win32.join(options.guardianRoot, "guardian.jsonl"),
        processes[0],
        startedAtMs,
      )
    )
      return processes[0].pid;
    if (now() >= deadline) break;
    await wait(Math.min(2000, deadline - now()));
  }
  throw new Error(
    "The JavaScript watchdog did not publish a process and lock before the startup deadline.",
  );
}

export async function installGuardian(options_, dependencies = {}) {
  if (options_.help) throw new Error("Help is a CLI-only option.");
  if (!options_.uninstall) assertGuardianNodeVersion(dependencies.nodeVersion);
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
    guardianRoot: options.guardianRoot,
    nodeExecutable: options.nodeExecutable,
    taskArguments: guardianTaskArguments(options),
    stoppedProcesses: [],
    dryRun: options.dryRun,
  };
  let applyRuntime;
  if (!options.uninstall) {
    const checkFile =
      dependencies.isRegularFile ??
      ((value) => existsSync(value) && lstatSync(value).isFile());
    if (!checkFile(options.nodeExecutable))
      throw new Error("The scheduled Node.js executable is unavailable.");
    if (!checkFile(options.installedExecutable))
      throw new Error("The installed application executable is missing.");
    applyRuntime = (dependencies.stageRuntime ?? stageGuardianRuntime)({
      sourceRoot: dependencies.sourceRoot ?? SCRIPT_ROOT,
      guardianRoot: options.guardianRoot,
    });
  }
  if (options.dryRun)
    return {
      ...baseResult,
      operation: options.uninstall ? "uninstall" : "install",
      matchingProcesses: ownedProcesses.map(({ pid }) => pid),
      runtimeFiles: options.uninstall ? [] : GUARDIAN_RUNTIME_FILES,
    };
  if (options.uninstall) {
    await mutate("unregister", snapshot.task);
    for (const identity of ownedProcesses) {
      await stop(identity);
      baseResult.stoppedProcesses.push(identity.pid);
    }
    // Keep lock, logs, maintenance leases, and unrelated files. Uninstall owns
    // the task and exact process identities, never a recursive directory delete.
    return { ...baseResult, taskRemoved: Boolean(snapshot.task) };
  }
  for (const identity of ownedProcesses) {
    await stop(identity);
    baseResult.stoppedProcesses.push(identity.pid);
  }
  const rollback = applyRuntime();
  try {
    await mutate("register", snapshot.task);
  } catch (error) {
    rollback();
    throw error;
  }
  if (!options.noStart) {
    const registered = await inspect();
    validateSnapshot(registered, options);
    if (
      !registered.task ||
      registered.task.actions[0].execute !== options.nodeExecutable ||
      registered.task.actions[0].arguments !== guardianTaskArguments(options)
    )
      throw new Error(
        "The registered JavaScript watchdog task does not match the requested action.",
      );
    const startedAtMs = (dependencies.now ?? Date.now)();
    await mutate("start", registered.task);
    baseResult.watcherPid = await (
      dependencies.waitForStartup ?? waitForGuardianStartup
    )(options, {
      inspect,
      startedAtMs,
      now: dependencies.now,
      wait: dependencies.wait,
      lockExists: dependencies.lockExists,
      startupReceiptMatches: dependencies.startupReceiptMatches,
    });
  }
  return { ...baseResult, installed: true, startRequested: !options.noStart };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const cliOptions = parseGuardianInstallerArguments(process.argv.slice(2));
    if (cliOptions.help) {
      process.stdout.write(
        "Usage: node scripts/install-ccswitchmulti-watchdog.mjs [options]\n\nInstalls the current-user production watchdog with Node.js 22.12 or newer.\nWindows task and identity APIs use inline PowerShell 7 commands.\n\n  --guardian-root PATH\n  --task-name NAME\n  --installed-executable PATH\n  --config-path PATH\n  --port NUMBER\n  --poll-seconds NUMBER\n  --failure-threshold-seconds NUMBER\n  --no-start\n  --uninstall\n  --dry-run\n  --help\n\nLegacy -GuardianRoot/-TaskName/-InstalledExecutable/-ConfigPath/-Port/\n-PollSeconds/-FailureThresholdSeconds/-NoStart/-Uninstall are accepted.\n",
      );
    } else {
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
