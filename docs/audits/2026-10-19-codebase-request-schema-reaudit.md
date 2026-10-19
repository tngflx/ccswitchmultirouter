# Codebase and request-schema re-audit, 2026-10-19

## Scope and limits

This review inventoried 1,199 tracked implementation, script, and test files and
ran repository-wide frontend and Rust-library verification. Manual source review
focused on the request forwarding boundary, protocol/schema inspection,
diagnostics privacy, settings persistence, catalog authority, provider/import
boundaries, proxy authentication/listener separation, and release/CI gates.
This is not a claim that every line or every platform was exhaustively audited.

The working tree already contained substantial changes before this review. They
were preserved. Before editing overlapping files, scoped backups were saved in
`.tmp/reaudit-schema-20261019-baseline/`; this directory also holds verification
logs. No user settings, provider credentials, active sessions, or installed
binaries were edited. No live provider requests or CDP/UI audit was substituted
for the repository's configured background audit tooling.

## Findings and corrections

| Priority | Finding                                                                                                                                                                                                                     | Correction and regression evidence                                                                                                                                                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Request Health stored arbitrary `type` and `role` strings as diagnostic category names, and retained endpoint queries/fragments. Those fields could contain sensitive values despite the diagnostic-only redaction promise. | Known item types continue to use the shared reviewed contract; unknown types and roles now project fixed category labels. Diagnostic endpoints keep only paths. The forwarded request is unchanged. The new serialized-diagnostic regression failed before the fix and passed afterward.                                        |
| P2       | Both declaration extractors accepted a documentation body without its closing `Returns` boundary. A truncated response could be treated as a complete reference instead of a failed check.                                  | Both JavaScript and Rust extractors now require the boundary. Independent truncated-reference regressions failed before the fix and passed afterward.                                                                                                                                                                           |
| P2       | The desktop reference fetch checked the 2 MiB size limit only after `response.bytes()` had collected the complete response. The advertised limit did not bound retained download data.                                      | Content length is checked when available, and chunks are bounded before append. A local chunked HTTP fixture deliberately never ends; the old implementation timed out, while the corrected reader rejects immediately after crossing the limit. No provider or desktop connection is involved.                                 |
| P2       | The renderer's gated build verified catalogs but did not validate the embedded Responses contract. A corrupt contract could pass the build and later fail when loaded by the backend.                                       | The build now validates the snapshot offline before the unchanged catalog/Vite gates. An actual child-process regression, using a temporary fixture project, reproduced the old successful build with a corrupt digest and now proves rejection before either downstream gate; the valid build still executes both gates.       |
| P2       | The existing diagnostics UI reported broad drift categories and raw finding descriptions without adequate next-step guidance.                                                                                               | Added bounded public declaration samples/totals, separate drift versus network-failure guidance, remediation by finding category, and a Settings breadcrumb to the status view. All four locales were updated; existing separation of settings/status views is preserved. Seven new UI assertions failed before implementation. |

No existing assertion, guard, timeout, or build gate was weakened. Unknown provider
extensions remain informational and pass through unchanged. No new automatic
request/history rewriting or schema-based blocking was added.

## The live schema checker really detected a change

The following were executed against the actual public OpenAI reference:

1. `pnpm contract:check`: offline snapshot validation passed.
2. `pnpm contract:test`: the original nine tests passed before new regressions.
3. `pnpm contract:drift`: failed with one added and one removed declaration.

The reviewed change was specifically the replayed web-search action
`input[].action` / `FindInPage.url`:

```diff
- url: string
+ url: optional string or null
```

This is a documentation/contract change, not evidence that this fork emitted a
bad request or that a provider rejected one. The runtime inspector already
leaves this nested payload unchanged. A new regression explicitly preserves
missing, null, and string URLs in this action; no unrelated rule was relaxed.

After reviewing that scope and the runtime behavior, the explicit maintainer
command `pnpm contract:refresh` was run. The tracked snapshot diff contains only
that declaration, the declaration digest, and `verified_at: 2026-10-19`.
`pnpm contract:drift` then passed against the public reference. No live provider
capability or model-access claim follows from this result.

## What the checker does, and does not do

There are three distinct mechanisms, not one universal schema validator:

- **Offline baseline checks** (`contract:check`) verify snapshot identity,
  declaration digest, reviewed type-rule structure, selected null allowances,
  tool-choice types, and retained replay evidence. They do not fetch docs or
  prove provider acceptance.
- **Documentation drift checks** (`contract:drift`, the weekly/manual GitHub
  workflow, and the manual desktop command) compare public declarations and
  selected invariants with the reviewed embedded baseline. Fetch/parser failure
  is `check_failed`, not success. The desktop check runs only when requested and
  caches its result in memory for that application process.
- **Runtime Request Health** inspects the finalized wire JSON offline when
  diagnostics are enabled. Selected Responses create rules are applied only to
  the actual Responses wire transport, including the Lite fallback boundary;
  converted Chat/Anthropic payloads are not judged by the Responses-create
  contract. Compact, raw binary/realtime, provider capability, and response-body
  contracts are not covered by this selected create-schema checker.

Runtime checks cover selected known field types, tool declarations/choices and
replay invariants. They are intentionally conservative, not a complete JSON
Schema/OpenAPI validator, tokenizer, or model-capability oracle. Normal requests
do not download documentation. Unknown extensions are not silently removed.

## What users should do when a check reports an issue

| Report                                                                               | Safe next step                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `drift_detected`                                                                     | A maintainer reviews the full public declaration diff and enclosing type, updates affected validators/adapters and regression tests if required, refreshes the reviewed baseline, runs gates, and rebuilds. Do not auto-accept a new hash or disable validation merely to make the status green. |
| `check_failed`                                                                       | Check documentation network/proxy access and retry the official-contract check. Do not rotate provider keys or change models just because a public documentation fetch failed. The embedded runtime rules remain active.                                                                         |
| Known field-type mismatch                                                            | Correct the originating client or the selected protocol adapter using the redacted field path, with a regression test. Retrying the same malformed payload is not a schema fix.                                                                                                                  |
| Missing tool declaration or bad explicit tool choice                                 | Match the request with tools actually declared and supported by that provider. Do not invent support or delete tool results to silence the finding.                                                                                                                                              |
| Orphaned/duplicate tool calls, conflicting continuation fields, bad compaction order | Fix history assembly in the client/adapter, preserving the complete history and proper call IDs. Do not automatically discard calls, results, or compaction items.                                                                                                                               |
| Unverified extension                                                                 | Treat as informational unless the provider rejects it; verify protocol/capability evidence before altering routing.                                                                                                                                                                              |
| Large request or input/cache growth                                                  | Compare actual usage with estimates; inspect images/history and use supported client compaction or reduce attachments when appropriate. Byte estimates alone are not grounds for truncating a turn.                                                                                              |

## UI location and behavior

The UI already existed at **Codex → Status → Request Health**. It now provides:

- Official-check status, last check, embedded baseline date and coverage.
- Public declaration addition/removal totals and bounded samples: at most 12
  samples per side, 320 characters plus a truncation marker per sample.
- Distinct instructions for documentation drift and failed checks.
- Non-destructive next-step guidance beside each runtime finding.
- A Settings → Request Health hint directing users to that status view.

Samples contain public documentation only, never request bodies or credentials.
Indentation-based declarations do not contain full enclosing-type paths, so the
UI explicitly directs maintainers to review the full documentation/source diff.
There is deliberately no automatic baseline-update, guard-disable, or
history-rewrite button. A desktop UI cannot safely infer a universal repair for
all providers from a documentation hash change.

## Remaining work from the wider review

### P1: explicitly protect the takeover listener's network boundary

The default takeover listener is loopback (`127.0.0.1`). However, the existing
proxy settings permit non-loopback and wildcard addresses, and the full proxy
binds them without a loopback policy. Codex classification on that listener uses
client-controlled user-agent/fingerprint headers; those are compatibility
signals, not strong authentication. Consequently, a takeover listener must not
be treated as a safely authenticated LAN API merely because the separate
External API listener requires a key.

Relevant owners: `src-tauri/src/proxy/types.rs`, `proxy/server.rs`,
`proxy/handlers.rs`, and `src/components/proxy/ProxyPanel.tsx`.

Recommended follow-up: enforce loopback for the takeover listener, or design an
explicit authenticated LAN mode with a migration/confirmation path. LAN clients
should use the separate authenticated External API listener. This review did
not silently change existing bind behavior, because doing so could break
existing clients. No current live binding or external exposure was inspected;
this is a conditional source-level risk, not a claim that the running app is
exposed.

### P2: incomplete full-suite completion evidence in this local environment

Two pnpm-invoked full frontend runs returned exit code 0 without a complete
footer. The first log contains completed report rows for only 250 of the 260
current test files; the JSON-reporter repeat did not write its requested result
file. These runs are not accepted as a clean full-suite gate. The cause is not
established, and no assertion/timeout was weakened to hide it.

The missing ten files were run directly through Node and produced a successful
JSON report (34 tests). A direct-Node full-suite JSON run is used for final
verification below. Keep machine-readable completion evidence in release
verification, and investigate the pnpm-invoked execution path before relying
only on its exit code in this environment. No package-manager configuration or
runtime pin was changed during this audit.

### Lower-risk follow-ups

- Keep protocol-specific validation ownership separate. A complete Chat,
  Anthropic, Compact, realtime, or provider-capability validator needs its own
  reviewed contract and real-wire tests; expanding the Responses rules across
  those protocols would introduce false positives.
- If persistent drift history or proactive user notifications are desired,
  design one canonical, non-secret record and explicit notification policy.
  Currently checks are manual in-app and scheduled in GitHub, and desktop
  results are process-local. A restarted app showing "Not checked" is expected.
- Reduce the large forwarder/workspace modules along existing transport/state
  ownership boundaries in a separate refactor, protected by the broad suites.
  No broad rewrite was mixed into these fixes.
- The production renderer build reports a roughly 5.9 MB minified main bundle
  (about 1.7 MB gzip) and mixed static/dynamic subscription imports. Profile and
  split large feature boundaries separately; do not merely raise the warning
  threshold to hide bundle growth.
- Clean up existing non-failing test warnings without suppressing their guards:
  React `act`, Node localStorage, and three Rust test-compilation warnings remain.

## Verification

| Command / scope                                                                                                                                                            | Outcome                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                                                                                                           | Passed.                                                                                                                                               |
| `pnpm contract:check`                                                                                                                                                      | Passed.                                                                                                                                               |
| `pnpm contract:drift`                                                                                                                                                      | Initially detected the reviewed URL declaration change; passed after the narrowly reviewed baseline refresh.                                          |
| `pnpm contract:test`                                                                                                                                                       | 12 passed, including real child-process build-gate coverage and mocked live-check success/drift.                                                      |
| `node --test` over all six `scripts/*.node-test.mjs` files                                                                                                                 | 162 passed. Includes the 12 contract tests above.                                                                                                     |
| `pnpm canary:test`                                                                                                                                                         | 7 synthetic parser tests passed; no live provider request.                                                                                            |
| `pnpm test:unit --maxWorkers=2 --minWorkers=1` and the JSON-reporter repeat                                                                                                | Exit 0 but incomplete completion evidence; **not accepted as a clean full-suite pass**. See the tooling finding above.                                |
| `node node_modules/vitest/vitest.mjs run --maxWorkers=4 --minWorkers=1 --reporter=json --outputFile=.tmp/reaudit-schema-20261019-baseline/direct-full-vitest-results.json` | **2,466 passed across all 260 files**, zero failed/pending. JSON report has `success: true`; exact file count was independently asserted.             |
| Focused Request Health, diagnostics hook, Settings integration, and locale-contract Vitest run                                                                             | 69 passed across 4 files. Included in the broad direct-Node run.                                                                                      |
| `pnpm catalog:verify`                                                                                                                                                      | Reader guard, 23 reader tests, 6 discovery/config tests, and 470 catalog tests passed.                                                                |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=4 --quiet`                                                                                        | **4,857 passed, 10 existing tests ignored**, zero failed.                                                                                             |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter:: -- --test-threads=4 --quiet`                                                                    | 153 passed. Included in the broad Rust-library run.                                                                                                   |
| Focused Rust `proxy::openai_contract::tests::`, `proxy::request_health::tests::`, `proxy::providers::responses_contract::tests::`                                          | 9 + 35 + 8 passed. Included in the broad Rust-library run.                                                                                            |
| `pnpm format:check`                                                                                                                                                        | Passed.                                                                                                                                               |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml`                                                                                                                   | Passed.                                                                                                                                               |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`                                                                                                         | Passed.                                                                                                                                               |
| `pnpm build:renderer`                                                                                                                                                      | Passed, including the new offline contract gate, unchanged catalog gates, and Vite production build. Existing size/annotation/import warnings remain. |
| Targeted Prettier checks for changed scripts and this audit; `git diff --check`                                                                                            | Passed.                                                                                                                                               |

Counts overlap and must not be summed as unique coverage. The new regressions
were observed failing before the corresponding fixes: truncated-reference
acceptance in both extractors, unbounded desktop download collection, unsafe
diagnostic labels/queries, corrupt-baseline build success, and missing UI help.
Neither incomplete pnpm invocation was represented as complete verification.

## Release and live-audit boundary

A gated renderer build is not a rebuilt native application. The Rust checker,
redaction changes, and embedded baseline require a native rebuild and restart;
a renderer bundle alone does not replace those backend components. No installer
was produced or installed, no application was stopped, no commit or push was
performed, and no live provider/protocol request was sent.

Only Windows local source and isolated-test verification was performed. The
full native integration-binary suite, other operating systems, a fresh installed
workflow, and live desktop/provider behavior remain outside this audit. Existing
ignored Rust tests were not reclassified or used as passing evidence.
