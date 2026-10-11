[CmdletBinding()]
param(
    [string]$UpstreamUrl = "https://github.com/BigStrongSun/ccswitchmulti.git",
    [string]$Branch = "main",
    [string]$RemoteName = "ccswitchmulti-upstream",
    [ValidateRange(1, 500)]
    [int]$MaxCount = 50
)

$ErrorActionPreference = "Stop"

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = & git @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed:`n$($output -join "`n")"
    }
    return @($output)
}

$insideWorkTree = (Invoke-Git rev-parse --is-inside-work-tree | Select-Object -First 1)
if ($insideWorkTree -ne "true") {
    throw "Run this command from inside the cc-switch-multi Git worktree."
}

$remoteNames = @(Invoke-Git remote)
if ($remoteNames -notcontains $RemoteName) {
    Invoke-Git remote add $RemoteName $UpstreamUrl | Out-Null
} else {
    $existingRemote = (Invoke-Git remote get-url $RemoteName | Select-Object -First 1)
    if ($existingRemote -ne $UpstreamUrl) {
        Invoke-Git remote set-url $RemoteName $UpstreamUrl | Out-Null
    }
}

Invoke-Git fetch --no-tags $RemoteName "+refs/heads/$Branch`:refs/remotes/$RemoteName/$Branch" | Out-Null

$upstreamRef = "$RemoteName/$Branch"
$newCommits = @(
    Invoke-Git log --no-merges --format="%h %s" --max-count=$MaxCount "HEAD..$upstreamRef"
)

if ($newCommits.Count -eq 0 -or ($newCommits.Count -eq 1 -and [string]::IsNullOrWhiteSpace($newCommits[0]))) {
    Write-Host "No new commits from $UpstreamUrl ($Branch)." -ForegroundColor Green
    exit 0
}

Write-Warning "New commits are available from $UpstreamUrl ($Branch):"
$newCommits | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "Review with: git log HEAD..$upstreamRef"
