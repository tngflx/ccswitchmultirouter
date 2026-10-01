$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $repoRoot
try {
    . (Join-Path $repoRoot 'scripts/validate-agents-md.ps1') | Out-Null
    if ($fail -ne 0) { throw "Repository validator failed $fail checks" }
    $record = @'
- Approval: approved
- Implementation: implemented
- Verification: partial
- Runtime freshness: not-applicable
- Disposition: active
'@
    $cases = @(
        @{ Name = 'valid independent statuses'; Record = $record; Expected = $true },
        @{ Name = 'tested does not imply approved'; Record = $record.Replace('- Approval: approved', '- Approval: not-approved').Replace('- Verification: partial', '- Verification: passed'); Expected = $true },
        @{ Name = 'missing approval rejected'; Record = $record.Replace('- Approval: approved', ''); Expected = $false },
        @{ Name = 'combined status rejected'; Record = "- Status: verified`n" + $record; Expected = $false },
        @{ Name = 'verification cannot be approval'; Record = $record.Replace('- Approval: approved', '- Approval: verified'); Expected = $false },
        @{ Name = 'duplicate approval rejected'; Record = "- Approval: not-approved`n" + $record; Expected = $false },
        @{ Name = 'missing freshness rejected'; Record = $record.Replace('- Runtime freshness: not-applicable', ''); Expected = $false },
        @{ Name = 'invalid verification rejected'; Record = $record.Replace('- Verification: partial', '- Verification: done'); Expected = $false }
    )
    foreach ($case in $cases) {
        $actual = Test-DecisionRecordStatuses $case.Record
        if ($actual -ne $case.Expected) {
            throw "FAIL $($case.Name): expected $($case.Expected), got $actual"
        }
        Write-Output "PASS $($case.Name)"
    }
    Write-Output "RESULT: $($cases.Count) passed, 0 failed"
} finally {
    Pop-Location
}
