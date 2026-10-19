# Codex Catalog Sync Log Audit, 2026-10-18

## Scope

This completes the interrupted catalog-to-Desktop-picker investigation. The
configured log directory is `C:\Users\Felix\.cc-switch\logs`, not
`C:\Users\Felix.cc-switch\logs`.

Historical signature searches covered the retained application, router,
watchdog, and error `*.log*`/`*.jsonl` files in that directory. Only timestamps,
event counts, and fixed diagnostic signatures were extracted; raw requests,
credentials, and rejected metadata objects are not reproduced here.

No configured background picker audit automation was available to this
completion run. The repository watchdog is an application/process-health
guardian, not a catalog-to-picker diagnostic monitor. This report does not
substitute a manual CDP, provider, or workspace-UI audit.

## Findings

1. Three retained events report `No routed models were found`: October 9 at
   11:59:52 and October 17 at 21:23:26 and 21:23:47. Timestamps are recorded as
   written in the application logs.
2. The October 17 failures are interleaved with successful injection messages
   reporting `models=36` at 21:23:36, 21:24:14, and 21:24:35. This is consistent
   with transient catalog availability during startup/publication, but the
   logs alone cannot identify the writer or prove visible picker convergence.
3. The retained reasoning-declaration rejection warnings total 1,340:

   | October 17 Timestamp | Warnings |
   | -------------------- | -------: |
   | 06:39:15             |      334 |
   | 06:51:32             |      334 |
   | 15:25:13             |      336 |
   | 15:28:32             |      336 |

   These are historical bursts, not evidence of 1,340 distinct missing models.
   The rejected metadata objects were not retained, so the precise upstream
   declaration defects cannot be reconstructed. Strict validation is unchanged.

4. Existing `models=N` success messages establish an injection's reported row
   count, not that request-client hooks or reasoning-query caches were ready.
   No historical message contains the new payload diagnostic signature.

## Corrections

- Manual picker repair now propagates catalog-load failures before touching
  the renderer or launching Desktop. It no longer turns an unreadable managed
  catalog into a successful empty installation.
- Empty fallback cache/inline snapshots are unavailable, not usable empty
  catalogs. Selection continues to a later usable fallback or reports failure
  so the existing renderer payload remains untouched.
- A structurally valid canonical empty catalog remains authoritative. A
  verified unmanaged configuration still explicitly releases picker ownership.
  Provider binding, disabled-row exclusion, and same-provider preservation
  rules remain intact.
- Injection diagnostics now distinguish payload delivery from hook readiness:
  catalog/runtime fingerprints, normalized reasoning/max/ultra model counts,
  discovered reasoning-query-cache count, app-server hook readiness, and
  whether the previous same-provider payload was preserved. No catalog contents
  or provider credentials are logged.

Regression coverage includes failed reads, empty fallbacks, canonical empty
authority, unmanaged release, normalized/excluded effort counts, and decoding
diagnostics without treating a delivered payload as proof of hook readiness.

## Verification

- `pnpm typecheck`: passed.
- `pnpm catalog:verify`: passed, including the reader/discovery guards and
  393 catalog feature tests.
- `pnpm test:unit`: passed.
- Focused Desktop reasoning-projection/client-discovery JavaScript tests:
  42 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_desktop::`:
  106 passed, zero failed or ignored.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::`:
  153 passed, zero failed or ignored.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_ -- --test-threads=4`:
  1,886 passed, zero failed, four ignored.
- `pnpm format:check`, `cargo fmt --check --manifest-path src-tauri/Cargo.toml`,
  and `git diff --check`: passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`: passed.
- `pnpm build:renderer`: passed the catalog gates and production renderer build.

The first broad Rust run with default concurrency passed 1,885 tests but failed
`powershell_timeout_terminates_and_reaps_stalled_child` on its five-second
wall-clock cleanup assertion. It had passed in the initial focused Desktop run.
The complete broad scope passed when rerun with four test threads, including
that assertion. No test, timeout, guard, or build gate was weakened.

The unit/build output retains existing nonfatal Node/React and bundler warnings.
Rust test builds also retain three nonfatal test-only compiler warnings; the
required production Clippy command passes with warnings denied.

## Deployment Boundary

The runtime JavaScript is embedded in the native binary through `include_str!`.
A renderer build or passing source tests cannot update an already-running
CCSwitch executable. No native application installation, restart, fresh upstream
refresh, or live visible-picker verification was performed in this completion.
