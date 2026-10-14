$corePath = Join-Path (Split-Path -Parent $PSScriptRoot) "ccswitchmulti-guardian-core.ps1"
. $corePath
$watchdogPath = Join-Path (Split-Path -Parent $PSScriptRoot) "watch-ccswitchmulti.ps1"
. $watchdogPath -PlanOnly | Out-Null
$script:boundaryGetDevPlan = ${function:Get-CcsmDevSessionRecoveryPlan}

function New-WatchdogTempConfig {
    param([string]$MarkerJson = "")
    $root = Join-Path $env:TEMP ("ccsm-watchdog-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path (Join-Path $root "logs") | Out-Null
    if (-not [string]::IsNullOrEmpty($MarkerJson)) {
        [System.IO.File]::WriteAllText(
            (Join-Path $root "logs\app-run-marker.json"),
            $MarkerJson,
            [System.Text.UTF8Encoding]::new($false)
        )
    }
    return $root
}

Describe "CCSwitchMulti watchdog restart policy" {
    It "never restarts a clean exit or a fresh install" {
        $root = New-WatchdogTempConfig
        (Test-CcsmGuardianUncleanExit -ConfigPath $root -GetProcessIdentity { param($ProcessId) $null }) | Should Be $false
        Remove-Item -LiteralPath $root -Recurse -Force
    }

    It "keeps a healthy run alive and blocks restart only for a dead run" {
        $root = New-WatchdogTempConfig -MarkerJson ('{ "pid": 4242 }')
        (Test-CcsmGuardianUncleanExit -ConfigPath $root -GetProcessIdentity {
            param($ProcessId)
            if ([int]$ProcessId -eq 4242) { return [pscustomobject]@{ ProcessId = 4242 } }
            return $null
        }) | Should Be $false
        (Test-CcsmGuardianUncleanExit -ConfigPath $root -GetProcessIdentity { param($ProcessId) $null }) | Should Be $true
        Remove-Item -LiteralPath $root -Recurse -Force
    }

    It "treats an unreadable marker as a crash" {
        $root = New-WatchdogTempConfig -MarkerJson ('{ "pid": 0 }')
        (Test-CcsmGuardianUncleanExit -ConfigPath $root -GetProcessIdentity { param($ProcessId) $null }) | Should Be $true
        Remove-Item -LiteralPath $root -Recurse -Force
    }

    It "rate limits restarts inside the window" {
        $now = [datetime]::UtcNow
        (Test-CcsmGuardianRestartBudget -RestartTimesUtc @() -NowUtc $now -WindowMinutes 30 -MaxRestarts 2) | Should Be $true
        (Test-CcsmGuardianRestartBudget -RestartTimesUtc @($now) -NowUtc $now -WindowMinutes 30 -MaxRestarts 2) | Should Be $true
        (Test-CcsmGuardianRestartBudget -RestartTimesUtc @($now, $now) -NowUtc $now -WindowMinutes 30 -MaxRestarts 2) | Should Be $false
        (Test-CcsmGuardianRestartBudget -RestartTimesUtc @($now.AddMinutes(-90)) -NowUtc $now -WindowMinutes 30 -MaxRestarts 1) | Should Be $true
    }
}

Describe "CCSwitchMulti watchdog loop resilience" {
    It "keeps running when a single iteration throws" {
        $events = New-Object System.Collections.Generic.List[string]
        $writeEvent = { param($Level, $Event, $Detail) $events.Add("$Level|$Event") | Out-Null }
        $ok = Invoke-CcsmGuardianSafeIteration -WriteEvent $writeEvent -Action { throw "transient wmi failure" }
        $ok | Should Be $false
        ($events -join ",") | Should Match "error\|iteration-failed"
    }

    It "reports success for a healthy iteration" {
        $events = New-Object System.Collections.Generic.List[string]
        $writeEvent = { param($Level, $Event, $Detail) $events.Add("$Level|$Event") | Out-Null }
        (Invoke-CcsmGuardianSafeIteration -WriteEvent $writeEvent -Action { $script:ran = $true }) | Should Be $true
        $events.Count | Should Be 0
    }
}

Describe "CCSwitchMulti guardian JSON timestamp precision" {
    It "preserves fractional timestamps when JSON fields have already become dates" {
        $lease = [pscustomobject]@{
            schemaVersion = 1; leaseId = "json-dates"; ownerPid = 4242
            ownerExecutablePath = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
            ownerStartTimeUtc = [datetime]"2026-10-13T00:00:00.1234567Z"
            expiresAtUtc = [datetime]"2026-10-13T00:10:00.9876543Z"
        }
        $owner = [pscustomobject]@{
            ProcessId = 4242; Path = $lease.ownerExecutablePath
            StartTimeUtc = "2026-10-13T00:00:00.1234567Z"
        }
        Test-CcsmMaintenanceLeaseRecord -Lease $lease -NowUtc ([datetime]"2026-10-13T00:10:00.5000000Z") `
            -GetProcessIdentity { param($ProcessId) $owner } | Should Be $true

        $owner.StartTimeUtc = "2026-10-13T00:00:00.1234568Z"
        Test-CcsmMaintenanceLeaseRecord -Lease $lease -NowUtc ([datetime]"2026-10-13T00:10:00.5000000Z") `
            -GetProcessIdentity { param($ProcessId) $owner } | Should Be $false
        $owner.StartTimeUtc = "2026-10-13T00:00:00.1234567Z"
        Test-CcsmMaintenanceLeaseRecord -Lease $lease -NowUtc $lease.expiresAtUtc `
            -GetProcessIdentity { param($ProcessId) $owner } | Should Be $false
    }
}

Describe "CCSwitchMulti development session ownership" {
    BeforeEach {
        $script:devRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ccsm-dev-session-" + [guid]::NewGuid().ToString("N"))
        $script:devConfig = Join-Path $script:devRoot "config"
        $script:repoRoot = Join-Path $script:devRoot "repo"
        $script:nodePath = Join-Path $script:devRoot "node.exe"
        $script:devLaunches = 0
        New-Item -ItemType Directory -Force -Path (Join-Path $script:devConfig "logs"), (Join-Path $script:repoRoot "scripts"), (Join-Path $script:repoRoot "src-tauri\target\debug") | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $script:repoRoot "scripts\dev-tauri-delayed.mjs"), "", [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText((Join-Path $script:repoRoot "package.json"), "{}", [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($script:nodePath, "", [System.Text.UTF8Encoding]::new($false))
    }
    AfterEach { if (Test-Path -LiteralPath $script:devRoot) { Remove-Item -LiteralPath $script:devRoot -Recurse -Force } }

    function Write-DevSession {
        param([string]$State = "running", [int]$SessionPid = 4242, [string]$NodePath = $script:nodePath)
        $scriptPath = Join-Path $script:repoRoot "scripts\dev-tauri-delayed.mjs"
        $session = [ordered]@{
            schemaVersion = 1; supervisorPid = $SessionPid; supervisorExecutablePath = $NodePath
            supervisorStartedAtUtc = "2026-10-13T00:00:00.000Z"; repoRoot = $script:repoRoot
            scriptPath = $scriptPath; args = @("--delay", "0"); startedAtUtc = "2026-10-13T00:00:01.000Z"
            state = $State; workerPid = 5000; roots = @()
        }
        $session | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $script:devConfig "logs\dev-session.json") -Encoding utf8
        return [pscustomobject]@{ Session = $session; CommandLine = "node $scriptPath --delay 0"; ScriptPath = $scriptPath }
    }

    It "recognizes a live supervisor only when identity, start time, and command line match" {
        $written = Write-DevSession
        $identity = { param($ProcessId) [pscustomobject]@{ ProcessId = $ProcessId; Path = $script:nodePath; StartTimeUtc = "2026-10-13T00:00:00.000Z"; CimStartTimeUtc = "2026-10-13T00:00:00.000Z"; CommandLine = $written.CommandLine } }
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:devConfig -GetProcessIdentity $identity
        $plan.Active | Should Be $true
        $plan.Recoverable | Should Be $false
    }

    It "recognizes pnpm's relative entrypoint bound to the recorded supervisor identity" {
        $written = Write-DevSession
        $written.Session.supervisorStartedAtUtc = "2026-10-13T00:00:00.123Z"
        $written.Session | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $script:devConfig "logs\dev-session.json") -Encoding utf8
        $identity = { param($ProcessId) [pscustomobject]@{ ProcessId = $ProcessId; Path = $script:nodePath; StartTimeUtc = "2026-10-13T00:00:00.1234567Z"; CimStartTimeUtc = "2026-10-13T00:00:00.1234567Z"; CommandLine = 'node "scripts/dev-tauri-delayed.mjs" --delay 0' } }
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:devConfig -GetProcessIdentity $identity
        $plan.Active | Should Be $true
        $plan.Recoverable | Should Be $false
        $identity = { param($ProcessId) [pscustomobject]@{ ProcessId = $ProcessId; Path = $script:nodePath; StartTimeUtc = "2026-10-13T00:00:00.124Z"; CimStartTimeUtc = "2026-10-13T00:00:00.124Z"; CommandLine = 'node "scripts/dev-tauri-delayed.mjs" --delay 0' } }
        (Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:devConfig -GetProcessIdentity $identity).Active | Should Be $false
    }

    It "rejects a reused supervisor PID and makes the stale running marker recoverable" {
        $written = Write-DevSession
        $identity = { param($ProcessId) [pscustomobject]@{ ProcessId = $ProcessId; Path = $script:nodePath; StartTimeUtc = "2026-10-13T00:01:00.000Z"; CimStartTimeUtc = "2026-10-13T00:01:00.000Z"; CommandLine = $written.CommandLine } }
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:devConfig -GetProcessIdentity $identity
        $plan.Active | Should Be $false
        $plan.Recoverable | Should Be $true
    }

    It "never recovers a stopping marker or falls back to the installed app" {
        Write-DevSession -State "stopping" | Out-Null
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:devConfig -GetProcessIdentity { param($ProcessId) $null }
        $plan.PreventInstalledFallback | Should Be $true
        $plan.Recoverable | Should Be $false
        $plan.State | Should Be "stopping"
    }

    It "starts the recorded Node launcher for a stale dev session" {
        Write-DevSession | Out-Null
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:devConfig -GetProcessIdentity { param($ProcessId) $null }
        $events = New-Object System.Collections.Generic.List[string]
        Invoke-CcsmDevSessionRecovery -Plan $plan -IsMaintenance { $false } -GetListenerOwner { $null } `
            -GetProcessIdentity { param($ProcessId) $null } -StartDevSession { param($DevPlan) $script:started = $DevPlan; 9876 } `
            -WriteEvent { param($Level, $Event, $Detail) $events.Add($Event) | Out-Null }
        $script:started.Executable | Should Be $script:nodePath
        $script:started.ScriptPath | Should Be (Join-Path $script:repoRoot "scripts\dev-tauri-delayed.mjs")
        ($events -contains "dev-session-started") | Should Be $true
        ($events -contains "dev-session-rebuild-pending") | Should Be $true
    }

    It "accepts only the recorded stale dev binary as the listener owner" {
        $markerPath = Join-Path $script:devConfig "logs\app-run-marker.json"
        $appPath = Join-Path $script:repoRoot "src-tauri\target\debug\cc-switch.exe"
        @{ pid = 6000; executablePath = $appPath; processStartedAtTicks = 134000000000000000 } |
            ConvertTo-Json | Set-Content -LiteralPath $markerPath -Encoding utf8
        Write-DevSession | Out-Null
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:devConfig -GetProcessIdentity { param($ProcessId) $null }
        $good = [pscustomobject]@{ ProcessId = 6000; Path = $appPath; StartTimeUtc = ([datetime]::FromFileTimeUtc(134000000000000000)).ToString("o") }
        (Test-CcsmDevSessionListenerIdentity -Plan $plan -Identity $good) | Should Be $true
        $foreign = [pscustomobject]@{ ProcessId = 6000; Path = "C:\Program Files\CCSwitchMulti\cc-switch.exe"; StartTimeUtc = $good.StartTimeUtc }
        (Test-CcsmDevSessionListenerIdentity -Plan $plan -Identity $foreign) | Should Be $false
    }

    It "blocks recovery when a foreign listener owns the dev port" {
        Write-DevSession | Out-Null
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:devConfig -GetProcessIdentity { param($ProcessId) $null }
        $events = New-Object System.Collections.Generic.List[string]
        Invoke-CcsmDevSessionRecovery -Plan $plan -IsMaintenance { $false } -GetListenerOwner { 9001 } `
            -GetProcessIdentity { param($ProcessId) [pscustomobject]@{ ProcessId = 9001; Path = "C:\Windows\notepad.exe"; StartTimeUtc = "2026-10-13T00:00:00.000Z" } } `
            -StartDevSession { $script:devLaunches++; 9876 } -WriteEvent { param($Level, $Event, $Detail) $events.Add($Event) | Out-Null }
        $script:devLaunches | Should Be 0
        ($events -contains "foreign-listener-blocked-dev-recovery") | Should Be $true
    }

    It "rejects foreign node identity and a command line using a similarly named script" {
        $written = Write-DevSession
        $wrongPath = { param($ProcessId) [pscustomobject]@{ ProcessId = $ProcessId; Path = "C:\Windows\node.exe"; StartTimeUtc = "2026-10-13T00:00:00.000Z"; CommandLine = $written.CommandLine } }
        (Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:devConfig -GetProcessIdentity $wrongPath).Active | Should Be $false
        $wrongCommand = { param($ProcessId) [pscustomobject]@{ ProcessId = $ProcessId; Path = $script:nodePath; StartTimeUtc = "2026-10-13T00:00:00.000Z"; CommandLine = "node $($written.ScriptPath).other" } }
        (Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:devConfig -GetProcessIdentity $wrongCommand).Active | Should Be $false
    }

    It "blocks installed fallback when the dev marker is malformed or its script leaves the repository" {
        $written = Write-DevSession
        $sessionPath = Join-Path $script:devConfig "logs\dev-session.json"
        $written.Session.scriptPath = Join-Path $script:devRoot "foreign.mjs"
        $written.Session | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $sessionPath -Encoding utf8
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:devConfig -GetProcessIdentity { param($ProcessId) $null }
        $plan.Recoverable | Should Be $false
        $plan.PreventInstalledFallback | Should Be $true
        Set-Content -LiteralPath $sessionPath -Value "{" -Encoding utf8
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:devConfig -GetProcessIdentity { param($ProcessId) $null }
        $plan.Recoverable | Should Be $false
        $plan.PreventInstalledFallback | Should Be $true
    }

    It "defers during live dev builds, planned stopping, and maintenance" {
        Write-DevSession | Out-Null
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:devConfig -GetProcessIdentity { param($ProcessId) $null }
        $start = { param($DevPlan) $script:devLaunches++; 9876 }
        $events = New-Object System.Collections.Generic.List[string]
        $write = { param($Level, $Event, $Detail) $events.Add($Event) | Out-Null }
        Invoke-CcsmDevSessionRecovery -Plan $plan -IsMaintenance { $true } -GetListenerOwner { throw "must defer" } -GetProcessIdentity { param($ProcessId) $null } -StartDevSession $start -WriteEvent $write
        $plan.Active = $true
        Invoke-CcsmDevSessionRecovery -Plan $plan -IsMaintenance { $false } -GetListenerOwner { throw "must defer" } -GetProcessIdentity { param($ProcessId) $null } -StartDevSession $start -WriteEvent $write
        $plan.Active = $false
        $plan.State = "stopping"
        Invoke-CcsmDevSessionRecovery -Plan $plan -IsMaintenance { $false } -GetListenerOwner { throw "must defer" } -GetProcessIdentity { param($ProcessId) $null } -StartDevSession $start -WriteEvent $write
        $script:devLaunches | Should Be 0
        $events.Count | Should Be 3
    }

    It "uses the persisted watchdog toggle and fails closed for malformed settings" {
        (Test-CcsmGuardianWatchdogEnabled -ConfigPath $script:devConfig) | Should Be $true
        $settingsPath = Join-Path $script:devConfig "settings.json"
        Set-Content -LiteralPath $settingsPath -Value '{"watchdogEnabled":false}' -Encoding utf8
        (Test-CcsmGuardianWatchdogEnabled -ConfigPath $script:devConfig) | Should Be $false
        Set-Content -LiteralPath $settingsPath -Value '{"watchdog_enabled":false}' -Encoding utf8
        (Test-CcsmGuardianWatchdogEnabled -ConfigPath $script:devConfig) | Should Be $false
        Set-Content -LiteralPath $settingsPath -Value '{' -Encoding utf8
        (Test-CcsmGuardianWatchdogEnabled -ConfigPath $script:devConfig) | Should Be $false
    }

    It "quotes Node launcher arguments with spaces, quotes, and trailing backslashes" {
        (ConvertTo-CcsmGuardianQuotedArgument 'C:\repo with space\scripts\dev-tauri-delayed.mjs') | Should Be '"C:\repo with space\scripts\dev-tauri-delayed.mjs"'
        (ConvertTo-CcsmGuardianQuotedArgument 'quote"value') | Should Be '"quote\"value"'
        (ConvertTo-CcsmGuardianQuotedArgument 'C:\repo\') | Should Be '"C:\repo\\"'
        (ConvertTo-CcsmGuardianQuotedArgument '') | Should Be '""'
    }

    It "preserves only supported string environment values from the dev marker" {
        $written = Write-DevSession
        $written.Session["environment"] = @{
            TAURI_DEV_REBUILD_DELAY_MS = "1800"; TAURI_DEV_NO_REBUILD = "true"; TAURI_DEV_PORT = "4321"
            CC_SWITCH_TEST_HOME = $script:devRoot; CC_SWITCH_DEV_WATCHDOG_ENABLED = "1"
            PATH = "untrusted-path"; CCSM_UNRECOGNIZED_SETTING = "untrusted-setting"
        }
        $written.Session | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $script:devConfig "logs\dev-session.json") -Encoding utf8
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:devConfig -GetProcessIdentity { param($ProcessId) $null }
        $plan.Environment.Count | Should Be 5
        $plan.Environment.TAURI_DEV_REBUILD_DELAY_MS | Should Be "1800"
        $plan.Environment.TAURI_DEV_NO_REBUILD | Should Be "true"
        $plan.Environment.TAURI_DEV_PORT | Should Be "4321"
        $plan.Environment.CC_SWITCH_TEST_HOME | Should Be $script:devRoot
        $plan.Environment.CC_SWITCH_DEV_WATCHDOG_ENABLED | Should Be "1"
        $plan.Environment.ContainsKey("PATH") | Should Be $false
        $plan.Environment.ContainsKey("CCSM_UNRECOGNIZED_SETTING") | Should Be $false
        (Get-CcsmDevSessionEnvironment @{ TAURI_DEV_PORT = 4321 }).Count | Should Be 0
    }

    It "starts Node with supported child environment overrides without changing the guardian environment" {
        Write-DevSession | Out-Null
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:devConfig -GetProcessIdentity { param($ProcessId) $null }
        $plan.Environment.Count | Should Be 0
        $plan.Environment = @{ TAURI_DEV_PORT = "4321"; CC_SWITCH_TEST_HOME = $script:devRoot; PATH = "untrusted-path"; CCSM_UNRECOGNIZED_SETTING = "untrusted-setting" }
        $beforePort = [Environment]::GetEnvironmentVariable("TAURI_DEV_PORT", "Process")
        $beforePath = [Environment]::GetEnvironmentVariable("PATH", "Process")
        $captured = New-Object 'System.Collections.Generic.List[System.Diagnostics.ProcessStartInfo]'
        $newPid = Start-CcsmDevSessionLauncher -Plan $plan -StartProcess { param($Info) $captured.Add($Info); [pscustomobject]@{ Id = 9876 } }
        $newPid | Should Be 9876
        $captured[0].FileName | Should Be $script:nodePath
        $captured[0].WorkingDirectory | Should Be $script:repoRoot
        $captured[0].CreateNoWindow | Should Be $true
        $captured[0].UseShellExecute | Should Be $false
        $captured[0].EnvironmentVariables["TAURI_DEV_PORT"] | Should Be "4321"
        $captured[0].EnvironmentVariables["CC_SWITCH_TEST_HOME"] | Should Be $script:devRoot
        $captured[0].EnvironmentVariables["PATH"] | Should Be $beforePath
        ($captured[0].EnvironmentVariables.ContainsKey("CCSM_UNRECOGNIZED_SETTING") -and
            $captured[0].EnvironmentVariables["CCSM_UNRECOGNIZED_SETTING"] -eq "untrusted-setting") | Should Be $false
        ([Environment]::GetEnvironmentVariable("TAURI_DEV_PORT", "Process")) | Should Be $beforePort
        { Start-CcsmDevSessionLauncher -Plan $plan -StartProcess { param($Info) throw "injected dev launch failure" } } | Should Throw "injected dev launch failure"
        ([Environment]::GetEnvironmentVariable("TAURI_DEV_PORT", "Process")) | Should Be $beforePort
    }
}

Describe "CCSwitchMulti production and development guardian boundary" {
    BeforeEach {
        $script:boundaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ccsm-guardian-boundary-" + [guid]::NewGuid().ToString("N"))
        $script:ConfigPath = Join-Path $script:boundaryRoot "config"
        $script:boundaryRepo = Join-Path $script:boundaryRoot "repo"
        $script:boundaryNode = Join-Path $script:boundaryRoot "node.exe"
        $script:InstalledExecutable = Join-Path $script:boundaryRoot "installed\cc-switch.exe"
        $script:boundaryScript = Join-Path $script:boundaryRepo "scripts\dev-tauri-delayed.mjs"
        $script:DevelopmentMode = $false
        $script:RestartOnCleanExit = $false
        $script:NoRestart = $false
        $script:MaxRestartsPerWindow = 6
        $script:RestartWindowMinutes = 30
        $script:boundaryEvents = New-Object System.Collections.Generic.List[string]
        $script:boundaryRestarts = New-Object System.Collections.Generic.List[datetime]
        $script:boundaryInstalledTarget = ""
        $script:boundaryStartedDevPlan = $null
        $script:boundarySupervisorAlive = $false
        New-Item -ItemType Directory -Force -Path (Join-Path $script:ConfigPath "logs"), (Split-Path -Parent $script:boundaryScript) | Out-Null
        [System.IO.File]::WriteAllText($script:boundaryScript, "")
        [System.IO.File]::WriteAllText((Join-Path $script:boundaryRepo "package.json"), "{}")
        [System.IO.File]::WriteAllText($script:boundaryNode, "")
        [System.IO.File]::WriteAllText((Join-Path $script:ConfigPath "logs\app-run-marker.json"), '{"pid":7777}')
        Mock Test-CcsmMaintenanceLease { $false }
        Mock Test-CcsmUpgradeProcessActive { $false }
        Mock Get-CcsmGuardianListenerOwner { $null }
        Mock Get-CcsmDevSessionRecoveryPlan {
            param($ConfigPath, $GetProcessIdentity)
            & $script:boundaryGetDevPlan -ConfigPath $ConfigPath -GetProcessIdentity $GetProcessIdentity
        }
        Mock Get-CcsmGuardianProcessIdentity {
            param($ProcessId)
            if ($script:boundarySupervisorAlive -and $ProcessId -eq 4242) {
                return [pscustomobject]@{
                    ProcessId = 4242; Path = $script:boundaryNode
                    StartTimeUtc = "2026-10-13T00:00:00.000Z"; CimStartTimeUtc = "2026-10-13T00:00:00.000Z"
                    CommandLine = "node `"$script:boundaryScript`" --delay 0"
                }
            }
            return $null
        }
        Mock Invoke-CcsmGuardianRecovery {
            param($InstalledExecutable)
            $script:boundaryInstalledTarget = $InstalledExecutable
        }
        Mock Start-CcsmDevSessionLauncher {
            param($Plan)
            $script:boundaryStartedDevPlan = $Plan
            return 9876
        }
        Mock Write-CcsmGuardianEvent {
            param($Level, $Event, $Detail)
            $script:boundaryEvents.Add($Event) | Out-Null
        }
    }

    AfterEach {
        if (Test-Path -LiteralPath $script:boundaryRoot) { Remove-Item -LiteralPath $script:boundaryRoot -Recurse -Force }
    }

    function Write-BoundaryDevSession {
        param([string]$State = "running", [switch]$Malformed)
        $markerPath = Join-Path $script:ConfigPath "logs\dev-session.json"
        if ($Malformed) {
            [System.IO.File]::WriteAllText($markerPath, "{")
            return
        }
        [ordered]@{
            schemaVersion = 1; state = $State; supervisorPid = 4242
            supervisorExecutablePath = $script:boundaryNode; supervisorStartedAtUtc = "2026-10-13T00:00:00.000Z"
            startedAtUtc = "2026-10-13T00:00:01.000Z"; repoRoot = $script:boundaryRepo
            scriptPath = $script:boundaryScript; args = @("--delay", "0"); roots = @()
        } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $markerPath -Encoding utf8
    }

    function Invoke-BoundaryRecovery {
        Invoke-CcsmGuardianRecoveryPolicy -IsMaintenance { Test-CcsmGuardianMaintenance } `
            -WriteEvent { param($Level, $Event, $Detail) Write-CcsmGuardianEvent -Level $Level -Event $Event -Detail $Detail } `
            -RestartTimesUtc $script:boundaryRestarts
    }

    It "requires explicit development opt-in in the executable guardian plan" {
        $watchdogPath = Join-Path (Split-Path -Parent $PSScriptRoot) "watch-ccswitchmulti.ps1"
        $defaultPlan = & $watchdogPath -PlanOnly | ConvertFrom-Json
        $devPlan = & $watchdogPath -PlanOnly -DevelopmentMode | ConvertFrom-Json
        $defaultPlan.DevelopmentMode | Should Be $false
        $devPlan.DevelopmentMode | Should Be $true
    }

    It "ignores a <Marker> dev marker and recovers the installed app by default" -TestCases @(
        @{ Marker = "live"; State = "running"; Alive = $true; Malformed = $false; ExpectedActive = $true; ExpectedRecoverable = $false }
        @{ Marker = "stale"; State = "running"; Alive = $false; Malformed = $false; ExpectedActive = $false; ExpectedRecoverable = $true }
        @{ Marker = "stopping"; State = "stopping"; Alive = $false; Malformed = $false; ExpectedActive = $false; ExpectedRecoverable = $false }
        @{ Marker = "malformed"; State = "running"; Alive = $false; Malformed = $true; ExpectedActive = $false; ExpectedRecoverable = $false }
    ) {
        param($Marker, $State, $Alive, $Malformed, $ExpectedActive, $ExpectedRecoverable)
        $script:boundarySupervisorAlive = $Alive
        Write-BoundaryDevSession -State $State -Malformed:$Malformed
        $devPlan = & $script:boundaryGetDevPlan -ConfigPath $script:ConfigPath `
            -GetProcessIdentity { param($ProcessId) Get-CcsmGuardianProcessIdentity -ProcessId $ProcessId }
        $devPlan.Active | Should Be $ExpectedActive
        $devPlan.Recoverable | Should Be $ExpectedRecoverable
        $devPlan.PreventInstalledFallback | Should Be $true
        Mock Get-CcsmDevSessionRecoveryPlan { throw "production must not read development session markers" }

        (Test-CcsmGuardianMaintenance) | Should Be $false
        Invoke-BoundaryRecovery

        $script:boundaryInstalledTarget | Should Be $script:InstalledExecutable
        $script:boundaryStartedDevPlan | Should Be $null
        $script:boundaryRestarts.Count | Should Be 1
        Assert-MockCalled Get-CcsmDevSessionRecoveryPlan -Times 0 -Exactly -Scope It
        Assert-MockCalled Invoke-CcsmGuardianRecovery -Times 1 -Exactly -Scope It
        Assert-MockCalled Start-CcsmDevSessionLauncher -Times 0 -Exactly -Scope It
    }

    It "does not launch the installed app from a modern dev crash while the supervisor is <SupervisorState>" -TestCases @(
        @{ SupervisorState = "rebuilding"; Alive = $true }
        @{ SupervisorState = "stale"; Alive = $false }
    ) {
        param($SupervisorState, $Alive)
        $script:boundarySupervisorAlive = $Alive
        Write-BoundaryDevSession
        [ordered]@{
            pid = 7777
            executablePath = (Join-Path $script:boundaryRepo "src-tauri\target\debug\cc-switch.exe")
            processStartedAtTicks = 134000000000000001L
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $script:ConfigPath "logs\app-run-marker.json") -Encoding utf8
        Mock Get-CcsmDevSessionRecoveryPlan { throw "production must not inspect the development session" }

        Invoke-BoundaryRecovery

        $script:boundaryInstalledTarget | Should Be ""
        $script:boundaryStartedDevPlan | Should Be $null
        $script:boundaryRestarts.Count | Should Be 0
        Assert-MockCalled Invoke-CcsmGuardianRecovery -Times 0 -Exactly -Scope It
        Assert-MockCalled Start-CcsmDevSessionLauncher -Times 0 -Exactly -Scope It
        Assert-MockCalled Get-CcsmDevSessionRecoveryPlan -Times 0 -Exactly -Scope It
    }

    It "does not authorize production launch from a modern foreign executable marker" {
        [ordered]@{
            pid = 7777; executablePath = "C:\OtherApp\cc-switch.exe"
            processStartedAtTicks = 134000000000000001L
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $script:ConfigPath "logs\app-run-marker.json") -Encoding utf8

        Invoke-BoundaryRecovery

        $script:boundaryInstalledTarget | Should Be ""
        $script:boundaryRestarts.Count | Should Be 0
        Assert-MockCalled Invoke-CcsmGuardianRecovery -Times 0 -Exactly -Scope It
    }

    It "recovers the expected modern installed executable independently of a live dev session" {
        $script:boundarySupervisorAlive = $true
        Write-BoundaryDevSession
        [ordered]@{
            pid = 7777; executablePath = $script:InstalledExecutable
            processStartedAtTicks = 134000000000000001L
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $script:ConfigPath "logs\app-run-marker.json") -Encoding utf8
        Mock Get-CcsmDevSessionRecoveryPlan { throw "production must not inspect the development session" }

        Invoke-BoundaryRecovery

        $script:boundaryInstalledTarget | Should Be $script:InstalledExecutable
        $script:boundaryStartedDevPlan | Should Be $null
        $script:boundaryRestarts.Count | Should Be 1
        Assert-MockCalled Invoke-CcsmGuardianRecovery -Times 1 -Exactly -Scope It
        Assert-MockCalled Start-CcsmDevSessionLauncher -Times 0 -Exactly -Scope It
        Assert-MockCalled Get-CcsmDevSessionRecoveryPlan -Times 0 -Exactly -Scope It
    }

    It "keeps explicit production clean-exit restart opt-in bound to the installed app" {
        $script:RestartOnCleanExit = $true
        Write-BoundaryDevSession
        [ordered]@{
            pid = 7777
            executablePath = (Join-Path $script:boundaryRepo "src-tauri\target\debug\cc-switch.exe")
            processStartedAtTicks = 134000000000000001L
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $script:ConfigPath "logs\app-run-marker.json") -Encoding utf8
        Mock Get-CcsmDevSessionRecoveryPlan { throw "production opt-in must not select development recovery" }

        Invoke-BoundaryRecovery

        $script:boundaryInstalledTarget | Should Be $script:InstalledExecutable
        $script:boundaryStartedDevPlan | Should Be $null
        Assert-MockCalled Invoke-CcsmGuardianRecovery -Times 1 -Exactly -Scope It
        Assert-MockCalled Start-CcsmDevSessionLauncher -Times 0 -Exactly -Scope It
        Assert-MockCalled Get-CcsmDevSessionRecoveryPlan -Times 0 -Exactly -Scope It
    }

    It "restarts the recorded dev launcher only after opting into development mode" {
        $script:DevelopmentMode = $true
        Write-BoundaryDevSession
        Remove-Item -LiteralPath (Join-Path $script:ConfigPath "logs\app-run-marker.json")
        (Test-CcsmGuardianMaintenance) | Should Be $false

        Invoke-BoundaryRecovery

        $script:boundaryStartedDevPlan.Executable | Should Be $script:boundaryNode
        $script:boundaryStartedDevPlan.ScriptPath | Should Be $script:boundaryScript
        $script:boundaryInstalledTarget | Should Be ""
        ($script:boundaryEvents -contains "dev-session-started") | Should Be $true
        Assert-MockCalled Invoke-CcsmGuardianRecovery -Times 0 -Exactly -Scope It
        Assert-MockCalled Start-CcsmDevSessionLauncher -Times 1 -Exactly -Scope It
    }

    It "defers development recovery while the recorded supervisor is still alive" {
        $script:DevelopmentMode = $true
        $script:boundarySupervisorAlive = $true
        Write-BoundaryDevSession

        (Test-CcsmGuardianMaintenance) | Should Be $true
        Invoke-BoundaryRecovery

        ($script:boundaryEvents -contains "dev-session-recovery-deferred") | Should Be $true
        Assert-MockCalled Invoke-CcsmGuardianRecovery -Times 0 -Exactly -Scope It
        Assert-MockCalled Start-CcsmDevSessionLauncher -Times 0 -Exactly -Scope It
    }

    It "does not select the installed app for an invalid marker in explicit development mode" {
        $script:DevelopmentMode = $true
        Write-BoundaryDevSession -Malformed

        Invoke-BoundaryRecovery

        ($script:boundaryEvents -contains "dev-session-recovery-required") | Should Be $true
        Assert-MockCalled Invoke-CcsmGuardianRecovery -Times 0 -Exactly -Scope It
        Assert-MockCalled Start-CcsmDevSessionLauncher -Times 0 -Exactly -Scope It
    }

    It "still honors production clean exit instead of a stale development marker" {
        Write-BoundaryDevSession
        Remove-Item -LiteralPath (Join-Path $script:ConfigPath "logs\app-run-marker.json")

        Invoke-BoundaryRecovery

        ($script:boundaryEvents -contains "restart-skipped-clean-exit") | Should Be $true
        Assert-MockCalled Invoke-CcsmGuardianRecovery -Times 0 -Exactly -Scope It
        Assert-MockCalled Start-CcsmDevSessionLauncher -Times 0 -Exactly -Scope It
    }
}
