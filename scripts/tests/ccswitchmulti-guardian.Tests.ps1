$corePath = Join-Path (Split-Path -Parent $PSScriptRoot) "ccswitchmulti-guardian-core.ps1"
if (Test-Path -LiteralPath $corePath -PathType Leaf) {
    . $corePath
}

function Write-TestLease {
    param([string]$Path, [hashtable]$Lease)

    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    [System.IO.File]::WriteAllText(
        $Path,
        ($Lease | ConvertTo-Json -Depth 4),
        [System.Text.UTF8Encoding]::new($false)
    )
}

function New-TestLease {
    param(
        [datetime]$ExpiresAtUtc = [datetime]"2026-08-24T05:10:00Z",
        [int]$OwnerPid = 4242,
        [string]$OwnerStartTimeUtc = "2026-08-24T05:00:00.0000000Z"
    )

    return @{
        schemaVersion = 1
        leaseId = "lease-test"
        purpose = "local-upgrade"
        ownerPid = $OwnerPid
        ownerExecutablePath = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        ownerStartTimeUtc = $OwnerStartTimeUtc
        createdAtUtc = "2026-08-24T05:00:10.0000000Z"
        expiresAtUtc = $ExpiresAtUtc.ToUniversalTime().ToString("o")
    }
}

Describe "CCSwitchMulti production run marker ownership" {
    BeforeEach {
        $script:runRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ccsm-run-marker-" + [guid]::NewGuid().ToString("N"))
        $script:runMarkerPath = Join-Path $script:runRoot "logs\app-run-marker.json"
        $script:runMarker = @{
            pid = 4242
            executablePath = "C:\Apps\CCSwitchMulti\cc-switch.exe"
            processStartedAtTicks = 134000000000000001L
        }
        $script:runIdentity = [pscustomobject]@{
            ProcessId = 4242
            Path = $script:runMarker.executablePath
            StartTimeUtc = ([datetime]::FromFileTimeUtc($script:runMarker.processStartedAtTicks)).ToString("o")
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $script:runMarkerPath) -Force | Out-Null
    }

    AfterEach {
        if (Test-Path -LiteralPath $script:runRoot) {
            Remove-Item -LiteralPath $script:runRoot -Recurse -Force
        }
    }

    function Write-RunMarker {
        [System.IO.File]::WriteAllText(
            $script:runMarkerPath,
            ($script:runMarker | ConvertTo-Json -Depth 4),
            [System.Text.UTF8Encoding]::new($false)
        )
    }

    It "keeps the exact original process alive with a <TimestampType> timestamp" -TestCases @(
        @{ TimestampType = "string" }
        @{ TimestampType = "date" }
    ) {
        param($TimestampType)
        if ($TimestampType -eq "date") {
            $script:runIdentity.StartTimeUtc = [datetime]::FromFileTimeUtc($script:runMarker.processStartedAtTicks)
        }
        Write-RunMarker

        Test-CcsmGuardianUncleanExit -ConfigPath $script:runRoot `
            -GetProcessIdentity { param($ProcessId) $script:runIdentity } | Should Be $false
    }

    It "does not confuse a matching Codex AppContainer path projection with PID reuse" {
        $script:runMarker.executablePath = Join-Path $env:LOCALAPPDATA "CCSwitchMulti\cc-switch.exe"
        $script:runIdentity.Path = Join-Path $env:LOCALAPPDATA "Packages\OpenAI.Codex_test\LocalCache\Local\CCSwitchMulti\cc-switch.exe"
        Write-RunMarker

        Test-CcsmGuardianUncleanExit -ConfigPath $script:runRoot `
            -GetProcessIdentity { param($ProcessId) $script:runIdentity } | Should Be $false
    }

    It "allows recovery when the recorded PID belongs to a different executable" {
        $script:runIdentity.Path = "C:\Windows\notepad.exe"
        Write-RunMarker

        Test-CcsmGuardianUncleanExit -ConfigPath $script:runRoot `
            -GetProcessIdentity { param($ProcessId) $script:runIdentity } | Should Be $true
    }

    It "allows recovery when the same executable reused the PID one FILETIME tick later" {
        $script:runIdentity.StartTimeUtc = ([datetime]::FromFileTimeUtc($script:runMarker.processStartedAtTicks + 1)).ToString("o")
        Write-RunMarker

        Test-CcsmGuardianUncleanExit -ConfigPath $script:runRoot `
            -GetProcessIdentity { param($ProcessId) $script:runIdentity } | Should Be $true
    }

    It "allows recovery when the returned identity belongs to another PID" {
        $script:runIdentity.ProcessId = 5151
        Write-RunMarker

        Test-CcsmGuardianUncleanExit -ConfigPath $script:runRoot `
            -GetProcessIdentity { param($ProcessId) $script:runIdentity } | Should Be $true
    }

    It "allows recovery after the recorded process disappears" {
        Write-RunMarker

        Test-CcsmGuardianUncleanExit -ConfigPath $script:runRoot `
            -GetProcessIdentity { param($ProcessId) $null } | Should Be $true
    }

    It "does not authorize installed recovery from a modern development crash marker" {
        $expectedInstalled = $script:runMarker.executablePath
        $script:runMarker.executablePath = Join-Path $script:runRoot "repo\src-tauri\target\debug\cc-switch.exe"
        Write-RunMarker

        Test-CcsmGuardianUncleanExit -ConfigPath $script:runRoot -ExpectedExecutable $expectedInstalled `
            -GetProcessIdentity { param($ProcessId) $null } | Should Be $false
    }

    It "authorizes recovery when the modern marker belongs to the expected installed executable" {
        Write-RunMarker

        Test-CcsmGuardianUncleanExit -ConfigPath $script:runRoot -ExpectedExecutable $script:runMarker.executablePath `
            -GetProcessIdentity { param($ProcessId) $null } | Should Be $true
    }

    It "accepts the installed AppContainer projection when binding a modern crash marker" {
        $expectedInstalled = Join-Path $env:LOCALAPPDATA "CCSwitchMulti\cc-switch.exe"
        $script:runMarker.executablePath = Join-Path $env:LOCALAPPDATA "Packages\OpenAI.Codex_test\LocalCache\Local\CCSwitchMulti\cc-switch.exe"
        Write-RunMarker

        Test-CcsmGuardianUncleanExit -ConfigPath $script:runRoot -ExpectedExecutable $expectedInstalled `
            -GetProcessIdentity { param($ProcessId) $null } | Should Be $true
    }

    It "preserves <ProcessState> PID-only marker compatibility with an expected executable" -TestCases @(
        @{ ProcessState = "live"; Expected = $false }
        @{ ProcessState = "dead"; Expected = $true }
    ) {
        param($ProcessState, $Expected)
        $expectedInstalled = $script:runMarker.executablePath
        $script:runMarker = @{ pid = 4242 }
        if ($ProcessState -eq "dead") { $script:runIdentity = $null }
        Write-RunMarker

        Test-CcsmGuardianUncleanExit -ConfigPath $script:runRoot -ExpectedExecutable $expectedInstalled `
            -GetProcessIdentity { param($ProcessId) $script:runIdentity } | Should Be $Expected
    }

    It "preserves conservative PID-only compatibility for a <ProcessState> legacy marker" -TestCases @(
        @{ ProcessState = "live"; Expected = $false }
        @{ ProcessState = "dead"; Expected = $true }
    ) {
        param($ProcessState, $Expected)
        $script:runMarker = @{ pid = 4242 }
        if ($ProcessState -eq "dead") { $script:runIdentity = $null }
        Write-RunMarker

        Test-CcsmGuardianUncleanExit -ConfigPath $script:runRoot `
            -GetProcessIdentity { param($ProcessId) $script:runIdentity } | Should Be $Expected
    }

    It "does not restart from a modern marker with <InvalidField>" -TestCases @(
        @{ InvalidField = "missing path" }
        @{ InvalidField = "missing start time" }
        @{ InvalidField = "relative path" }
        @{ InvalidField = "drive-relative path" }
        @{ InvalidField = "empty path" }
        @{ InvalidField = "null path" }
        @{ InvalidField = "null identity" }
        @{ InvalidField = "null ticks" }
        @{ InvalidField = "zero ticks" }
        @{ InvalidField = "fractional ticks" }
        @{ InvalidField = "non-numeric ticks" }
        @{ InvalidField = "out-of-range ticks" }
    ) {
        param($InvalidField)
        switch ($InvalidField) {
            "missing path" { $script:runMarker.Remove("executablePath") }
            "missing start time" { $script:runMarker.Remove("processStartedAtTicks") }
            "relative path" { $script:runMarker.executablePath = "cc-switch.exe" }
            "drive-relative path" { $script:runMarker.executablePath = "C:cc-switch.exe" }
            "empty path" { $script:runMarker.executablePath = "" }
            "null path" { $script:runMarker.executablePath = $null }
            "null identity" { $script:runMarker.executablePath = $null; $script:runMarker.processStartedAtTicks = $null }
            "null ticks" { $script:runMarker.processStartedAtTicks = $null }
            "zero ticks" { $script:runMarker.processStartedAtTicks = 0 }
            "fractional ticks" { $script:runMarker.processStartedAtTicks = 1.5 }
            "non-numeric ticks" { $script:runMarker.processStartedAtTicks = "not-ticks" }
            "out-of-range ticks" { $script:runMarker.processStartedAtTicks = [long]::MaxValue }
        }
        Write-RunMarker

        Test-CcsmGuardianUncleanExit -ConfigPath $script:runRoot `
            -GetProcessIdentity { param($ProcessId) $null } | Should Be $false
    }

    It "does not restart from a live identity with <InvalidField>" -TestCases @(
        @{ InvalidField = "missing PID" }
        @{ InvalidField = "missing path" }
        @{ InvalidField = "relative path" }
        @{ InvalidField = "drive-relative path" }
        @{ InvalidField = "missing start time" }
        @{ InvalidField = "invalid start time" }
    ) {
        param($InvalidField)
        switch ($InvalidField) {
            "missing PID" { $script:runIdentity.PSObject.Properties.Remove("ProcessId") }
            "missing path" { $script:runIdentity.PSObject.Properties.Remove("Path") }
            "relative path" { $script:runIdentity.Path = "cc-switch.exe" }
            "drive-relative path" { $script:runIdentity.Path = "C:cc-switch.exe" }
            "missing start time" { $script:runIdentity.PSObject.Properties.Remove("StartTimeUtc") }
            "invalid start time" { $script:runIdentity.StartTimeUtc = "not-a-date" }
        }
        Write-RunMarker

        Test-CcsmGuardianUncleanExit -ConfigPath $script:runRoot `
            -GetProcessIdentity { param($ProcessId) $script:runIdentity } | Should Be $false
    }
}

Describe "CCSwitchMulti shared development restart budget" {
    BeforeEach {
        $script:budgetRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ccsm-dev-budget-" + [guid]::NewGuid().ToString("N"))
        $script:budgetConfig = Join-Path $script:budgetRoot "config"
        $script:budgetRepo = Join-Path $script:budgetRoot "repo"
        $script:budgetNode = Join-Path $script:budgetRoot "node.exe"
        $script:budgetSessionPath = Join-Path $script:budgetConfig "logs\dev-session.json"
        $script:budgetNowMs = [datetimeoffset]::UtcNow.ToUnixTimeMilliseconds()
        $script:budgetLaunches = 0
        $script:budgetHistoryAtLaunch = @()
        $script:budgetEvents = New-Object System.Collections.Generic.List[string]
        $script:budgetWatchdogs = @()
        $script:budgetSession = @{
            schemaVersion = 1; state = "running"; supervisorPid = 4242
            supervisorExecutablePath = $script:budgetNode; supervisorStartedAtUtc = "2026-10-13T00:00:00.000Z"
            startedAtUtc = "2026-10-13T00:00:01.000Z"; repoRoot = $script:budgetRepo
            scriptPath = (Join-Path $script:budgetRepo "scripts\dev-tauri-delayed.mjs")
            args = @("--no-rebuild"); roots = @(); restartTimesMs = @()
            environment = @{ TAURI_DEV_PORT = "4321" }; preservedExtra = "keep"
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $script:budgetSessionPath), (Join-Path $script:budgetRepo "scripts") | Out-Null
        [System.IO.File]::WriteAllText($script:budgetNode, "")
        [System.IO.File]::WriteAllText((Join-Path $script:budgetRepo "package.json"), "{}")
        [System.IO.File]::WriteAllText($script:budgetSession.scriptPath, "")
        Mock Get-CimInstance { $script:budgetWatchdogs } -ParameterFilter {
            $ClassName -eq "Win32_Process" -and $Filter -eq "Name='node.exe'"
        }
    }

    AfterEach {
        if (Test-Path -LiteralPath $script:budgetRoot) {
            Remove-Item -LiteralPath $script:budgetRoot -Recurse -Force
        }
    }

    function Write-BudgetSession {
        [System.IO.File]::WriteAllText(
            $script:budgetSessionPath,
            ($script:budgetSession | ConvertTo-Json -Depth 8),
            [System.Text.UTF8Encoding]::new($false)
        )
    }

    function Invoke-BudgetRecovery {
        param([switch]$Maintenance)
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:budgetConfig -GetProcessIdentity { param($ProcessId) $null }
        Invoke-CcsmDevSessionRecovery -Plan $plan -IsMaintenance { [bool]$Maintenance } -GetListenerOwner { $null } `
            -GetProcessIdentity { param($ProcessId) $null } -StartDevSession {
                param($DevPlan)
                $script:budgetLaunches++
                $saved = [System.IO.File]::ReadAllText($script:budgetSessionPath) | ConvertFrom-Json
                $script:budgetHistoryAtLaunch = @()
                if ($saved.PSObject.Properties.Name -contains "restartTimesMs") {
                    $script:budgetHistoryAtLaunch = @($saved.restartTimesMs)
                }
                return 9876
            } -WriteEvent { param($Level, $Event, $Detail) $script:budgetEvents.Add($Event) | Out-Null }
    }

    function New-BudgetWatchdog {
        return [pscustomobject]@{
            ProcessId = 5151; ParentProcessId = 4242
            ExecutablePath = $script:budgetNode
            CommandLine = "`"$script:budgetNode`" `"$($script:budgetSession.scriptPath)`" --ccsm-dev-watchdog 4242"
            CreationDate = [datetime]"2026-10-13T00:00:01.000Z"
        }
    }

    It "recognizes a live supervisor with an <EnvironmentState> environment" -TestCases @(
        @{ EnvironmentState = "absent" }
        @{ EnvironmentState = "null" }
        @{ EnvironmentState = "empty object" }
    ) {
        param($EnvironmentState)
        switch ($EnvironmentState) {
            "absent" { $script:budgetSession.Remove("environment") }
            "null" { $script:budgetSession.environment = $null }
            "empty object" { $script:budgetSession.environment = [pscustomobject]@{} }
        }
        Write-BudgetSession
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:budgetConfig -GetProcessIdentity {
            param($ProcessId)
            [pscustomobject]@{
                ProcessId = $ProcessId; Path = $script:budgetNode
                StartTimeUtc = "2026-10-13T00:00:00.0001234Z"; CimStartTimeUtc = "2026-10-13T00:00:00.0001230Z"
                CommandLine = "node scripts/dev-tauri-delayed.mjs --no-rebuild"
            }
        }

        $plan.Active | Should Be $true
        $plan.Recoverable | Should Be $false
        $plan.Environment.Count | Should Be 0
    }

    It "permits canonical-budget fallback for a stale session with an empty environment object" {
        $script:budgetSession.environment = [pscustomobject]@{}
        Write-BudgetSession

        Invoke-BudgetRecovery

        $script:budgetLaunches | Should Be 1
        $script:budgetHistoryAtLaunch.Count | Should Be 1
    }

    It "does not charge or launch while the exact detached watchdog owns <Phase>" -TestCases @(
        @{ Phase = "crash monitoring"; PriorCharges = 0 }
        @{ Phase = "replacement publication"; PriorCharges = 1 }
    ) {
        param($Phase, $PriorCharges)
        $script:budgetSession.restartTimesMs = @($script:budgetNowMs) * $PriorCharges
        $script:budgetWatchdogs = @(New-BudgetWatchdog)
        Write-BudgetSession
        $before = [System.IO.File]::ReadAllText($script:budgetSessionPath)

        Invoke-BudgetRecovery

        $script:budgetLaunches | Should Be 0
        [System.IO.File]::ReadAllText($script:budgetSessionPath) | Should Be $before
        ($script:budgetEvents -contains "dev-session-recovery-deferred") | Should Be $true
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:budgetConfig -GetProcessIdentity { param($ProcessId) $null }
        $plan.Active | Should Be $false
        $plan.WatchdogActive | Should Be $true
        $plan.Recoverable | Should Be $false
    }

    It "does not let an unrelated <Mismatch> process claim development recovery" -TestCases @(
        @{ Mismatch = "executable" }
        @{ Mismatch = "similarly named script" }
        @{ Mismatch = "repository" }
        @{ Mismatch = "supervisor PID" }
        @{ Mismatch = "worker flag" }
        @{ Mismatch = "parent PID" }
        @{ Mismatch = "older creation time" }
        @{ Mismatch = "extra arguments" }
    ) {
        param($Mismatch)
        $candidate = New-BudgetWatchdog
        switch ($Mismatch) {
            "executable" { $candidate.ExecutablePath = "C:\Windows\node.exe" }
            "similarly named script" { $candidate.CommandLine = $candidate.CommandLine.Replace("dev-tauri-delayed.mjs", "dev-tauri-delayed.mjs.other") }
            "repository" { $candidate.CommandLine = $candidate.CommandLine.Replace($script:budgetRepo, (Join-Path $script:budgetRoot "foreign")) }
            "supervisor PID" { $candidate.CommandLine = $candidate.CommandLine.Replace("4242", "4243") }
            "worker flag" { $candidate.CommandLine = $candidate.CommandLine.Replace("--ccsm-dev-watchdog 4242", "--ccsm-dev-worker") }
            "parent PID" { $candidate.ParentProcessId = 9001 }
            "older creation time" { $candidate.CreationDate = [datetime]"2026-10-12T23:59:59.999Z" }
            "extra arguments" { $candidate.CommandLine += " --foreign" }
        }
        $script:budgetWatchdogs = @($candidate)
        Write-BudgetSession

        Invoke-BudgetRecovery

        $script:budgetLaunches | Should Be 1
        $script:budgetHistoryAtLaunch.Count | Should Be 1
    }

    It "defers an otherwise plausible watchdog with <MissingIdentity> identity data" -TestCases @(
        @{ MissingIdentity = "missing executable" }
        @{ MissingIdentity = "missing command line" }
        @{ MissingIdentity = "missing parent" }
        @{ MissingIdentity = "missing creation time" }
        @{ MissingIdentity = "invalid creation time" }
        @{ MissingIdentity = "missing PID" }
    ) {
        param($MissingIdentity)
        $candidate = New-BudgetWatchdog
        switch ($MissingIdentity) {
            "missing executable" { $candidate.PSObject.Properties.Remove("ExecutablePath") }
            "missing command line" { $candidate.PSObject.Properties.Remove("CommandLine") }
            "missing parent" { $candidate.PSObject.Properties.Remove("ParentProcessId") }
            "missing creation time" { $candidate.PSObject.Properties.Remove("CreationDate") }
            "invalid creation time" { $candidate.CreationDate = "not-a-date" }
            "missing PID" { $candidate.PSObject.Properties.Remove("ProcessId") }
        }
        $script:budgetWatchdogs = @($candidate)
        Write-BudgetSession
        $before = [System.IO.File]::ReadAllText($script:budgetSessionPath)

        Invoke-BudgetRecovery

        $script:budgetLaunches | Should Be 0
        [System.IO.File]::ReadAllText($script:budgetSessionPath) | Should Be $before
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:budgetConfig -GetProcessIdentity { param($ProcessId) $null }
        $plan.WatchdogOwnershipUnknown | Should Be $true
        $plan.Recoverable | Should Be $false
    }

    It "does not charge or launch when live watchdog ownership cannot be inspected" {
        Write-BudgetSession
        $before = [System.IO.File]::ReadAllText($script:budgetSessionPath)
        Mock Get-CimInstance { throw "injected watchdog census failure" } -ParameterFilter {
            $ClassName -eq "Win32_Process" -and $Filter -eq "Name='node.exe'"
        }

        Invoke-BudgetRecovery

        $script:budgetLaunches | Should Be 0
        [System.IO.File]::ReadAllText($script:budgetSessionPath) | Should Be $before
    }

    It "permits fallback after the detached watchdog has disappeared" {
        $script:budgetWatchdogs = @(New-BudgetWatchdog)
        Write-BudgetSession
        Invoke-BudgetRecovery
        $script:budgetWatchdogs = @()

        Invoke-BudgetRecovery

        $script:budgetLaunches | Should Be 1
        $script:budgetHistoryAtLaunch.Count | Should Be 1
    }

    It "does not start Node when five canonical restart charges remain in the shared window" {
        $script:budgetSession.restartTimesMs = @($script:budgetNowMs) * 5
        Write-BudgetSession

        Invoke-BudgetRecovery

        $script:budgetLaunches | Should Be 0
        ($script:budgetEvents -contains "dev-session-restart-rate-limited") | Should Be $true
    }

    It "persists the fifth canonical charge before launch and blocks the next guardian attempt" {
        $script:budgetSession.restartTimesMs = @($script:budgetNowMs) * 4
        Write-BudgetSession

        Invoke-BudgetRecovery
        Invoke-BudgetRecovery

        $script:budgetLaunches | Should Be 1
        $script:budgetHistoryAtLaunch.Count | Should Be 5
        $saved = [System.IO.File]::ReadAllText($script:budgetSessionPath) | ConvertFrom-Json
        @($saved.restartTimesMs).Count | Should Be 5
        $saved.preservedExtra | Should Be "keep"
        $saved.environment.TAURI_DEV_PORT | Should Be "4321"
    }

    It "blocks exhausted legacy history when the canonical field is <CanonicalState>" -TestCases @(
        @{ CanonicalState = "absent" }
        @{ CanonicalState = "malformed" }
    ) {
        param($CanonicalState)
        if ($CanonicalState -eq "absent") {
            $script:budgetSession.Remove("restartTimesMs")
        } else {
            $script:budgetSession.restartTimesMs = $null
        }
        $script:budgetSession.supervisorRestartTimesMs = @($script:budgetNowMs) * 5
        Write-BudgetSession

        Invoke-BudgetRecovery

        $script:budgetLaunches | Should Be 0
    }

    It "migrates legacy history and removes the competing field when charging a restart" {
        $script:budgetSession.Remove("restartTimesMs")
        $script:budgetSession.supervisorRestartTimesMs = @($script:budgetNowMs) * 4
        Write-BudgetSession

        Invoke-BudgetRecovery

        $script:budgetLaunches | Should Be 1
        $script:budgetHistoryAtLaunch.Count | Should Be 5
        $saved = [System.IO.File]::ReadAllText($script:budgetSessionPath) | ConvertFrom-Json
        ($saved.PSObject.Properties.Name -contains "supervisorRestartTimesMs") | Should Be $false
    }

    It "keeps an empty canonical history authoritative over stale legacy charges" {
        $script:budgetSession.supervisorRestartTimesMs = @($script:budgetNowMs) * 5
        Write-BudgetSession

        Invoke-BudgetRecovery

        $script:budgetLaunches | Should Be 1
        $script:budgetHistoryAtLaunch.Count | Should Be 1
        $saved = [System.IO.File]::ReadAllText($script:budgetSessionPath) | ConvertFrom-Json
        ($saved.PSObject.Properties.Name -contains "supervisorRestartTimesMs") | Should Be $false
    }

    It "expires old charges before persisting the next launch" {
        $script:budgetSession.restartTimesMs = @($script:budgetNowMs - 1800001) * 5
        Write-BudgetSession

        Invoke-BudgetRecovery

        $script:budgetLaunches | Should Be 1
        $script:budgetHistoryAtLaunch.Count | Should Be 1
    }

    It "preserves raw worker and root identity date strings for Node's exact cleanup checks" {
        $creationDate = "/Date(1791914373703)/"
        $script:budgetSession.workerIdentity = @{
            ProcessId = 5000; ExecutablePath = $script:budgetNode; CreationDate = $creationDate
        }
        $script:budgetSession.roots = @(@{
            pid = 6000; role = "vite"
            identity = @{ ProcessId = 6000; ExecutablePath = $script:budgetNode; CreationDate = $creationDate }
        })
        Write-BudgetSession

        Invoke-BudgetRecovery

        $script:budgetLaunches | Should Be 1
        $savedJson = [System.IO.File]::ReadAllText($script:budgetSessionPath).Replace('\/', '/')
        [regex]::Matches($savedJson, [regex]::Escape($creationDate)).Count | Should Be 2
        $savedJson | Should Match ([regex]::Escape('"supervisorStartedAtUtc":"2026-10-13T00:00:00.000Z"'))
    }

    It "does not charge or launch during <Suppression>" -TestCases @(
        @{ Suppression = "maintenance" }
        @{ Suppression = "planned stopping" }
        @{ Suppression = "disabled watchdog" }
    ) {
        param($Suppression)
        if ($Suppression -eq "planned stopping") { $script:budgetSession.state = "stopping" }
        if ($Suppression -eq "disabled watchdog") {
            [System.IO.File]::WriteAllText((Join-Path $script:budgetConfig "settings.json"), '{"watchdogEnabled":false}')
        }
        Write-BudgetSession
        $before = [System.IO.File]::ReadAllText($script:budgetSessionPath)

        Invoke-BudgetRecovery -Maintenance:($Suppression -eq "maintenance")

        $script:budgetLaunches | Should Be 0
        [System.IO.File]::ReadAllText($script:budgetSessionPath) | Should Be $before
    }

    It "does not launch or overwrite a newer stopping marker from a stale recovery plan" {
        Write-BudgetSession
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:budgetConfig -GetProcessIdentity { param($ProcessId) $null }
        $script:budgetSession.state = "stopping"
        Write-BudgetSession
        $before = [System.IO.File]::ReadAllText($script:budgetSessionPath)

        Invoke-CcsmDevSessionRecovery -Plan $plan -IsMaintenance { $false } -GetListenerOwner { $null } `
            -GetProcessIdentity { param($ProcessId) $null } -StartDevSession { $script:budgetLaunches++; 9876 } `
            -WriteEvent { param($Level, $Event, $Detail) $script:budgetEvents.Add($Event) | Out-Null }

        $script:budgetLaunches | Should Be 0
        [System.IO.File]::ReadAllText($script:budgetSessionPath) | Should Be $before
    }

    It "matches Node's inclusive window and numeric safe-integer filtering" {
        $history = [pscustomobject]@{
            restartTimesMs = @(199999L, 200000L, 200000L, 2000000L, 9007199254740991L,
                "2000000", $null, $true, 1.5, [double]::NaN, [double]::PositiveInfinity, 9007199254740992L)
            supervisorRestartTimesMs = @(2000000L) * 5
        }

        $actual = @(Get-CcsmDevSessionRestartTimesMs -Session $history -NowMs 2000000L)

        $actual.Count | Should Be 4
        ($actual -join ",") | Should Be "200000,200000,2000000,9007199254740991"
    }

    It "retains the persisted charge when spawning the replacement fails" {
        Write-BudgetSession
        $plan = Get-CcsmDevSessionRecoveryPlan -ConfigPath $script:budgetConfig -GetProcessIdentity { param($ProcessId) $null }

        {
            Invoke-CcsmDevSessionRecovery -Plan $plan -IsMaintenance { $false } -GetListenerOwner { $null } `
                -GetProcessIdentity { param($ProcessId) $null } -StartDevSession { throw "injected dev start failure" } `
                -WriteEvent { param($Level, $Event, $Detail) $script:budgetEvents.Add($Event) | Out-Null }
        } | Should Throw "injected dev start failure"

        $saved = [System.IO.File]::ReadAllText($script:budgetSessionPath) | ConvertFrom-Json
        @($saved.restartTimesMs).Count | Should Be 1
    }

    It "does not launch or damage the marker when persisting the charge fails" {
        Write-BudgetSession
        $before = [System.IO.File]::ReadAllText($script:budgetSessionPath)
        $lock = [System.IO.File]::Open(
            $script:budgetSessionPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        try {
            Invoke-BudgetRecovery
        } finally {
            $lock.Dispose()
        }

        $script:budgetLaunches | Should Be 0
        [System.IO.File]::ReadAllText($script:budgetSessionPath) | Should Be $before
        ($script:budgetEvents -contains "dev-session-restart-budget-persist-failed") | Should Be $true
        @(Get-ChildItem -LiteralPath (Split-Path -Parent $script:budgetSessionPath) -Filter "*.tmp").Count | Should Be 0
    }

    It "uses the shared development budget without consulting the production restart allowance" {
        # The runner policy now lives in JavaScript. Exercise that implementation
        # while preserving the separately tested PowerShell transaction helpers.
        $runnerTests = Join-Path (Split-Path -Parent $PSScriptRoot) "watch-ccswitchmulti.node-test.mjs"
        $output = & node --test --test-reporter=tap `
            --test-name-pattern '^development recovery does not consult production restart budget$' `
            $runnerTests 2>&1
        $LASTEXITCODE | Should Be 0
        ($output -join "`n") | Should Match '(?m)^# pass 1$'
    }
}

Describe "CCSwitchMulti guardian maintenance lease" {
    BeforeEach {
        $script:testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ccsm-guardian-test-" + [guid]::NewGuid().ToString("N"))
        $script:markerPath = Join-Path $script:testRoot "maintenance.json"
    }

    AfterEach {
        if (Test-Path -LiteralPath $script:testRoot) {
            Remove-Item -LiteralPath $script:testRoot -Recurse -Force
        }
    }

    It "treats the Codex AppContainer LocalCache projection as the same LocalAppData executable" {
        $installed = Join-Path $env:LOCALAPPDATA "CCSwitchMulti\cc-switch.exe"
        $projected = Join-Path $env:LOCALAPPDATA "Packages\OpenAI.Codex_test\LocalCache\Local\CCSwitchMulti\cc-switch.exe"

        (Test-CcsmGuardianSamePath -Left $projected -Right $installed) | Should Be $true
    }

    It "does not collapse unrelated AppContainer paths into the installed executable" {
        $installed = Join-Path $env:LOCALAPPDATA "CCSwitchMulti\cc-switch.exe"
        $foreign = Join-Path $env:LOCALAPPDATA "Packages\Other.Product_test\LocalCache\Local\CCSwitchMulti\cc-switch.exe"

        (Test-CcsmGuardianSamePath -Left $foreign -Right $installed) | Should Be $false
    }

    It "accepts an unexpired lease only when PID path and start time match" {
        Write-TestLease -Path $script:markerPath -Lease (New-TestLease)
        $getIdentity = {
            param($ProcessId)
            return [pscustomobject]@{
                ProcessId = $ProcessId
                Path = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
                StartTimeUtc = "2026-08-24T05:00:00.0000000Z"
            }
        }

        Test-CcsmMaintenanceLease -MarkerPath $script:markerPath `
            -NowUtc ([datetime]"2026-08-24T05:05:00Z") -GetProcessIdentity $getIdentity | Should Be $true
    }

    It "rejects an expired lease even while the recorded PID remains alive" {
        Write-TestLease -Path $script:markerPath -Lease (New-TestLease -ExpiresAtUtc ([datetime]"2026-08-24T05:04:59Z"))
        $getIdentity = {
            param($ProcessId)
            return [pscustomobject]@{
                ProcessId = $ProcessId
                Path = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
                StartTimeUtc = "2026-08-24T05:00:00.0000000Z"
            }
        }

        Test-CcsmMaintenanceLease -MarkerPath $script:markerPath `
            -NowUtc ([datetime]"2026-08-24T05:05:00Z") -GetProcessIdentity $getIdentity | Should Be $false
    }

    It "rejects a lease when the PID has been reused by another process instance" {
        Write-TestLease -Path $script:markerPath -Lease (New-TestLease)
        $getIdentity = {
            param($ProcessId)
            return [pscustomobject]@{
                ProcessId = $ProcessId
                Path = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
                StartTimeUtc = "2026-08-24T05:01:00.0000000Z"
            }
        }

        Test-CcsmMaintenanceLease -MarkerPath $script:markerPath `
            -NowUtc ([datetime]"2026-08-24T05:05:00Z") -GetProcessIdentity $getIdentity | Should Be $false
    }

    It "removes only the lease owned by the caller" {
        Write-TestLease -Path $script:markerPath -Lease (New-TestLease)

        Exit-CcsmMaintenanceLease -MarkerPath $script:markerPath -LeaseId "some-other-lease"
        (Test-Path -LiteralPath $script:markerPath) | Should Be $true

        Exit-CcsmMaintenanceLease -MarkerPath $script:markerPath -LeaseId "lease-test"
        (Test-Path -LiteralPath $script:markerPath) | Should Be $false
    }

    It "cleans the owned lease when the protected upgrade action fails" {
        {
            Invoke-CcsmMaintenanceLeaseScope -MarkerPath $script:markerPath -Purpose "test-upgrade" `
                -DurationSeconds 600 -Action { throw "injected upgrade failure" }
        } | Should Throw "injected upgrade failure"

        (Test-Path -LiteralPath $script:markerPath) | Should Be $false
    }

    It "atomically replaces an expired lease file instead of blocking every future upgrade" {
        Write-TestLease -Path $script:markerPath -Lease (
            New-TestLease -ExpiresAtUtc ([datetime]"2000-01-01T00:00:00Z")
        )

        $leaseId = Enter-CcsmMaintenanceLease -MarkerPath $script:markerPath `
            -Purpose "replacement-upgrade" -DurationSeconds 600
        try {
            $lease = [System.IO.File]::ReadAllText($script:markerPath, [System.Text.Encoding]::UTF8) |
                ConvertFrom-Json
            [string]$lease.leaseId | Should Be $leaseId
            [string]$lease.purpose | Should Be "replacement-upgrade"
            [int]$lease.ownerPid | Should Be $PID
        } finally {
            Exit-CcsmMaintenanceLease -MarkerPath $script:markerPath -LeaseId $leaseId
        }
    }

    It "preserves an active lease owned by the matching live process" {
        $owner = Get-CcsmGuardianProcessIdentity -ProcessId $PID
        $active = New-CcsmMaintenanceLeaseRecord -OwnerIdentity $owner -LeaseId "active-owner" `
            -NowUtc ([datetime]::UtcNow) -DurationSeconds 600 -Purpose "active-upgrade"
        Write-TestLease -Path $script:markerPath -Lease $active

        {
            Enter-CcsmMaintenanceLease -MarkerPath $script:markerPath `
                -Purpose "competing-upgrade" -DurationSeconds 600
        } | Should Throw "active CCSwitchMulti maintenance lease"

        $lease = [System.IO.File]::ReadAllText($script:markerPath, [System.Text.Encoding]::UTF8) |
            ConvertFrom-Json
        [string]$lease.leaseId | Should Be "active-owner"
    }

    It "atomically replaces malformed lease JSON" {
        New-Item -ItemType Directory -Path $script:testRoot -Force | Out-Null
        [System.IO.File]::WriteAllText(
            $script:markerPath,
            "not-json",
            [System.Text.UTF8Encoding]::new($false)
        )

        $leaseId = Enter-CcsmMaintenanceLease -MarkerPath $script:markerPath `
            -Purpose "repair-malformed" -DurationSeconds 600
        try {
            $lease = [System.IO.File]::ReadAllText($script:markerPath, [System.Text.Encoding]::UTF8) |
                ConvertFrom-Json
            [string]$lease.leaseId | Should Be $leaseId
        } finally {
            Exit-CcsmMaintenanceLease -MarkerPath $script:markerPath -LeaseId $leaseId
        }
    }
}

Describe "CCSwitchMulti owned child process wait" {
    It "returns when the transaction owner exits without waiting for its long-running descendant" {
        $testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ccsm-process-wait-" + [guid]::NewGuid().ToString("N"))
        $spawnScript = Join-Path $testRoot "spawn-descendant.ps1"
        $childPidPath = Join-Path $testRoot "child.pid"
        $parent = $null
        $childPid = 0
        New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
        [System.IO.File]::WriteAllText(
            $spawnScript,
            @'
param([string]$ChildPidPath)
$powerShell7Executable = Join-Path $PSHOME "pwsh.exe"
$child = Start-Process -FilePath $powerShell7Executable -WindowStyle Hidden -PassThru `
    -ArgumentList @("-NoProfile", "-Command", "Start-Sleep -Seconds 30")
[System.IO.File]::WriteAllText(
    $ChildPidPath,
    [string]$child.Id,
    [System.Text.UTF8Encoding]::new($false)
)
'@,
            [System.Text.UTF8Encoding]::new($false)
        )
        try {
            $powerShell7Executable = Join-Path $PSHOME "pwsh.exe"
            $parent = Start-Process -FilePath $powerShell7Executable -WindowStyle Hidden -PassThru `
                -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $spawnScript, $childPidPath)
            $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

            $exitCode = Wait-CcsmOwnedProcessExit -Process $parent

            $stopwatch.Stop()
            $exitCode | Should Be 0
            $stopwatch.Elapsed.TotalSeconds | Should BeLessThan 10
            (Test-Path -LiteralPath $childPidPath -PathType Leaf) | Should Be $true
            $childPid = [int][System.IO.File]::ReadAllText($childPidPath, [System.Text.Encoding]::UTF8)
            (Get-Process -Id $childPid -ErrorAction SilentlyContinue) | Should Not BeNullOrEmpty
        } finally {
            if ($childPid -gt 0) { Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue }
            if ($null -ne $parent -and -not $parent.HasExited) { Stop-Process -Id $parent.Id -Force -ErrorAction SilentlyContinue }
            if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
        }
    }
}

Describe "CCSwitchMulti Tauri NSIS payload hash" {
    It "hashes the packaged binary after the official bundle marker replacement" {
        $testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ccsm-nsis-hash-" + [guid]::NewGuid().ToString("N"))
        $binaryPath = Join-Path $testRoot "app.exe"
        New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
        try {
            $source = [System.Text.Encoding]::ASCII.GetBytes(
                "prefix-__TAURI_BUNDLE_TYPE_VAR_UNK-suffix"
            )
            $expected = [System.Text.Encoding]::ASCII.GetBytes(
                "prefix-__TAURI_BUNDLE_TYPE_VAR_NSS-suffix"
            )
            [System.IO.File]::WriteAllBytes($binaryPath, $source)
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try {
                $expectedHash = [System.BitConverter]::ToString($sha.ComputeHash($expected)).Replace("-", "")
            } finally {
                $sha.Dispose()
            }

            Get-CcsmTauriNsisPayloadHash -ExecutablePath $binaryPath | Should Be $expectedHash
        } finally {
            if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
        }
    }
}

Describe "CCSwitchMulti dependency-free file hash" {
    It "hashes an ordinary file without Get-FileHash" {
        $testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ccsm-file-hash-" + [guid]::NewGuid().ToString("N"))
        $filePath = Join-Path $testRoot "artifact.bin"
        New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
        try {
            [System.IO.File]::WriteAllText(
                $filePath,
                "ccsm-hash-contract",
                [System.Text.UTF8Encoding]::new($false)
            )

            Get-CcsmGuardianFileSha256 -LiteralPath $filePath |
                Should Be "BCA9833A47F154896A0B105E173390BC393E068BF5C3FB9AC45AAC2C580B1CE4"
        } finally {
            if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
        }
    }
}

Describe "CCSwitchMulti upgrade wrapper result contract" {
    It "reads the successful transaction PID from NewPid" {
        $wrapperPath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) `
            "scripts\invoke-ccswitchmulti-local-upgrade.ps1"
        $wrapper = [System.IO.File]::ReadAllText($wrapperPath, [System.Text.Encoding]::UTF8)

        $wrapper | Should Match '\$transactionResult\.NewPid'
        $wrapper | Should Not Match '\$transactionResult\.NewProcessId'
        $wrapper | Should Match 'Get-CcsmGuardianFileSha256'
        $wrapper | Should Not Match 'Get-FileHash'
    }
}

Describe "CCSwitchMulti guardian decision loop" {
    BeforeEach {
        $script:events = New-Object System.Collections.Generic.List[string]
        $script:recoveries = 0
        $script:writeEvent = {
            param($Level, $Event, $Detail)
            $script:events.Add($Event) | Out-Null
        }
        $script:recover = { $script:recoveries++ }
    }

    It "does nothing while the expected listener is healthy" {
        $state = [pscustomobject]@{ FailureSinceUtc = $null }
        $inspect = { [pscustomobject]@{ Healthy = $true; ListenerOwner = 4242 } }

        Invoke-CcsmGuardianIteration -State $state -NowUtc ([datetime]"2026-08-24T05:00:00Z") `
            -FailureThresholdSeconds 60 -IsMaintenance { $false } -InspectRuntime $inspect `
            -Recover $script:recover -WriteEvent $script:writeEvent

        $script:recoveries | Should Be 0
        $state.FailureSinceUtc | Should Be $null
    }

    It "suppresses recovery and clears the failure timer during active maintenance" {
        $state = [pscustomobject]@{ FailureSinceUtc = [datetime]"2026-08-24T04:58:00Z" }
        $inspect = { throw "runtime inspection must not run during maintenance" }

        Invoke-CcsmGuardianIteration -State $state -NowUtc ([datetime]"2026-08-24T05:00:00Z") `
            -FailureThresholdSeconds 60 -IsMaintenance { $true } -InspectRuntime $inspect `
            -Recover $script:recover -WriteEvent $script:writeEvent

        $script:recoveries | Should Be 0
        $state.FailureSinceUtc | Should Be $null
    }

    It "waits for a continuous sixty-second failure before recovery" {
        $state = [pscustomobject]@{ FailureSinceUtc = $null }
        $inspect = { [pscustomobject]@{ Healthy = $false; ListenerOwner = $null } }

        Invoke-CcsmGuardianIteration -State $state -NowUtc ([datetime]"2026-08-24T05:00:00Z") `
            -FailureThresholdSeconds 60 -IsMaintenance { $false } -InspectRuntime $inspect `
            -Recover $script:recover -WriteEvent $script:writeEvent
        Invoke-CcsmGuardianIteration -State $state -NowUtc ([datetime]"2026-08-24T05:00:59Z") `
            -FailureThresholdSeconds 60 -IsMaintenance { $false } -InspectRuntime $inspect `
            -Recover $script:recover -WriteEvent $script:writeEvent
        $script:recoveries | Should Be 0

        Invoke-CcsmGuardianIteration -State $state -NowUtc ([datetime]"2026-08-24T05:01:00Z") `
            -FailureThresholdSeconds 60 -IsMaintenance { $false } -InspectRuntime $inspect `
            -Recover $script:recover -WriteEvent $script:writeEvent
        $script:recoveries | Should Be 1
    }
}

Describe "CCSwitchMulti guarded recovery" {
    BeforeEach {
        $script:actions = New-Object System.Collections.Generic.List[string]
        $script:writeEvent = {
            param($Level, $Event, $Detail)
            $script:actions.Add("event:$Event") | Out-Null
        }
    }

    It "refuses to stop a foreign listener" {
        Invoke-CcsmGuardianRecovery -InstalledExecutable "C:\Apps\CCSwitchMulti\cc-switch.exe" `
            -IsMaintenance { $false } -InstalledExecutableExists { $true } -GetListenerOwner { 9001 } `
            -GetProcessIdentity { param($ProcessId) [pscustomobject]@{ ProcessId = $ProcessId; Path = "C:\Windows\notepad.exe"; StartTimeUtc = "2026-08-24T05:00:00Z" } } `
            -IsExpectedProductIdentity { param($Identity) $false } `
            -GetExpectedProductProcesses { @() } `
            -StopVerifiedProductProcess { param($Identity) $script:actions.Add("stop") | Out-Null } `
            -WaitPortFree { $script:actions.Add("wait-port") | Out-Null; $true } `
            -StartProduct { $script:actions.Add("start") | Out-Null; 5000 } `
            -WaitReady { param($ProcessId) $true } -WriteEvent $script:writeEvent

        (@($script:actions | Where-Object { $_ -eq "stop" }).Count) | Should Be 0
        (@($script:actions | Where-Object { $_ -eq "start" }).Count) | Should Be 0
        ($script:actions -contains "event:foreign-listener-blocked-recovery") | Should Be $true
    }

    It "stops verified stale processes and waits for port release before start" {
        $identity = [pscustomobject]@{ ProcessId = 4242; Path = "C:\Apps\CCSwitchMulti\cc-switch.exe"; StartTimeUtc = "2026-08-24T05:00:00Z" }
        Invoke-CcsmGuardianRecovery -InstalledExecutable "C:\Apps\CCSwitchMulti\cc-switch.exe" `
            -IsMaintenance { $false } -InstalledExecutableExists { $true } -GetListenerOwner { $null } `
            -GetProcessIdentity { param($ProcessId) $identity } `
            -IsExpectedProductIdentity { param($Identity) $true } `
            -GetExpectedProductProcesses { @($identity) } `
            -StopVerifiedProductProcess { param($Identity) $script:actions.Add("stop:$($Identity.ProcessId)") | Out-Null } `
            -WaitPortFree { $script:actions.Add("wait-port") | Out-Null; $true } `
            -StartProduct { $script:actions.Add("start") | Out-Null; 5000 } `
            -WaitReady { param($ProcessId) $script:actions.Add("ready:$ProcessId") | Out-Null; $true } `
            -WriteEvent $script:writeEvent

        $script:actions.IndexOf("stop:4242") | Should BeLessThan $script:actions.IndexOf("wait-port")
        $script:actions.IndexOf("wait-port") | Should BeLessThan $script:actions.IndexOf("start")
        $script:actions.IndexOf("start") | Should BeLessThan $script:actions.IndexOf("ready:5000")
    }
}
