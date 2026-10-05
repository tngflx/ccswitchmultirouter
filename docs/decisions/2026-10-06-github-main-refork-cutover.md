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
