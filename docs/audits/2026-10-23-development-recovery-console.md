# Development recovery console investigation

## Cause and supported behavior

The development watchdog previously discarded its output and the replacement
supervisor's output. That prevented Cargo, Tauri, and Vite startup messages from
reaching the original terminal after an automatic recovery.

Changing only `windowsHide` and inheriting output does not fix a full Windows
supervisor exit. The installed Node.js v26.2.0 uses libuv v1.52.1. In that exact
libuv implementation, `detached: true` sets `DETACHED_PROCESS` and
`CREATE_NEW_PROCESS_GROUP`; it does not set `CREATE_NEW_CONSOLE`.
`windowsHide: false` controls the startup show state and does not attach the
child to the original console. The detached child can survive the parent, but
its inherited console handles can be invalid. This was reproduced with real
Windows console handles, including `EBADF` from both output streams.
[libuv v1.52.1 Windows process implementation](https://github.com/libuv/libuv/blob/v1.52.1/src/win/process.c#L970),
[Microsoft process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags),
[Microsoft console handles](https://learn.microsoft.com/en-us/windows/console/console-handles).

Using `detached: false` and calling `unref()` is also unsafe for the watchdog.
libuv explicitly assigns non-detached children to a job with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; terminating the parent closes that job
and kills its direct child. `unref()` changes Node's event-loop references,
not Windows job membership. The installed runtime reproduced that loss even
after the child had confirmed it was running.
[libuv job setup](https://github.com/libuv/libuv/blob/v1.52.1/src/win/process.c#L65),
[libuv non-detached process assignment](https://github.com/libuv/libuv/blob/v1.52.1/src/win/process.c#L1016),
[Node child-process unref documentation](https://nodejs.org/api/child_process.html#subprocessunref).

The selected recovery policy therefore preserves detached watchdog survival
and gives full-supervisor recovery a durable append-only output file for
stdout and stderr. The shared JavaScript helper
`scripts/dev-recovery-output.mjs` derives that file from the current session
marker's directory: `<config-dir>/logs/dev-recovery.log`. For the investigated
profile, it is `C:/Users/felix/.cc-switch/logs/dev-recovery.log`. The living
launcher prints the output location and this PowerShell 7 tail command:

```powershell
Get-Content -LiteralPath 'C:/Users/felix/.cc-switch/logs/dev-recovery.log' -Tail 60 -Wait
```

An app or worker restart while the main supervisor remains alive keeps using
that supervisor's existing output path. A full supervisor recovery does not
promise reuse of its old Windows console. The development watchdog,
replacement supervisor, and explicitly enabled external development guardian
use the same output policy; production launch behavior is unchanged.

A process that has already exited cannot launch its replacement. A surviving
watchdog must perform that operation. Reusing a still-existing native console
requires native console attachment to a living owner; when the last attached
process exits, that console is destroyed. A separate native launch can create
a fresh console, but that also requires an explicit process-identity and
lifecycle integration. A local WMI launch must account for the provider job,
the intended interactive session, the environment, and launch publication;
`windowsHide: false` alone provides none of those guarantees.
[Microsoft AttachConsole](https://learn.microsoft.com/en-us/windows/console/attachconsole),
[Microsoft console creation](https://learn.microsoft.com/en-us/windows/console/creation-of-a-console),
[Microsoft Win32_Process.Create](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/create-method-in-class-win32-process).

## Native reproduction evidence

The probes used disposable Node processes only. They did not launch the
application, restart a development session, alter settings, or touch provider
traffic. Both tests used the installed Node v26.2.0 / libuv v1.52.1.

### Parent exit and job ownership

`C:/Users/felix/AppData/Local/Temp/ccswitch-node-parent-exit-console-proof-20261023.mjs`
started a disposable parent and child. The parent waited for the child's
started receipt, called `unref()` on its child handle, and exited normally.
The child attempted a delayed file write after that exit and then terminated.

| Spawn options                | Child started before parent exit | Delayed write after parent exit | Child left alive after bounded probe |
| ---------------------------- | -------------------------------- | ------------------------------- | ------------------------------------ |
| `detached: false`, `unref()` | Yes                              | No; killed by parent job        | No                                   |
| `detached: true`, `unref()`  | Yes                              | Yes                             | No                                   |

The combined receipt is
`C:/Users/felix/AppData/Local/Temp/ccswitch-node-parent-exit-console-proof-20261023.json`.
Its exact disposable case directories are
`C:/Users/felix/AppData/Local/Temp/ccswitch-parent-exit-iEMpXb` and
`C:/Users/felix/AppData/Local/Temp/ccswitch-parent-exit-FV5tVK`.

### Detached inheritance from a real console

`C:/Users/felix/AppData/Local/Temp/ccswitch-hidden-console-proof-20261023.mjs`
was launched through PowerShell 7 `Start-Process -WindowStyle Hidden`, creating
a real, hidden disposable console. The parent confirmed that stdout and stderr
were both TTYs. It then spawned its child with `detached: true`,
`windowsHide: false`, and `stdio: ["ignore", "inherit", "inherit"]`.

| Observation                | Result                           |
| -------------------------- | -------------------------------- |
| Parent stdout and stderr   | Both `isTTY: true`               |
| Child started              | Yes                              |
| Child stdout and stderr    | Both `isTTY: false`              |
| Child stdout write         | `EBADF`                          |
| Child stderr write         | `EBADF`                          |
| Child survived parent exit | Yes; completed its bounded probe |

The receipts are `parent.json` and `child.json` under
`C:/Users/felix/AppData/Local/Temp/ccswitch-hidden-console-6762036138b448b2b31e6e3f60aea2bf`.
This native failure invalidated the initial inherit-and-unhide proposal before
it was accepted as the final fix.

## Verification boundary

These probes establish Windows process-survival and console-handle behavior.
They do not establish that the running development application has loaded the
new output policy. No live application restart or build activation was
performed for this console investigation. The repository regression tests
separately cover the selected append-file launch policy and the worker and
watchdog recovery paths. The helper's six regression cases passed, including
a real child that waits until its launching parent has exited before writing
both stdout and stderr to the persistent file. Restoring the previous ignored
output configuration makes that native case fail because no log file exists.

Final combined checks passed on the integrated source:

- `pnpm test:dev-recovery`: 195 passed, zero failed. This includes the real
  default watchdog launch adapter and output written after a disposable
  launcher exits.
- `pnpm test:lifecycle`: 130 passed, zero failed. The installed watchdog bundle
  includes the new shared helper; the production launcher keeps its installed
  application output policy and creates no development log.
- TypeScript, repository formatting, targeted script/document Prettier,
  JavaScript syntax checks, and `git diff --check` passed.

The actual running supervisor must be replaced by a fresh `pnpm dev` from the
user's terminal to load the changed JavaScript launcher. Source and fixture
verification do not update a previously loaded watchdog process.
