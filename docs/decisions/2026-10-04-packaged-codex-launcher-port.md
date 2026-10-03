# Packaged Codex launcher identity port

## Goal

Preserve reliable Windows Codex Desktop activation when stable and Preview MSIX
packages coexist, while keeping one owner for packaged launcher discovery and
activation in the fresh refork.

## Evidence

The legacy fork resolves the selected executable against each installed
package's manifest and constructs its exact `PackageFamilyName!Application.Id`
 AUMID. The fresh refork's runtime refresh queried `Get-StartApps` and selected
the first `OpenAI.Codex* !App` entry independently of the executable. The fresh
refork also duplicated COM activation in `codex_runtime_refresh.rs` rather than
reusing the Codex Desktop launcher owner.

Reference verdict: `BigStrongSun/ccswitchmulti` contains the same runtime
refresh shape as the fresh base; the legacy fork contains the exact manifest
matching behavior. The original `farion1231/cc-switch` history does not provide
a safer packaged Codex activation owner for this behavior.

## Decision

Port the manifest-specific matching and AUMID activation into the existing
`codex_desktop` owner, expose it to runtime refresh, and remove the duplicate
runtime-refresh resolver/COM activation implementation. Standalone installs
continue to launch through the executable path. No second launcher subsystem is
introduced.

## Alternatives

- Keep first-match `Get-StartApps`: rejected because stable and Preview can
  coexist and the selected executable may not match the selected AUMID.
- Copy the legacy module unchanged and leave runtime refresh independent:
  rejected because it preserves duplicate activation ownership.
- Always launch the executable: rejected because packaged MSIX activation can
  require the registered AUMID and manifest application identity.

## Approval / implementation / verification

- Approval: user-approved fresh-refork migration in the current task; no
  separate approval was required for this focused compatibility fix.
- Implementation: complete in `codex_windows_launch.rs`, `codex_desktop.rs`,
  and `codex_runtime_refresh.rs`.
- Verification: targeted Codex Desktop tests (51 passed), runtime refresh tests
  (42 passed, 1 ignored), `cargo check`, `pnpm typecheck`, and `git diff
  --check` passed. Formatter check still reports unrelated pre-existing files,
  specifically `codex_config.rs`, `services/proxy.rs`, and
  `services/provider/mod.rs`; the new launcher hunks were corrected.
- Runtime freshness: not checked; no rebuilt desktop process was requested.

