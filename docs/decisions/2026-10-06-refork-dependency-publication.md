# Publish the approved refork dependency upgrades

## Goal and approval

Include the existing dependency upgrades in the fresh-refork publication and
verify the same manifest, lockfile, formatter, and workflow installer boundary
that GitHub will consume.

Approval: approved for dependency upgrades. Exact user instruction:
"ok ive restarted! now try finish it up! and yes the dependency upgrades should
be included!!"

Routine, reversible formatter/workflow compatibility corrections need no
separate approval. This does not authorize a new dependency security-policy
exception or any production-data change.

## Evidence

The approved files upgrade the declared package manager from pnpm 10.12.3 to
12.9.1 and update frontend runtime/dev dependency versions. A frozen pnpm 12.9.1
install exited 0 without changing the lockfile. The upgraded Prettier 3.9.9
reports 46 source files, whereas the old locked formatter passed them.

The release and supplemental macOS workflows still explicitly install pnpm
10.12.3. Their installer is a competing version owner. The pnpm action's official
documentation permits omitting `version` when `package.json` declares
`packageManager` and supports pnpm 12. The published pnpm package declares
Node >=18; existing setup-node 20 is not itself a demonstrated incompatibility.

Reference audit on October 6 inspected both BigStrongSun and farion1231
package/release/CI commit histories, current nearby implementations, and open/
closed pnpm-title PRs. Both references still declare pnpm 10.12.3 and Prettier
3.6.2; neither provides this local upgrade boundary. Original PR #2518 upgraded
the setup action; PR #5246 is about application tool-path discovery, not the
workflow installer version. Verdict: adapt the current workflows locally;
do not import unrelated upstream toolchain or application changes.

The workspace diff also added `minimumReleaseAgeExclude: postcss@8.5.29`.
That is a policy exception, not a package version. No explicit approval for
lowering the existing dependency-age policy is recorded.

## Decision and alternatives

- Retain the approved package/lock upgrades and verify with pnpm 12.9.1.
- Let the existing setup action read `packageManager` instead of maintaining
  pnpm 10.12.3 in two release workflows. Keep Node 20 and release triggers intact.
- Apply the upgraded formatter only to its reported files, after checking their
  pre/post TypeScript ASTs match. Do not reformat unexplained dirty source work.
- Omit the newly introduced workspace age-policy exception, preserving the
  pre-existing policy. Verify frozen installation again without the exception.
  If it fails, preserve the error and resolve the actual install boundary rather
  than weakening security policy automatically.

Rejected: reverting approved dependency versions, disabling format checks,
publishing stale workflow pins, or globally bypassing package-age checks.

## Ownership and affected files

`package.json` owns the pnpm version and direct dependency ranges;
`pnpm-lock.yaml` owns resolved packages. Workflow installers consume that version.
Prettier owns mechanical formatting only; source behavior must stay unchanged.
`pnpm-workspace.yaml` retains its established install/build policy.

## Independent status

- Approval: approved for the package upgrades; not-approved for a new security
  exception, which is omitted.
- Implementation: in-progress.
- Verification: partial; first frozen install passed, upgraded formatting check
  failed on 46 files before correction.
- Runtime freshness: user confirmed restart; observed fresh-checkout process
  start at 01:35 on October 6, after the settings regression commits. No complete
  live workflow audit is claimed.
- Publication: pending. The full Cargo run still requires the app stopped, not
  merely restarted; user was asked to stop the normal `pnpm dev`.

Related: `2026-10-06-github-main-refork-cutover.md` and
`2026-10-06-refork-final-frontend-regressions.md`.

## October 6 install-boundary investigation

Without the new exception, frozen installation exited 1 with
`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`: exactly one entry, PostCSS 8.5.29,
was published inside the default one-day cutoff. The lockfile remained
unchanged. This confirms the exception concealed an actual install-policy
violation; do not retain it merely to make the check pass.

Decision: use the preceding eligible PostCSS patch, 8.5.28 (published September
3), still an upgrade from the old direct range ^8.4.49. Keep all other approved
upgrades and regenerate the PostCSS resolution through pnpm, not hand-edited
lockfile entries, then rerun frozen install. This is conservative dependency
compatibility work within the approved upgrades, not approval for weaker policy.
Do not clear the lockfile or disable the guard. A later deliberate package
refresh may take 8.5.29 once it satisfies the normal policy.

Failure log:
`C:/Users/Felix/AppData/Local/Temp/ccswitchmulti-refork-frozen-install-no-exception-20261006.log`.

The initial update command rejected `--depth Infinity` (exit 2; no changes).
Its integer-depth rerun also exited 1: pnpm validates the existing rejected
entry before updating it. Pin the direct PostCSS requirement to 8.5.28 and use
the documented lockfile repair/re-resolution path without installing packages
or trusting the rejected lockfile. The dependency manifest is the producing
boundary; a policy bypass is not the fix.

The documented repair command also rejected the old entry before resolution
(exit 1), even with `--fix-lockfile` and `--no-prefer-frozen-lockfile`.
Correction to the earlier no-regeneration preference: after fixing the producing
manifest, preserve the rejected lockfile as diagnostic evidence and regenerate
only that derived file with policy enforcement. Do not run `pnpm clean`, which
also deletes node_modules. Compare the old/new resolved package inventories;
do not silently accept unrelated version drift. This is derived-artifact
regeneration after a root fix, not clearing state to hide the violation.

## October 6 lockfile and workflow audit correction

Policy-enforced `pnpm install --lockfile-only` exited 0, followed by
`pnpm install --frozen-lockfile` exiting 0 with an unchanged lockfile hash.
PostCSS resolves to 8.5.28. The removed workspace-policy exception is not part
of the publication tree; `pnpm-workspace.yaml` matches the committed baseline.
The rejected lockfile was preserved at
`C:/Users/Felix/AppData/Local/Temp/ccswitchmulti-refork-rejected-postcss-lock-20261006.yaml`
(SHA256 `B551C730D1D6E4DFE8FA32AF9C6C431FDA90167EB2FDEA3A6442697BC98E8A61`).

Regeneration was not zero-drift: besides PostCSS and its peer bindings, four
MSW/Inquirer transitive packages advanced: ansi 2.0.8 to 2.0.9, confirm 6.3.2
to 6.3.3, core 12.0.3 to 12.0.4, and type 4.1.1 to 4.2.0. Their manifests were
inspected; parent dependency ranges remain compatible and their unchanged
Node engine is `>=23.5.0 || ^22.13.0 || ^20.17.0`. Retain this measured drift
within the approved upgrade and verify the resulting lockfile, rather than
claiming that only PostCSS changed.

The first full frontend run on the final dependencies exited 1: 224 files and
1,751 tests passed; one workflow regression failed. I missed the supplemental
Linux workflow's older explicit pnpm 9.15.0 pin in the initial installer edit.
The test correctly detected a third competing version owner; it is not a
fixture failure. Apply the same manifest-consumption fix to that workflow
without changing its release triggers, Node version, or artifact commands,
then rerun the direct workflow tests and the final full suite.

All 46 formatting edits passed pre/post TypeScript AST equivalence before
writing. `pnpm typecheck`, upgraded `pnpm format:check`, `git diff --check`,
Cargo formatting, `cargo check -j1`, and `cargo clippy -j1 -- -D warnings`
passed. Full `cargo test -j1 -- --test-threads=1` exited 101 before tests:
Windows denied removal of the running normal-target `cc-switch.exe`.
No alternative target or process kill was used. The user must stop the existing
fresh-checkout `pnpm dev` and leave it stopped for the normal-target rerun.

## Status history (append-only)

- 2026-10-06: User explicitly approved including the dependency upgrades.
  Implemented the manifest/lockfile changes and manifest-owned installers in
  all three release workflows. Frozen install passed under unchanged age policy.
  Direct workflow/identity tests passed (2 files, 6 tests), including all five
  workflow cases. The first full frontend failure is preserved above; its
  remaining full rerun is pending. Current implementation is implemented for
  this source slice, verification is partial, runtime freshness is not-checked
  for the final installed dependency graph, and main publication is pending.
- 2026-10-06: Removed the missed pnpm 9.15.0 pin from
  `supplemental-linux-release.yml`; the direct workflow/identity run then passed
  2 files / 6 tests. On the committed tree, the full frontend run passed
  225 files / 1,752 tests, `pnpm typecheck`, upgraded `pnpm format:check`,
  workflow-test formatting, and `git diff --check` all passed. Full Cargo
  testing remains blocked by the running normal-target executable; no process
  was killed and no alternate target was used.
