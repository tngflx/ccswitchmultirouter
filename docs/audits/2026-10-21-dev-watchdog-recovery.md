# Development supervisor recovery and PowerShell 7

The user reported that the outer `pnpm dev` session exited without restarting.
The previous tests covered Vite/Tauri worker failures and replacement-marker
publication separately, but did not exercise the detached watcher's complete
detect-launch-failed-publication-retry path.

## Confirmed defect

The detached watcher launched the JavaScript dev entry point and waited for the
new supervisor to publish its owned marker. If the new process died before
publication, the old watcher logged `dev-supervisor-publication-failed` and
retired anyway. There was then no confirmed replacement watcher owning recovery.
The extracted helper also initially returned `restarted: true` on this branch.

The regression first failed with one launch when two were required. The fix
returns an explicit retry outcome after a dead replacement, and the existing
watcher loops with the same persisted restart history. A live unpublished child
continues to own its attempt; timeouts do not start a competing launcher.
Repeated failed replacements stop at five attempts in thirty minutes and emit
`dev-supervisor-restart-skipped` with the reason. Clean quits and disabled
recovery retain their existing behavior.

Supervisor marker deletion was investigated and rejected as the cause:
`superviseDevSessions` handles unexpected worker failures internally. A normal
nonzero completion represents disabled recovery or an exhausted budget;
exceptions already preserve the owned marker. No exit-code-only cleanup rule
was retained.

## Process probes and language choice

The development supervisor and detached watcher are JavaScript:
`pnpm dev` runs `node scripts/dev-tauri-delayed.mjs`. They do not run a repository
`.ps1` file. Windows process and listener probes use a small shared
`windows-json-query.mjs` boundary that invokes PowerShell 7 (`pwsh.exe`) only.
The Cargo cleanup preflight consumes the same boundary.

Probes require PowerShell 7 or newer, use UTF-8, stop on WMI errors, time out
after ten seconds, and redact output from diagnostics. Failed or incomplete
ownership probes block target cleanup. The old Windows PowerShell dependency
had recurring historical `0xC0000142` startup failures. Those logs establish
probe failures; they do not prove which branch caused a specific missing live
handoff.

JavaScript remains the recommended lifecycle owner. Removing PowerShell from
Windows process inspection entirely would require a native Node module or a
compiled Win32/Rust helper to retain executable, command line, parent, and
creation-time checks. TypeScript would still execute through Node and would not
remove that Windows API requirement.

## Verification checkpoint

The focused combined Node command passed 145/145 tests, including the direct
watcher retry, shared restart limit, process-query failure recovery, PowerShell
7 host requirement, and guarded Cargo cleanup cases. The RED failure was
`1 !== 2` for the replacement retry assertion. The captured combined log is
`%TEMP%/ccswitch-dev-exit-ps7-20261021.log`. The subsequent combined run including
the isolated Windows process integration is
`%TEMP%/ccswitch-dev-exit-ps7-integration-20261021.log`.

The integration uses the actual watcher loop, handoff helper, and publication
checker with real owned Node fixtures and PID-scoped PowerShell 7 CIM queries.
The old supervisor is observed alive before its retained child handle is
terminated. One replacement exits before publication; a second publishes its
exact CIM creation identity. The test checks two budget charges, one failure
event, one success event, preserved dev arguments, and retirement only after
publication. It creates no app/provider/Cargo processes or listener ports.

Windows lifecycle and launcher Pester checks passed 221/221, and history-tool
PowerShell migration regressions passed 2/2. Lifecycle evidence is in
`%TEMP%/ccswitch-pwsh7-lifecycle-final-20261021.log`.

App-side process probes and Windows terminal launches now share the Rust
PowerShell 7 command factory. The persisted `powershell` terminal selection
continues to work and launches `pwsh.exe`. History migration refuses to write
when its offline-process probe fails. The About installer command and terminal
labels also use PowerShell 7. At this checkpoint the production build/install
`.ps1` scripts remained; the JavaScript dev supervisor did not depend on them.
The subsequent [JavaScript lifecycle migration](2026-10-21-javascript-lifecycle.md)
replaces the external watchdog, its installer, and the local production build
entry points while preserving thin PowerShell compatibility wrappers.

Final validation of the current source passed:

- `pnpm test:dev-recovery`: 145 tests, including the isolated Windows handoff.
  The command is also a Windows backend CI gate; remote Actions were not run.
- Windows lifecycle Pester: 221 tests; history Python: 2 tests; CI Python:
  27 tests; About component: 12 tests.
- Full Rust library: 4,970 passed, 10 existing ignored; separate multirouter
  scope: 156 passed; strict Clippy and Rust formatting passed.
- Typecheck, frontend formatting, explicit script/package formatting, and
  `git diff --check` passed.
- `pnpm build:renderer` passed its Responses contract, catalog reader guards,
  and 476 catalog tests before producing the renderer bundle. Vite reported
  its existing large-chunk warning.

Final command receipts are in these local logs:

```text
%TEMP%/ccswitch-dev-recovery-command-final-20261021.log
%TEMP%/ccswitch-pwsh7-lifecycle-final-20261021.log
%TEMP%/ccswitch-dev-recovery-pwsh7-rust-20261021.log
%TEMP%/ccswitch-dev-recovery-pwsh7-clippy-20261021.log
%TEMP%/ccswitch-dev-recovery-pwsh7-multirouter-20261021.log
%TEMP%/ccswitch-dev-recovery-pwsh7-typecheck-20261021.log
%TEMP%/ccswitch-dev-recovery-pwsh7-renderer-20261021.log
```

## Development activation

A guarded planned reload activated the current development code on
2026-10-21. It validated and retained the exact old supervisor/watcher handles,
stopped the watcher before the supervisor under the canonical maintenance
lease, and used the existing launcher with the saved arguments/environment.
The new supervisor rebuilt the debug application and published one owned
watcher. At 12:01:22 UTC, supervisor 58868, watchdog 56280, worker 50980, and
app 9360 had matching ownership and app-marker creation identity. The app's
executable was written at 12:01:15 UTC. A subsequent PID-scoped check confirmed
all four processes remained alive, the helper exited, and the maintenance
lease was absent. Selected evidence is recorded in
[the runtime receipt](2026-10-21-dev-watchdog-runtime.json); the full local
observer receipt is `%TEMP%/ccswitch-dev-recovery-activation-20261021.json`.

This planned reload establishes that the running development session loaded
the current code. Automatic failed-replacement recovery is established by the
isolated real-process regression. Neither is a live provider interruption
audit: the configured provider monitor was unavailable, and no UI automation
was substituted. No production binary was built or installed.
