$scriptRoot = Split-Path -Parent $PSScriptRoot
$suitePath = Join-Path $scriptRoot "local-build-pipeline.node-test.mjs"
$wrapperPath = Join-Path $scriptRoot "local-build-pipeline.ps1"

Describe "CCSwitchMulti JavaScript local production build" {
    It "preserves artifact, failure, rollback, ownership, junction and isolated cleanup guards in the Node suite" {
        $nodeExecutable = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        & $nodeExecutable --test $suitePath | Out-Host
        $LASTEXITCODE | Should Be 0
    }

    It "exposes JavaScript build help through the legacy entry point without starting a build" {
        $helpOutput = @(& $wrapperPath -Help) -join "`n"
        $LASTEXITCODE | Should Be 0
        $helpOutput | Should Match 'Usage: node scripts/local-build-pipeline.mjs'
        $helpOutput | Should Match 'without installing or publishing'
    }
}
