$ErrorActionPreference = "Continue"
$fail = 0; $pass = 0
function Check([string]$What, [bool]$Ok) {
  if ($Ok) { $script:pass++; Write-Output "PASS  $What" }
  else { $script:fail++; Write-Output "FAIL  $What" }
}

# 1) Documented paths exist
$paths = @(
  "src/lib/api", "src/lib/query", "src/lib/schemas", "src/components/ui",
  "src/i18n/locales/en.json", "src/i18n/locales/zh.json", "src/i18n/locales/zh-TW.json", "src/i18n/locales/ja.json",
  "src-tauri/src/commands", "src-tauri/src/services", "src-tauri/src/database/dao",
  "src-tauri/src/codex_multirouter", "src-tauri/src/proxy", "src-tauri/src/protocol_compatibility",
  "src-tauri/src/codex_desktop.rs", "src-tauri/tests", "tests/msw/tauriMocks.ts",
  "tests/utils/testQueryClient.ts", "tests/setupTests.ts", "src-tauri/src/database/mod.rs"
)
foreach ($p in $paths) { Check "path exists: $p" (Test-Path $p) }

# 2) Documented pnpm commands exist in package.json
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
foreach ($cmd in @("dev","dev:renderer","build","build:exe","release:local","typecheck","format:check","test:unit")) {
  Check "pnpm script: $cmd" ($null -ne $pkg.scripts.$cmd)
}

# 3) SCHEMA_VERSION documented as 18
$sv = (Select-String -Path src-tauri/src/database/mod.rs -Pattern "SCHEMA_VERSION: i32 = (\d+)").Matches[0].Groups[1].Value
Check "SCHEMA_VERSION = 18 (found $sv)" ($sv -eq "18")

# 4) i18n default language = en
$i18n = Get-Content src/i18n/index.ts -Raw
Check "DEFAULT_LANGUAGE = en" ($i18n.Contains('DEFAULT_LANGUAGE: Language = "en"'))
Check "fallbackLng en" ($i18n.Contains('fallbackLng: "en"'))

# 5) Data dir documented ~/.cc-switch
Check "config dir ~/.cc-switch" ((Get-Content src-tauri/src/config.rs -Raw).Contains('.cc-switch'))

# 6) lock_conn macro exists
Check "lock_conn! macro" ((Get-Content src-tauri/src/database/mod.rs -Raw).Contains("macro_rules! lock_conn"))

# 7) Fork-specific identifiers exist
$idents = @(
  @{ F = "src-tauri/src/proxy/providers/codex.rs"; S = "codexApiKeyGroups" },
  @{ F = "src/types.ts"; S = "CodexApiKeyGroup" },
  @{ F = "src-tauri/src/proxy/codex_traffic_policy.rs"; S = "admission_enabled" },
  @{ F = "src/types/codexSubagentV2.ts"; S = "official_first" },
  @{ F = "src-tauri/src/protocol_compatibility/runner.rs"; S = "run_protocol_compatibility_probe_with_reporter" },
  @{ F = "src/components/settings/LanguageSwitcher.tsx"; S = "LanguageSwitcher" },
  @{ F = "src/lib/api/protocol-compatibility.ts"; S = "preflightCodexProviderProtocolCompatibility" }
)
foreach ($i in $idents) { Check "identifier $($i.S) in $($i.F)" ((Get-Content $i.F -Raw).Contains($i.S)) }

# 8) generate_handler registration point exists
Check "generate_handler in lib.rs" ((Get-Content src-tauri/src/lib.rs -Raw).Contains("generate_handler"))

# 9) AGENTS.md rules count sanity (rule 31 exists)
$agents = Get-Content AGENTS.md -Raw
Check "AGENTS.md has memory protocol (rule 31)" ($agents.Contains("31."))
Check "AGENTS.md documents schema v18" ($agents.Contains("schema v18"))
Check "AGENTS.md documents build:exe" ($agents.Contains("build:exe"))

Write-Output ""
Write-Output "RESULT: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }


