#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$GuardianRoot = "$env:LOCALAPPDATA\CCSwitchMultiGuardian",
    [string]$TaskName = "CCSwitchMulti-Watchdog",
    [string]$InstalledExecutable = "$env:LOCALAPPDATA\CCSwitchMulti\cc-switch.exe",
    [int]$Port = 15721,
    [int]$PollSeconds = 5,
    [int]$FailureThresholdSeconds = 60,
    [string]$ConfigPath = "$env:USERPROFILE\.cc-switch",
    [switch]$Uninstall,
    [switch]$NoStart,
    [switch]$Help
)

# Compatibility entry only. The JavaScript file owns all lifecycle behavior.
$ErrorActionPreference = 'Stop'
$nodeExecutable = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$nodeArguments = @((Join-Path $PSScriptRoot 'install-ccswitchmulti-watchdog.mjs'))
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
