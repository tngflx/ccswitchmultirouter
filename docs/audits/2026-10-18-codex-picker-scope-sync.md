# Codex Picker Scope Sync, 2026-10-18

## Evidence And Reproduction

The user's screenshot shows the Subly GPT-6.1 Sol effort slider with five
stops: Low, Medium, High, Extra High, Ultra. Max is missing. The local generated
catalog and cache both declare all six efforts for this route. The 15:59:01
installation log reports 36 models, 16 with Max, one reasoning query cache, and
runtime fingerprint

    sha256-e6d65913ecf838963285e7dd29ffc9944b5ef07af11a831243d3bca794f6b6b0

That fingerprint matched the source before this follow-up. The symptom cannot
be dismissed as an old embedded runtime for that installation.

Scope discovery returned immediately after its first declared dependency scope
and reused that scope forever. A shell cache preceding a separate picker cache
therefore left the picker outside the registered-query ownership guard. The
native effort-preference filter could retain Ultra while removing Max.

A regression using real TanStack Query clients reproduced exactly those five
stops before the fix. A second regression reproduced a picker scope mounted
after the initial shell scope being missed indefinitely. Both failed before
the discovery correction and pass afterward. The first also verifies that a
mounted reader receives a change notification with all six efforts, without a
refetch, and that an unsubscribed optimistic reader receives the same result.
The underlying raw provider response remains unchanged.

This proves the source defect and its isolated reproduction. It does not prove
that this was the only failure in the user's live renderer.

## Correction

- Collect every declared scope encountered by the existing bounded,
  descriptor-only renderer scan instead of stopping at its first scope.
- Refresh scope ownership every 30 seconds so navigation and late mounting do
  not permanently strand a picker on an undiscovered cache.
- Retain generation checks so superseded discovery cannot publish old scopes.
- Run the broader scope scan as a single guarded background job. A regression
  of the actual assembled runtime first reproduced installation and heartbeat
  being blocked by a paused scan, then passed after making it nonblocking.
- Keep exact registered-query membership, local-host/provider guards,
  authoritative empty catalogs, disabled-row exclusion, and reversible hooks.
  Do not change global effort preferences or invent model capabilities.

No provider credentials, catalogs, routing selections, or Codex installation
files were edited.

## Verification

- Typecheck, catalog reader guards, and 393 catalog tests passed.
- Frontend unit suite: 2,426 passed across 258 files.
- Focused picker/discovery suite: 45 passed.
- Full Rust library suite: 4,852 passed, zero failed, 10 existing ignored.
- Explicit MultiRouter scope: 153 passed.
- Prettier, Rust formatting, Clippy with warnings denied, and diff checks passed.
- Gated renderer production build passed.

The checks retain existing test-only Rust, Node/React, and bundler warnings.
No guard, assertion, timeout, or build gate was weakened.

## Native Deployment Boundary

The native command was:

    cargo build --manifest-path src-tauri/Cargo.toml --bin cc-switch

It linked the updated executable but failed to replace the running debug
executable: Windows returned Access is denied (os error 5) while removing
src-tauri/target/debug/cc-switch.exe. This command did not complete successfully.

The linked artifact at src-tauri/target/debug/deps/cc_switch.exe was verified to
contain both fixed JavaScript resource files byte-for-byte, and was copied to:

    output/picker-sync-fix-20261018/cc-switch.exe

This is a debug replacement executable, not a packaged installer. Its SHA-256 is:

    b9ca5e192bb82a6f97b13c1ea2983c4d687ffb9147347479d66aac4bead6f67e

The expected new renderer fingerprint is:

    sha256-7c7fb990b57d2dcdcd9c0826498426858c83799d7e3703689703275f062b9dd1

CCSwitch was not stopped or restarted. The running executable remains unchanged;
activation needs a controlled restart and replacement of that debug executable.
Restart permission was requested because it interrupts the active local proxy.
No configured live picker diagnostic monitor was available, and no UI automation
or direct live CDP audit was substituted. Visible-picker convergence remains
unverified until deployment and follow-up evidence.
