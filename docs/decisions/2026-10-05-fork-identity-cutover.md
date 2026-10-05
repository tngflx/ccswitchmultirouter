# Fresh-refork public identity cutover

## Goal

Make the fresh BigStrongSun-based refork the maintained `main` foundation while
keeping its public repository, update-check, and updater-signing identity aligned
with the existing MultiRouter project at `tngflx/ccswitchmultirouter`.

## Evidence

The fresh tree still contained BigStrongSun repository URLs and updater metadata,
while the preserved legacy checkout already used the MultiRouter repository and
its rotated updater public key. The legacy release commit `6d254f58` explicitly
changed the updater endpoint and public key together; copying only the endpoint
would make signed updates unverifiable.

## Decision

Port the legacy MultiRouter identity as one boundary: repository metadata, public
GitHub links, update comparison URLs, updater endpoint, and the matching rotated
public key. Keep BigStrongSun links only where they document upstream attribution,
not as the app's own release destination. Do not copy private signing material.

## Alternatives

- Keep BigStrongSun updater identity: rejected because the replacement repository
  would check and download releases from another project's signing boundary.
- Change only visible links: rejected because updater endpoint and public key must
  remain a matching pair.
- Generate a new signing key: deferred; the established MultiRouter public key
  is already paired with the project's existing release workflow.

## Ownership Boundary

`src-tauri/tauri.conf.json` owns updater endpoint/key configuration; `productLinks`,
commands, tray, app links, and documentation own public destinations. No private
key is added to the repository.

## Approval / implementation / verification

- Approval: approved by the user's instruction to make the fresh refork replace the
  current repository main branch and become the foundation.
- Implementation: complete (2026-10-05); repository metadata, public links,
  updater endpoint, and matching public key were updated in the fresh refork.
- Verification: targeted identity tests passed (`pnpm vitest run
  src/config/productLinks.test.ts src/lib/updater.test.ts`: 3/3 tests), and the
  final Rust/frontend checks passed: `cargo fmt --check`, `cargo clippy -D
  warnings`, `cargo check`, full `cargo test` (4,373 unit tests plus all
  integration tests), `pnpm format:check`, `pnpm typecheck`, full Vitest (224
  files, 1,744 tests), and `git diff --check`.
- Runtime freshness: not checked; runtime must be rebuilt/restarted after the
  public identity cutover.
