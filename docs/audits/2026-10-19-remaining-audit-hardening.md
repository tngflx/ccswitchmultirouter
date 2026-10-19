# Remaining audit hardening — October 19, 2026

## Scope

Follow-up to `2026-10-19-codebase-request-schema-reaudit.md` and the user's request to improve the remaining findings conservatively. These changes address the takeover listener trust boundary and incomplete frontend-test reporting. They do not replace or revert the existing upstream, catalog, Codex picker, or request-schema work in this dirty checkout.

A scoped pre-change backup and regression/check logs are in `.tmp/improvements-20261019-baseline/`. No commit, push, native release build, app installation, app restart, live provider request, or live CDP/UI audit was performed.

## 1. Unauthenticated takeover listener: fail closed outside loopback

### Finding

The full takeover router trusted local client-identification headers but could bind a configurable non-loopback address. Client fingerprints are not network authentication. The separate External API router already has a different trust boundary and API-key enforcement.

### Changes

- Added one shared Rust address parser/loopback validator in `src-tauri/src/proxy/listener_address.rs`.
- Enforced loopback at **both** global/legacy settings writers and the actual full-proxy socket bind. Configuration imports or older databases cannot bypass the runtime guard.
- Normalized supported addresses on save: `localhost` becomes `127.0.0.1`; bracketed/expanded IPv6 loopback becomes `::1`. IPv4 loopback literals in `127.0.0.0/8` remain valid. DNS hostnames, wildcards, LAN addresses, scoped addresses, abbreviated IPv4, and IPv4-mapped IPv6 are not accepted for takeover.
- Constructed listener sockets with `SocketAddr::new`, fixing the old unbracketed IPv6 address/port concatenation.
- Live-client URL generation uses the same validator instead of silently converting wildcard binds into localhost projections.
- Kept the authenticated **External API** profile/listener independent and able to bind a LAN/wildcard address. Its authentication and routing are unchanged.
- An old unsafe saved address remains readable. The global writer permits retaining exactly that address **only while disabled**, so stopping/recovery is not blocked; it cannot be re-enabled or replaced with another unsafe address. There is no silent migration.

### UI and recovery

The proxy panel now shows a translated warning for an unsafe saved takeover address and provides **Use localhost**. It writes the existing canonical global settings, preserving port, logging, system-proxy preference, and the separate External API profile. It does not invent an additional persisted flag or automatically rebind a running service.

Recovery requires a confirmed stopped runtime status. Loading/unknown status is not treated as stopped. Both normal address saving and repair are disabled until that status is known. A failed repair keeps the draft/settings intact and reports failure.

For an old LAN takeover configuration:

1. Stop takeover and restore client configurations using the existing stop/recovery controls.
2. Select **Use localhost**, or save a supported loopback address.
3. Restart takeover.
4. If LAN access is intentional, configure the separate authenticated External API listener and API key. This listener exposes OpenAI-compatible routes; it is **not** a drop-in replacement for every Claude/Gemini takeover route.

This is an intentional security-related compatibility change for non-loopback takeover configurations. Default localhost setups are unchanged. Loopback restriction does not authenticate other processes on the same machine.

### Regression evidence

Before the implementation, the new database tests failed because unsafe writes succeeded and localhost was not normalized. The socket regression confirmed that unauthenticated takeover could bind `0.0.0.0`. UI regressions failed because there was no warning/repair flow and LAN saves were accepted. A further loading-status regression failed because an unknown status enabled repair. The corresponding tests now pass.

Coverage includes rejected writes without partial preference changes, normalization, disabling and repairing a simulated legacy database, runtime bind rejection, independent External API binding, legacy live-URL rejection, IPv6 URL formatting, UI recovery success/failure, unchanged unrelated fields, loading/running guards, and all four supported locales.

## 2. Frontend tests: require verified completion

### Finding

Earlier audit runs observed a zero process exit without a complete frontend report. The underlying cause was not established; this change does not attribute it to pnpm, Vitest, or Windows without evidence.

### Changes

- `pnpm test:unit` now invokes the installed Vitest Node entry through `scripts/run-unit-tests.mjs`, using the current Node executable directly.
- A supplementary reporter records the actual selected/discovered file list and terminal file/task counts. Discovery still belongs to Vitest, including its config exclusions, projects, CLI filters, and worker settings. There is no fixed suite-count gate or replacement filesystem glob.
- The wrapper requires a fresh, per-run completion receipt and exact discovered/completed file correspondence, plus consistent counters and no failures, unfinished tasks, cancellation, or unhandled errors.
- Missing, stale, malformed, or partial receipts fail even if the child exits zero. Child nonzero exits, signals, and startup errors fail too.
- Explicit CLI reporters and output files remain intact; default human-readable reporting is retained. Watch mode stays on `pnpm test:unit:watch` rather than being mistaken for a completed one-shot check. CLI argument terminators are forwarded after the verification-reporter flags.
- The receipt contains only file paths, states, and counts, not assertion payloads, request bodies, credentials, or error details. The per-run temporary file and empty directory are removed without recursive cleanup.
- Catalog verification now uses the same completion gate for its existing, unchanged test list. CI also runs the isolated runner regression tests.

### Regression evidence

Thirteen Node regressions cover valid completion, missing/stale/malformed/partial receipts, failed/unfinished tasks, intentional skip/todo handling, cancellation, unhandled errors, child nonzero/signal/startup failures, reporter/output/worker argument forwarding, and argument terminators. The CLI failure path was also exercised by the failing UI regression before its fix.

The previously problematic two-worker full invocation completed with a JSON report and verification footer: **262 files, 2,494 tests**. Two additional UI regressions were then added and the final full invocation completed with **262 files, 2,496 tests**. These are observed counts, not hardcoded requirements. Both machine reports were independently checked for success, zero failed/pending tests, and passed file results.

## Verification on the final working tree

| Check                                                                               | Result                                                                                                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck`                                                                    | Passed                                                                                                                   |
| `pnpm catalog:verify`                                                               | Passed: reader guard, 23 reader tests, 6 discovery tests, 470 catalog tests; completion verified for all 15 Vitest files |
| `pnpm test:unit --reporter=json --outputFile=...`                                   | Passed: **2,496 tests / 262 files**, verified completion and independently checked JSON                                  |
| Focused listener frontend suites                                                    | Passed: **31 tests / 3 files**, including the existing listener-recovery test                                            |
| `node --test scripts/*.node-test.mjs`                                               | Passed: **175 tests**, including 13 new runner regressions                                                               |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=4 --quiet` | Passed: **4,863 tests**, 10 existing ignored tests, zero failures                                                        |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::`         | Passed: **153 tests**                                                                                                    |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml`                            | Passed                                                                                                                   |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`                  | Passed                                                                                                                   |
| `pnpm format:check` and focused script/test/workflow formatting                     | Passed                                                                                                                   |
| `git diff --check`                                                                  | Passed                                                                                                                   |
| `pnpm build:renderer`                                                               | Passed: offline Responses contract gate, catalog gate with verified completion, and Vite renderer build                  |

The Rust test build emits existing test-only warnings. The required production Clippy command passes with warnings denied; no lint or test guard was relaxed.

## Request-schema checker and remaining boundaries

The previous request-schema changes remain in place: bounded/truncation-safe official-doc extraction, privacy-safe diagnostics, reviewed declaration drift, renderer build gating, and contextual recovery guidance in **Codex → Status → Request Health**. This follow-up adds no automatic payload rewriting, conversation-history deletion, or one-click acceptance of a changed official schema.

Treat schema findings by category: fix malformed outgoing requests at their producer, correct a mismatched provider/protocol rather than weakening validation, and review official-document drift before updating the checked-in contract. A documentation fetch failure is not itself proof of request-schema failure. The existing Request Health guidance is the appropriate UI for these findings; listener binding recovery belongs in the proxy panel.

The renderer still has a roughly **5.9 MB minified / 1.7 MB gzip** main JavaScript chunk and existing bundling warnings. Broad code splitting was deliberately deferred to avoid unrelated behavior/module-order changes in an already heavily modified checkout. No warning thresholds were raised or suppressed.

A native rebuild and restart are required before the running desktop app receives the Rust listener guard. A renderer build does not prove that a native release was rebuilt/installed, that the installed UI changed, or that live provider requests work. Those remain separate verification steps, to be performed through the repository's configured background monitoring/diagnostic workflow rather than substituting direct UI automation.
