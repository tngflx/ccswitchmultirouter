# 2026-09-17 Live Tauri UI Audit

Audited the running `cc-switch.exe` MultiRouter workspace for the model-order,
alias, routing, and Sub-Agents work. The app was hidden to tray; the window was
restored with the user's explicit instruction, then captured read-only with
`scripts/capture-tauri-window.ps1` (PrintWindow, `PW_RENDERFULLCONTENT`).
Content was verified with the WebView2 UI Automation tree in addition to the
non-blank pixel check.

## Pages

- `01-current-before-dialog-dismiss.png`: the app was blocked by the "Codex
  local routing is enabled" confirmation dialog; dismissed via UIA Invoke.
- `02-overview.png`: MultiRouter overview shows listen/takeover/routing healthy,
  catalog projection synced (115 mappings), and two renamed-model policy
  warnings.
- `03-model-ordering.png`: all 115 aggregate models render with provider labels,
  ranked top eight (`gpt-5.6-sol-sublyx`, `~deepseek/deepseek-flash-latest`,
  `deepseek/deepseek-v4-pro-0813`, `mimo-v2.5-free`, `gpt-5.6`,
  `gpt-5.6-luna-sublyx`, `gpt-5.6-sol-openai-compact`,
  `gpt-5.6-terra-sublyx`), drag/rank/move/hide controls, Save order, Reset,
  Apply recommendations, and hidden-models section.
- `04-model-sources.png`: candidate sources list renders with OpenCode Go
  present; 4 rules attached to Sublyx, OpenRouter, OpenCode Zen, OpenCode Go.
- `05-routing-rules.png`: four enabled rules with prefix matching, route API
  key reuse, provider config ownership, and per-source model refresh states.
  OpenRouter (25), OpenCode Zen (58), and OpenCode Go (27) succeeded; one row
  shows `Failed` with the generic operation-failure message while its row
  heading was not exposed by UIA. The underlying provider is the Sublyx source,
  whose upstream was returning 402/DAILY LIMIT EXCEEDED at the time.
- `06-sub-agents.png`: Sub-Agent V2 active, selection policy, filters, capability
  questionnaire, and "Sync with catalog: remove stale models (2)" render.
- `07-status.png`: link Online, takeover taken over, entry enabled, catalog
  projection synced, both `deepseek-v4-*` rename warnings listed, model-menu
  guardian injected for 2 CDP targets.

## Findings

1. The persisted `codexRouting.modelOrder` still contains stale OpenCode Zen
   names (`deepseek-v4-flash-opencode-zen`, `deepseek-v4-pro-opencode-zen`,
   `claude-opus-4-8-opencode-zen`, etc.). The ordering UI correctly renders the
   current renamed visible models; `applyCodexCatalogModelOrder` only applies
   ranks for models that still exist, so stale entries are inert. The compiler
   still warns about them because the router document itself references the old
   names; saving the current ordering once clears them.
2. The Routing rules candidate-refresh panel showed one unnamed `Failed` row.
   The database has no provider with an empty name; the row corresponds to the
   Sublyx source, which was failing upstream with
   `HTTP 402 / DAILY LIMIT EXCEEDED`. The panel leaves the row heading blank in
   the UIA tree for this state; worth a small rendering-cost follow-up if users
   cannot tell which source failed.

## Tooling

`scripts/capture-tauri-window.ps1` was exercised end-to-end: hidden-to-tray app
fails fast with a clear message, restored app captures non-blank output.
