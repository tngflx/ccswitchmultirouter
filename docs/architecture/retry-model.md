# CCSwitchMulti Retry Architecture

This document is the source of truth for request retry and turn recovery in the
Codex proxy path. The main-page control is named **Retry** and selects one of
three policies: Off, Safe, or Aggressive.

## Three Recovery Layers

| Layer | Owner | Scope | Budget |
|---|---|---|---|
| Proxy stream reconnect | CCSwitchMulti proxy | Replays the same upstream request only before semantic output reaches Codex | 5 reconnects in Safe and Aggressive; 0 in Off |
| Native stream retry | Codex client | Client-owned retry after a visible stream failure | Managed `stream_max_retries = 5`; independent of the main-page control |
| Desktop turn continuation | CCSwitchMulti + Codex Desktop | Starts a new conversation turn containing literal `continue` after a recoverable failed or truncated streamed turn | 1-3 submissions in Aggressive; 0 in Safe and Off |

The layers are complementary. Proxy reconnect covers the cheap replay window.
Codex native retry remains available for failures it recognizes. Aggressive
recovery adds a bounded conversation-level fallback when a streamed Codex
Desktop turn still terminates unsuccessfully.

## Main-Page Modes

| Mode | Proxy reconnect | Desktop continuation |
|---|---|---|
| **Off** | Disabled | Disabled |
| **Safe** (default) | Up to 5 pre-semantic reconnects | Disabled |
| **Aggressive** | Same 5 pre-semantic reconnects | Submit literal `continue` after an eligible failed/truncated turn, up to the selected 1-3 attempt limit |

`Off` does not rewrite or disable Codex's managed `stream_max_retries`. It only
turns off the two CCSwitchMulti-owned layers.

Settings are stored as:

```text
streamRetryMode: off | safe | aggressive
streamRetryMaxAttempts: 1 | 2 | 3
```

`enableStreamRetry` is retained for compatibility with older settings files.
The current UI writes it consistently with the selected tier.

## Proxy Reconnect Boundary

The reconnect implementation is in
`src-tauri/src/proxy/providers/streaming_retry.rs`. A reconnect may replay the
same HTTP request while the downstream stream has emitted only non-semantic
scaffolding such as `response.created`.

Once reasoning, text, refusal, or tool-call semantics have reached Codex, the
proxy must not replay that request:

1. Forwarded bytes cannot be withdrawn from the client.
2. A tool call may already have caused a side effect.
3. A replay can duplicate output and billing.
4. Only Codex owns the conversation and rollout state needed to start another
   logical turn safely.

Aggressive mode does not weaken this rule. It starts a new visible Codex turn;
it never replays a post-semantic HTTP stream inside the proxy.

## Aggressive Desktop Recovery

The final Responses SSE stream seen by Codex Desktop is observed in
`src-tauri/src/proxy/codex_turn_recovery.rs`, after the proxy has constructed
the client-facing Responses event stream. This covers native Responses
passthrough, Chat-to-Responses conversion (including hosted-tool streams),
OpenAI Messages conversion, Anthropic-to-Responses conversion, and streams
whose namespaced tool calls were restored for Codex. Responses compaction is
intentionally excluded: it is not a normal assistant turn and must never cause
the Desktop composer to receive `continue`.

Recovery is scheduled for a streamed turn that:

- ends without a terminal event;
- ends with a downstream stream error;
- emits a recoverable `response.failed`;
- emits a recoverable `response.incomplete`; or
- emits a recoverable malformed/protocol-error terminal.

The recovery coordinator then uses CDP integration in
`src-tauri/src/codex_desktop.rs` to enter and submit exactly `continue`. It waits
for the Desktop composer to become ready and records `scheduled`, `submitted`,
`not_scheduled`, or `submit_failed` events in the Codex router log.

### Eligibility Boundary

Aggressive continuation requires both:

- a request already classified as the verified local Codex path; and
- an explicit Desktop identity: `Codex Desktop`,
  `codex_chatgpt_desktop`, or a versioned form of either identity.

Generic Codex, Codex CLI, VS Code, and authenticated external OpenAI API
requests are not eligible. A spoofed Desktop header cannot override the
external API boundary.

### Suppression Rules

No continuation is submitted after:

- a valid client tool call;
- cancellation or abort;
- authentication, invalid-key, permission, unauthorized, or forbidden errors;
- invalid requests;
- unsupported or missing models;
- context-window/length exhaustion;
- content-filter or policy failures; or
- a valid completed turn.

Transient upstream failures such as server errors and exhausted rate limits
remain eligible after the lower retry layers have finished.

### Attempt Accounting

A genuine new user turn clears prior recovery state. The exact injected final
user message `continue` preserves the current state and consumes one reserved
attempt. Completion clears the state. The coordinator stops scheduling after
the selected 1-3 successful submissions.

Failed CDP submission does not consume the continuation budget, but the
coordinator's composer-readiness loop is itself bounded.

## Failure Matrix

| Failure | Proxy reconnect | Native Codex retry | Aggressive continuation |
|---|---|---|---|
| Drop before semantic output | Safe/Aggressive, up to 5 | Usually not needed | Only if lower layers still surface a failed/truncated final stream |
| Drop after semantic output | Never proxy-replayed | Client-owned | Eligible for verified Desktop when no tool call or permanent failure exists |
| Recoverable explicit SSE failure/incomplete | Forwarded | Client-owned | Eligible for verified Desktop |
| Valid completed text/refusal | Not needed | Not needed | Never |
| Valid completed client tool call | Not needed | Tool loop continues | Never |
| Cancellation/auth/request/model/context/policy failure | Not replayed | Client-owned behavior | Never |
| HTTP failure before the SSE stream exists | Forwarder/failover policy | Client-owned behavior | Not observed by the final SSE continuation layer |

The last row is intentional: Aggressive recovery observes final streamed
Responses turns. Admission rejection, request replay, provider failover, and
pre-stream HTTP failures remain responsibilities of the forwarder and traffic
policy layers.

## Related Components

- `src/components/proxy/StreamRetryToggle.tsx`: compact main-page selector.
- `src-tauri/src/settings.rs`: mode defaults, compatibility, and bounded budgets.
- `src-tauri/src/proxy/forwarder.rs`: creates the pre-semantic reconnector.
- `src-tauri/src/proxy/providers/streaming_retry.rs`: replay safety boundary.
- `src-tauri/src/proxy/handlers.rs`: client eligibility and final stream wiring.
- `src-tauri/src/proxy/codex_turn_recovery.rs`: turn state and terminal observer.
- `src-tauri/src/codex_desktop.rs`: CDP composer submission.
- `src-tauri/src/codex_config.rs`: independently managed native Codex retry budget.
