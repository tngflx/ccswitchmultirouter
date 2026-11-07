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
Modern scope cache lookup uses the initialized own `node.queryClient` slot;
React scope discovery does not require an obsolete semantic bundle to load.
Picker cache/prototype discovery never authorizes a continuation request client.
Semantic fallback imports are restricted to exact same-origin module-script URLs.
Preload links, resource timings, source dependency tables, and unused lazy-import
strings do not prove execution and cannot authorize another module import.
Initialized exported scopes can expose patchable caches but cannot join the
canonical current-owner set from a complete React scan. Root replacement, pending
DOM mutations, and incomplete/capped scans invalidate native ownership proof.

Current numeric Desktop also applies a native visibility preference after the
query selector. `native_reasoning_visibility.js` reads only the exact initialized
signal via a current same-cache scope and intrinsic Set checks. When the managed
canonical catalog declares `max`, it installs a narrowly scoped, renderer-local
wrapper around that same scope's `get(Q3tq.pN)` result and returns a cloned Set
with `max`; it does not call the native preference writer or persist a user
setting. The wrapper is owned by the current renderer/scope/atom tuple and is
restored on catalog release, renderer reinjection, scope replacement, or any
uncertain ownership state. Hidden canonical efforts report `mismatch`;
unavailable native visibility remains `unverified`. Numeric-import failure or
reinjection cannot silently make that proof optional. Historical patched caches
are retained for restoration, not mistaken for current owners. Ultra remains
behind Codex's separate includeUltra/Statsig gate and is intentionally not
forced by this compatibility layer.

The guardian reads a fresh compatibility observation on each poll. Runtime
installation/currentness and model-picker readiness are separate: a live
interval and matching resource/catalog fingerprints do not certify a successful
picker observer or visible Max/Ultra efforts. Pending/error/unverified picker
observations do not trigger reinjection of an otherwise current runtime, so
asynchronous client discovery can settle. The renderer's existing
`readCodexModelPickerDiagnostics` function remains the readiness authority.
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
