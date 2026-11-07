# Publication verification — November 8, 2026

## Scope and cleanup

The user requested removal of obsolete `.tmp` files and publication of the latest
source changes from the existing `main` branch to `origin/main` in
`tngflx/ccswitchmultirouter`. No branch/worktree switch, forced push, upstream push,
application restart, or native installation was requested or performed.

The repository-local `.tmp` directory contained 21,839 files totaling 830,854,143
bytes. It consisted of historical audit logs, extracted application fixtures,
source baselines, replay data, and old test homes. No existing contents were
required by application or test source. Build helpers recreate their temporary
Cargo directory when needed. The absolute cleanup target and lack of linked
contents were checked before removal.

All 63 previously tracked scratch files were removed in cleanup commit
`046651a2b`. A root `/.tmp/` ignore rule replaces narrower scratch exclusions.
Existing generated production output and the extracted root application chunk
were left local and excluded from publication. Earlier audit documents now mark
their scratch-file references as historical, rather than claiming those files
remain available.

## Verification of the source snapshot

| Command                                                                     | Result                                                           |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm typecheck`                                                            | Passed.                                                          |
| `pnpm catalog:verify`                                                       | Passed: 15 files, 528 tests, with verified completion.           |
| `pnpm test:unit`                                                            | Passed: 282 files, 2,934 tests, with verified completion.        |
| `pnpm format:check`                                                         | Passed.                                                          |
| `pnpm build:renderer`                                                       | Passed through the catalog/contract gates and Vite build.        |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml`                    | Passed.                                                          |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`          | Passed.                                                          |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::` | Passed: 166 tests.                                               |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib`                     | Failed: 5,193 passed, 1 failed, 10 existing ignored.             |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1` | Failed identically: 5,193 passed, 1 failed, 10 existing ignored. |
| `git diff --check` / `git diff --cached --check`                            | Passed.                                                          |

The first catalog verification attempt was rejected by the completion guard:
Vitest exited without a valid completion receipt. The unchanged gated command was
rerun and completed successfully. The subsequent full unit run and gated renderer
build also completed successfully. The incomplete attempt is not counted as a
passing test run; no completion guard, assertion, timeout, or build gate was
weakened.

### Outstanding Windows listener-state test failure

`process_identity::tests::live_port_rows_describe_a_listening_socket` fails at
`src-tauri/src/process_identity.rs:1019`: the test's own loopback listener reports
`UNKNOWN` instead of `LISTEN`, while its port and owning PID are correct. It also
fails alone with `--test-threads=1`. The file is unchanged in the published source
snapshot; its last modification was commit `160d28adb`.

An independent C# P/Invoke check reproduced the host API returning
`dwState=0x00000000` from `GetExtendedTcpTable(TCP_TABLE_OWNER_PID_ALL)` for a new
own-process listener. This supports a host reporting issue independently of the
pending Rust edits. Zero was not relabeled as LISTEN to obtain a passing test.
The actual listener-owner lookup uses a listener-only table and owning PID,
rather than this diagnostic state label. The full Rust suite is **not green**.

## Boundaries

Verification logs from this publication run were stored outside repository
`.tmp`, in the operating system temporary directory, and were not published.
Existing nonfatal Rust test warnings, Node/React warnings, and Vite's large-chunk
advisory remain visible.

The renderer build does not prove that a native executable was rebuilt or
installed. No complete live UI/provider audit was performed; the previously
reported monitor/desktop-bridge limitations remain unresolved. This publication
must not be described as live end-to-end verification or deployment.
