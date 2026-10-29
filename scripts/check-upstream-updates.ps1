[CmdletBinding()]
param(
    [string]$UpstreamUrl = "https://github.com/BigStrongSun/ccswitchmulti.git",
    [string]$Branch = "main",
    [string]$RemoteName = "ccswitchmulti-upstream",
    [ValidateRange(1, 500)]
    [int]$MaxCount = 50
)

$ErrorActionPreference = "Stop"

# `origin` is the user's repository and is never an upstream-analysis target.
# Keep this check before any Git command so a typo or VSCode override cannot
# repoint the user's push remote or fetch from an unintended destination.
if ($RemoteName -ieq "origin") {
    throw "The remote name 'origin' is reserved for the user's repository and cannot be used for upstream analysis."
}

# Upstream-analysis remotes are fetch-only. This is intentionally a reserved
# non-routable URL rather than a blank push URL: Git's push destination is then
# explicit and fails closed even if a future tool invokes `git push <remote>`.
$DisabledUpstreamPushUrl = "https://example.invalid/UPSTREAM_PUSH_DISABLED.git"

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
        # Do not echo command arguments or Git's stderr: either can contain a
        # credential-bearing URL. Callers add only redacted operation context.
        throw "git operation failed (exit code $exitCode)."
    }
    return @($output)
}

function Get-ExistingRemoteName {
    param([string[]]$RemoteNames, [string]$RequestedName)

    return $RemoteNames |
        Where-Object { $_ -ieq $RequestedName } |
        Select-Object -First 1
}

function Get-RemoteFetchUrls {
    param([string]$Name)

    $urls = @(Invoke-Git remote get-url --all $Name | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    return @($urls | ForEach-Object { $_.ToString().Trim() })
}

function Get-GitConfigurationValues {
    param([string]$Key)

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $values = @(& git config --get-all $Key 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -eq 1) {
        return @()
    }
    if ($exitCode -ne 0) {
        throw "Unable to validate upstream configuration without exposing its values."
    }
    return @($values | ForEach-Object { $_.ToString() })
}

function Assert-UpstreamIsFetchOnly {
    param([string]$Name)

    # Git resolves inherited/multiple push URLs and url.*.insteadOf itself.
    # Checking configured sentinel text alone would let a rewrite rule turn it
    # into a live upstream destination.
    $pushUrls = @(Invoke-Git remote get-url --push --all $Name)
    if ($pushUrls.Count -ne 1 -or $pushUrls[0].ToString().Trim() -cne $DisabledUpstreamPushUrl) {
        throw "Upstream analysis requires an effectively fetch-only remote with pushes disabled; no configuration was changed."
    }
}

function Assert-NewUpstreamCanBeFetchOnly {
    param([string]$Name)

    # `git remote` may omit a name configured only in an inherited scope. Such
    # values are not safe to overwrite: notably pushurl values are multivalued,
    # so adding one local disabled value does not hide a writable global value.
    foreach ($field in @("url", "pushurl", "fetch")) {
        $inheritedValues = @(Get-GitConfigurationValues -Key "remote.$Name.$field")
        if ($inheritedValues.Count -gt 0) {
            throw "Upstream analysis requires an unambiguous fetch-only remote with pushes disabled; inherited configuration must be reviewed without rewriting it."
        }
    }

    # `ls-remote --get-url` expands insteadOf without contacting any server.
    # Unlike a synthetic named remote, it works before a remote exists. The
    # future explicit pushurl intentionally ignores pushInsteadOf, as Git does.
    $resolvedPushUrl = @(Invoke-Git ls-remote --get-url $DisabledUpstreamPushUrl)
    if ($resolvedPushUrl.Count -ne 1 -or $resolvedPushUrl[0].ToString().Trim() -cne $DisabledUpstreamPushUrl) {
        throw "Upstream analysis cannot create a fetch-only remote because the disabled push URL is rewritten; no configuration was changed."
    }
}

$insideWorkTree = (Invoke-Git rev-parse --is-inside-work-tree | Select-Object -First 1)
if ($insideWorkTree -ne "true") {
    throw "Run this command from inside the cc-switch-multi Git worktree."
}

$remoteNames = @(Invoke-Git remote)
$existingRemoteName = Get-ExistingRemoteName -RemoteNames $remoteNames -RequestedName $RemoteName
if ($null -eq $existingRemoteName) {
    # Validate rewrites and inherited destinations before any config write.
    Assert-NewUpstreamCanBeFetchOnly -Name $RemoteName

    # Create and lock the fetch-only remote before the first fetch. If fetching
    # fails, the remote remains safe to inspect/retry and cannot push upstream.
    # If the second write fails unexpectedly, remove the half-created remote so a
    # writable fetch URL cannot survive a failed installation.
    $createdRemote = $false
    try {
        Invoke-Git remote add $RemoteName $UpstreamUrl | Out-Null
        $createdRemote = $true
        Invoke-Git remote set-url --push $RemoteName $DisabledUpstreamPushUrl | Out-Null
    } catch {
        if ($createdRemote) {
            try {
                Invoke-Git remote remove $RemoteName | Out-Null
            } catch {
                throw "Unable to establish or roll back the fetch-only upstream remote; no push is authorized."
            }
        }
        throw
    }
    $existingRemoteName = $RemoteName
} else {
    try {
        $existingUrls = @(Get-RemoteFetchUrls -Name $existingRemoteName)
    } catch {
        throw "Existing upstream remote '$existingRemoteName' cannot be resolved as an effectively fetch-only remote; refusing to rewrite it."
    }
    if ($existingUrls.Count -ne 1 -or $existingUrls[0] -cne $UpstreamUrl) {
        throw "Existing upstream remote '$existingRemoteName' has a fetch URL mismatch or ambiguous URLs; refusing to rewrite it."
    }
    Assert-UpstreamIsFetchOnly -Name $existingRemoteName
}

Invoke-Git fetch --no-tags $existingRemoteName "+refs/heads/$Branch`:refs/remotes/$existingRemoteName/$Branch" | Out-Null

$upstreamRef = "$existingRemoteName/$Branch"
$newCommits = @(
    Invoke-Git log --no-merges --format="%h %s" --max-count=$MaxCount "HEAD..$upstreamRef"
)

if ($newCommits.Count -eq 0 -or ($newCommits.Count -eq 1 -and [string]::IsNullOrWhiteSpace($newCommits[0]))) {
    Write-Host "No new commits from the configured upstream ($Branch)." -ForegroundColor Green
    exit 0
}

Write-Warning "New commits are available from the configured upstream ($Branch):"
$newCommits | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "Review with: git log HEAD..$upstreamRef"
