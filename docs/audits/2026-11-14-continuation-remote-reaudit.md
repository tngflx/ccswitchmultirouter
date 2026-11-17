# Codex continuation and remote-access re-audit — 2026-11-14

## Scope and safety boundary

This audit covers the source path from a failed provider request or Responses
stream to a separately authorized Codex Desktop `continue` turn. It also
separates remote model access from remote Codex chat access. Existing unrelated
workspace changes were preserved; no branch switch, push, installation, or
application restart was performed.

## Corrections

- The shared Rust/renderer terminal policy now honors boolean `retryable: false`
  at known error boundaries, and explicit no-retry instructions in known error
  strings. Permanent auth, quota, permissions, cancellation, and pending-operation
  categories retain priority. Unrelated request/debug metadata is not a new
  source of continuation policy.
- Native, Chat, and Anthropic stream normalization retain the explicit retry
  decision so conversion cannot turn a provider refusal into automatic recovery.
- Capacity recovery stops after an unclassified reconnect failure rather than
  continuing to replay in the translated/raw protocol paths. The safe-replay
  capacity setting and separately enabled Aggressive continuation remain distinct:
  a locally generated "capacity retry disabled" overload does not manufacture an
  upstream `retryable: false` instruction.
- Native SSE replay guards require a verified `response.created` scaffold.
  Malformed or conflicting payloads do not gain permission to replay. Mixed LF
  and CRLF blocks are consumed in wire order, preserving the semantic-output
  boundary.

- Multi-device quota enforcement and overview now derive fresh windows from
  canonical, current-account per-device database reports. Each report expires
  independently after ten minutes, including when no new sync occurs. A fresh
  low-usage device no longer extends a stale high-usage device's block. Future
  timestamps and a prior account's aggregate cache cannot authorize enforcement.
  Stale UPSERTs preserve both the newer report's payload and its metadata.
  Historical reports remain available for display; settings aggregates remain
  compatibility projections, not enforcement authority.

These changes have regression cases that failed against the prior implementation.

## Recovery policy remains bounded

- **Off:** no automatic replay or Desktop continuation.
- **Safe:** replay the finalized upstream request only before semantic output.
- **Aggressive:** Safe plus separately authorized new Desktop `continue` turns
  for recoverable failures, within the configured one-to-three-turn budget.
- Desktop continuation backoff remains 5, 10, and 20 minutes. No production timer
  was shortened for this audit.
- Current provider/settings, exact failed turn/model, user activity, renderer
  ownership, and final mutation authorization are rechecked. An ambiguous
  acknowledgement spends the attempted-submission budget rather than submitting
  the same continuation again.
- Overload/concurrency, connection/stream interruptions, and temporary usage
  errors with positive retry/reset wording can be recoverable. Hard quota,
  billing/credit exhaustion, auth/permission errors, cancellation, explicit
  no-retry, and an operation that may still be running must not be retried.

The request-handler boundary audit found no additional integration change needed:
concrete upstream errors retain their original classification, and the final
client-facing observer runs after adapters and timeout/logging wrappers.

## Read-only live observation

Receipt:
[Read-only readiness receipt](2026-11-14-continuation-readiness.json)

The repository verifier ran against the exact current workspace debug executable
and configured CCSwitch log, with a 60-second bound and neither disposable-thread
nor source-injection flags. At `2026-11-14T09:39:29.200Z` it stopped at readiness
with `runtime_fingerprint_not_observed`:

- `verified: false`
- Initial requests: `0`; continued requests: `0`
- No fixture thread created; existing threads untouched.

This means no fresh installed-runtime fingerprint was observed in that log
window. It is **not** proof that the bridge is broken, nor proof that automatic
native scheduling works. The prior November 13 receipts prove controlled Desktop
submission using a hot-injected source renderer; they do not activate these new
native/source changes in the running executable. A current build must be activated
and the controlled installed-runtime scenario must pass before claiming live
end-to-end completion.

## Remote access: three different capabilities

1. **View and continue Codex chats on another computer:** native Remote Control
   is separate from CCSwitchMulti. The host uses **Settings → Connections →
   Control this Mac or PC → Set up/Add** and pairs the viewer. Another desktop
   uses **Control other devices** where available; mobile uses ChatGPT's
   Codex/Remote surface. Use the same account/workspace and keep the host awake
   and online. Pairing was not performed. CCSwitch's continuation patch still
   owns only its local host client.
2. **Use another CCSwitchMulti instance's models:** its authenticated
   **Third-party Agent API** can serve inference through a private network or
   authenticated tunnel, normally on its separate port `15722`. Add that endpoint
   as a provider on the consuming machine if desired. This is not a Codex chat,
   history, or screen-sharing endpoint, and quota collaboration does not
   automatically fail over a conversation to it.
3. **See the actual desktop/window pixels:** use authenticated remote-desktop or
   screen-sharing software. Native chat Remote Control and the model API are not
   full-screen mirroring. Keep CDP and Tauri IPC private; do not publish port
   `9229` or the unauthenticated takeover listener to the Internet.

Moving to another device does not reset the same account's usage allowance. A
remote model backend only helps a quota failure if that backend independently has
usable capacity; it is not an account-limit bypass.

Sources checked on November 14, 2026:

- OpenAI Remote Control: <https://learn.chatgpt.com/docs/remote-connections.md>
- Codex plan usage: <https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan>
- Repository setup guide: `docs/guides/external-openai-api-relay-domain-guide-zh.md`
- Quota collaboration guide: `docs/guides/codex-multi-device-quota-collaboration-zh.md`

## Verification

The final completed checks retain all existing gates and assertion boundaries:

| Check                                                                                       | Result                                                             |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `pnpm typecheck`                                                                            | Passed                                                             |
| `pnpm catalog:verify`                                                                       | Reader guards and 18 files / 722 tests passed                      |
| `pnpm format:check` and `git diff --check`                                                  | Passed                                                             |
| `pnpm test:unit --maxWorkers=2`                                                             | 294 files, 3,628 tests passed                                      |
| Renderer continuation suite (also included above)                                           | 142 tests passed                                                   |
| `node --test scripts/verify-codex-desktop-continuation.node-test.mjs`                       | 27 tests passed                                                    |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib proxy:: -- --test-threads=1 --quiet` | 2,418 tests passed                                                 |
| Rust `codex_desktop::` scope                                                                | 138 tests passed                                                   |
| Rust `codex_guardian::` scope                                                               | 16 tests passed                                                    |
| Rust `codex_multirouter::` scope                                                            | 173 tests passed                                                   |
| Rust `services::quota_collaboration::` scope                                                | 35 tests passed                                                    |
| Rust `settings::` scope                                                                     | 39 tests passed                                                    |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml`                                    | Passed                                                             |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`                          | Passed                                                             |
| `pnpm build:renderer`                                                                       | Passed, including the catalog and offline Responses contract gates |

The Rust scopes above use one test thread. The initial parallel proxy run exposed
an image-edits shared-port assertion failure that passed both in isolation and
in the complete serialized proxy scope. Initial concurrent frontend/verifier
runs also hit UI and native identity-query deadlines; the complete final frontend
run and all verifier tests passed away from the heavy compilation work. No test
timeout was increased, no guard was bypassed, and no failing assertion was removed.

The replay/content-length integration fixture originally called a header-only
`response.created` payload a valid scaffold. Its two fixture frames now contain
a proper response object/id/status; all original header and replay assertions
remain intact. The new malformed/mismatched-created regressions retain the strict
no-replay boundary.

Rust test compilation still reports two existing test-only warnings (an unused
fixture variant and an intentionally invalid UTF-8 literal); the required
production Clippy command passed with warnings denied. Renderer build output
retains the existing large-chunk advisory.

Passing these source checks is not installed-runtime or remote-pairing evidence.

## Post-restart verification follow-up

The current development executable was subsequently rebuilt and activated through the verified CCSwitch-only dev handoff. Six installed-renderer scenarios passed without source injection. See `H:\repos\ccswitchmulti-refork\docs\audits\2026-11-14-continuation-postrestart-verification.md` and its sanitized JSON receipts for the IPv4/IPv6 restart fix, retained failed-attempt evidence, and the still-unverified automatic native timer boundary.

## Owner remote design correction — November 15, 2026

The remote observations above are historical; no pairing/browser-control test was
added by this correction. The [owner remote access design](../guides/codex-owner-remote-access.md)
is the single current implementation contract. An enrolled owner tablet/laptop
must not need per-action human approval at an unattended host. Explicit owner
Continue is a deliberate new user turn, separate from automatic retry policy,
but must reuse the shared exact-thread executor, mutation evidence, and canonical
transaction coordination. Neither a new retry engine nor a generic remote admin
API is required. Existing native tool/sandbox approvals remain unchanged.
