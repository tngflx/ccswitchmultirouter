$ErrorActionPreference = "Stop"
$fail = 0; $pass = 0
function Check([string]$What, [bool]$Ok) {
  if ($Ok) { $script:pass++; Write-Output "PASS  $What" }
  else { $script:fail++; Write-Output "FAIL  $What" }
}

function Test-DecisionRecordStatuses([string]$Record) {
  $allowed = @{
    'Approval' = @('not-approved', 'approved', 'rejected', 'withdrawn')
    'Implementation' = @('not-started', 'in-progress', 'implemented', 'reverted')
    'Verification' = @('not-run', 'partial', 'passed', 'failed', 'blocked')
    'Runtime freshness' = @('not-applicable', 'not-checked', 'stale', 'current')
    'Disposition' = @('active', 'superseded')
  }
  if ($Record -match '(?m)^- Status:') { return $false }
  foreach ($field in $allowed.Keys) {
    $matches = [regex]::Matches($Record, '(?m)^- ' + [regex]::Escape($field) + ': ([^\r\n]+)\r?$')
    if ($matches.Count -ne 1 -or $matches[0].Groups[1].Value -notin $allowed[$field]) {
      return $false
    }
  }
  return $true
}

$agents = Get-Content AGENTS.md -Raw

# 1) Documented paths exist
$paths = @(
  "src/lib/api", "src/lib/query", "src/lib/schemas", "src/components/ui",
  "src/i18n/locales/en.json", "src/i18n/locales/zh.json", "src/i18n/locales/zh-TW.json", "src/i18n/locales/ja.json",
  "src-tauri/src/commands", "src-tauri/src/services", "src-tauri/src/database/dao",
  "src-tauri/src/codex_multirouter", "src-tauri/src/proxy", "src-tauri/src/protocol_compatibility",
  "src-tauri/src/resources", "src-tauri/src/codex_desktop.rs", "src-tauri/tests", "tests/msw/tauriMocks.ts",
  "tests/utils/testQueryClient.ts", "tests/setupTests.ts", "src-tauri/src/database/mod.rs",
  "docs/memory/README.md", "docs/memory/journal.md", "docs/decisions/README.md",
  "docs/architecture/retry-model.md", "docs/guides/codex-config-schema-troubleshooting.md",
  "scripts/capture-tauri-window.ps1"
)
foreach ($p in $paths) { Check "path exists: $p" (Test-Path $p) }
$tablePaths = [regex]::Matches($agents, '(?m)^\| `([^`]+)` \|')
Check "AGENTS.md has source-table paths" ($tablePaths.Count -gt 0)
foreach ($match in $tablePaths) {
  $p = $match.Groups[1].Value
  Check "documented table path exists: $p" (Test-Path -LiteralPath $p)
}

# 2) Documented pnpm commands exist in package.json
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
foreach ($cmd in @("dev","dev:renderer","build","build:exe","release:local","typecheck","format:check","test:unit")) {
  Check "pnpm script: $cmd" ($null -ne $pkg.scripts.$cmd)
}

# 3) Documented schema matches the source of truth
$sv = [regex]::Match((Get-Content src-tauri/src/database/mod.rs -Raw), 'SCHEMA_VERSION: i32 = (\d+)')
$documentedSchema = [regex]::Match($agents, 'schema v(\d+)')
Check "documented schema matches SCHEMA_VERSION" ($sv.Success -and $documentedSchema.Success -and $sv.Groups[1].Value -eq $documentedSchema.Groups[1].Value)

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
  @{ F = "src-tauri/src/proxy/providers/codex.rs"; S = "resolve_reasoning_content_mode" },
  @{ F = "src-tauri/src/proxy/providers/codex.rs"; S = "ReasoningContentMode" },
  @{ F = "src-tauri/src/proxy/providers/openai_compat.rs"; S = "normalize_third_party_responses_reasoning_content_for_strict_schema" },
  @{ F = "src-tauri/src/provider.rs"; S = "reasoning_content_mode" },
  @{ F = "src-tauri/src/settings.rs"; S = "enable_stream_retry" },
  @{ F = "src/components/providers/forms/codexCatalogSync.ts"; S = "reconcileFetchedCodexCatalogRows" },
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

# 9) Rules and decision records retain the required structural boundaries
$ruleIds = @((1..36 | ForEach-Object { [string]$_ })) + @('6-A','6-B','6-C','10-A','10-B','10-C','22-A','22-B','22-C','22-D','22-E','22-F','27-A')
foreach ($id in $ruleIds) {
  $matches = [regex]::Matches($agents, '(?m)^' + [regex]::Escape($id) + '\. ')
  Check "AGENTS.md has exactly one rule $id" ($matches.Count -eq 1)
}
Check "AGENTS.md requires waiting for approval" ($agents.Contains('Wait for explicit user approval'))
Check "AGENTS.md separates decision statuses" ($agents.Contains('Keep approval, implementation, verification, and runtime freshness separate'))
Check "AGENTS.md retains minimized UIA precedence" ($agents.Contains('For a minimized window, rule 22-E takes precedence'))
Check "AGENTS.md documents snake_case invoke names" ($agents.Contains('invoke command names match the registered Rust snake_case names'))
Check "AGENTS.md requires remote identity verification" ($agents.Contains('verify its remote URL'))
Check "AGENTS.md documents decision records" ($agents.Contains('docs/decisions/'))
Check "AGENTS.md documents build:exe prohibition" ($agents.Contains('`pnpm build:exe`'))

$decisionReadme = Get-Content docs/decisions/README.md -Raw
foreach ($field in @('Approval','Implementation','Verification','Runtime freshness','Disposition')) {
  Check "decision template documents $field" ($decisionReadme.Contains('- ' + $field + ':'))
}
Check "decision template preserves status history" ($decisionReadme.Contains('Status history (append-only)'))
$records = @(Get-ChildItem docs/decisions -File -Filter '*.md' | Where-Object { $_.Name -ne 'README.md' })
Check "at least one decision record exists" ($records.Count -gt 0)
foreach ($record in $records) {
  $content = Get-Content -LiteralPath $record.FullName -Raw
  Check "decision record filename: $($record.Name)" ($record.Name -match '^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$')
  Check "independent decision statuses: $($record.Name)" (Test-DecisionRecordStatuses $content)
  Check "decision approval reference: $($record.Name)" ($content -match '(?m)^- Requested by / approval reference: \S')
  Check "decision history: $($record.Name)" ($content.Contains('Status history (append-only)'))
}

Write-Output ""
Write-Output "RESULT: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }


