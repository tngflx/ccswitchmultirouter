$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function ConvertTo-CcsmGuardianCanonicalPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@([char]92, [char]47))
}

function ConvertTo-CcsmGuardianHostLocalPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $canonical = ConvertTo-CcsmGuardianCanonicalPath -Path $Path
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { return $canonical }
    $localAppData = ConvertTo-CcsmGuardianCanonicalPath -Path $env:LOCALAPPDATA
    $escaped = [regex]::Escape($localAppData)
    $pattern = "^$escaped\\Packages\\OpenAI\.Codex_[^\\]+\\LocalCache\\Local(?:\\(?<relative>.*))?$"
    $match = [regex]::Match($canonical, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) { return $canonical }
    $relative = [string]$match.Groups["relative"].Value
    if ([string]::IsNullOrWhiteSpace($relative)) { return $localAppData }
    return ConvertTo-CcsmGuardianCanonicalPath -Path (Join-Path $localAppData $relative)
}

function Test-CcsmGuardianSamePath {
    param([string]$Left, [string]$Right)

    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
        return $false
    }
    return [string]::Equals(
        (ConvertTo-CcsmGuardianHostLocalPath -Path $Left),
        (ConvertTo-CcsmGuardianHostLocalPath -Path $Right),
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function ConvertTo-CcsmGuardianUtc {
    param([Parameter(Mandatory = $true)]$Value)

    if ($Value -is [datetimeoffset]) { return $Value.ToUniversalTime() }
    if ($Value -is [datetime]) { return [datetimeoffset]$Value.ToUniversalTime() }
    $parsed = [datetimeoffset]::MinValue
    $styles = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor
        [System.Globalization.DateTimeStyles]::AdjustToUniversal
    if (-not [datetimeoffset]::TryParse(
            [string]$Value,
            [System.Globalization.CultureInfo]::InvariantCulture,
            $styles,
            [ref]$parsed
        )) {
        throw "invalid UTC timestamp"
    }
    return $parsed.ToUniversalTime()
}

function Get-CcsmGuardianProcessIdentity {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    $handle = Get-Process -Id $ProcessId -ErrorAction Stop
    return [pscustomobject]@{
        ProcessId = $ProcessId
        Path = [string]$process.ExecutablePath
        CommandLine = [string]$process.CommandLine
        StartTimeUtc = $handle.StartTime.ToUniversalTime().ToString("o")
        CimStartTimeUtc = $process.CreationDate.ToUniversalTime().ToString("o")
    }
}

function Test-CcsmGuardianAbsolutePath {
    param([string]$Path)

    return -not [string]::IsNullOrWhiteSpace($Path) -and
        [System.IO.Path]::IsPathRooted($Path) -and [System.IO.Path]::GetPathRoot($Path).Length -gt 1
}

function Test-CcsmGuardianPathInside {
    param([string]$ParentPath, [string]$CandidatePath)

    if (-not (Test-CcsmGuardianAbsolutePath $ParentPath) -or
        -not (Test-CcsmGuardianAbsolutePath $CandidatePath)) { return $false }
    $parent = (ConvertTo-CcsmGuardianCanonicalPath $ParentPath) + [System.IO.Path]::DirectorySeparatorChar
    $candidate = ConvertTo-CcsmGuardianCanonicalPath $CandidatePath
    return $candidate.StartsWith($parent, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-CcsmGuardianWatchdogEnabled {
    param([Parameter(Mandatory = $true)][string]$ConfigPath)

    $settingsPath = Join-Path $ConfigPath "settings.json"
    if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) { return $true }
    try {
        $settings = [System.IO.File]::ReadAllText($settingsPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        foreach ($name in @("watchdogEnabled", "watchdog_enabled")) {
            if ($settings.PSObject.Properties.Name -contains $name) {
                $value = $settings.$name
                if ($value -is [bool]) { return $value }
                return $true
            }
        }
        return $true
    } catch {
        return $false
    }
}

function Get-CcsmDevSessionEnvironment {
    param($Environment)

    $result = @{}
    foreach ($name in @("TAURI_DEV_REBUILD_DELAY_MS", "TAURI_DEV_NO_REBUILD", "TAURI_DEV_PORT", "CC_SWITCH_TEST_HOME", "CC_SWITCH_DEV_WATCHDOG_ENABLED")) {
        $value = $null
        if ($Environment -is [System.Collections.IDictionary]) {
            if ($Environment.Keys -ccontains $name) { $value = $Environment[$name] }
        } elseif ($null -ne $Environment -and $Environment.PSObject.Properties.Name -ccontains $name) {
            $value = $Environment.$name
        }
        if ($value -is [string] -and $value.IndexOf([char]0) -lt 0) { $result[$name] = $value }
    }
    return $result
}

function Get-CcsmDevSessionRecoveryPlan {
    param(
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [Parameter(Mandatory = $true)][scriptblock]$GetProcessIdentity
    )

    $plan = [pscustomobject]@{
        Exists = $false; Active = $false; Recoverable = $false; PreventInstalledFallback = $false
        State = ""; Executable = ""; ScriptPath = ""; RepoRoot = ""; Args = @(); Roots = @(); Environment = @{}
        SupervisorPid = 0; Marker = $null
    }
    $sessionPath = Join-Path $ConfigPath "logs\dev-session.json"
    if (-not (Test-Path -LiteralPath $sessionPath -PathType Leaf)) { return $plan }
    $plan.Exists = $true
    # Even an unreadable dev marker must not select the installed binary instead.
    $plan.PreventInstalledFallback = $true
    try {
        $session = [System.IO.File]::ReadAllText($sessionPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ([int]$session.schemaVersion -ne 1 -or $session.state -notin @("running", "stopping") -or
            -not (Test-CcsmGuardianAbsolutePath ([string]$session.repoRoot)) -or
            -not (Test-CcsmGuardianAbsolutePath ([string]$session.scriptPath))) { return $plan }
        $repoRoot = ConvertTo-CcsmGuardianCanonicalPath ([string]$session.repoRoot)
        $scriptPath = ConvertTo-CcsmGuardianCanonicalPath ([string]$session.scriptPath)
        if (-not (Test-CcsmGuardianSamePath $scriptPath (Join-Path $repoRoot "scripts\dev-tauri-delayed.mjs")) -or
            -not (Test-Path -LiteralPath $scriptPath -PathType Leaf) -or
            -not (Test-Path -LiteralPath (Join-Path $repoRoot "package.json") -PathType Leaf)) { return $plan }
        $plan.State = [string]$session.state
        $plan.RepoRoot = $repoRoot
        $plan.ScriptPath = $scriptPath
        $markerPath = Join-Path $ConfigPath "logs\app-run-marker.json"
        if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
            try {
                $plan.Marker = [System.IO.File]::ReadAllText($markerPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
            } catch { }
        }
        if ([int]$session.supervisorPid -lt 1 -or
            -not (Test-CcsmGuardianAbsolutePath ([string]$session.supervisorExecutablePath)) -or
            -not [string]::Equals([System.IO.Path]::GetFileName([string]$session.supervisorExecutablePath),
                "node.exe", [System.StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath ([string]$session.supervisorExecutablePath) -PathType Leaf) -or
            $session.args -isnot [array] -or $session.roots -isnot [array]) { return $plan }
        foreach ($argument in $session.args) {
            if ($argument -isnot [string] -or $argument.IndexOf([char]0) -ge 0 -or $argument -match "[\r\n]") {
                return $plan
            }
        }
        foreach ($root in $session.roots) {
            if ([int]$root.pid -lt 1 -or $root.role -notin @("tauri", "vite") -or
                [int]$root.identity.ProcessId -ne [int]$root.pid -or
                -not (Test-CcsmGuardianAbsolutePath ([string]$root.identity.ExecutablePath)) -or
                [string]::IsNullOrWhiteSpace([string]$root.identity.CreationDate)) { return $plan }
        }
        $expectedStart = ConvertTo-CcsmGuardianUtc $session.supervisorStartedAtUtc
        $null = ConvertTo-CcsmGuardianUtc $session.startedAtUtc
        $plan.Executable = ConvertTo-CcsmGuardianCanonicalPath ([string]$session.supervisorExecutablePath)
        $plan.SupervisorPid = [int]$session.supervisorPid
        $plan.Args = @($session.args)
        $plan.Roots = @($session.roots)
        if ($session.PSObject.Properties.Name -contains "environment") {
            $plan.Environment = Get-CcsmDevSessionEnvironment $session.environment
        }
        $owner = $null
        try { $owner = & $GetProcessIdentity $plan.SupervisorPid } catch { }
        if ($null -ne $owner -and [int]$owner.ProcessId -eq $plan.SupervisorPid -and
            (Test-CcsmGuardianSamePath ([string]$owner.Path) $plan.Executable)) {
            $actualStartText = [string]$owner.StartTimeUtc
            if ($owner.PSObject.Properties.Name -contains "CimStartTimeUtc") {
                $actualStartText = [string]$owner.CimStartTimeUtc
            }
            $actualStart = ConvertTo-CcsmGuardianUtc $actualStartText
            # Node's Date.toISOString() preserves milliseconds from CIM CreationDate.
            $sameStart = $expectedStart.ToUnixTimeMilliseconds() -eq $actualStart.ToUnixTimeMilliseconds()
            $commandLine = ([string]$owner.CommandLine).Replace('/', '\')
            $scriptToken = '(?:^|[\s"])(?:' + [regex]::Escape($scriptPath) + '|' +
                [regex]::Escape('scripts\dev-tauri-delayed.mjs') + ')(?=$|[\s"])'
            $plan.Active = $sameStart -and [regex]::IsMatch($commandLine, $scriptToken,
                [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        }
        $plan.Recoverable = -not $plan.Active -and $plan.State -eq "running"
    } catch {
        $plan.Active = $false
        $plan.Recoverable = $false
    }
    return $plan
}

function Test-CcsmDevSessionListenerIdentity {
    param([Parameter(Mandatory = $true)]$Plan, [Parameter(Mandatory = $true)]$Identity)

    try {
        $marker = $Plan.Marker
        return $null -ne $marker -and [int]$marker.pid -eq [int]$Identity.ProcessId -and
            (Test-CcsmGuardianPathInside (Join-Path $Plan.RepoRoot "src-tauri\target") ([string]$Identity.Path)) -and
            [string]::Equals([System.IO.Path]::GetFileName([string]$Identity.Path), "cc-switch.exe",
                [System.StringComparison]::OrdinalIgnoreCase) -and
            (Test-CcsmGuardianSamePath ([string]$marker.executablePath) ([string]$Identity.Path)) -and
            [datetime]::FromFileTimeUtc([long]$marker.processStartedAtTicks).Ticks -eq
                (ConvertTo-CcsmGuardianUtc ([string]$Identity.StartTimeUtc)).UtcTicks
    } catch {
        return $false
    }
}

function ConvertTo-CcsmGuardianQuotedArgument {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Start-CcsmDevSessionLauncher {
    param(
        [Parameter(Mandatory = $true)]$Plan,
        [scriptblock]$StartProcess = { param($Info) [System.Diagnostics.Process]::Start($Info) }
    )

    $arguments = @($Plan.ScriptPath) + @($Plan.Args)
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Plan.Executable
    $info.Arguments = @($arguments | ForEach-Object { ConvertTo-CcsmGuardianQuotedArgument $_ }) -join " "
    $info.WorkingDirectory = $Plan.RepoRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $environment = Get-CcsmDevSessionEnvironment $Plan.Environment
    foreach ($name in $environment.Keys) { $info.EnvironmentVariables[$name] = $environment[$name] }
    return [int](& $StartProcess $info).Id
}

function Invoke-CcsmDevSessionRecovery {
    param(
        [Parameter(Mandatory = $true)]$Plan,
        [Parameter(Mandatory = $true)][scriptblock]$IsMaintenance,
        [Parameter(Mandatory = $true)][scriptblock]$GetListenerOwner,
        [Parameter(Mandatory = $true)][scriptblock]$GetProcessIdentity,
        [Parameter(Mandatory = $true)][scriptblock]$StartDevSession,
        [Parameter(Mandatory = $true)][scriptblock]$WriteEvent
    )

    if ($Plan.Active -or $Plan.State -eq "stopping" -or (& $IsMaintenance)) {
        & $WriteEvent "info" "dev-session-recovery-deferred" @{ State = $Plan.State; Active = $Plan.Active }
        return
    }
    if (-not $Plan.Recoverable) {
        & $WriteEvent "warning" "dev-session-recovery-required" @{ RepoRoot = $Plan.RepoRoot }
        return
    }
    $ownerPid = & $GetListenerOwner
    if ($null -ne $ownerPid) {
        $identity = $null
        try { $identity = & $GetProcessIdentity ([int]$ownerPid) } catch { }
        if ($null -eq $identity -or -not (Test-CcsmDevSessionListenerIdentity -Plan $Plan -Identity $identity)) {
            & $WriteEvent "error" "foreign-listener-blocked-dev-recovery" @{ ProcessId = $ownerPid }
            return
        }
    }
    $startedPid = [int](& $StartDevSession $Plan)
    & $WriteEvent "warning" "dev-session-started" @{
        ProcessId = $startedPid; Executable = $Plan.Executable; ScriptPath = $Plan.ScriptPath; RepoRoot = $Plan.RepoRoot
    }
    # The Node supervisor owns readiness and may need minutes for a Rust rebuild.
    & $WriteEvent "info" "dev-session-rebuild-pending" @{ ProcessId = $startedPid }
}

function New-CcsmMaintenanceLeaseRecord {
    param(
        [Parameter(Mandatory = $true)]$OwnerIdentity,
        [Parameter(Mandatory = $true)][string]$LeaseId,
        [Parameter(Mandatory = $true)][datetime]$NowUtc,
        [Parameter(Mandatory = $true)][int]$DurationSeconds,
        [Parameter(Mandatory = $true)][string]$Purpose
    )

    if ($DurationSeconds -lt 1) { throw "maintenance lease duration must be positive" }
    if ([string]::IsNullOrWhiteSpace($LeaseId)) { throw "maintenance lease ID must not be empty" }
    if ([string]::IsNullOrWhiteSpace([string]$OwnerIdentity.Path)) { throw "maintenance lease owner path must not be empty" }

    $created = $NowUtc.ToUniversalTime()
    return [ordered]@{
        schemaVersion = 1
        leaseId = $LeaseId
        purpose = $Purpose
        ownerPid = [int]$OwnerIdentity.ProcessId
        ownerExecutablePath = ConvertTo-CcsmGuardianCanonicalPath -Path ([string]$OwnerIdentity.Path)
        ownerStartTimeUtc = [string]$OwnerIdentity.StartTimeUtc
        createdAtUtc = $created.ToString("o")
        expiresAtUtc = $created.AddSeconds($DurationSeconds).ToString("o")
    }
}

function Test-CcsmMaintenanceLeaseRecord {
    param(
        [Parameter(Mandatory = $true)]$Lease,
        [Parameter(Mandatory = $true)][datetime]$NowUtc,
        [Parameter(Mandatory = $true)][scriptblock]$GetProcessIdentity
    )

    try {
        if ([int]$Lease.schemaVersion -ne 1 -or
            [string]::IsNullOrWhiteSpace([string]$Lease.leaseId) -or
            [int]$Lease.ownerPid -lt 1 -or
            [string]::IsNullOrWhiteSpace([string]$Lease.ownerExecutablePath) -or
            [string]::IsNullOrWhiteSpace([string]$Lease.ownerStartTimeUtc) -or
            [string]::IsNullOrWhiteSpace([string]$Lease.expiresAtUtc)) {
            return $false
        }
        $expiresAt = ConvertTo-CcsmGuardianUtc -Value $Lease.expiresAtUtc
        if ($expiresAt -le [datetimeoffset]$NowUtc.ToUniversalTime()) { return $false }

        $owner = & $GetProcessIdentity ([int]$Lease.ownerPid)
        if ($null -eq $owner -or [int]$owner.ProcessId -ne [int]$Lease.ownerPid) { return $false }
        if (-not (Test-CcsmGuardianSamePath -Left ([string]$owner.Path) -Right ([string]$Lease.ownerExecutablePath))) {
            return $false
        }
        $expectedStart = ConvertTo-CcsmGuardianUtc -Value $Lease.ownerStartTimeUtc
        $actualStart = ConvertTo-CcsmGuardianUtc -Value $owner.StartTimeUtc
        return $expectedStart.UtcTicks -eq $actualStart.UtcTicks
    } catch {
        return $false
    }
}

function Enter-CcsmMaintenanceLease {
    param(
        [Parameter(Mandatory = $true)][string]$MarkerPath,
        [Parameter(Mandatory = $true)][string]$Purpose,
        [Parameter(Mandatory = $true)][int]$DurationSeconds
    )

    $nowUtc = [datetime]::UtcNow
    $owner = Get-CcsmGuardianProcessIdentity -ProcessId $PID
    $leaseId = [guid]::NewGuid().ToString("N")
    $record = New-CcsmMaintenanceLeaseRecord -OwnerIdentity $owner -LeaseId $leaseId `
        -NowUtc $nowUtc -DurationSeconds $DurationSeconds -Purpose $Purpose
    $directory = Split-Path -Parent $MarkerPath
    New-Item -ItemType Directory -Path $directory -Force | Out-Null

    $stream = [System.IO.File]::Open(
        $MarkerPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    try {
        $existingLease = $null
        if ($stream.Length -gt 0 -and $stream.Length -le 65536) {
            try {
                $stream.Position = 0
                $buffer = New-Object byte[] ([int]$stream.Length)
                $offset = 0
                while ($offset -lt $buffer.Length) {
                    $count = $stream.Read($buffer, $offset, $buffer.Length - $offset)
                    if ($count -le 0) { break }
                    $offset += $count
                }
                if ($offset -eq $buffer.Length) {
                    $existingLease = [System.Text.Encoding]::UTF8.GetString($buffer) | ConvertFrom-Json
                }
            } catch {
                $existingLease = $null
            }
        }
        if ($null -ne $existingLease -and (Test-CcsmMaintenanceLeaseRecord `
                    -Lease $existingLease -NowUtc $nowUtc `
                    -GetProcessIdentity { param($ProcessId) Get-CcsmGuardianProcessIdentity -ProcessId $ProcessId })) {
            throw "an active CCSwitchMulti maintenance lease already owns $MarkerPath"
        }

        $stream.SetLength(0)
        $stream.Position = 0
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Depth 4))
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
    return $leaseId
}

function Test-CcsmMaintenanceLease {
    param(
        [Parameter(Mandatory = $true)][string]$MarkerPath,
        [Parameter(Mandatory = $true)][datetime]$NowUtc,
        [Parameter(Mandatory = $true)][scriptblock]$GetProcessIdentity
    )

    if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) { return $false }
    try {
        $lease = [System.IO.File]::ReadAllText($MarkerPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        return Test-CcsmMaintenanceLeaseRecord -Lease $lease -NowUtc $NowUtc `
            -GetProcessIdentity $GetProcessIdentity
    } catch {
        return $false
    }
}

function Exit-CcsmMaintenanceLease {
    param(
        [Parameter(Mandatory = $true)][string]$MarkerPath,
        [Parameter(Mandatory = $true)][string]$LeaseId
    )

    if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) { return }
    try {
        $lease = [System.IO.File]::ReadAllText($MarkerPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ([string]::Equals([string]$lease.leaseId, $LeaseId, [System.StringComparison]::Ordinal)) {
            Remove-Item -LiteralPath $MarkerPath -Force -ErrorAction Stop
        }
    } catch {
        return
    }
}

function Invoke-CcsmMaintenanceLeaseScope {
    param(
        [Parameter(Mandatory = $true)][string]$MarkerPath,
        [Parameter(Mandatory = $true)][string]$Purpose,
        [Parameter(Mandatory = $true)][int]$DurationSeconds,
        [Parameter(Mandatory = $true)][scriptblock]$Action
    )

    $leaseId = Enter-CcsmMaintenanceLease -MarkerPath $MarkerPath -Purpose $Purpose `
        -DurationSeconds $DurationSeconds
    try {
        return & $Action $leaseId
    } finally {
        Exit-CcsmMaintenanceLease -MarkerPath $MarkerPath -LeaseId $leaseId
    }
}

function Wait-CcsmOwnedProcessExit {
    param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)

    $Process.WaitForExit()
    return [int]$Process.ExitCode
}

function Get-CcsmGuardianFileSha256 {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $stream = [System.IO.File]::Open(
        $LiteralPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace("-", "")
    } finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

function Get-CcsmTauriNsisPayloadHash {
    param([Parameter(Mandatory = $true)][string]$ExecutablePath)

    if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
        throw "Tauri executable missing: $ExecutablePath"
    }
    $unknownMarker = "__TAURI_BUNDLE_TYPE_VAR_UNK"
    $nsisMarker = "__TAURI_BUNDLE_TYPE_VAR_NSS"
    if ($unknownMarker.Length -ne $nsisMarker.Length) {
        throw "Tauri bundle markers must have equal length"
    }

    $bytes = [System.IO.File]::ReadAllBytes($ExecutablePath)
    $ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
    $markerIndex = $ascii.IndexOf($unknownMarker, [System.StringComparison]::Ordinal)
    if ($markerIndex -lt 0) { throw "Tauri unknown bundle marker not found" }
    if ($ascii.IndexOf($unknownMarker, $markerIndex + 1, [System.StringComparison]::Ordinal) -ge 0) {
        throw "multiple Tauri unknown bundle markers found"
    }

    $replacement = [System.Text.Encoding]::ASCII.GetBytes($nsisMarker)
    [System.Array]::Copy($replacement, 0, $bytes, $markerIndex, $replacement.Length)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace("-", "")
    } finally {
        $sha.Dispose()
    }
}

function Invoke-CcsmGuardianIteration {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][datetime]$NowUtc,
        [Parameter(Mandatory = $true)][int]$FailureThresholdSeconds,
        [Parameter(Mandatory = $true)][scriptblock]$IsMaintenance,
        [Parameter(Mandatory = $true)][scriptblock]$InspectRuntime,
        [Parameter(Mandatory = $true)][scriptblock]$Recover,
        [Parameter(Mandatory = $true)][scriptblock]$WriteEvent
    )

    if (& $IsMaintenance) {
        $State.FailureSinceUtc = $null
        return
    }

    $runtime = & $InspectRuntime
    if ([bool]$runtime.Healthy) {
        $State.FailureSinceUtc = $null
        return
    }

    $now = $NowUtc.ToUniversalTime()
    if ($null -eq $State.FailureSinceUtc) {
        $State.FailureSinceUtc = $now
        & $WriteEvent "warning" "health-loss-detected" @{ Owner = $runtime.ListenerOwner }
        return
    }

    $elapsed = ($now - ([datetime]$State.FailureSinceUtc).ToUniversalTime()).TotalSeconds
    if ($elapsed -lt $FailureThresholdSeconds) { return }

    & $WriteEvent "warning" "health-loss-threshold-reached" @{ ElapsedSeconds = [int]$elapsed }
    & $Recover
    $State.FailureSinceUtc = $now
}

function Test-CcsmGuardianUncleanExit {
    <#
    应用只在“正常退出”时由自己移除运行标记 app-run-marker.json。标记仍在、而它记录的
    进程已经不存在，说明上一次运行是异常死亡（崩溃/被杀），才允许守护重启。
    #>
    param(
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [Parameter(Mandatory = $true)][scriptblock]$GetProcessIdentity
    )

    $configRoot = [System.IO.Path]::GetFullPath($ConfigPath)
    $markerPath = Join-Path $configRoot "logs\app-run-marker.json"
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { return $false }
    try {
        $marker = [System.IO.File]::ReadAllText($markerPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    } catch {
        return $false
    }
    $markerPid = 0
    if ($marker.PSObject.Properties.Name -contains "pid") { $markerPid = [int]$marker.pid }
    if ($markerPid -lt 1) { return $true }
    try {
        $identity = & $GetProcessIdentity $markerPid
    } catch {
        return $true
    }
    return $null -eq $identity
}

function Test-CcsmGuardianRestartBudget {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][datetime[]]$RestartTimesUtc,
        [Parameter(Mandatory = $true)][datetime]$NowUtc,
        [Parameter(Mandatory = $true)][int]$WindowMinutes,
        [Parameter(Mandatory = $true)][int]$MaxRestarts
    )

    if ($WindowMinutes -lt 1 -or $MaxRestarts -lt 1) { return $false }
    $windowStart = $NowUtc.ToUniversalTime().AddMinutes(-$WindowMinutes)
    $recent = @($RestartTimesUtc | Where-Object { $_.ToUniversalTime() -ge $windowStart })
    return $recent.Count -lt $MaxRestarts
}

function Invoke-CcsmGuardianSafeIteration {
    <#
    守护是常驻进程，任何一次循环里的瞬时异常（WMI/CIM/网络查询抖动）都不应该让
    守护整体退出：吞掉异常、写 iteration-failed 事件，然后继续下一轮。
    #>
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][scriptblock]$WriteEvent
    )

    try {
        & $Action
        return $true
    } catch {
        & $WriteEvent "error" "iteration-failed" @{ Error = $_.Exception.Message }
        return $false
    }
}

function Invoke-CcsmGuardianRecovery {
    param(
        [Parameter(Mandatory = $true)][string]$InstalledExecutable,
        [Parameter(Mandatory = $true)][scriptblock]$IsMaintenance,
        [Parameter(Mandatory = $true)][scriptblock]$InstalledExecutableExists,
        [Parameter(Mandatory = $true)][scriptblock]$GetListenerOwner,
        [Parameter(Mandatory = $true)][scriptblock]$GetProcessIdentity,
        [Parameter(Mandatory = $true)][scriptblock]$IsExpectedProductIdentity,
        [Parameter(Mandatory = $true)][scriptblock]$GetExpectedProductProcesses,
        [Parameter(Mandatory = $true)][scriptblock]$StopVerifiedProductProcess,
        [Parameter(Mandatory = $true)][scriptblock]$WaitPortFree,
        [Parameter(Mandatory = $true)][scriptblock]$StartProduct,
        [Parameter(Mandatory = $true)][scriptblock]$WaitReady,
        [Parameter(Mandatory = $true)][scriptblock]$WriteEvent
    )

    if (& $IsMaintenance) {
        & $WriteEvent "info" "recovery-deferred-maintenance" $null
        return
    }
    if (-not (& $InstalledExecutableExists)) {
        & $WriteEvent "error" "installed-executable-missing" @{ Path = $InstalledExecutable }
        return
    }

    $stopped = New-Object 'System.Collections.Generic.HashSet[int]'
    $ownerPid = & $GetListenerOwner
    if ($null -ne $ownerPid) {
        try {
            $ownerIdentity = & $GetProcessIdentity ([int]$ownerPid)
        } catch {
            & $WriteEvent "warning" "listener-owner-transient" @{ ProcessId = $ownerPid }
            return
        }
        if (-not (& $IsExpectedProductIdentity $ownerIdentity)) {
            & $WriteEvent "error" "foreign-listener-blocked-recovery" @{
                ProcessId = $ownerPid
                Path = [string]$ownerIdentity.Path
            }
            return
        }
        & $WriteEvent "warning" "stopping-unhealthy-product" @{ ProcessId = $ownerPid }
        & $StopVerifiedProductProcess $ownerIdentity
        [void]$stopped.Add([int]$ownerPid)
    }

    foreach ($identity in @(& $GetExpectedProductProcesses)) {
        if ($null -eq $identity -or $stopped.Contains([int]$identity.ProcessId)) { continue }
        if (-not (& $IsExpectedProductIdentity $identity)) { continue }
        & $WriteEvent "warning" "stopping-stale-product" @{ ProcessId = [int]$identity.ProcessId }
        & $StopVerifiedProductProcess $identity
        [void]$stopped.Add([int]$identity.ProcessId)
    }

    if (-not (& $WaitPortFree)) {
        & $WriteEvent "error" "port-did-not-release" @{ Owner = (& $GetListenerOwner) }
        return
    }
    if (& $IsMaintenance) {
        & $WriteEvent "info" "recovery-deferred-maintenance" $null
        return
    }

    $startedPid = [int](& $StartProduct)
    & $WriteEvent "warning" "product-started" @{ ProcessId = $startedPid; Path = $InstalledExecutable }
    if (& $WaitReady $startedPid) {
        & $WriteEvent "info" "recovery-ready" @{ ProcessId = $startedPid }
    } else {
        & $WriteEvent "error" "recovery-not-ready" @{ ProcessId = $startedPid }
    }
}
