# Recurring MultiRouter Projection Drift, 2026-10-18

## Symptom And Scope

The reported status is `projection_live_drift`, not a failed upstream model
refresh or failed renderer injection. A green request-routing status and an
injected picker guardian do not prove that the generated disk projection
matches its verifier.

The status view inspects projection state every 15 seconds. That poll does not
itself perform a resync: it rediscovers discrepancies introduced by a writer.
The earlier picker-load preservation fix did not address this writer mismatch.

## Reproduced Cause

Two production paths generated different contracts for the same compiled V2
router and unchanged dependency fingerprint:

1. Manual resync calls `publish_codex_multirouter_projection_impl`, which
   publishes a `NativeResponses` catalog.
2. Normal takeover calls `write_codex_takeover_live_for_provider`, which used
   `CodexCatalogToolProfile::from_api_format` on router-level metadata. Unset
   metadata selects `ProxyChat`.
3. New workspace routers intentionally have no upstream API-format metadata.
   They route to multiple providers; the absence is valid, not malformed data.
4. Readback always recomputes the compiled router as `NativeResponses`. After a
   normal takeover rewrite, the catalog, inline provider models, and cache no
   longer match that expected projection.

Thus manual resync could repair the files, while a later normal writer undid
that repair. Merely retrying, suppressing the warning, or preserving a previous
renderer payload cannot correct this inconsistency.

## Red/Green Evidence

Both added regressions failed before the implementation change:

- `multirouter_resync_uses_same_contract_across_catalog_writer_profiles`
- `codex_multirouter_resync_stays_verified_after_takeover_rewrites`

Both failures retained the expected dependency fingerprint but returned:

```text
catalog_verified: false
config_verified: false
cache_verified: false
agent_files_verified: true
```

The service regression uses a real in-memory provider/router database, isolated
temporary Codex files, the actual manual publisher, and the actual takeover
writer. No UI automation, live CDP injection, or provider request is involved.

After the fix, both regressions pass. The service case covers unset, Chat,
Anthropic, and Responses router metadata, with three normal rewrites per case.
Each iteration checks all four artifacts and the actual status inspector's
`Ready` state. The lower-level test also compares the generated catalog, cache
model rows, and semantic TOML config against the manual-resync baseline.

The frontend recovery test now uses the reported `projection_live_drift` state
with a metadata-free V2 router and asserts that one successful resync removes
the resync action.

## Correction

The shared catalog prepare boundary now selects `NativeResponses` whenever a
valid compiled projection fingerprint is present. Every compiled-router writer
therefore uses the existing manual-publication/readback contract. Per-model
transport policy still comes from the compiled catalog; standalone providers
retain their existing profile selection.

No readback equality, fingerprint, empty-catalog, exclusion, or publication
guard was removed or weakened. No second persisted catalog was introduced.

## Verification

Completed on 2026-10-18:

- `cargo test --manifest-path src-tauri/Cargo.toml --lib multirouter_resync -- --test-threads=4`:
  both new regressions failed before the correction and passed afterward.
- `pnpm typecheck`: passed.
- `pnpm catalog:verify`: passed the reader guards and all 393 catalog tests,
  including all 167 workspace tests and the updated drift-recovery case.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::`:
  153 passed.
- `pnpm test:unit --reporter=dot --silent`: 2,418 passed across 258 files.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_ -- --test-threads=4 --quiet`:
  1,888 passed, zero failed, four existing ignored tests.
- `pnpm format:check`: passed.
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml`: passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`: passed.
- `pnpm build:renderer`: passed its catalog verification gate and production
  renderer build.
- `git diff --check`: passed.

The renderer build reported non-fatal dependency annotation, mixed import, and
bundle-size warnings. Test output also included existing Node local-storage
and React `act` warnings; no assertions or checks were relaxed.

## Deployment And Live Evidence

This establishes a reproducible source-level cause of the recurring warning.
The screenshot alone does not identify the running binary's exact write history
or which readback components failed on that machine.

No configured background picker/projection audit monitor was available. No
live UI, CDP, provider audit, native installation, or application restart was
substituted. The Rust change requires a rebuilt native CCSwitch executable;
frontend hot reload and source tests cannot apply it to the running process.
