import path from "node:path";
import {
  runWindowsJsonQuery,
  windowsJsonQueryCommand,
} from "./windows-json-query.mjs";

const plannedReasons = new Set([
  "development_manual_restart",
  "development_backend_reload",
  "development_requested_exit",
]);

const query = (body, name, runQuery) =>
  JSON.parse(
    runQuery(windowsJsonQueryCommand(body), name, { timeoutMs: 30_000 }),
  );

/** A planned receipt is proof of our successful native termination, never
 * merely proof that a process which was alive earlier has disappeared. */
export function stopPlannedWindowsApp(
  identity,
  {
    markerPath,
    reason,
    requireMarker = false,
    runQuery = runWindowsJsonQuery,
  } = {},
) {
  if (!plannedReasons.has(reason))
    throw new Error("Invalid planned development exit reason.");
  if (
    !markerPath ||
    !Number.isSafeInteger(identity?.ProcessId) ||
    identity.ProcessId < 1 ||
    typeof identity.ExecutablePath !== "string" ||
    typeof identity.CreationDate !== "string" ||
    ((requireMarker || identity.NativeStartedAtFiletime !== undefined) &&
      (typeof identity.NativeStartedAtFiletime !== "string" ||
        !/^[1-9]\d{0,19}$/.test(identity.NativeStartedAtFiletime) ||
        BigInt(identity.NativeStartedAtFiletime) > 18446744073709551615n))
  ) {
    throw new Error(
      "Planned development exit requires a complete process identity.",
    );
  }
  const payload = Buffer.from(
    JSON.stringify({ identity, markerPath, reason, requireMarker }),
  ).toString("base64");
  return query(
    `
$ErrorActionPreference = 'Stop'
$proof = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json -DateKind String
$markerText = if ([IO.File]::Exists($proof.markerPath)) { [IO.File]::ReadAllText($proof.markerPath) } else { $null }
$marker = if ($null -ne $markerText) { $markerText | ConvertFrom-Json -DateKind String } else { $null }
try { $handle = Get-Process -Id $proof.identity.ProcessId -ErrorAction Stop } catch {
  if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { '{"terminated":false}'; return }; throw
}
try {
  $null = $handle.Handle
  $childHandles = [Collections.Generic.List[Diagnostics.Process]]::new()
  $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($proof.identity.ProcessId)" -ErrorAction Stop
  $observedTicks = ([DateTimeOffset]$proof.identity.CreationDate).UtcTicks
  $currentTicks = if ($null -ne $current) { ([DateTimeOffset]$current.CreationDate).UtcTicks } else { 0 }
  if ($null -eq $current -or $current.ExecutablePath -ine $proof.identity.ExecutablePath -or
      $handle.Path -ine $proof.identity.ExecutablePath -or $observedTicks -ne $currentTicks -or
      ($null -ne $proof.identity.NativeStartedAtFiletime -and
       [uint64]$proof.identity.NativeStartedAtFiletime -ne [uint64]$handle.StartTime.ToUniversalTime().ToFileTimeUtc()) -or
      ($null -ne $marker -and ($marker.pid -ne $proof.identity.ProcessId -or $marker.executablePath -ine $handle.Path -or
      [string]::IsNullOrWhiteSpace([string]$marker.configScope) -or
      [string]::IsNullOrWhiteSpace([string]$marker.startedAt) -or
      [uint64]$marker.processStartedAtTicks -ne [uint64]$handle.StartTime.ToUniversalTime().ToFileTimeUtc()))) {
    throw 'Planned development app identity or marker changed.'
  }
  if ($handle.HasExited) { '{"terminated":false}'; return }
  if ($proof.requireMarker -and $null -eq $marker) { throw 'The verified development app marker disappeared before planned termination.' }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CcsmPlannedExitNative {
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool TerminateProcess(IntPtr process, uint exitCode);
}
'@
  # Retain and validate children while their parent still exists. Killing a
  # WebView child first can make the app exit naturally before our unique
  # TerminateProcess result is established, losing the planned exit proof.
  foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($proof.identity.ProcessId)" -ErrorAction Stop)) {
    try { $childHandle = Get-Process -Id $child.ProcessId -ErrorAction Stop } catch {
      if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { continue }; throw
    }
    try {
      $null = $childHandle.Handle
      if ($childHandle.Path -ine $child.ExecutablePath -or
          ($childHandle.StartTime.ToUniversalTime().Ticks - ($childHandle.StartTime.ToUniversalTime().Ticks % 10)) -ne
          ([DateTimeOffset]$child.CreationDate).UtcTicks) { throw 'Planned app child identity changed.' }
      $childHandles.Add($childHandle)
    } catch { $childHandle.Dispose(); throw }
  }
  # This unique exit code plus the native success result distinguishes our
  # termination from an app crash between observation and shutdown.
  $plannedCode = [uint32]1129534541
  if (-not [CcsmPlannedExitNative]::TerminateProcess($handle.Handle, $plannedCode)) {
    if ($handle.HasExited) { '{"terminated":false}'; return }
    throw 'The retained development app could not be terminated.'
  }
  if (-not $handle.WaitForExit(5000) -or $handle.ExitCode -ne $plannedCode) {
    throw 'The planned development app termination was not confirmed.'
  }
  # Preserve the existing /T boundary after proving our retained app stop.
  foreach ($childHandle in $childHandles) {
    if (-not $childHandle.HasExited) { $childHandle.Kill($true) }
    if (-not $childHandle.WaitForExit(5000)) { throw 'A planned app child did not exit.' }
  }
  [pscustomobject]@{ terminated=$true; markerPath=$proof.markerPath; markerText=$markerText; reason=$proof.reason } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $childHandles) { foreach ($childHandle in $childHandles) { $childHandle.Dispose() } }
  $handle.Dispose()
}
`,
    "planned development app stop",
    runQuery,
  );
}

/** Called only after the owning tree and listeners have finished cleanup. The
 * canonical exit journal retains the marker for exact startup correlation. */
export function commitPlannedDevExit(
  proof,
  { runQuery = runWindowsJsonQuery } = {},
) {
  if (!proof?.terminated || proof.markerText == null) return false;
  if (
    !plannedReasons.has(proof.reason) ||
    typeof proof.markerText !== "string" ||
    !path.isAbsolute(proof.markerPath)
  )
    throw new Error("Invalid planned development exit proof.");
  const payload = Buffer.from(JSON.stringify(proof)).toString("base64");
  return (
    query(
      `
$ErrorActionPreference = 'Stop'
$proof = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json -DateKind String
if (-not [IO.File]::Exists($proof.markerPath)) { '{"recorded":false}'; return }
if ([IO.File]::ReadAllText($proof.markerPath) -cne $proof.markerText) { throw 'Development app marker changed before planned exit commit.' }
$marker = $proof.markerText | ConvertFrom-Json -DateKind String
$live = Get-CimInstance Win32_Process -Filter "ProcessId=$($marker.pid)" -ErrorAction Stop
if ($null -ne $live) {
  $handle = Get-Process -Id $marker.pid -ErrorAction Stop
  try {
    $null = $handle.Handle
    if ($handle.Path -ieq $marker.executablePath -and
        [uint64]$handle.StartTime.ToUniversalTime().ToFileTimeUtc() -eq [uint64]$marker.processStartedAtTicks) {
      throw 'A planned development app remains alive.'
    }
  } finally { $handle.Dispose() }
}
$event = [ordered]@{
  timestamp=[DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff'); kind='planned_restart'; reason=$proof.reason;
  exitCode=0; version=$marker.version; os=$marker.os; arch=$marker.arch; pid=$marker.pid;
  details=[ordered]@{ executablePath=$marker.executablePath; processStartedAtTicks=([uint64]$marker.processStartedAtTicks).ToString(); configScope=$marker.configScope; startedAt=$marker.startedAt }
}
$eventPath = Join-Path ([IO.Path]::GetDirectoryName($proof.markerPath)) 'app-exit-events.jsonl'
[IO.File]::AppendAllText($eventPath, (($event | ConvertTo-Json -Depth 5 -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
'{"recorded":true}'
`,
      "planned development app exit commit",
      runQuery,
    ).recorded === true
  );
}
