# MiMo reasoning: provider control versus native picker fallback

Date: November 13, 2026 (Asia/Singapore).

## What the screenshot exposed

The screenshot shows the Codex composer labeling OpenRouter MiMo-V2.6-Pro as
Medium. The previous fix only stopped fabricating a missing effort during fresh
handoff; it did not implement a native Boolean control or prevent the native
composer from manufacturing its own Medium fallback. Passing projection-only
fixtures was not proof of the actual composer label or an operational toggle.

Read-only inspection of the installed OpenAI.Codex 26.1106.6628.0 renderer found
three native consumers that default empty effort lists to medium. In particular,
the native model/effort normalizer also turns an explicit none into medium when
its model descriptor has no selectable effort tokens. Deleting defaults alone
cannot preserve Off in this consumer.

## Provider evidence and own-app observations

Public primary sources independently retrieved over HTTP on November 13:

- `https://openrouter.ai/api/v1/models`
- `https://openrouter.ai/api/v1/models/xiaomi/mimo-v2.6-pro/endpoints`
- `https://openrouter.ai/api/v1/models/xiaomi/mimo-v2.6-flash/endpoints`
- `https://openrouter.ai/docs/guides/best-practices/reasoning-tokens`
- `https://mimo.mi.com/docs/en-US/api/chat/responses-post`

Both MiMo model records advertise optional reasoning, with no supported-effort
list or effort default. OpenRouter documents that an omitted supported-efforts
field is not equivalent to an explicit null/all-values field. Xiaomi documents
that none disables thinking, while the other accepted effort strings enable the
same thinking behavior rather than distinct intensities. Merely receiving HTTP
200 for an effort string would not prove it was honored as a distinct intensity.

Through the running CCSwitchMulti UI, OpenRouter -> Configure reasoning -> Detect
again succeeded for Pro at approximately 21:09 SGT and Flash at 21:16 SGT. Both
cards showed Boolean toggle, no native/selectable effort ladder, and the
reasoning.enabled wire behavior. The persisted row declaration remained an
input to the effective resolver (the card reported user config); refreshing the
metadata cache is not proof that a newer detection overrode a declaration.

No Included choice, default model, API key, transport selection, or manual
capability declaration was changed. No provider form Save was submitted. The
running source editor received the metadata-refresh/summary UI changes via HMR.

This action is metadata discovery, NOT inference-effort probing. The existing
Deep compatibility probe intentionally omits reasoning/effort request controls;
its results cannot prove distinct effort intensities. No authenticated inference
was submitted during this investigation.

## Fix boundary and single ownership

The shared Rust capability projector derives ccSwitchReasoningControl only from
a validated Boolean canonical capability, using its existing resolver fingerprint
and disableAllowed. All other controls remove a stale marker. Normal/vendor
catalogs, cache JSON, and inline TOML projections follow this same authority.
Canonical Boolean effort arrays remain empty and no effort default is invented.

Only the injected native renderer descriptor adapts Boolean controls into the
native enum transport vocabulary: none means Off; medium means On. This is not a
provider capability ladder and is not persisted into the provider declaration or
ModelInfo effort list. Graded, budget, unknown, excluded, and unrelated official
models do not acquire the adapter.

A connected-current-React-owner presentation bridge replaces the composer effort
label with Thinking on/off and a sibling switch. The current native callback is
the only selection writer. Actions revalidate current payload/row/provider,
capability marker, current React root, callback, DOM connection, inclusion,
disabled/saving state, and the complete renderer adapter. No independent
selection state, global None preference, or native bundle mutation is introduced.
Cleanup restores native style/accessibility on release, reinjection, or loss of
ownership. Observer-driven sync avoids waiting for the fallback heartbeat.

The collapsed provider summary now calls Boolean reasoning Thinking on/off
instead of Not declared or a fabricated medium effort default. Detect again is
available for supported automatic results and explicitly labeled metadata-only.

Picker readiness requires independent connected-control proof for the binary
adapter. Installing tokens alone does not certify UI readiness and cannot bypass
missing actual native values or any graded-model visibility gate.

## Verification and deployment limits

New tests were observed failing before the fixes: metadata refresh (4), collapsed
MiMo summary (2), native Boolean adapter (7), native control bridge (16 initial),
and readiness-without-control-proof (1). The Rust projection regressions also
failed before the marker generator was added. The existing real-provider-parser
matrix now checks the marker across catalog/cache/inline projections while
retaining all prior canonical effort/default assertions.

The configured readiness-only Desktop monitor still reports
`desktop_bridge_not_ready` / `desktop_request_client_unavailable`. No temporary
thread or existing-thread mutation was performed by that monitor. Its evidence
is in `.tmp/mimo-desktop-readiness-installed-20261113.json`.

Source and fixture-backed native-consumer tests are not an installed-Desktop
visual verification. The running native process embeds the older renderer
resources. Activating this change requires rebuilding that backend and
regenerating the managed catalog projection, not merely refreshing metadata or
reinjecting the old binary. No active proxy process was restarted blindly.
The current bridge addresses the composer trigger/switch; the separate native
advanced power-slider popup can still expose its generic enum alias labels.

## Final source checks

Completed against the final source changes:

- `pnpm typecheck`: passed.
- `pnpm build:renderer`: passed through the gated catalog/Responses checks. This is not a native Desktop executable rebuild.
- `pnpm test:unit`: 293 files, 3,465 tests passed.
- `pnpm catalog:verify`: 18 files, 680 tests passed, plus its reader/discovery guards.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::`: 172 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`: 5,325 passed, 10 ignored.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`: passed.
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml`: passed.
- `pnpm format:check`: passed.
- `git diff --check`: passed (existing line-ending warnings only).

The new native Boolean UI suite has 31 passing tests, including commit-driven
observer updates and idle-mutation/cleanup regressions. The binary adapter has
10 passing tests. Picker diagnostics have 14 passing tests, including mandatory
independent UI proof and preservation of native graded visibility restrictions.

Computer Use was stopped by the user with Escape during the final provider
summary re-check. All UI interaction stopped at that point; there was no attempt
to resume it. Neither a native Desktop binary rebuild/activation nor the new
native switch's installed-app visual verification was completed.
