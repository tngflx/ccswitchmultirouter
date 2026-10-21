#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$InstalledExecutable = "$env:LOCALAPPDATA\CCSwitchMulti\cc-switch.exe",
    [int]$Port = 15721,
    [string]$HealthUri = "http://127.0.0.1:15721/health",
    [int]$FailureThresholdSeconds = 60,
    [int]$PollSeconds = 5,
    [int]$ReadyTimeoutSeconds = 45,
    [string]$MaintenanceMarker = "$env:LOCALAPPDATA\CCSwitchMultiGuardian\maintenance.lock",
    [string]$LogPath = "$env:LOCALAPPDATA\CCSwitchMultiGuardian\guardian.jsonl",
    [string]$LockPath = "$env:LOCALAPPDATA\CCSwitchMultiGuardian\guardian.lock",
    [string]$ConfigPath = "$env:USERPROFILE\.cc-switch",
    [int]$MaxRestartsPerWindow = 6,
    [int]$RestartWindowMinutes = 30,
    [switch]$RestartOnCleanExit,
    [int]$MaxCycles = 0,
    [switch]$NoRestart,
    [switch]$DevelopmentMode,
    [switch]$PlanOnly,
    [switch]$Help
)

# Compatibility entry only. The JavaScript file owns all lifecycle behavior.
$ErrorActionPreference = 'Stop'
$nodeExecutable = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$nodeArguments = @((Join-Path $PSScriptRoot 'watch-ccswitchmulti.mjs'))
foreach ($name in $PSBoundParameters.Keys) {
    $value = $PSBoundParameters[$name]
    if ($name -eq 'Help') {
        if ($value) { $nodeArguments += '--help' }
    } elseif ($value -is [System.Management.Automation.SwitchParameter]) {
        if ($value.IsPresent) { $nodeArguments += "-$name" }
    } else {
        $nodeArguments += "-$name"
        $nodeArguments += [string]$value
    }
}
& $nodeExecutable.Source @nodeArguments
if ($LASTEXITCODE -ne 0) {
    if ($MyInvocation.InvocationName -eq '.') { throw "JavaScript lifecycle command failed with exit code $LASTEXITCODE" }
    exit $LASTEXITCODE
}
