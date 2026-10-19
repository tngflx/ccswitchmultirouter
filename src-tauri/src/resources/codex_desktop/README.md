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
