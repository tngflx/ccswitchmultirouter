# Codex Desktop Runtime

These files are executable JavaScript fragments assembled by `codex_desktop.rs`
and injected into the local Codex renderer. They are not ES modules: fragments
share the runtime's lexical scope, including `state`, `recordFailure`, and other
compatibility helpers. Keep their assembly order in Rust unchanged unless the
corresponding behavior tests cover the new order.

`renderer_runtime.js` owns installation, scheduling, app-server discovery, and
history integration. Its `/*__CCSWITCH_*__*/` comments mark fragment insertion
points. The remaining `__CCSWITCH_*__` identifiers are literal-value slots;
`request_health_warning.js` and `summary_handoff.js` each have one value slot.
Every file remains syntactically valid JavaScript before assembly.

Rust resolves executable fragments and fixed constants first. It inserts the
JSON-serialized provider catalog last, so arbitrary model metadata cannot be
rescanned as template instructions. The manual summary prompt is also
JSON-serialized before insertion.

QuickJS tests in `codex_desktop.rs` check each fragment, the assembled runtime,
template resolution, and literal metadata preservation. Reasoning projection
tests also execute the picker resources with real TanStack Query observers.
The renderer runtime identity is a SHA-256 fingerprint of the assembled
resources. Rebuilt integrations automatically invalidate prior closures and
rebind their hooks; no manual scheduler-version bump is required.

Discovery supports both the older semantic Vite chunks and current numeric
Rspack ESM entries. `webpack_discovery.js` inspects only initialized module-cache
exports reached through an exact already-loaded same-origin entry URL; it never
invokes module factories, export getters or application constructors. Recursive
export discovery is bounded and does not walk browser/global/host internals.
Modern scope cache lookup accepts an initialized own data `node.queryClient` slot.
Current numeric Codex also reuses retained nodes with one exact forwarding triple:
own configurable/enumerable accessors for `parent`, `queryClient`, and `value`,
with no setters and intrinsic sources `()=>n.parent`, `()=>n.queryClient`, and
`()=>n.value` (whitespace-insensitive). Only after that complete descriptor proof
does the reader invoke the pure `queryClient` forwarder; arbitrary or partial
accessors remain unknown owners and keep native visibility unverified. React scope
discovery does not require an obsolete semantic bundle to load.
Picker cache/prototype discovery never authorizes a continuation request client.
Semantic fallback imports are restricted to exact same-origin module-script URLs.
Preload links, resource timings, source dependency tables, and unused lazy-import
strings do not prove execution and cannot authorize another module import.
Initialized exported scopes can expose patchable caches but cannot join the
canonical current-owner set from a complete React scan. A single in-flight,
time-sliced inventory is bound to an exact committed Fiber snapshot and a DOM
mutation generation. Root/Fiber changes during a yield, removal-only mutations,
and incomplete/capped scans invalidate native ownership proof. A stable FiberRoot
or its alternate is not by itself proof that the scanned scopes are still current.
React element debug-owner links are not mounted ownership paths; ordinary unknown
application fields remain part of the fail-closed inventory. Bounded scan telemetry
reports scanning, complete, capped, invalidated, or unavailable-root outcomes.

Current numeric Desktop also applies a native visibility preference after the
query selector. `native_reasoning_visibility.js` reads only the exact initialized
signal via a current same-cache scope and intrinsic Set checks. When the managed
canonical catalog declares native graded efforts, it installs a narrowly scoped,
renderer-local wrapper around that same scope's `get(Q3tq.pN)` result and returns
a cloned Set containing only the declared native tiers (including literal `max`);
it does not call the native preference writer or persist a user setting. The
wrapper is owned by the current renderer/scope/atom tuple and is restored on
catalog release, renderer reinjection, scope replacement, or any uncertain
ownership state. After the native read boundary is known, a bounded
renderer-local Fiber projection repairs the mounted picker props themselves so a
cached native picker cannot keep filtering a declared tier; it only adds missing
per-model rows, preserves the native callback, and restores the exact original
props on release or uncertainty. A single bounded quarter-second sync keeps that projection
aligned with ordinary React commits without fetching or scanning outside mounted
picker buttons. Hidden canonical efforts report `mismatch`; unavailable native
visibility remains `unverified`. Numeric-import failure or reinjection cannot
silently make that proof optional. Historical patched caches are retained for
restoration, not mistaken for current owners. Ultra remains behind Codex's
separate includeUltra/Statsig gate and is intentionally not forced by this
compatibility layer.

The guardian reads a fresh compatibility observation on each poll. Runtime
installation/currentness and model-picker readiness are separate: a live
interval and matching resource/catalog fingerprints do not certify a successful
picker observer or visible Max/Ultra efforts. Pending/error/unverified picker
observations do not trigger reinjection of an otherwise current runtime, so
asynchronous client discovery can settle. Numeric picker discovery retries
uninitialized native bindings every five seconds independently of continuation
client backoff; known bindings use the regular thirty-second inventory refresh.
Previously imported exact entry namespaces are re-inspected synchronously, so a
routine cache scan does not temporarily erase valid native proof at an import
await boundary. Changed current React roots still invalidate ownership immediately;
the renderer re-proves that ownership on a bounded five-second retry instead of
waiting on unrelated request-client discovery. Current snapshots do not trigger
another tree scan, and incomplete ownership remains unverified. The renderer's
existing `readCodexModelPickerDiagnostics` function remains the readiness authority.
A successful managed-local picker observer can prove readiness through its
query cache without an app-server request-client hook. `appServerReady` remains
independent telemetry: cache discovery never authorizes continuation clients,
creates a request hook, or certifies another host/provider's picker.

A valid, explicitly empty catalog clears managed selections and has no included
models to verify (`not_required` if no successful picker observation exists).
An unavailable catalog cannot certify readiness; its last usable same-provider
payload is preserved by `selectCatalogPayload`. Neither no targets nor missing
readiness fields from an older native process are interpreted as Ready.

Continuation authorization also requires a live source for each request client.
Scoped registry lookups, exact module export/signal bindings, and connected React
root-to-client descriptor paths are revalidated at the mutation boundary. A hook
retained on an old client is restoration state, not permission to use it. The
commit re-reads the exact thread, then repeats runtime generation, user-action,
source ownership, and hook identity checks after the final await. Unknown or
conflicting model bindings fail closed; no picker defaults are substituted.

The read-only `--inspect-picker` monitor accepts the same bounded public-model
identity grammar as renderer observations, including leading `~` aliases, while
rejecting URL/credential-shaped identities. Boolean `none`/`medium` adapter
tokens are not graded provider levels: hidden aliases alone are not a graded
effort mismatch, but strict token equality and independent mounted Boolean-control
proof remain mandatory. Boolean readiness counters count canonical models once,
not once per query observer, and an uncertain proof always dominates a positive one.
The monitor may report a bounded whitelist of mounted native effort labels and
their opacity state without clicking, typing, changing selection, or returning
arbitrary DOM text. Presence of a label is not menu usability or provider proof;
`renderedMenuVerified` remains false in these receipts.

`owner_remote_view.js` is the local owner-view resource, loaded after the shared
continuation core. It reads count-bounded metadata/turn/item pages from an exact
owned local client and projects a recent, allowlisted selected conversation.
Unsupported or ignored page options fail closed instead of loading complete
history. Saved command output is deferred; native response/projection caps do not
prove arbitrary source messages were byte-bounded before renderer receipt.

Owner Continue uses explicit intent through the same renderer prepare/commit
path, coordinated with the existing native recovery ledger. The native owner
adapter pins the viewed endpoint/target/process/config epoch and rechecks the
owner session at commit. Authentication, the opt-in loopback HTTP service and the
responsive browser UI live outside this renderer resource. No per-action human
approval is required at the unattended host after enrollment.

This is not a verified mirror of the host's current window: `currentDisplay`
remains unavailable, and installed in-progress output fidelity and real
HTTPS/tablet/laptop behavior still require runtime evidence. The single setup,
security, state-ownership and verification contract is in
[`docs/guides/codex-owner-remote-access.md`](../../../../docs/guides/codex-owner-remote-access.md).
