# Stream capacity retry follow-up — October 19, 2026

## User-visible failure

Codex could show:

> stream disconnected before completion: Our servers are currently overloaded. Please try again later.

CC Switch already had bounded pre-semantic stream replay, but this message fell through its short transport backoff. The capacity classifier recognized the overload, while the long-wait classifier only recognized high-demand/concurrency wording. The request therefore used 200/400/800/1600/3200 ms reconnect delays, exhausted five attempts in seconds, and returned the terminal stream failure.

## Change

`src-tauri/src/proxy/providers/streaming_retry.rs` now treats `servers are currently overloaded` as an explicit long-wait capacity signal. When no upstream `Retry-After` is supplied, capacity replay waits:

| Replay |      Delay |
| -----: | ---------: |
|      1 |  5 minutes |
|      2 | 10 minutes |
|      3 | 20 minutes |
|      4 | 40 minutes |
|      5 | 80 minutes |

The total fallback wait budget is 155 minutes. An upstream `Retry-After` remains authoritative, bounded by the corresponding exponential tier and total budget. Ordinary transport interruptions retain the existing millisecond backoff. The five-attempt shared budget and the no-replay-after-semantic-output safety rule are unchanged.

During the wait, the stream emits SSE comment pings every 10 seconds after the initial scaffold. These are protocol comments, not assistant content, and keep downstream idle timers alive. If the connection reconnects, lifecycle scaffolding is still de-duplicated.

The same helper is used by:

- native Responses SSE;
- Chat Completions SSE;
- Anthropic upstream SSE;
- non-streaming Codex capacity responses handled by the forwarder.

## Required settings

There are two independent controls:

1. **Auto-resume model capacity errors** (Codex app proxy configuration) must be enabled. It defaults on for new Codex app rows, but older or manually edited rows may have it off.
2. **Stream retry mode** must be **Safe** or **Aggressive**. If it is Off, the forwarder intentionally does not create a stream reconnector, even when capacity retry is enabled.

Aggressive Desktop continuation is a separate mechanism. It can submit a new `continue` turn under its own safety/binding checks; it is not a way to replay a partially emitted stream.

## Regression coverage

- Exact `Our servers are currently overloaded. Please try again later.` Responses failure reconnects before semantic output.
- Exact wording is classified as long-wait capacity, while a bare `Please try again later` remains non-capacity without a server signal.
- Delay helper is pinned to 5/10/20/40/80 minutes.
- Native, Chat, Anthropic, and forwarder capacity tests pass.
- Retries after semantic output remain disabled.
- Retry-disabled settings remain non-replaying.

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml --lib proxy::providers::streaming_retry::tests:: -- --test-threads=1`: 58 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib capacity_ -- --test-threads=1`: 23 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=4 --quiet`: 4,863 passed; 10 existing ignored; 0 failed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::`: 153 passed.
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml`: passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`: passed.
- `pnpm typecheck`: passed.
- `pnpm format:check`: passed.
- Guarded focused UI test: 2 tests / 1 file passed.
- `git diff --check`: passed.

No live provider request or installed-app restart was performed. The Rust change takes effect after a native rebuild and restart. The first retry is intentionally delayed by five minutes; do not use this path for a request that already emitted text, reasoning deltas, or tool calls.
