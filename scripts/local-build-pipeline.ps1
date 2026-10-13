param(
    [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = Resolve-Path (Join-Path $scriptDir "..") | Select-Object -ExpandProperty Path
. (Join-Path $scriptDir "release-build-config.ps1")

function Resolve-LocalProductionOutputRoot {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [string]$RequestedOutputDir = ""
    )

    if ([string]::IsNullOrWhiteSpace($RequestedOutputDir)) {
        $RequestedOutputDir = "output\production"
    }
    if (-not [System.IO.Path]::IsPathRooted($RequestedOutputDir)) {
        $RequestedOutputDir = Join-Path $RepoRoot $RequestedOutputDir
    }
    return [System.IO.Path]::GetFullPath($RequestedOutputDir)
}

function Assert-LocalProductionOutputRoot {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$OutputRoot
    )

    $repoFull = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\', '/')
    $outputFull = [System.IO.Path]::GetFullPath($OutputRoot).TrimEnd('\', '/')
    if ($outputFull -eq [System.IO.Path]::GetPathRoot($OutputRoot).TrimEnd('\', '/')) {
        throw "local production output must not be a filesystem root: $OutputRoot"
    }
    $allowedPrefix = (Join-Path $repoFull "output") + [System.IO.Path]::DirectorySeparatorChar
    $repoPrefix = $repoFull + [System.IO.Path]::DirectorySeparatorChar
    $outputPrefix = $outputFull + [System.IO.Path]::DirectorySeparatorChar
    if ($outputFull -eq $repoFull -or $repoFull.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        ($outputFull.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
            -not $outputFull.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "local production output inside the repository must be a child of its output directory: $outputFull"
    }

    # Staging and previous-output backups share the final output's parent.
    # Check existing ancestors so a junction cannot redirect those mutations.
    $current = $outputFull
    while (-not [string]::IsNullOrWhiteSpace($current) -and
        -not [string]::Equals($current, $repoFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $current) {
            $ancestor = Get-Item -LiteralPath $current -Force
            if (($ancestor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "local production output path must not contain a reparse point: $current"
            }
            if (-not $ancestor.PSIsContainer) {
                throw "local production output path must contain only directories: $current"
            }
        }
        $current = Split-Path -Parent $current
    }

    if (Test-Path -LiteralPath $outputFull) {
        $children = @(Get-ChildItem -LiteralPath $outputFull -Force)
        if ($children.Count -gt 0) {
            $markerPath = Join-Path $outputFull "LOCAL-BUILD.json"
            $marker = if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
                [System.IO.File]::ReadAllText($markerPath) | ConvertFrom-Json
            }
            if (-not $marker -or $marker.generatedBy -ne "local-build-pipeline.ps1") {
                throw "local production output is not owned by this build pipeline; choose an empty output directory: $outputFull"
            }
        }
    }
}

function Export-LocalProductionArtifacts {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$CargoTargetDir,
        [Parameter(Mandatory = $true)][string]$OutputRoot
    )

    Assert-LocalProductionOutputRoot -RepoRoot $RepoRoot -OutputRoot $OutputRoot
    $releaseDir = Join-Path $CargoTargetDir "release"
    $rawExe = Join-Path $releaseDir "cc-switch.exe"
    $bundleDir = Join-Path $releaseDir "bundle"
    if (-not (Test-Path -LiteralPath $rawExe -PathType Leaf)) {
        throw "local production build did not produce the raw executable: $rawExe"
    }
    $installers = @(Get-ChildItem -LiteralPath (Join-Path $bundleDir "nsis") -Filter "*-setup.exe" -File -ErrorAction SilentlyContinue)
    if ($installers.Count -eq 0) {
        throw "local production build did not produce an NSIS installer: $bundleDir"
    }

    $stageRoot = New-ReleaseStageRoot -ReleaseRoot $OutputRoot
    try {
        New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
        Copy-Item -LiteralPath $rawExe -Destination (Join-Path $stageRoot "cc-switch.exe") -Force
        Copy-Item -LiteralPath $bundleDir -Destination (Join-Path $stageRoot "bundle") -Recurse -Force
        $resourceDir = Join-Path $RepoRoot "src-tauri\resources"
        if (Test-Path -LiteralPath $resourceDir -PathType Container) {
            Copy-Item -LiteralPath $resourceDir -Destination (Join-Path $stageRoot "resources") -Recurse -Force
        }
        $marker = [ordered]@{
            generatedBy = "local-build-pipeline.ps1"
            generatedAt = (Get-Date).ToUniversalTime().ToString("o")
            updaterSigned = $false
        } | ConvertTo-Json
        [System.IO.File]::WriteAllText((Join-Path $stageRoot "LOCAL-BUILD.json"), $marker, [System.Text.UTF8Encoding]::new($false))
        Replace-ReleaseRootFromStage -StageRoot $stageRoot -ReleaseRoot $OutputRoot
        return $OutputRoot
    } finally {
        if (Test-Path -LiteralPath $stageRoot) {
            Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-LocalProductionBuild {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$OutputRoot,
        [scriptblock]$BuildAction
    )

    Assert-LocalProductionOutputRoot -RepoRoot $RepoRoot -OutputRoot $OutputRoot
    Push-Location $RepoRoot
    try {
        return Invoke-WithLocalReleaseCargoTarget `
            -RepoRoot $RepoRoot `
            -Enabled $true `
            -Action {
            param($cargoTargetDir)

            $buildConfigPath = New-TauriBuildConfigFile
            try {
                Write-Host "Using isolated Cargo target for this build: $cargoTargetDir"
                # NSIS is the Windows local production bundle. Updater signing is
                # handled separately by release:local when a signing key exists.
                if ($BuildAction) {
                    & $BuildAction $cargoTargetDir $buildConfigPath | Out-Host
                } else {
                    & pnpm tauri build --bundles nsis --config $buildConfigPath | Out-Host
                    $buildExitCode = $LASTEXITCODE
                    if ($buildExitCode -ne 0) {
                        throw "tauri build failed with exit code $buildExitCode"
                    }
                }
                return Export-LocalProductionArtifacts -RepoRoot $RepoRoot -CargoTargetDir $cargoTargetDir -OutputRoot $OutputRoot
            } finally {
                Remove-TauriBuildConfigFile -Path $buildConfigPath
            }
        }
    } finally {
        Pop-Location -ErrorAction SilentlyContinue
    }
}

# Dot-sourcing exposes the helpers for tests without starting a real build.
if ($MyInvocation.InvocationName -ne ".") {
    $outputRoot = Resolve-LocalProductionOutputRoot -RepoRoot $repoRoot -RequestedOutputDir $OutputDir
    $builtOutputRoot = Invoke-LocalProductionBuild -RepoRoot $repoRoot -OutputRoot $outputRoot
    Write-Host "Local production artifacts exported to: $builtOutputRoot"
    Write-Host "Raw executable: $(Join-Path $builtOutputRoot 'cc-switch.exe')"
    Write-Host "Installer bundles: $(Join-Path $builtOutputRoot 'bundle\nsis')"
}
