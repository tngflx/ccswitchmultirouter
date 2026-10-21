function Resolve-CcsmPowerShell7Executable {
    param(
        [scriptblock]$GetCommand = {
            Get-Command -Name 'pwsh.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        },
        [scriptblock]$GetMajorVersion = {
            param([string]$ExecutablePath)
            [System.Diagnostics.FileVersionInfo]::GetVersionInfo($ExecutablePath).ProductMajorPart
        }
    )

    $command = & $GetCommand
    if ($null -eq $command -or [string]::IsNullOrWhiteSpace([string]$command.Source)) {
        throw 'PowerShell 7 is required. Install the latest stable PowerShell 7 and make pwsh.exe available on PATH.'
    }
    $executable = [string]$command.Source
    if (-not [System.IO.Path]::IsPathRooted($executable) -or
        -not [string]::Equals([System.IO.Path]::GetFileName($executable), 'pwsh.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'PowerShell 7 resolution returned an invalid pwsh.exe path.'
    }
    try {
        $majorVersion = & $GetMajorVersion $executable
    } catch {
        throw 'PowerShell 7 version could not be verified. Reinstall the latest stable PowerShell 7.'
    }
    if ($majorVersion -ne 7) {
        throw 'PowerShell 7 is required. Update pwsh.exe on PATH to the latest stable PowerShell 7.'
    }
    return $executable
}
