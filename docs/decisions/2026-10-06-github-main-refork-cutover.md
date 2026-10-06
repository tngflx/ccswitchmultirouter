# Replace GitHub main with the fresh-refork foundation

## Goal

Publish the adapted BigStrongSun-based refork as
`tngflx/ccswitchmultirouter`'s `main`, rather than rebase its changes onto the
legacy foundation or leave the replacement only in a local checkout.

## Evidence

On October 6, the fresh checkout is `H:/repos/ccswitchmulti-refork`, on `main`.
Its verified `origin` is `https://github.com/tngflx/ccswitchmultirouter.git`;
its verified `upstream` is `https://github.com/BigStrongSun/ccswitchmulti.git`.
`git merge-base --is-ancestor b4741adeac9b5da84bffe2b75c18c9bb234c5e72 HEAD`
exited 0, confirming the fresh foundation is an ancestor of the implementation.

After fetching origin, `git ls-remote origin refs/heads/main` still returned
`641d53c8113ddb5564b3154dd6f75c17570a450e`. No remote replacement has occurred.
The legacy checkout is dirty with separate catalog/reasoning work; it must stay
intact. The fresh checkout also contains unexplained manifest/lock/workspace
updates that are not part of this chat's committed port.

## Decision

After the final gates pass, replace only remote `refs/heads/main` using
`--force-with-lease=refs/heads/main:<freshly-verified-remote-sha>`. Recheck the
remote immediately before publication and verify it equals the tested final HEAD
afterwards. A lease rejection means stop and audit the newly published work,
not retry with an unconditional force.

Do not rebase onto the legacy main. Do not delete or reset the legacy checkout,
copy its dirty work, create a backup branch/alternate checkout, or change any
production data. Its existing main commit and dirty files remain available
locally. This operation publishes source, not a release artifact.

## Alternatives and risks

- Rebase onto legacy main: rejected; retains the wrong foundation.
- Merge the fresh tree into legacy main: rejected; imports legacy ownership and
  defeats the requested replacement.
- Unconditional force push: rejected; could overwrite concurrent remote work.
- Push now despite unresolved gates: deferred; the current tested dependency
  tree is not the committed publication tree, and final integration verification
  is blocked.

Replacing main rewrites its ancestry; collaborators must reconcile their
checkouts. The lease protects against concurrent updates, not every workflow
consequence. No other refs are authorized for deletion or replacement.

## Ownership boundary and affected files

GitHub `tngflx/ccswitchmultirouter` `refs/heads/main` is the publication boundary.
The fresh checkout is the source of the replacement; the legacy checkout is
preserved evidence, not an implementation target. Decisions and the journal own
verification/cutover evidence.

## Approval and independent status

- Approval: approved. Exact user instruction: "then i want the github repo main
  branch to have these fresh refork codebase with our own flavours!!! that's the
  whole purpose!!"
- Implementation: pending for the remote replacement; the fresh foundation and
  adapted custom-feature commits already exist locally.
- Verification: partial. See
  `2026-10-06-refork-final-frontend-regressions.md` for current exact results.
- Runtime freshness: not-checked for the latest regression fixes; no complete
  live workflow audit is claimed.
- Disposition: active; cutover not-started.

## Final gates

1. Resolve ownership/disposition of the dirty dependency/toolchain changes
   without overwriting someone else's work, then verify the actual publication
   dependency tree. No approval for a dependency age-policy exception is inferred.
2. User stops the normal fresh-checkout `pnpm dev`; rerun the full normal-target
   Cargo suite. Do not kill the app or use an alternate build target.
3. Preserve test failures and ignored tests, verify required custom contracts,
   and confirm tested source/config matches the intended final committed tree.
4. Refresh the remote and perform the exact-lease publication; verify its SHA.

Known scope limitations: translation gaps and deliberately deferred legacy
global-loading behavior remain, and newer dirty legacy reasoning/catalog work is
not automatically included. Neither feature parity nor cutover is called 100%.

Related: `2026-10-03-bigstrongsun-refork-foundation.md`,
`2026-10-05-fork-identity-cutover.md`, and `docs/memory/journal.md`.

## October 6 publication-gate update

The committed dependency and formatter tree now passes the full frontend suite
(225 files / 1,752 tests), `pnpm typecheck`, upgraded `pnpm format:check`, the
workflow ownership tests (2 files / 6 tests), and `git diff --check`.
The full normal-target Cargo suite was attempted and exited 101 before tests
because the user's running `pnpm dev` still locks
`src-tauri/target/debug/cc-switch.exe`. The process was not killed and no
alternate target was used. The user must stop that process before the backend
rerun. Remote `origin/main` remains
`641d53c8113ddb5564b3154dd6f75c17570a450e`; publication is still pending.

## October 6 adapted-order continuation gate correction

The later localization/order tree supersedes the earlier green frontend tree.
Its final frontend run failed: 17 failed / 216 passed files and 54 failed /
1,775 passed tests. `pnpm format:check` failed on the four protected
reasoning/form files. The normal-target full Cargo command exited 101:
`failed to remove file H:\repos\ccswitchmulti-refork\src-tauri\target\debug\cc-switch.exe`,
`Access is denied. (os error 5)`. The app was not killed and no alternate
target was created; the user has been asked to stop their existing `pnpm dev`
before the final backend rerun.

Passing source gates for this tree: `cargo check`, `pnpm typecheck`,
`cargo fmt -- --check`, and `git diff --check`. Targeted tests passed:
9 frontend files / 443 tests, 130 router library tests, and 245 catalog
configuration tests. The two backend test-fixture warnings remain. The
latest running binary predates the source; live workflow freshness is not
verified. Publication remains pending; no cutover or 100% parity is claimed.

## October 6 current-tree gate update

The latest full frontend command exited 1: 229 passed / 4 failed files,
1,834 passed / 9 failed tests. Remaining failures are protected reasoning/form
consumers; their ownership is not released. Formatting still fails on four
protected source files. Fresh source/type/format checks otherwise passed.
The normal-target backend library command passed 4,379 tests, failed 0 and
ignored 9, retaining two existing test-fixture warnings. Library-only evidence
does not substitute for the blocked full backend/integration command.

An additional presentation audit found hardcoded English in attributable
localization edits. Four-locale correction is in progress under the existing
localization decision. Both observed refork app processes still predate current
source; no fresh runtime or publication is claimed. Approval remains for an
exact-lease replacement of remote main only after the final actual-tree gates.

## October 6 current-tree regression correction

The latest full frontend rerun narrowed the failures to the concurrent protected
reasoning/form task: 231 files passed and 5 failed, with 1,843 tests passed and
13 failed. `pnpm format:check` reports only the four protected reasoning source
files. This supersedes the immediately preceding 229/4-file, 1,834/9-test
snapshot as the current evidence; that earlier result remains above for audit
history. The model-order and egress targeted run passed 2 files / 118 tests,
while `pnpm typecheck`, `cargo check`, `cargo fmt -- --check`, and
`git diff --check` passed. No publication is authorized until the protected task
releases its files, the user restarts the normal refork `pnpm dev`, and the
complete final gates pass.
