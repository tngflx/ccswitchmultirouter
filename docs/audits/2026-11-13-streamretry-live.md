# StreamRetry and Codex Desktop continuation audit

The live Codex Desktop accepted a literal `continue`, sent it to the local
upstream fixture, and completed the new turn. Each successful scenario produced
one initial request and exactly one continuation. The verifier archived its own
test thread. CCSwitchMulti and Codex were not stopped, rebuilt, or restarted by
this audit.

## Live evidence

All 17 receipts are preserved in [one consolidated JSON audit](2026-11-13-streamretry-live.json).
Its `latestSuccessfulRuns` maps each scenario to the corresponding record in
`runs`; earlier attempts remain in chronological order in the same file.

| Error exercised through the real Desktop             | Successful record |
| ---------------------------------------------------- | ----------------- |
| SSE server overload                                  | `run-12`          |
| Stream account concurrency limit reached             | `run-13`          |
| Temporary usage limit with an explicit retry message | `run-17`          |
| SSE connection closes before completion              | `run-15`          |

The tests use the installed Desktop page and its actual local app-server client.
The upstream is a controlled loopback HTTP fixture. Per-thread endpoint and retry
settings isolate the test without switching the Desktop's global provider.
The production renderer performs preparation, exact-thread/model/failed-turn
validation, the final reread, and the exactly-once submission marker.
The final connection-drop and usage-limit receipts both identify source
fingerprint `sha256-5c2010b14da9fafeb408f93b29929d54ecebb31a7a756109e40dfb23914abe49`.

The test deliberately sets the fixture thread's native retry counts to zero so
one failed request reaches the continuation guard. An earlier live run inherited
Codex's retry setting and received six upstream requests before the failed turn;
that result is preserved as `run-11` in the consolidated JSON audit.

Full compatibility injection can refresh existing model/history caches. The
verifier's direct fixture operations and submitted prompts are restricted to
its owned test thread. Older receipts' `existingThreadsTouched: false` field
describes that fixture scope; current receipts distinguish prompt submission
from compatibility-cache refreshes explicitly.

## Fixes

Current numeric Codex bundles no longer expose the legacy request-client
registry. A retained account-service `RpcPromise` also has a generic request
method, but rejects thread operations. Discovery now identifies the canonical
initialized app-server status atom and its matching manager token without
executing module factories. It accepts only the current `ready`, `local`
manager client.

The host provider's `forHost("local")` and canonical RPC route share one guarded
facade. Current scope, node, status, client, provider and hook identities are
checked again before continuation. High-level user start, retry, interrupt,
edit and archive calls update the activity guard. Non-extensible owners and
rejected hook assignments fail without leaving stacked proxies. Startup locates
the canonical mounted scope before the full picker/Fiber inventory.

Temporary usage-limit classification now comes from the shared terminal-error
policy consumed by Rust and the renderer. Explicit retry/reset/wait wording can
be recoverable; hard quota/billing/credit limits, authentication, permission,
cancellation and explicit instructions not to retry remain terminal. Capacity
retry settings continue to gate safe request replays.

## Validation and runtime boundary

The required type, catalog, formatting and diff checks passed. The full frontend
unit run passed 3,220 tests in 287 files. Focused final discovery/ownership tests
passed 89 tests, and renderer continuation tests passed 122 tests. The verifier's
16 Node tests passed. Rust scopes passed terminal classification (6), stream
retry (81), turn recovery (51), Desktop injection (136), and the multirouter
contract (167). Rust formatting and Clippy passed.

The successful Desktop tests explicitly hot-inject the assembled production
renderer resources. Their receipts record the exact source fingerprint. The
currently running CCSwitchMulti binary still embeds its earlier renderer and
native recovery policy; its guardian restored that embedded renderer after the
tests. The final read found zero verifier leases, and all owned fixture threads
and temporary working directories were cleaned up.
Consequently these tests prove real Desktop preparation/submission/completion,
while automatic native scheduling and its five-minute-and-longer backoff remain
a separate installed-binary boundary. No production backoff was shortened and
no native scheduling timer was claimed as live-verified by the direct verifier.

## Remote desktop status

Running CCSwitchMulti on two desktops does not currently connect their Codex
chats. Thread/history commands are local Tauri IPC, and the HTTP proxy exposes
inference routes rather than remote thread control. The minimal existing remote
arrangement is authenticated SSH or remote desktop into the target computer and
running its local monitor there. This audit did not add a network thread-control
service or expose CDP beyond loopback.
