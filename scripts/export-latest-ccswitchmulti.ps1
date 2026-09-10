param(
    [string]$ReleaseRoot = "",
    [switch]$SkipBuild
)

throw "Local release builds, exports, and hooks are retired. Use .github/workflows/release.yml (v* tag) and its GitHub Actions artifacts."
