$pipelinePath = Join-Path (Split-Path -Parent $PSScriptRoot) "local-build-pipeline.ps1"

Describe "CCSwitchMulti local production build" {
    . $pipelinePath

    function New-ProductionBuildFixture {
        $root = Join-Path ([System.IO.Path]::GetTempPath()) ("ccsm-production-build-" + [guid]::NewGuid().ToString("N"))
        [System.IO.Directory]::CreateDirectory((Join-Path $root "src-tauri\src")) | Out-Null
        [System.IO.Directory]::CreateDirectory((Join-Path $root "src-tauri\resources")) | Out-Null
        [System.IO.File]::WriteAllText(
            (Join-Path $root "src-tauri\Cargo.toml"),
            "[package]`nname = `"production-build-fixture`"`nversion = `"0.1.0`"`nedition = `"2021`"`n",
            [System.Text.UTF8Encoding]::new($false)
        )
        [System.IO.File]::WriteAllText((Join-Path $root "src-tauri\src\lib.rs"), "pub fn fixture() {}")
        [System.IO.File]::WriteAllText((Join-Path $root "src-tauri\resources\reasoning-capabilities.json"), '{"models":[]}')
        return $root
    }

    function Write-ProductionBuildFixtureArtifacts {
        param([string]$TargetDir)

        [System.IO.File]::WriteAllText((Join-Path $TargetDir "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55`n")
        $releaseDir = Join-Path $TargetDir "release"
        $installerDir = Join-Path $releaseDir "bundle\nsis"
        [System.IO.Directory]::CreateDirectory($installerDir) | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $releaseDir "cc-switch.exe"), "production executable")
        [System.IO.File]::WriteAllText((Join-Path $releaseDir "cc-switch.pdb"), "temporary symbols")
        [System.IO.File]::WriteAllText((Join-Path $installerDir "CCSwitchMulti_0.1.0_x64-setup.exe"), "production installer")
    }

    function Write-PreviousProductionOutput {
        param([string]$OutputRoot)

        [System.IO.Directory]::CreateDirectory($OutputRoot) | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $OutputRoot "LOCAL-BUILD.json"), '{"generatedBy":"local-build-pipeline.ps1"}')
        [System.IO.File]::WriteAllText((Join-Path $OutputRoot "cc-switch.exe"), "previous executable")
        [System.IO.File]::WriteAllText((Join-Path $OutputRoot "old-installer.exe"), "previous installer")
    }

    It "resolves persistent default and custom relative output directories from the repository" {
        $fixtureRoot = New-ProductionBuildFixture
        try {
            Resolve-LocalProductionOutputRoot -RepoRoot $fixtureRoot | Should Be (Join-Path $fixtureRoot "output\production")
            Resolve-LocalProductionOutputRoot -RepoRoot $fixtureRoot -RequestedOutputDir "output\candidate" |
                Should Be (Join-Path $fixtureRoot "output\candidate")
        } finally {
            [System.IO.Directory]::Delete($fixtureRoot, $true)
        }
    }

    It "keeps production binaries and resources after successful isolated Cargo cleanup" {
        $fixtureRoot = New-ProductionBuildFixture
        $outputRoot = Join-Path $fixtureRoot "output\production"
        $hadPrevious = Test-Path Env:CARGO_TARGET_DIR
        $previous = $env:CARGO_TARGET_DIR
        $env:CARGO_TARGET_DIR = 'D:\caller-owned-cargo-target'
        $script:capturedProductionTarget = $null
        $script:capturedProductionConfig = $null
        try {
            Write-PreviousProductionOutput -OutputRoot $outputRoot
            $result = Invoke-LocalProductionBuild -RepoRoot $fixtureRoot -OutputRoot $outputRoot -BuildAction {
                param($targetDir, $configPath)

                $script:capturedProductionTarget = $targetDir
                $script:capturedProductionConfig = $configPath
                $config = [System.IO.File]::ReadAllText($configPath) | ConvertFrom-Json
                $config.bundle.createUpdaterArtifacts | Should Be $false
                $env:CARGO_TARGET_DIR | Should Be $targetDir
                Write-ProductionBuildFixtureArtifacts -TargetDir $targetDir
                Write-Output "build output must not become part of the returned path"
            }

            $result | Should Be $outputRoot
            [System.IO.File]::ReadAllText((Join-Path $outputRoot "cc-switch.exe")) | Should Be "production executable"
            [System.IO.File]::ReadAllText((Join-Path $outputRoot "bundle\nsis\CCSwitchMulti_0.1.0_x64-setup.exe")) |
                Should Be "production installer"
            [System.IO.File]::ReadAllText((Join-Path $outputRoot "resources\reasoning-capabilities.json")) |
                Should Be '{"models":[]}'
            (Test-Path -LiteralPath (Join-Path $outputRoot "old-installer.exe")) | Should Be $false
            (Test-Path -LiteralPath (Join-Path $outputRoot "cc-switch.pdb")) | Should Be $false
            (Test-Path -LiteralPath $script:capturedProductionTarget) | Should Be $false
            (Test-Path -LiteralPath $script:capturedProductionConfig) | Should Be $false
            $env:CARGO_TARGET_DIR | Should Be 'D:\caller-owned-cargo-target'
            @(Get-ChildItem -LiteralPath (Join-Path $fixtureRoot "output") -Force).Count | Should Be 1
        } finally {
            if ($hadPrevious) { $env:CARGO_TARGET_DIR = $previous } else { Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue }
            [System.IO.Directory]::Delete($fixtureRoot, $true)
        }
    }

    It "preserves an earlier output and cleans partial build artifacts after a build failure" {
        $fixtureRoot = New-ProductionBuildFixture
        $outputRoot = Join-Path $fixtureRoot "output\production"
        $script:capturedProductionTarget = $null
        $script:capturedProductionConfig = $null
        try {
            Write-PreviousProductionOutput -OutputRoot $outputRoot
            { Invoke-LocalProductionBuild -RepoRoot $fixtureRoot -OutputRoot $outputRoot -BuildAction {
                param($targetDir, $configPath)

                $script:capturedProductionTarget = $targetDir
                $script:capturedProductionConfig = $configPath
                Write-ProductionBuildFixtureArtifacts -TargetDir $targetDir
                throw "simulated build failure after partial binaries"
            } } | Should Throw "simulated build failure after partial binaries"

            [System.IO.File]::ReadAllText((Join-Path $outputRoot "cc-switch.exe")) | Should Be "previous executable"
            (Test-Path -LiteralPath (Join-Path $outputRoot "bundle")) | Should Be $false
            (Test-Path -LiteralPath $script:capturedProductionTarget) | Should Be $false
            (Test-Path -LiteralPath $script:capturedProductionConfig) | Should Be $false
            @(Get-ChildItem -LiteralPath (Join-Path $fixtureRoot "output") -Force).Count | Should Be 1
        } finally {
            [System.IO.Directory]::Delete($fixtureRoot, $true)
        }
    }

    It "does not export or replace an earlier output when the native build exits unsuccessfully" {
        $fixtureRoot = New-ProductionBuildFixture
        $outputRoot = Join-Path $fixtureRoot "output\production"
        $previousPath = $env:PATH
        try {
            Write-PreviousProductionOutput -OutputRoot $outputRoot
            $fakeBin = Join-Path $fixtureRoot "bin"
            [System.IO.Directory]::CreateDirectory($fakeBin) | Out-Null
            $fakePnpm = @(
                '@mkdir "%CARGO_TARGET_DIR%\release\bundle\nsis"',
                '@echo Signature: 8a477f597d28d172789f06886806bc55>"%CARGO_TARGET_DIR%\CACHEDIR.TAG"',
                '@echo partial executable>"%CARGO_TARGET_DIR%\release\cc-switch.exe"',
                '@echo partial installer>"%CARGO_TARGET_DIR%\release\bundle\nsis\CCSwitchMulti_0.1.0_x64-setup.exe"',
                '@exit /b 7'
            ) -join "`r`n"
            [System.IO.File]::WriteAllText((Join-Path $fakeBin "pnpm.cmd"), $fakePnpm, [System.Text.Encoding]::ASCII)
            $env:PATH = "$fakeBin;$previousPath"
            { Invoke-LocalProductionBuild -RepoRoot $fixtureRoot -OutputRoot $outputRoot } |
                Should Throw "tauri build failed with exit code 7"
            [System.IO.File]::ReadAllText((Join-Path $outputRoot "cc-switch.exe")) | Should Be "previous executable"
            (Test-Path -LiteralPath (Join-Path $outputRoot "bundle")) | Should Be $false
        } finally {
            $env:PATH = $previousPath
            [System.IO.Directory]::Delete($fixtureRoot, $true)
        }
    }

    It "runs a successful native production NSIS build and tolerates progress on stderr" {
        $fixtureRoot = New-ProductionBuildFixture
        $outputRoot = Join-Path $fixtureRoot "output\production"
        $previousPath = $env:PATH
        try {
            $fakeBin = Join-Path $fixtureRoot "bin"
            [System.IO.Directory]::CreateDirectory($fakeBin) | Out-Null
            $fakePnpm = @(
                '@echo %*>"%~dp0arguments.txt"',
                '@copy /y "%~6" "%~dp0captured-config.json" >nul',
                '@mkdir "%CARGO_TARGET_DIR%\release\bundle\nsis"',
                '@echo Signature: 8a477f597d28d172789f06886806bc55>"%CARGO_TARGET_DIR%\CACHEDIR.TAG"',
                '@echo production executable>"%CARGO_TARGET_DIR%\release\cc-switch.exe"',
                '@echo production installer>"%CARGO_TARGET_DIR%\release\bundle\nsis\CCSwitchMulti_0.1.0_x64-setup.exe"',
                '@echo successful build progress 1>&2',
                '@exit /b 0'
            ) -join "`r`n"
            [System.IO.File]::WriteAllText((Join-Path $fakeBin "pnpm.cmd"), $fakePnpm, [System.Text.Encoding]::ASCII)
            $env:PATH = "$fakeBin;$previousPath"

            $result = Invoke-LocalProductionBuild -RepoRoot $fixtureRoot -OutputRoot $outputRoot

            $result | Should Be $outputRoot
            $arguments = [System.IO.File]::ReadAllText((Join-Path $fakeBin "arguments.txt")).Trim()
            $arguments | Should Match '^tauri build --bundles nsis --config '
            $config = [System.IO.File]::ReadAllText((Join-Path $fakeBin "captured-config.json")) | ConvertFrom-Json
            $config.bundle.createUpdaterArtifacts | Should Be $false
            [System.IO.File]::ReadAllText((Join-Path $outputRoot "cc-switch.exe")).Trim() | Should Be "production executable"
            (Test-Path -LiteralPath (Join-Path $outputRoot "bundle\nsis\CCSwitchMulti_0.1.0_x64-setup.exe")) | Should Be $true
        } finally {
            $env:PATH = $previousPath
            [System.IO.Directory]::Delete($fixtureRoot, $true)
        }
    }

    It "refuses to replace an earlier output if a successful build omitted the installer" {
        $fixtureRoot = New-ProductionBuildFixture
        $outputRoot = Join-Path $fixtureRoot "output\production"
        $script:capturedProductionTarget = $null
        try {
            Write-PreviousProductionOutput -OutputRoot $outputRoot
            { Invoke-LocalProductionBuild -RepoRoot $fixtureRoot -OutputRoot $outputRoot -BuildAction {
                param($targetDir, $configPath)

                $script:capturedProductionTarget = $targetDir
                [System.IO.File]::WriteAllText((Join-Path $targetDir "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55`n")
                [System.IO.Directory]::CreateDirectory((Join-Path $targetDir "release")) | Out-Null
                [System.IO.File]::WriteAllText((Join-Path $targetDir "release\cc-switch.exe"), "partial output")
            } } | Should Throw "local production build did not produce an NSIS installer"
            [System.IO.File]::ReadAllText((Join-Path $outputRoot "cc-switch.exe")) | Should Be "previous executable"
            (Test-Path -LiteralPath $script:capturedProductionTarget) | Should Be $false
        } finally {
            [System.IO.Directory]::Delete($fixtureRoot, $true)
        }
    }

    Context "artifact copy failure" {
        It "leaves the prior output intact and removes staging if copying an installer fails" {
            $fixtureRoot = New-ProductionBuildFixture
            $outputRoot = Join-Path $fixtureRoot "output\production"
            try {
                Write-PreviousProductionOutput -OutputRoot $outputRoot
                Mock Copy-Item { throw "simulated installer copy failure" } -ParameterFilter { $LiteralPath -like '*\bundle' }
                { Invoke-LocalProductionBuild -RepoRoot $fixtureRoot -OutputRoot $outputRoot -BuildAction {
                    param($targetDir, $configPath)

                    Write-ProductionBuildFixtureArtifacts -TargetDir $targetDir
                } } | Should Throw "simulated installer copy failure"
                [System.IO.File]::ReadAllText((Join-Path $outputRoot "cc-switch.exe")) | Should Be "previous executable"
                @(Get-ChildItem -LiteralPath (Join-Path $fixtureRoot "output") -Force).Count | Should Be 1
            } finally {
                [System.IO.Directory]::Delete($fixtureRoot, $true)
            }
        }
    }

    Context "output replacement failure" {
        It "restores the prior output and cleans staging when replacing it fails" {
            $fixtureRoot = New-ProductionBuildFixture
            $outputRoot = Join-Path $fixtureRoot "output\production"
            try {
                Write-PreviousProductionOutput -OutputRoot $outputRoot
                Mock Move-Item { throw "simulated output replacement failure" } -ParameterFilter {
                    $LiteralPath -like '*\.ccswitchmulti-release-staging-*'
                }
                { Invoke-LocalProductionBuild -RepoRoot $fixtureRoot -OutputRoot $outputRoot -BuildAction {
                    param($targetDir, $configPath)

                    Write-ProductionBuildFixtureArtifacts -TargetDir $targetDir
                } } | Should Throw "simulated output replacement failure"
                [System.IO.File]::ReadAllText((Join-Path $outputRoot "cc-switch.exe")) | Should Be "previous executable"
                @(Get-ChildItem -LiteralPath (Join-Path $fixtureRoot "output") -Force).Count | Should Be 1
            } finally {
                [System.IO.Directory]::Delete($fixtureRoot, $true)
            }
        }
    }

    It "rejects source and Cargo scratch destinations before starting a build" {
        $fixtureRoot = New-ProductionBuildFixture
        try {
            foreach ($unsafeOutput in @($fixtureRoot, (Split-Path -Parent $fixtureRoot), (Join-Path $fixtureRoot "src-tauri"), (Join-Path $fixtureRoot ".tmp\local-release-cargo\run-fixture"))) {
                { Assert-LocalProductionOutputRoot -RepoRoot $fixtureRoot -OutputRoot $unsafeOutput } |
                    Should Throw "local production output inside the repository must be a child of its output directory"
            }
        } finally {
            [System.IO.Directory]::Delete($fixtureRoot, $true)
        }
    }

    It "does not replace an arbitrary existing directory" {
        $fixtureRoot = New-ProductionBuildFixture
        $outputRoot = Join-Path $fixtureRoot "output\foreign"
        try {
            [System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null
            [System.IO.File]::WriteAllText((Join-Path $outputRoot "keep.txt"), "unrelated file")
            { Assert-LocalProductionOutputRoot -RepoRoot $fixtureRoot -OutputRoot $outputRoot } |
                Should Throw "local production output is not owned by this build pipeline"
            [System.IO.File]::ReadAllText((Join-Path $outputRoot "keep.txt")) | Should Be "unrelated file"
        } finally {
            [System.IO.Directory]::Delete($fixtureRoot, $true)
        }
    }

    It "rejects an output ancestor that redirects into another directory" {
        $fixtureRoot = New-ProductionBuildFixture
        $redirectedOutput = Join-Path $fixtureRoot "output"
        try {
            $foreignRoot = Join-Path $fixtureRoot "foreign"
            [System.IO.Directory]::CreateDirectory($foreignRoot) | Out-Null
            [System.IO.File]::WriteAllText((Join-Path $foreignRoot "keep.txt"), "unrelated file")
            New-Item -ItemType Junction -Path $redirectedOutput -Target $foreignRoot | Out-Null

            { Assert-LocalProductionOutputRoot -RepoRoot $fixtureRoot -OutputRoot (Join-Path $redirectedOutput "production") } |
                Should Throw "local production output path must not contain a reparse point"
            [System.IO.File]::ReadAllText((Join-Path $foreignRoot "keep.txt")) | Should Be "unrelated file"
        } finally {
            if (Test-Path -LiteralPath $redirectedOutput) {
                [System.IO.Directory]::Delete($redirectedOutput, $false)
            }
            [System.IO.Directory]::Delete($fixtureRoot, $true)
        }
    }
}
