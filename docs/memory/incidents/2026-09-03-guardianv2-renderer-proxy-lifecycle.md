# Guardian V2 Renderer and Proxy Lifecycle Incident

## What Happened

Codex Desktop intermittently rejected new or resumed threads with:

```text
data did not match any variant of untagged enum FeatureToml in features.guardianv2
```

At the same time, the local proxy appeared to detach during repeated CCSwitchMulti
development restarts.

## Evidence

- On September 3, 2026, the live `~/.codex/config.toml` contained the valid scalar
  `guardianv2 = false`.
- The Desktop-bundled `codex.exe` was version `0.152.1`; `features list` parsed the
  same file and reported Guardian V2 disabled.
- The current renderer template wrapped every Statsig `getDynamicConfig` result with
  the model-whitelist mutation. It did not restrict the mutation to model config
  `107580212`.
- BigStrongSun commit `0aa10552` documents and fixes the same producer: model fields
  were added to Guardian dynamic config `2553103476`, and that request-local object
  was rejected by app-server even when disk TOML was valid.
- CCSwitch logs show repeated unclean process replacement. At `07:53:06`, a new
  process restored Live config and then failed all proxy bind retries because the
  previous process still owned `127.0.0.1:15721`. A later process acquired the port
  at `07:59:17`.
- Startup launched Codex Desktop before database initialization and proxy takeover
  recovery, preserving the stale-runtime race described by BigStrongSun commit
  `07f4cfa7`.

## Root Cause

The Guardian failure was produced in the renderer request path, not by the stable
on-disk TOML. The compatibility wrapper applied model-only fields to unrelated
Statsig feature configs, including Guardian V2. Disk normalization could repair a
different failure class but could not stop the renderer from recreating the invalid
request-local object.

Proxy process churn was a separate lifecycle amplifier. During overlapping or
unclean development restarts, the fixed listener could remain owned by the previous
process while the replacement process restored and rebuilt takeover state.

## What We Did

- Scoped model-whitelist mutation to Statsig config `107580212`.
- Removed only the legacy model fields from Guardian config `2553103476`.
- Added a single exact-error fallback that converts only a rejected request-local
  Guardian object to its boolean `enabled` value.
- Bumped the renderer request-wrapper version so an open renderer replaces the old
  wrapper on reinjection.
- Moved automatic Codex Desktop launch after proxy recovery and required successful
  takeover recovery plus Guardian compatibility enforcement before launch.

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml --lib guardian_v2 -- --nocapture`:
  7 passed, 0 failed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_desktop::tests -- --nocapture`:
  40 passed, 0 failed.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- Scoped `git diff --check`: passed.
- Live verification of the new renderer wrapper was not performed because the
  running `cc-switch.exe` predates the source change and owns the normal target.

## What Not To Do Again

- Do not diagnose this signature from `config.toml` alone; inspect request-local
  renderer feature overrides.
- Do not apply model-whitelist fields to every Statsig dynamic config.
- Do not launch Codex Desktop before takeover and managed Live config are ready.
- Do not kill the active CCSwitchMulti or Codex process to force verification.

