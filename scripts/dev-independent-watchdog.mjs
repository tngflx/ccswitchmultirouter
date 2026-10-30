import { spawnSync } from "node:child_process";
import path from "node:path";
import { windowsJsonQueryCommand } from "./windows-json-query.mjs";

// Detached libuv children still inherit an ancestor's Windows job. Launching
// the watchdog through WMI with explicit breakaway keeps pnpm's job teardown
// from killing the process that must recover that same pnpm session.
export function quoteWindowsProcessArgument(value) {
  if (typeof value !== "string" || /[\0\r\n]/.test(value)) {
    throw new Error("Independent watchdog arguments must be plain strings.");
  }
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

export function launchIndependentWindowsProcess(
  { executable, args, cwd, env },
  { run = spawnSync, powershell = "pwsh.exe", timeoutMs = 15_000 } = {},
) {
  if (
    typeof executable !== "string" ||
    !path.win32.isAbsolute(executable) ||
    !/\.exe$/i.test(executable) ||
    typeof cwd !== "string" ||
    !path.win32.isAbsolute(cwd) ||
    !Array.isArray(args) ||
    !env ||
    typeof env !== "object" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    throw new Error("Independent watchdog launch specification is invalid.");
  }
  const commandLine = [executable, ...args]
    .map(quoteWindowsProcessArgument)
    .join(" ");
  const environment = Object.entries(env).map(([name, value]) => {
    if (
      !name ||
      /[=\0\r\n]/.test(name) ||
      typeof value !== "string" ||
      value.includes("\0")
    ) {
      throw new Error("Independent watchdog environment is invalid.");
    }
    return `${name}=${value}`;
  });
  const script = windowsJsonQueryCommand(String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
if ($PSVersionTable.PSVersion -lt [version]'7.5') { throw 'powershell_version_unsupported' }
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json -DateKind String
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
  ShowWindow=[uint16]0
  CreateFlags=[uint32]0x01000000
  EnvironmentVariables=[string[]]$payload.environment
}
$createdPid = 0
$handle = $null
try {
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine=[string]$payload.commandLine
    CurrentDirectory=[string]$payload.cwd
    ProcessStartupInformation=$startup
  }
  if ($created.ReturnValue -ne 0 -or $created.ProcessId -le 0) { throw 'independent_create_failed' }
  $createdPid = [int]$created.ProcessId
  $handle = Get-Process -Id $createdPid -ErrorAction Stop
  $retained = $handle.SafeHandle
  if ($retained.IsInvalid -or $handle.HasExited) { throw 'independent_process_exited' }
  $identity = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $handle.Id) -OperationTimeoutSec 5 -ErrorAction Stop
  if ($null -eq $identity -or $handle.Path -ine $payload.executable -or $identity.ExecutablePath -ine $payload.executable -or $identity.CommandLine -cne $payload.commandLine) { throw 'independent_identity_mismatch' }
  $nativeTicks = $handle.StartTime.ToUniversalTime().Ticks
  if (($nativeTicks - ($nativeTicks % 10)) -ne ([DateTimeOffset]$identity.CreationDate).UtcTicks -or $handle.HasExited) { throw 'independent_identity_changed' }
  [pscustomobject]@{
    ProcessId=$handle.Id
    ParentProcessId=[int]$identity.ParentProcessId
    Name=[string]$identity.Name
    ExecutablePath=[string]$handle.Path
    CommandLine=[string]$identity.CommandLine
    CreationDate=$identity.CreationDate.ToUniversalTime().ToString('o')
    ProcessStartedAtTicks=$handle.StartTime.ToFileTimeUtc().ToString()
  } | ConvertTo-Json -Compress
} catch {
  # WMI Create is independent from this PowerShell process. If validation
  # fails after creation, stop only the retained process whose executable and
  # command line still match the exact launch request.
  try {
    if ($null -eq $handle -and $createdPid -gt 0) {
      $handle = Get-Process -Id $createdPid -ErrorAction Stop
      $null = $handle.SafeHandle
    }
    if ($null -ne $handle -and -not $handle.HasExited) {
      $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $handle.Id) -OperationTimeoutSec 5 -ErrorAction Stop
      if ($handle.Path -ieq $payload.executable -and
          $null -ne $current -and
          $current.ExecutablePath -ieq $payload.executable -and
          $current.CommandLine -ceq $payload.commandLine) {
        $handle.Kill()
        $null = $handle.WaitForExit(5000)
      }
    }
  } catch { }
  throw
} finally {
  if ($null -ne $handle) { $handle.Dispose() }
}
`);
  const result = run(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      input: JSON.stringify({ executable, commandLine, cwd, environment }),
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error("Independent development watchdog launch failed.");
  }
  let identity;
  try {
    identity = JSON.parse(result.stdout);
  } catch {
    throw new Error("Independent development watchdog identity is invalid.");
  }
  if (
    !Number.isSafeInteger(identity?.ProcessId) ||
    identity.ProcessId <= 0 ||
    !Number.isSafeInteger(identity.ParentProcessId) ||
    identity.ParentProcessId <= 0 ||
    identity.CommandLine !== commandLine ||
    typeof identity.ExecutablePath !== "string" ||
    identity.ExecutablePath.toLowerCase() !== executable.toLowerCase() ||
    !Number.isFinite(Date.parse(identity.CreationDate)) ||
    !/^[1-9]\d+$/.test(identity.ProcessStartedAtTicks)
  ) {
    throw new Error("Independent development watchdog identity is invalid.");
  }
  return identity;
}

export function stopIndependentWindowsProcess(
  identity,
  { run = spawnSync, powershell = "pwsh.exe", timeoutMs = 15_000 } = {},
) {
  if (
    !identity ||
    !Number.isSafeInteger(identity.ProcessId) ||
    identity.ProcessId < 1 ||
    typeof identity.ExecutablePath !== "string" ||
    !path.win32.isAbsolute(identity.ExecutablePath) ||
    typeof identity.CommandLine !== "string" ||
    typeof identity.ProcessStartedAtTicks !== "string" ||
    !/^\d+$/.test(identity.ProcessStartedAtTicks) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  )
    throw new Error("Independent watchdog identity is invalid.");
  const script = windowsJsonQueryCommand(String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
if ($PSVersionTable.PSVersion -lt [version]'7.5') { throw 'powershell_version_unsupported' }
$identity = [Console]::In.ReadToEnd() | ConvertFrom-Json -DateKind String
try { $handle = Get-Process -Id ([int]$identity.ProcessId) -ErrorAction Stop } catch {
  if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') {
    '{"stopped":false,"absent":true}'
    return
  }
  throw
}
try {
  $retained = $handle.SafeHandle
  if ($retained.IsInvalid) { throw 'independent_handle_invalid' }
  $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $handle.Id) -OperationTimeoutSec 5 -ErrorAction Stop
  $nativeTicks = $handle.StartTime.ToFileTimeUtc().ToString()
  if ($null -eq $current -or $handle.Path -ine $identity.ExecutablePath -or
      $current.ExecutablePath -ine $identity.ExecutablePath -or
      $current.CommandLine -cne $identity.CommandLine -or
      $nativeTicks -cne $identity.ProcessStartedAtTicks) {
    throw 'independent_identity_changed'
  }
  if (-not $handle.HasExited) { $handle.Kill() }
  if (-not $handle.WaitForExit(5000)) { throw 'independent_process_did_not_exit' }
  '{"stopped":true,"absent":false}'
} finally { $handle.Dispose() }
`);
  const result = run(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      input: JSON.stringify(identity),
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error("Independent development watchdog cleanup failed.");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Independent development watchdog cleanup is invalid.");
  }
}
