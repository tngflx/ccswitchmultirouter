# Codex `config.toml` Schema Troubleshooting

## Guardian v2 resume error

### Signature

Codex may refuse to load or resume a thread with:

```text
data did not match any variant of untagged enum FeatureToml in features.guardianv2
```

This is a schema-shape error, not an ordinary TOML syntax error. A common
offending value is a table/object:

```toml
[features]
guardianv2 = { enabled = true, review_scope = { computer_use_only = true } }
```

The Codex CLI used by the failing process may expect the feature to be a
boolean instead:

```toml
[features]
guardianv2 = false
```

Codex Desktop and the Codex CLI can write/read the same file with different
feature-schema expectations. Treat the exact Codex versions as relevant
evidence; do not assume that a value accepted by one build is accepted by
another.

### Fast diagnosis

Run these commands without editing the live file:

```powershell
codex --version
Select-String "$HOME\.codex\config.toml" -Pattern 'guardianv2|\[features'
Select-String "$HOME\.cc-switch\logs\cc-switch.log" `
  -Pattern 'FeatureToml|guardianv2|Live.*恢复|恢复.*Live|UncleanExit' `
  -CaseSensitive:$false
```

Then inspect the CCSwitch backup source. A sequence like this is the key
correlation:

```text
UncleanExit
detected abnormal exit / takeover residue
codex Live config restored from backup
```

If those lines repeat around the failure, CCSwitch is replaying a stored
snapshot. Search the database/live-backup records for `guardianv2` and inspect
the raw `config` string before changing recovery logic.

### Ownership decision

- **Codex-side trigger:** a Codex Desktop/CLI version change or component
  mismatch emits or expects a different `features.guardianv2` shape. The
  repository history contains prior Guardian compatibility fixes for this
  versioned schema.
- **CCSwitch-side recurrence:** takeover recovery, snapshot restore, MCP
  synchronization, or provider switching replays the incompatible snapshot or
  bypasses the shared Codex writer. This makes the failure intermittent,
  especially during repeated unclean restarts or proxy-port recovery.

Do not blame only the parser and do not immediately delete `config.toml`.
First establish whether the bad value came from Codex itself or from a
CCSwitch restore/write boundary.

### Required fix boundary

Every CCSwitch mutation of Codex `config.toml` must go through:

```text
codex_config::write_codex_live_config_atomic
```

That boundary validates TOML, serializes writes under the Codex live-write
lock, and normalizes non-boolean `features.guardianv2` values to `false`.
Raw `write_text_file` calls for the live Codex config are a regression risk.
Add a regression test for each newly discovered write or restore path.

### Verification checklist

1. Confirm the current config parses and `features.guardianv2` is a scalar
   boolean (or absent).
2. Confirm the backup/recovery path writes through the central Codex writer.
3. Run the focused Guardian, recovery, MCP, and snapshot tests.
4. Run `cargo check --manifest-path src-tauri/Cargo.toml`.
5. Record exact full-suite failures separately when the shared development
   process locks `src-tauri\target` or concurrent work changes unrelated files.

