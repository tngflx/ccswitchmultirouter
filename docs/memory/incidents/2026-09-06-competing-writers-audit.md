# Competing writers audit - 2026-09-06

Status: findings remain open. This audit did not change application behavior.
The earlier loading/rendering fixes do not resolve these state ownership defects.

## Findings

### P1: Raw provider JSON and structured lists overwrite each other

`ProviderForm.tsx:3210` and `:3236` write raw JSON only to react-hook-form.
The OpenCode, OpenClaw, and Hermes hooks separately initialize local model state
from initialData; raw changes do not hydrate that state. Their model handlers
replace the entire models subtree with that older list:

- `src/components/providers/forms/hooks/useOpencodeFormState.ts:174`
- `src/components/providers/forms/hooks/useOpenclawFormState.ts:154`
- `src/components/providers/forms/hooks/useHermesFormState.ts:176`

Reproduction: add a model in raw JSON, then rename a pre-existing model through
the structured editor. The JSON-added model disappears. All three actual-hook
probes failed the preservation assertion. OpenCode headers and extra options
have the same ownership pattern, but were not separately executed.

The owning boundary needs a single canonical draft and explicit synchronization
of valid raw edits, while preserving invalid/incomplete text and structured row
drafts. Adding more loading flags cannot fix this overwrite.

### P1: Backend settings writers do not share one persistence critical section

`src-tauri/src/settings.rs:987` (`update_settings`) writes the settings file
before acquiring the settings-store write lock. `:999` (`mutate_settings`)
acquires that lock before cloning, changing, and persisting settings.

An allowed interleaving is: update A writes disk A; mutation B locks the old
cache, writes disk B and cache B; update A finally locks and installs cache A.
Disk and cache then disagree. The migration-marker helpers use mutate_settings,
so the comment claiming serialization with update_settings at :1088 is not true
for the whole disk/cache operation. save_settings_file uses direct file writes,
not an atomic temporary-file replacement, which also leaves concurrent writes
outside the lock unsafe.

The settings command separately reads existing settings, preserves backend-owned
markers, and later replaces the snapshot (`commands/settings.rs:124-131`). A
background mutation between those operations can still be lost even if only
the file-write lock ordering is corrected. Read/merge/persist/cache publication
must be reviewed together at the settings owner. Source-level finding; no Rust
concurrency reproduction was run and no real settings files were touched.

### P2: Shared editors retain stale callbacks and echo external hydration

`src/components/JsonEditor.tsx:148` and `MarkdownEditor.tsx:72` close over the
callback used when EditorView was created. Rerendering with a new callback does
not update that listener. The external value effects dispatch document changes
through those same listeners (`JsonEditor.tsx:223`, `MarkdownEditor.tsx:145`).
Consequently an external load/format/preset update also invokes a stale change
handler, creating an additional writer.

Both actual CodeMirror components failed both probes: a replacement callback
received zero user-edit calls; externally hydrated text emitted one onChange.
A concrete stateful consumer is `McpFormModal.tsx:226`: handleConfigChange uses
formId/formName to decide whether to auto-populate them. An initially empty ID
captured by the editor remains empty in that callback after manual edits,
allowing a later wrapped MCP JSON paste to replace the user's ID/name. That
consumer interaction was traced in source, not executed in this audit.

### P2: Settings cache refresh replaces unsaved drafts; saves send full snapshots

`src/hooks/useSettingsForm.ts:133` replaces all form state whenever query data
changes, without a dirty-field guard. The actual-hook probe edited a directory
locally, changed an unrelated server setting, then rerendered: the directory
reverted to the server value.

`src/hooks/useSettings.ts:185` constructs full snapshots for autosave, and
LanguageSwitcher independently sends another full snapshot. The shared mutation
(`src/lib/query/mutations.ts:564`) neither serializes nor merges patches; its
success invalidates settings, triggering the draft reset above. Independent
saves can therefore overwrite unrelated newer fields. Each widget's own pending
flag is not a cross-widget save lock. The cache-reset probe was executed; the
concurrent persistence scenario remains source-level evidence.

### P1: Daily-memory reads can place one file's contents under another filename

`src/components/workspace/DailyMemoryPanel.tsx:201` sets editingFile before an
await, then assigns content on completion without a request identity check.
The editor's Back action remains available while loading. Open A, return to the
list, open B; if B finishes first and A finishes later, the selected filename
remains B but content becomes A. Saving uses the current B filename and A content.
The earlier WorkspaceFileEditor cancellation fix does not cover this separate
implementation. Source-level finding; no file write or runtime reproduction.

### P2: Deep-link merge completion can replace a newer import request

`src/components/DeepLinkImportDialog.tsx:67-89` accepts concurrent events and
unconditionally sets the request/open state after awaiting a remote merge.
Slow link A can overwrite already-displayed link B, or reopen a dialog dismissed
while A was pending. Listener cleanup does not invalidate in-flight merges.
runWithLoading correctly counts pending work but supplies no request identity
guard. Source-level finding; not executed against external links.

## Verification

Executed:

```text
pnpm exec vitest run tests/components/OverwriteAudit.repro.test.tsx --maxWorkers=1 --minWorkers=1
```

First run: 1 file failed, 6 tests failed. Expanded run: 1 file failed, 8 tests
failed. These were assertions of required safe behavior; each failed on the
specific defect described above, not an import/setup error. Non-failing Node
localStorage experimental warning also appeared.

The [probe source](2026-09-06-overwrite-audit.repro.tsx) is retained outside normal
test discovery rather than leaving intentionally failing tests in the suite.
It was moved after execution; copy it to the command's test path to reproduce.
No application-source edits, backend tests, typecheck, full suites, or live Tauri
inspection were performed in this audit. Earlier loading-batch results are in
the separate large-model-loading incident and must not be counted as new audit
verification.

## Scope and reference verdict

Traced shared JSON/Markdown editors and consumers, provider raw/structured hooks,
settings form/query/command/persistence ownership, import events, and workspace
file selection. Also inspected loading bookkeeping and provider edit identity;
searched session/router effects and provider/proxy live-write locks. These
searches are not proof that every function in those domains is safe. Request
transformation/retry bodies, complete database synchronization, and all startup
recovery interleavings were not exhaustively audited.

Rejected a false lead: raw Codex writes at provider/mod.rs:1218 and :1287 are
inside cfg(test). Production live/repair paths inspected use the canonical
Codex writer. Proxy takeover/hot-switch code has explicit per-app switch locks;
duplicated call sites alone do not prove a race. HermesMemoryPanel already
protects its initial hydration from later query refreshes.

Both reference repositories were inspected using GitHub API all-state recent
PR listings and nearby editor/settings commit history, plus current editor
source. BigStrongSun retains the old captured callback. Original upstream
`farion1231/cc-switch` commit
[84e75ad2](https://github.com/farion1231/cc-switch/commit/84e75ad2)
adds onChangeRef and readOnly support to JsonEditor within its native Pi work;
that callback fix is applicable reference material, not a reason to port the
whole feature. Its listener still emits changes for external document updates.
The preceding editor commit bc7f5f41 only changes default rows. Settings histories
included ffcd61c3/e3927dba/07c9a847 (BigStrongSun) and
092ea1f3/bd15ea11/84e75ad2 (original upstream). The inspected PR listings do not
establish that no relevant fix exists elsewhere.

Do not treat a spinner, debounce, or bounded list as a state-ownership fix. Do
not add bidirectional effects blindly: they can create another overwrite loop.
