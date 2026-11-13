# Reasoning effort verification — 2026-11-13

All source changes are in the repository checkout. The provider audit reads the
configured database in read-only mode and does not modify provider settings,
credentials, catalogs, or generated client configuration.

## Corrected behavior

- Sublyx's maintained GPT contract includes native `max`; `max` remains `max`
  through editing, saving, routing, projection, and request conversion.
- Explicit valid user/detection effort subsets, defaults, mappings, provenance,
  and evidence scope are preserved. Malformed native `ultra` declarations are
  repaired before they can be treated as current native-max evidence.
- Explicit supported Ultra targets, including `max`, survive normalization.
  Ultra's maintained fallback target remains `xhigh`; the literal `ultra` is
  never a provider-native effort.
- OpenRouter native `max` is preserved instead of clamped to `xhigh` in the
  metadata-absent compatibility path. Current per-model capability maps remain
  authoritative.
- Responses-style reasoning objects do not acquire an unrelated Chat `thinking`
  object. Chat and native Responses reject unmappable requested efforts.
- An unavailable saved Ultra target stays visible with guidance to select a
  supported level; mounting the summary does not change persisted settings.
- Existing retry and desktop ownership fixes remain: permanent failures are
  not converted into capacity retries, and a CDP command-line declaration
  cannot replace verified listener ownership.

## Direct provider evidence

The two redacted artifacts contain 108 bounded inference requests across the
currently included catalog rows. Excluded rows were skipped. The original
matrix uses concurrency 2; the follow-up uses concurrency 1. Both use a
16-token output cap and no retries.

| Provider | Included models | Evidence |
| --- | ---: | --- |
| Sublyx | 8 | Seven models accepted and exactly echoed low, medium, high, xhigh, and max across the two runs. Each rejected invalid ultramax in the original run. gpt-6 returned upstream 502/429 and remains inconclusive. |
| OpenRouter | 18 | All 17 advertised effort requests across five models succeeded. Eleven of thirteen models without an effort list accepted max; the two Gemma free models returned 429. All thirteen invalid ultramax controls returned 400. |

Sublyx models with five accepted/echoed native levels: `gpt-5.6-terra`,
`gpt-6-astra`, `gpt-6-luna`, `gpt-6.1-sol`, `gpt-5.6-luna`, `gpt-5.6-sol`,
and `gpt-6-sol`.

The unresolved OpenRouter models are `google/gemma-4-26b-a4b-it:free` and
`google/gemma-4-31b-it:free`. Their baseline and max requests were rate limited.
Provider failures do not prove an invalid effort shape.

OpenRouter does not echo the requested effort in these responses. HTTP
acceptance, rejection of an invalid control, observed reasoning output, and
reasoning token counts are separate observations; they do not prove a
quantitative difference in reasoning quality or computation. The follow-up
artifact retains its original conservative classification of numeric 400
responses; the audit script now additionally recognizes explicit effort-enum
errors without serializing their raw messages.

Evidence files:

- `2026-11-13-provider-reasoning-live.json`
- `2026-11-13-provider-reasoning-followup.json`

## Probe and runtime boundaries

The existing deep protocol probe checks baseline JSON/SSE, tools, and
continuation, and classifies returned reasoning shapes. Its baseline
deliberately omits reasoning controls. It does not enumerate every reasoning
effort. Metadata discovery is a separate path; omitted effort metadata must
not be treated as proof that all levels work. The explicit effort requests
above provide additional audit evidence without automatically persisting
unconfirmed capabilities.

These requests went directly to Sublyx Responses and OpenRouter Chat APIs.
They do not certify an installed application's proxy or picker. The configured
desktop audit artifacts report blocked/rejected renderer operations, including
`desktop_bridge_not_ready`, so no successful live desktop verification is
claimed. No desktop release was installed.

## Validation

Completed verification:

- `pnpm typecheck`: passed.
- `pnpm catalog:verify`: passed, 552 catalog tests plus reader/runner guards.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter:: --quiet`:
  167 passed.
- `pnpm test:unit`: 287 files and 3,220 tests passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet`:
  5,267 passed, 10 ignored, no failures.
- `pnpm build:renderer`: passed through the gated build path, including the
  552 catalog tests. Vite reports its existing large-bundle warning.
- `pnpm format:check`, `cargo fmt --check --manifest-path src-tauri/Cargo.toml`,
  and `git diff --check`: passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`: passed.
- `node --test scripts/verify-codex-desktop-continuation.node-test.mjs scripts/audit-provider-reasoning-live.node-test.mjs`:
  19 passed.

The checkout remains on `main` at `7d911132`. Changes are uncommitted; other
concurrent dirty work was preserved. Passing source tests and the renderer
build do not imply that a desktop binary was rebuilt or installed. The Rust
test build reports two existing test-only warnings (an unused fixture variant
and an intentionally invalid UTF-8 literal); production Clippy passes with
warnings denied.
