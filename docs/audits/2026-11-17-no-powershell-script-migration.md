# No-PowerShell-script migration audit — November 17, 2026

## Scope and result

Repository-owned PowerShell script files are retired. Build, release, upstream
checking, cache cleanup, and diagnostic entry points use JavaScript. Installed
crash recovery remains owned by Rust; development supervision remains owned by
Node. This is a source/tooling migration, **not a zero-PowerShell-process claim**.

No Computer Use, application restart, provider mutation, installation, desktop
release, remote-ownership change, branch switch, or push was performed.

## Kept behavior and canonical ownership

- `package.json` entry points no longer run `pwsh -File`.
- Upstream checks retain the protected `origin`, fetch-only remote, URL rewrite,
  inherited configuration, and credential-redaction guards.
- Local build/export use one shared output guard and ownership inventory in
  `scripts/release-build-config.mjs`. Repository roots/ancestors, source trees,
  filesystem roots, active Cargo targets, junctions, and unrelated nonempty
  directories cannot be used as replaceable release output.
- Canonical `.ccswitchmulti-release-owner.json` inventory is authoritative. A
  malformed or changed canonical inventory does not fall back to old metadata.
  Complete old releases migrate only after their checksums and artifact identity
  agree. Marker-only `LOCAL-BUILD.json` output is preserved; choose a new empty
  output path rather than deleting it to make the build pass.
- Promotion validates the stage again after moving the previous output. Failed
  promotion restores the previous output. An unexpectedly changed backup is kept,
  not recursively deleted.
- A lock's age alone cannot authorize stealing a release pipeline lock.
- A signing invocation cannot reuse a copied stale signature. Environment keys
  and passwords stay out of argv, optional signing uses the configured key, and
  generated updater URLs point to `tngflx/ccswitchmultirouter`.
- History-tool export is an explicit Python-source/README allowlist. Local venvs,
  caches, and arbitrary files are not copied into releases.
- Release-hook installation preserves existing hooks and `core.hooksPath`, rejects
  junctions, and uses exclusive creation. Repeating an identical installation is
  read-only and idempotent; different/custom hooks need manual integration.
- The guardian's exported API and CLI both reject new scheduled guardian installs
  before any inspection or mutation. Only strict boolean `uninstall: true` permits
  legacy cleanup, retaining same-user/exact-action/process identity safeguards.
- Cargo cleanup rejects linked ancestors before even an injected Cargo command.
- OAuth diagnostics parse TOML structurally, omit malformed inputs, redact auth
  parser failures and supported credential/log formats, bound config/auth reads,
  refuse output junctions, and use distinct evidence directories per invocation.

## Script policy and generated bundle paths

`pnpm scripts:check` checks tracked **and non-ignored untracked** source inventory,
case-insensitively, for `.ps1`, `.psm1`, and `.psd1`; it also rejects executable
package/workflow/WiX script-file entry points. The check runs in CI and before the
gated renderer build. Generated dependency launch shims under ignored
`node_modules` are not repository source and were not removed or modified.

The per-user WiX template no longer packages or executes generated elevated-task
script helpers. Default Tauri configuration and the local build override explicitly
set `enableElevatedUpdateTask: false`. Git-remote CI uses Node/Git instead of a
PowerShell prerequisite; Windows recovery tests retain their real identity probes.

## Deliberately retired manual tooling

The unused historical transactional reinstall/rollback wrapper, obsolete v3.1
installer helper, one-off icon verifier, and unused PyInstaller build wrapper were
removed. Active package, application, CI, and release paths did not call the manual
transaction. Normal development/packaging and manually running a generated NSIS
installer do not depend on it.

The first migration attempt introduced an uncalled `local-upgrade.mjs` prototype.
Independent review found no native transaction executor, missing rollback and
filesystem guards, a concurrent maintenance-lease race, and fabricated process
identity. That prototype and its projection-only tests were removed instead of
presenting them as a complete/safe replacement. The former manual automatic
reinstall capability is **not available** after this retirement. Reintroducing it
requires a complete guarded transaction and native Rust handle/lock boundary,
including its rollback and integrity regression coverage; there is no unsafe
fallback command.

## Remaining Windows boundary

Existing inline PowerShell still implements some Windows identity queries,
exclusive lock retention, scheduled-task inspection/uninstall, AppX/tool actions,
the WiX WebView bootstrapper, and existing CI/release workflow shell steps.
Windows CI may also use its default PowerShell shell to launch a Node command;
that does not introduce a repository-owned script file. Historical PS1 action
names remain solely to recognize old owned tasks for safe removal. They are not repository script-file
runtime dependencies. These were not renamed scripts hidden inside JS by this
migration and have not been claimed as native-Rust replacements.

Log redaction is best-effort over structured fields, supported credential formats,
and credentials observed in that invocation's auth/config. Arbitrary opaque
unlabelled unknown text cannot universally be classified as a secret; raw evidence
must still be handled privately.

## Ownership diagram

```text
pnpm dev ── Node supervisor + one restart ledger ── Rust development app
installed app ── Rust crash watchdog + one restart ledger ── installed executable
legacy scheduled guardian ── inspect/uninstall only (new installs refused)

pnpm build / release:* ── Node tooling ── shared guarded stage/inventory/promotion
                                      └─ gated renderer build ── script/catalog gates
```

## Verification

The focused regressions were observed failing before their fixes, then passing.
The final verification was completed locally on November 17, 2026:

| Command                                                                                      | Final result                                                                                                          |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pnpm scripts:check`                                                                         | Passed; tracked and non-ignored untracked repository script inventory and executable entry points satisfy the policy. |
| `pnpm typecheck`                                                                             | Passed.                                                                                                               |
| `pnpm test:unit`                                                                             | 306 files / 4,193 tests passed.                                                                                       |
| `pnpm catalog:verify`                                                                        | 18 files / 787 tests passed.                                                                                          |
| `pnpm test:lifecycle`                                                                        | 229 tests: 228 passed, 1 skipped, 0 failed.                                                                           |
| `pnpm test:dev-recovery`                                                                     | 232 tests passed, 0 skipped.                                                                                          |
| `pnpm test:git-remotes`                                                                      | 65 tests passed, 0 skipped, including migrated upstream-checker fixtures.                                             |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::`                  | 184 tests passed.                                                                                                     |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml`                                     | Passed.                                                                                                               |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`                           | Passed.                                                                                                               |
| `pnpm format:check`                                                                          | Passed.                                                                                                               |
| Scoped `pnpm exec prettier --check` for migrated JS, package/workflows, guardrails and audit | Passed.                                                                                                               |
| `pnpm build:renderer`                                                                        | Passed through the script policy, offline contract, assets and catalog gates, then Vite.                              |
| `git diff --check` and `git diff --check --cached`                                           | Passed.                                                                                                               |
| `git ls-files '*.ps1' '*.psm1' '*.psd1'` plus case-insensitive inventory guard               | Empty / passed; 26 former tracked PS1 files retired.                                                                  |

The single lifecycle skip is the Windows file-symlink fixture: the host lacks
file-symlink creation privilege (`EPERM`). Directory-junction safety fixtures ran
and passed; the skipped fixture was not replaced by a weaker assertion.

A prior combined Git fixture run had one repository-availability failure; that
isolated test passed on rerun. The final complete 65-test run above passed without
retries, test changes, or source changes; the earlier failure did not recur.

Non-blocking diagnostics remain: the Rust test build reports existing test-only
warnings; frontend tests report React/localStorage warnings; Vite reports a Zod
annotation, mixed static/dynamic imports, and the large-chunk warning. None of the
checks or warning thresholds was disabled to obtain these results.

### Local verification receipts

Full receipts are private local temporary files, not packaged diagnostics:

- `C:\Users\Felix\AppData\Local\Temp\ccsm-no-ps1-typecheck-20261117.log`
- `C:\Users\Felix\AppData\Local\Temp\ccsm-no-ps1-frontend-20261117.log`
- `C:\Users\Felix\AppData\Local\Temp\ccsm-no-ps1-catalog-20261117.log`
- `C:\Users\Felix\AppData\Local\Temp\ccsm-no-ps1-lifecycle-20261117.log`
- `C:\Users\Felix\AppData\Local\Temp\ccsm-no-ps1-dev-recovery-20261117.log`
- `C:\Users\Felix\AppData\Local\Temp\ccsm-no-ps1-git-remotes-20261117-final.log`
- `C:\Users\Felix\AppData\Local\Temp\ccsm-no-ps1-rust-20261117.log`
- `C:\Users\Felix\AppData\Local\Temp\ccsm-no-ps1-format-20261117.log`
- `C:\Users\Felix\AppData\Local\Temp\ccsm-no-ps1-tooling-format-20261117.log`
- `C:\Users\Felix\AppData\Local\Temp\ccsm-no-ps1-renderer-build-20261117.log`

Source checks, renderer compilation, and disposable process fixtures do not prove
an installed application was replaced or that live provider/model-picker requests
succeeded; neither was attempted here. No real release export, Cargo cache cleanup,
release-hook install, scheduled guardian change, or transactional upgrade was run.
