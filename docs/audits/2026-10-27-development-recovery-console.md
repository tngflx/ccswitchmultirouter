# Live development recovery and console output verification

The actual development session recovered after a deliberate supervisor-only
crash on October 27, 2026. The successful
[runtime receipt](2026-10-27-development-recovery-console-runtime.json) records
the verified process identities, source hashes, log offsets, and output checks.
This verifies the development launcher and its real Vite/Cargo/Tauri startup;
it is separate from Codex continuation delivery and production installation.

## Failure found by the first live test

The initial October 23 test activated the logging helper successfully, but
recovery timed out after terminating its supervisor. The detached watchdog had
also died. A disposable package using the installed native `pnpm.exe`
reproduced the missing layer: `pnpm` starts Node inside an ancestor Windows job.
When the supervisor dies, `pnpm` exits and job teardown also kills its detached
watchdog. The earlier direct Node parent tests did not cover that ancestry.

The Windows watchdog now launches through WMI with explicit
`CREATE_BREAKAWAY_FROM_JOB`. JavaScript still owns recovery policy. PowerShell
7.5 or newer performs the native launch; no PS1 entrypoint was added. Executable,
arguments, working directory, and environment cross the native boundary over
stdin, with environment values excluded from command lines and diagnostics.
The launcher verifies a retained process handle and returns exact identity.

The canonical session now stores `watchdogIdentity`. Manual takeover and the
external development guardian read this shared identity instead of assuming
the watchdog's native parent is the supervisor. A present malformed or
conflicting identity fails closed. Legacy direct-child detection applies only
when the canonical field is absent. Native termination checks the recorded
exact FILETIME when available. Quoted watchdog arguments from the native
launcher are accepted only with exact token boundaries.

The replacement supervisor retains the durable append-file output helper.
Both stdout and stderr reach `dev-recovery.log` beside the canonical session
marker. The original console window is not reopened automatically.

## Actual runtime result

The test first ran normal `pnpm dev` takeover to load the changed JavaScript.
It verified the new supervisor, worker, independent watchdog, app, planned
restart receipt, exact application marker, and owned healthy ports. It then
started a real PowerShell `Get-Content -Tail 0 -Wait` follower before crashing
only the supervisor through its retained native handle.

All times below are Singapore time on October 27:

| Observation                                          | Verified result                                         |
| ---------------------------------------------------- | ------------------------------------------------------- |
| Activated development generation                     | 76                                                      |
| Deliberately crashed supervisor                      | PID 62176 at 11:11:24                                   |
| Independent watchdog                                 | PID 57084 survived the supervisor and pnpm exit         |
| Automatic replacement supervisor                     | PID 4748, started at 11:11:27                           |
| Recovered application                                | PID 8704, started at 11:11:49                           |
| Recovered generation                                 | 77                                                      |
| Restart budget                                       | Increased exactly once, from zero to one                |
| Old supervisor, worker, watchdog, and app identities | All retired                                             |
| Replacement watchdog                                 | Exactly one, PID 61812, canonical identity verified     |
| Proxy and frontend                                   | Healthy; unique expected owners of ports 15721 and 3000 |
| Fresh recovery log                                   | 12,262 bytes after the recorded pre-crash offset        |
| Actual output                                        | Vite startup, Cargo build result, and Tauri app launch  |
| PowerShell follower                                  | Received the same three real startup signatures         |

The verification completed at 11:12:01. It performed no provider request or
Codex restart. Raw diagnostic logs remain local; the repository receipt stores
finite facts and hashes rather than request bodies or environment values.

To watch subsequent full-supervisor recoveries:

```powershell
Get-Content -LiteralPath "$env:USERPROFILE\.cc-switch\logs\dev-recovery.log" -Tail 60 -Wait
```

The original window continues receiving worker-only restarts while its
supervisor stays alive. When the supervisor itself dies, the independent
watchdog performs recovery and the durable file retains output.

## Regression coverage

The actual native pnpm ancestor regression fails with the old detached-only
launcher and passes with independent creation. The finite watchdog starts
before its supervisor is terminated, survives pnpm's exit, writes afterward,
and exits without an orphan. Native argument tests also cover spaces, quotes,
trailing backslashes, Unicode, working directory, and environment propagation.

Additional regressions cover canonical independent watchdog ownership,
malformed identities, competing watchers, quoted token boundaries, marker
rereads, and a native one-tick FILETIME mismatch. These preserve the existing
manual takeover and production launch guards.

The final suites, including the quoted-argument correction, passed:

- `pnpm test:dev-recovery`: **222 passed**, zero failures or skips.
- `pnpm test:lifecycle`: **134 passed**, zero failures or skips.
- `pnpm typecheck`, `pnpm format:check`, targeted script and document
  Prettier, JavaScript syntax checks, and `git diff --check`: passed.

The [independent read-only review](2026-10-27-development-recovery-console-review.json)
revalidated the same recovered processes, healthy ports, fresh output hashes,
single restart event, and all source hashes recorded in the runtime receipt.
It also records the final canonical-reader hash, which the original runtime
receipt did not include. The quoted-flag correction was checked against the
actual running watchdog, including external guardian inspection and manual
takeover selection aborted before mutation. The separate
[reader receipt](2026-10-27-development-recovery-console-reader-review.json)
records that boundary explicitly. No additional live crash was needed for
that reader-only correction.
