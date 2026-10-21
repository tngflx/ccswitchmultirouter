# JavaScript watchdog and local production build

The previous recovery fix kept the development supervisor in JavaScript but
left the external watchdog, scheduled-task installer, and local production
build in PowerShell files. The user then requested the JavaScript migration.

## Operational entry points

These commands now run Node directly:

| Command                   | Implementation                                               |
| ------------------------- | ------------------------------------------------------------ |
| `pnpm dev`                | `scripts/dev-tauri-delayed.mjs` (existing development owner) |
| `pnpm watchdog:run`       | `scripts/watch-ccswitchmulti.mjs`                            |
| `pnpm watchdog:install`   | `scripts/install-ccswitchmulti-watchdog.mjs`                 |
| `pnpm watchdog:uninstall` | JavaScript installer with `--uninstall`                      |
| `pnpm build`              | `scripts/local-build-pipeline.mjs`                           |

The three replaced `.ps1` entry points are compatibility wrappers that preserve
argument boundaries and exit status, including paths containing quotes,
Unicode, spaces, and shell metacharacters. They contain no monitoring or build
implementation. Existing transaction and release-maintenance scripts remain
PowerShell; this migration does not claim that the repository has no `.ps1`
files.

The local production build runs its pinned local Tauri CLI through Node with
argument arrays. It retains the renderer build gate, isolated Cargo target,
unsigned local updater override, artifact ownership checks, junction checks,
staging, rollback, and cleanup. It accepts both `--output-dir` and `-OutputDir`.
Existing output marked by the PowerShell pipeline is accepted; new output
records the JavaScript pipeline as its owner.

## Recovery ownership and Windows boundary

The JavaScript guardian defaults to production and targets the installed app.
Development recovery requires `--development-mode` and reads the existing dev
session and persisted restart history. It reuses the canonical policy JSON;
the dev supervisor remains the normal development restart owner. Maintenance
leases retain their existing format, and transaction tooling retains lease
acquisition ownership.

Windows process identity, Task Scheduler, and the native exclusive-file lock
use inline PowerShell 7 commands through the bounded/redacted query boundary.
No `.ps1` file runs in the new watchdog's module closure. The exclusive lock
uses the same `FileShare.None` contract as older guardians. Process stops
retain the OS handle before validating executable, start time, and, when
needed, command line and user SID, then stop that retained handle.

Node 22.12 or newer is required for guardian installation and execution. Rust
writes FILETIME as a JSON number beyond JavaScript's safe integer range; the
new core preserves its raw numeric source and compares 100 ns ticks with
BigInt. PID reuse one tick apart must not authorize a stop. Task registration
uses the absolute Node executable and the current user's SID with a limited
interactive logon task. Node and PowerShell 7 must remain available afterward.

## Review corrections and regressions

Two cleanup regressions in the initial build port were reproduced before
fixing them: config cleanup could mask the build error and skip Cargo cleanup;
staging cleanup could mask an export failure. Independent cleanup stages now
preserve the primary error, and the redirected-stage regression verifies that
the unlink guard blocks deletion through a substituted junction.

Watchdog review also corrected two integration gaps. Lock loss must cancel
the pending JavaScript loop and prevent a later dev-history write or launch.
Installation must not infer readiness from a fresh process plus a stale lock
file: it now requires an unchanged task action and a post-lock
`guardian-started` record with the exact new PID and full creation-time string.
The stale-lock predicate failed its regression before this correction.

The existing runner-specific PowerShell tests now gate the actual JavaScript
suite and real wrapper calls. Core/transaction PowerShell tests remain. The
production build tests moved their assertions to Node and retain a Pester
bridge, rather than testing a second production build implementation.

## Verification and activation boundary

Final checks passed:

- `pnpm test:lifecycle`: 129 tests (44 core, 39 runner, 22 installer, 20 build,
  4 entry-point/real-wrapper tests).
- `pnpm test:dev-recovery`: 145 tests.
- Combined lifecycle, compatibility, release, and transaction Pester: 213 tests.
- `pnpm test:unit`: 269 files, 2,607 tests.
- `pnpm catalog:verify`: reader guards and 476 catalog tests.
- CI Python: 28 tests; typecheck, frontend/script formatting, and diff checks.

Native Windows tests use owned temporary fixture processes and lock files;
they do not stop the real app or change tasks. The lifecycle suite is now a
Windows backend CI gate. Remote Actions were not run.

The live, read-only preview `pnpm watchdog:install --dry-run` refused
installation because the default production executable
`%LOCALAPPDATA%/CCSwitchMulti/cc-switch.exe` is missing. No scheduled task or
installed runtime was changed. No production build, installation, publication,
or provider interruption request was performed. The development session from
the preceding recovery activation was not replaced by a production guardian.

Local receipts:

```text
%TEMP%/ccswitch-js-lifecycle-final-20261021.log
%TEMP%/ccswitch-js-lifecycle-dev-recovery-20261021.log
%TEMP%/ccswitch-js-lifecycle-pester-final-20261021.log
%TEMP%/ccswitch-js-lifecycle-unit-20261021.log
%TEMP%/ccswitch-js-lifecycle-ci-20261021.log
%TEMP%/ccswitch-js-lifecycle-typecheck-20261021.log
%TEMP%/ccswitch-js-lifecycle-format-20261021.log
%TEMP%/ccswitch-js-lifecycle-catalog-20261021.log
%TEMP%/ccswitch-js-watchdog-install-preview-20261021.log
```
