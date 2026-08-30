param(
    [double]$MaxGiB = 20,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$targetRoot = Resolve-Path -LiteralPath (Join-Path $repoRoot "src-tauri\target") -ErrorAction SilentlyContinue

if (-not $targetRoot) {
    Write-Output "No src-tauri target directory exists."
    exit 0
}

if ($MaxGiB -le 0) {
    throw "MaxGiB must be greater than zero."
}

$targetPath = $targetRoot.Path
$measurement = Get-ChildItem -LiteralPath $targetPath -File -Force -Recurse -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum
$sizeGiB = [double]$measurement.Sum / 1GB

Write-Output ("Development Cargo target: {0:N2} GiB (limit {1:N2} GiB)." -f $sizeGiB, $MaxGiB)
if ($sizeGiB -le $MaxGiB) {
    Write-Output "Cache is within the configured limit; nothing to clean."
    exit 0
}

$processes = Get-CimInstance Win32_Process |
    Where-Object {
        $name = [string]$_.Name
        $commandLine = [string]$_.CommandLine
        $executablePath = [string]$_.ExecutablePath
        $isBuildProcess = $name -in @("cargo.exe", "rustc.exe")
        $isRepoApp = $name -in @("cc-switch.exe", "cc-switch2.exe") -and
            (($executablePath -and $executablePath.StartsWith($targetPath, [StringComparison]::OrdinalIgnoreCase)) -or
             ($commandLine -and $commandLine -match "cc-switch"))
        $isBuildProcess -or $isRepoApp
    }

if ($processes) {
    $details = $processes | Select-Object ProcessId, Name, ExecutablePath, CommandLine
    $details | Format-Table -AutoSize | Out-String | Write-Output
    throw "Refusing to clean while Cargo, rustc, or the repository app is running."
}

if (-not $Force) {
    throw "Cache exceeds the limit. Re-run with -Force after confirming no development process is running."
}

Write-Output "Cleaning the complete development target with Cargo..."
& cargo clean --manifest-path (Join-Path $repoRoot "src-tauri\Cargo.toml")
if ($LASTEXITCODE -ne 0) {
    throw "cargo clean failed with exit code $LASTEXITCODE."
}

Write-Output "Development Cargo cache cleaned."
