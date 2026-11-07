# Max missing after Codex update — November 4, 2026

## Historical evidence cleanup — November 8, 2026

The `.tmp/` paths below are historical scratch locations removed during the
user-authorized cleanup on November 8, 2026. Structured findings and verification
conclusions remain in this audit; those paths are no longer retained artifacts.
This cleanup provides no new live-runtime or UI verification, and the audit's
existing live-verification limitations remain unchanged.

## Conclusion

The currently installed CLI binaries do **not** discard Max when parsing the
managed catalog or serializing `model/list`. The diagnosed compatibility
gap was in the **Desktop renderer adapter**, not a demonstrated CLI JSON schema
mismatch: the installed Desktop uses numeric Rspack ESM chunks and changed registry
APIs, while the previous CC Switch adapter depended on semantic Vite chunks and
the old registry.
The native picker additionally applies reasoning-effort visibility preferences;
its installed default preference sets do not contain Max.

These facts explain how a catalog can advertise Max while the visible picker
omits it. Current live preference values and successful live hook binding remain
unverified because the configured background monitor cannot reach a Desktop
debug port. No claim of a live fix is made.

## Exact installed versions checked

- Terminal/global npm CLI: **0.166.0**; `npm.cmd list -g @openai/codex --depth=0`
  confirms the installation. `npm.cmd view @openai/codex version --json` returned
  **0.166.0** at the time of this check.
- App-owned/running app-server binary: **0.166.0-alpha.6**, at
  `C:/Users/Felix/AppData/Local/OpenAI/Codex/bin/a159911ff70742e9/codex.exe`.
  Targeted process inspection confirms the active app-server uses that path.
- Installed app package: **OpenAI.Codex 26.1029.7803.0**.
- Internal app package version: **26.1029.61003**, matching the runtime hint in
  the effective config. These are separate package/application version fields;
  their difference alone is not evidence of a schema failure.

Neither CLI was upgraded or downgraded by this investigation.

## Native parser and schema evidence

Generated app-server JSON schemas from both exact installations:

- **321 files each**, identical filenames.
- **Zero structural JSON differences**.
- `ReasoningEffort` is a nonempty string, not a closed enum that excludes Max.
- Both bundled catalogs are identical: 12 models, including native Max/Ultra
  declarations. Bundled instruction text was not used as task instructions.

Schema equality alone does not validate an external model catalog. Therefore a
second, stronger test launched each native binary in isolated temporary
`CODEX_HOME`, `HOME`, and `USERPROFILE`, with a sanitized model-catalog fixture,
loopback-only dead provider/proxy addresses and analytics disabled. Only
`initialize`, `initialized`, and `model/list` were issued: no inference request,
paid probe, live config/auth/history, or existing chat was used.

All **six** runs succeeded (two binaries, experimental API true/false, plus
Desktop client-name controls). Each returned:

- **33 models**.
- **15 models retaining Max**.
- **8 models retaining Ultra**.
- First Sol alias: `low, medium, high, xhigh, max, ultra`.
- No catalog/config/model-list parsing errors.

The configured generated catalog independently contains those same 33/15/8
counts. Max is present through the native parser and RPC boundary.

## Actual installed renderer behavior

Scoped static inspection read only the target app's packed JavaScript in:

`C:/Program Files/WindowsApps/OpenAI.Codex_26.1029.7803.0_x64__2p2nqsd0c76g0/app/resources/app.asar`.

### Effort visibility is separate from capability

Installed selector module `Xvtr` in
`webview/assets/async/24191.589dcc9878.js` filters advertised efforts through its
recognized-effort utility, `enabledReasoningEfforts`, and a separate Ultra flag.

The signed-in account source is `reasoningEffortVisibility.enabled`, backed by
`model_picker_reasoning_effort_visibility`. When absent, the installed fallback
is **low, medium, high, xhigh**. The non-account local preference key is
`enabled-reasoning-efforts`; its default also omits Max. Ultra has an additional
feature gate. This is installed-source evidence, **not** proof of the user's
current in-memory or account preference values. Matching visibility keys were
not found in the exact known legacy `.codex-global-state.json`; that absence
cannot establish the active account preference.

An offline replay executed the unchanged installed selector **and** its actual
recognized-effort utility with synthetic inputs:

| Inputs                                             | Result                                   |
| -------------------------------------------------- | ---------------------------------------- |
| All catalog efforts, enabled set low through xhigh | Max and Ultra removed from displayed row |
| All enabled, Ultra included                        | All six retained                         |
| All enabled, Ultra excluded                        | Max retained; Ultra removed              |

The first result can still advertise the aggregate Max capability flag while
omitting Max from row options. Capability and visibility are therefore not the
same contract.

### The final menu filters a second time

Static tracing of current consumer `cyhU` in numeric chunk `104066` found a
second filter **after** the restored query selection: `uR(models, model)` is
filtered through the global account/local visibility Set (`Q3tq.pN`). The
secondary `dig0` model-selection handler repeats that filter. Three inert replay
cases prove that selected rows can contain all six efforts while the final menu
still hides Max/Ultra. The current user's live Set remains unknown.

Therefore query projection alone is insufficient to certify visible efforts.
The implementation now reads the exact initialized own-data signal token
through a validated **current same-cache** native dependency scope. It uses the
intrinsic Set brand/has operations rather than arbitrary methods/getters. This
is a read-only observation, not a preference write, derived-atom replacement,
account feature-gate bypass, global Set/filter patch or remote-host override.

A hidden canonical effort reports `mismatch` with missing Max/Ultra counts.
Unknown signal/ownership/import failure reports `unverified`. Updating the native
visibility Set is reflected by a fresh diagnostic without reinjection. A native
preference that intentionally excludes an effort remains respected: the adapter
does **not** silently enable it, and we do not claim to have made it visible.

### The pre-fix discovery adapter was stale for this bundle

The pre-fix `src-tauri/src/resources/codex_desktop/renderer_runtime.js` imported semantic
chunk names including `app-shared-`, `app-server-manager-hooks-`,
`app-server-manager-signals-`, and `app-initial-`, following relative Vite imports.
The installed package instead has numeric Webpack assets; those semantic names
are absent from the inspected webview JavaScript. Its expected `getForHostId`
registry API is absent too, while
`src-tauri/src/resources/codex_desktop/client_discovery.js` requires it.

The existing `restoreCodexCatalogReasoningSelection` projection does restore Max
and Ultra **when applied** to the synthetic managed local query. The same replay
leaves an unrelated remote-host selection unchanged. This does not prove that
current discovery can bind that projection to the updated running app.

Fresh focused source tests passed **60/60** (real query-cache projection and
picker diagnostics). Those tests establish behavior after binding, not
compatibility with the updated app's bundle/module discovery.

## Before/after logs and current monitor limitation

Only structured picker-install summaries from the configured CC Switch log were
compared, with exact Singapore dates/times:

- **November 4, 09:48:47**: 1 reasoning query cache, 2 picker observers, 15 Max
  and 8 Ultra models observed after selection. Its historical status was Ready;
  this is not reused as current acceptance.
- **November 4, 18:12:50**: payload still 15 Max/8 Ultra, but 0 query caches,
  0 observers, app-server client not discovered, status Pending.

The repository's readiness-only background monitor was run on the configured
candidate ports **9229, 9222, 9223, 9230, 9231**, without its disposable-test flag.
All returned `desktop_debug_port_unavailable`. No test thread was created and no
existing thread was touched. We cannot identify the current live visibility set
or verify a renderer repair until an intentionally debug-enabled Desktop session
is available. The app was not restarted or silently relaunched.

## Implemented source correction

The renderer now supports both semantic Vite discovery and the installed numeric
Rspack ESM contract. The new `webpack_discovery.js` resource:

- Accepts only exact same-origin, already-loaded top-level numeric ESM entries.
- Inspects the explicitly exported runtime's initialized `.c` cache; never calls
  require, module factories, export getters, application constructors or account
  preference setters.
- Uses bounded descriptor-only discovery, keeps browser/host/global objects out
  of recursive export-record traversal, and separates picker caches from request
  client/continuation authorization.
- Finds current initialized `node.queryClient` state without invoking the modern
  scope's getter or falling back to stale ownership when the node slot is empty.

React scope/cache discovery also runs independently of semantic chunk imports,
so missing old bundle names no longer prevent binding the existing canonical
catalog projection. The resource is part of the exact assembled runtime's
content fingerprint, invalidating stale closures after a rebuilt integration
is applied. Older Vite/legacy-scope compatibility remains covered.

Readiness uses a fresh successful managed-local picker observer, exact canonical
effort/flag equality and current runtime/catalog identity. It does not fabricate
an app-server request hook when a cache alone is bound. Request authorization
remains separately validated and unavailable/error/stale/unknown observations
cannot become Ready. No account visibility preference or blanket feature gate
was changed.

Executed RED → GREEN regressions cover the numeric-cache path, the actual modern
scope backing field, canonical empty/unavailable behavior, remote-host/provider
isolation, bounded getter/factory-free discovery, cache-only readiness, final native visibility/unknown-state guards and Rust
resource assembly. Final gate results were recorded in
`.tmp/continuation-20261104-modern-adapter/final-verification.sanitized.json`:
TypeScript, catalog guard, 279-file/2,853-test frontend suite, 5,147-test Rust
library suite, 165 multirouter tests, 129 Desktop tests, strict Clippy, Rust
formatting, Prettier, diff check, gated renderer build and a full isolated `pnpm
build` all passed. The full build exported to
`output/production-modern-20261104-2125` (including an NSIS installer) without
installing or launching it. The
focused Desktop regression set is 7 files/153 tests. This fixes the diagnosed source adapter,
not an uninspected installed process.

## Screenshot/UI clarification

The attached screenshot is the CC Switch **Codex model ordering** page, not the
native Desktop effort menu. Its `ModelOrderTab` is not hard-coded to stop at
`max`: the canonical resolver returns `codexSelectableEfforts`, and only
Sub-Agent v1 intentionally removes `ultra`. Existing `CodexRouterWorkspacePage`
tests cover a v2 capability containing `high`, `max`, and `ultra` and assert that
Ultra is rendered, saved and reloaded; the v1 case asserts that Ultra is omitted.
A max-only screenshot therefore means the selected model/provider capability
resolution did not include Ultra (or its v2 Ultra capability is disabled), not
that this UI has a stale max ceiling. I did not force Ultra into a model that
has not declared it.

## Remaining live acceptance boundary

A rebuilt native CC Switch integration must be installed/launched and applied to
an intentionally debug-enabled Desktop session before visible Max/Ultra can be
certified live. If the native visibility preference excludes the desired effort,
it must be explicitly enabled in Desktop; this repair preserves that account
choice instead of changing it globally. The configured monitor could not reach a debug port during this
investigation. Source tests and a build are not proof of a live picker repair;
no existing chat, app process, account preference, credential or CLI installation
has been mutated by this work.

## Evidence and change boundary

The earlier source fixes and narrowly adapted BigStrongSun protocol/auth fix
remain in place. The added adapter/readiness work extends those changes; it does
not repoint remotes, switch branches, or overwrite unrelated dirty files.

Historical sanitized evidence locations:

- `.tmp/continuation-20261104-codex-cli-max-audit-2/installed-cli-schema-summary.sanitized.json`
- `.tmp/continuation-20261104-codex-cli-max-audit-2/catalog-efforts.sanitized.json`
- `.tmp/continuation-20261104-codex-cli-max-audit-2/log-picker-summary.sanitized.json`
- `.tmp/continuation-20261104-codex-cli-max-audit-2/desktop-effort-preference-sources.sanitized.json`
- `.tmp/continuation-20261104-codex-cli-max-audit-2/installed-selector-replay.sanitized.json`
- `.tmp/continuation-20261104-codex-cli-max-audit-2/desktop-monitor-readiness*.json`
- `.tmp/continuation-20261104-max-offline-rpc/summary.sanitized.json`

Additional historical implementation evidence locations:

- `.tmp/continuation-20261104-modern-adapter/`
- `.tmp/continuation-20261104-max-scope-node/`
- `.tmp/continuation-20261104-max-scope-bounded/`
- `.tmp/continuation-20261104-picker-readiness/`
- `.tmp/continuation-20261104-native-reasoning-visibility/`
- `.tmp/continuation-20261104-codex-cli-max-audit-2/desktop-effort-consumer-filter.sanitized.json`

Temporary offline fixtures/schema exports and bounded diagnostics were saved in
ignored evidence directories before the authorized cleanup. The current-owner scan intentionally fails closed
while a capped React scan retains structurally valid prior scopes; this may delay
Ready until a complete scan, but cannot make a stale scope a positive proof. No
provider inference or disposable chat was run.
