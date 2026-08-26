# Check for new commits from original cc-switch
# Usage: .\scripts\check-original-updates.ps1

git fetch original main 2>$null

$mergeBase = git merge-base HEAD original/main
$newCommits = git log --oneline "$mergeBase..original/main" --no-merges

if (-not $newCommits) {
    Write-Host "✅ No new commits from original cc-switch." -ForegroundColor Green
} else {
    Write-Host "⚠️  New commits available from original cc-switch:" -ForegroundColor Yellow
    Write-Host ""
    $newCommits | ForEach-Object { Write-Host "  $_" }
    Write-Host ""
    Write-Host "To evaluate a commit: git show <hash>"
    Write-Host "To cherry-pick:       git cherry-pick <hash>"
}
