$runtimeHelperPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'powershell7-runtime.ps1'
. $runtimeHelperPath

Describe 'CCSwitchMulti PowerShell 7 runtime selection' {
    It 'resolves an installed PowerShell 7 application without a legacy host fallback' {
        $resolved = Resolve-CcsmPowerShell7Executable `
            -GetCommand { [pscustomobject]@{ Source = 'C:\Program Files\PowerShell\7\pwsh.exe' } } `
            -GetMajorVersion { param($ExecutablePath) 7 }
        $resolved | Should Be 'C:\Program Files\PowerShell\7\pwsh.exe'
    }

    It 'reports a clear requirement when pwsh.exe is missing' {
        { Resolve-CcsmPowerShell7Executable -GetCommand { $null } } |
            Should Throw 'PowerShell 7 is required'
    }

    It 'rejects a legacy or unsupported PowerShell major version' {
        foreach ($major in @(5, 6, 8)) {
            { Resolve-CcsmPowerShell7Executable `
                -GetCommand { [pscustomobject]@{ Source = 'C:\Program Files\PowerShell\7\pwsh.exe' } } `
                -GetMajorVersion { param($ExecutablePath) $major } } |
                Should Throw 'PowerShell 7 is required'
        }
    }

    It 'rejects a relative or legacy-host application path' {
        foreach ($candidate in @('pwsh.exe', 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')) {
            { Resolve-CcsmPowerShell7Executable `
                -GetCommand { [pscustomobject]@{ Source = $candidate } } `
                -GetMajorVersion { param($ExecutablePath) 7 } } |
                Should Throw 'invalid pwsh.exe path'
        }
    }

    It 'fails closed when the PowerShell application version cannot be read' {
        { Resolve-CcsmPowerShell7Executable `
            -GetCommand { [pscustomobject]@{ Source = 'C:\Program Files\PowerShell\7\pwsh.exe' } } `
            -GetMajorVersion { param($ExecutablePath) throw 'unreadable fixture' } } |
            Should Throw 'version could not be verified'
    }

    It 'runs an actual child through the resolved PowerShell 7 executable' {
        $executable = Resolve-CcsmPowerShell7Executable
        $output = & $executable -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.Major'
        $LASTEXITCODE | Should Be 0
        [int]$output | Should Be 7
    }

    It 'registers the migrated watchdog task with an absolute Node application' {
        $suitePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'install-ccswitchmulti-watchdog.node-test.mjs'
        $output = & node --test $suitePath 2>&1
        $LASTEXITCODE | Should Be 0
        ($output -join "`n") | Should Match '(?:#|ℹ) pass [1-9]'
    }

    It 'launches upgrade and historical install transactions through the resolved host' {
        foreach ($name in @('invoke-ccswitchmulti-local-upgrade.ps1', 'run-v31-local-install.ps1')) {
            $source = [System.IO.File]::ReadAllText((Join-Path (Split-Path -Parent $PSScriptRoot) $name))
            $source | Should Match '\$powerShell7Executable = Resolve-CcsmPowerShell7Executable'
            $source | Should Match 'Start-Process -FilePath \$powerShell7Executable -WindowStyle Hidden'
            $source | Should Not Match 'Start-Process powershell(?:\.exe)?\b'
        }
    }

    It 'resolves the release exporter host before the pipeline can install dependencies' {
        $source = [System.IO.File]::ReadAllText((Join-Path (Split-Path -Parent $PSScriptRoot) 'local-release-pipeline.ps1'))
        $resolveOffset = $source.IndexOf('$powerShell7Executable = Resolve-CcsmPowerShell7Executable')
        $installOffset = $source.IndexOf('Invoke-CheckedCommand -FilePath "pnpm" -Arguments @("install"')
        $resolveOffset | Should BeGreaterThan -1
        $installOffset | Should BeGreaterThan $resolveOffset
        $source | Should Match 'Invoke-CheckedCommand -FilePath \$powerShell7Executable -Arguments \$exportArgs'
    }

    It 'generates a post-commit hook that requires pwsh.exe and preserves both execution modes' {
        $path = Join-Path (Split-Path -Parent $PSScriptRoot) 'install-local-release-hook.ps1'
        $tokens = $null
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
        $errors.Count | Should Be 0
        $function = $ast.Find({ param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq 'New-PostCommitHookContent'
        }, $true)
        Invoke-Expression $function.Extent.Text
        $synchronous = New-PostCommitHookContent -RunSynchronously $true
        $background = New-PostCommitHookContent -RunSynchronously $false
        foreach ($content in @($synchronous, $background)) {
            $content | Should Match 'command -v pwsh\.exe'
            $content | Should Match 'pwsh\.exe -NoProfile -ExecutionPolicy Bypass'
            $content | Should Not Match 'powershell\.exe'
        }
        $synchronous.TrimEnd() | Should Not Match '&$'
        $background.TrimEnd() | Should Match '&$'
    }
}
