# Owner remote access to Codex

Status: **local native Continue and two actual-browser flows verified, with an intervening bridge-readiness failure; production and off-device deployment remain unverified**. Updated November 17, 2026. This is the single owner-remote implementation contract and setup guide. It supersedes the earlier suggestion of host approval for each remote action; native Codex tool/sandbox approvals are unchanged.

## Current implementation boundary

The source now contains an opt-in owner website, passkey enrollment/login,
revocable browser sessions, a dedicated loopback control service, bounded
selected-conversation viewing, and an exact-view Continue adapter. The scoped
evidence below includes an actual HTTPS browser-console/native Continue flow
against the deployed Codex renderer, repeated with a fresh fixture after an
intervening readiness refusal. The failed confirmation created no test
conversation because the guarded desktop client was unavailable. The two browser
successes do not explain that refusal, certify the installed production service
or prove that a tablet can reach this host; sustained bridge availability remains
an open gate.

| Area                       | Implemented source                                                                                                           | Remaining boundary                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host setup                 | Settings → Owner remote access; enable/disable, exact HTTPS origin, short-lived enrollment link                              | Audited host service remains off; exact HTTPS origin/private ingress unconfigured                                                                                             |
| Website and authentication | `resources/owner_remote/`, `services/owner_remote/`; real WebAuthn verification, sessions, CSRF, device management           | Two local HTTPS browser/virtual-passkey flows passed; private HTTPS deployment and real-device passkey/browser tests                                                          |
| Native bridge              | `codex_owner_remote.rs`; concrete endpoint/target, process start identity, runtime and canonical provider/settings freshness | Strong native owner proof is Windows-only; intervening guarded-client readiness failed; other platforms fail closed                                                           |
| Content                    | `owner_remote_view.js`; count-bounded native protocol pages, allowlisted recent projection and exact-turn failure category   | Exact failed-conversation view passed in actual local browser; in-progress output fidelity remains unverified; failure detail is sanitized and must not fall back to raw logs |
| Displayed host chat        | Explicit conversation selection                                                                                              | No verified host-navigation reader; `currentDisplay: "unavailable"`                                                                                                           |
| Continue                   | Shared renderer prepare/commit core and canonical native recovery ledger with typed owner intent                             | Isolated native HTTP and actual-browser Continue passed; production service/native scheduling unverified                                                                      |
| Action-record migration    | Strict install-time v2 action document, secure document revisions and runtime/action freshness evidence                      | Installed migration/current-writer verification; failed persistence cannot promise evidence across full process loss                                                          |

### Actual runtime evidence and its limits

The current-binary native HTTP and actual-browser mutation proofs below used:

- Renderer: `sha256-6db559937767f1e548e66f527c14155169b728b1a83136981d58532b278ac548`
- CCSwitch binary SHA-256: `bf06753fb50cba457fd5b9db65ff035c2d421fb5857eaf6b5e3c6a1a9a3ac4db`

The six earlier deployed renderer policy cases used the same renderer fingerprint
and binary `6f7eba90fa894e610b47e2c5e331209b08e70275853e7ac27e5fbac0dd08ec54`.
The current binary is now independently covered by the successful native and
browser receipts; those are not merely a readiness check or an inference from
the earlier binary's results.

All times in this table are **November 15, 2026 UTC**; the current-binary native
success occurred at **22:49 Singapore time**, and browser successes at **22:50
and 22:59 Singapore time**:

| Evidence                                                                                                   | Observed result                                                                                                                     | Receipt under `.tmp/`                                         |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Deployed renderer: `overload`, `concurrent_limit`, `temporary_usage`, `connection_drop`; 10:07:09–10:08:15 | Each scenario: one initial request, exactly one literal `continue`, continued turn completed                                        | `owner-remote-status-live-<scenario>-20261115.json`           |
| Deployed renderer: `explicit_no_retry`, `hard_quota`; 10:08:28–10:08:45                                    | Each scenario: one initial request, zero Continue requests                                                                          | `owner-remote-status-live-<scenario>-20261115.json`           |
| Current binary: isolated authenticated HTTP/native Continue; 14:49:25.985                                  | Canonical ACK/operation GET, duplicate refusal and logout verified; one literal Continue completed; owned fixture archived          | `owner-remote-native-trace-live-20261115.json`                |
| Current binary: actual HTTPS browser console/native Continue; 14:50:41.121                                 | Virtual-passkey enrollment/login, real view and one UI Continue passed; canonical ACK/operation GET matched; owned fixture archived | `owner-remote-browser-prestop-trace-live-20261115.json`       |
| Follow-up browser confirmation; 14:51:36.525                                                               | Failed at readiness: `desktop_request_client_unavailable`; no fixture created, zero initial/Continue provider requests              | `owner-remote-browser-confirm-live-20261115.json`             |
| Read-only readiness recovery; 14:58:03.406                                                                 | `readinessVerified: true`; no test conversation or provider request; not a mutation proof                                           | `owner-remote-readiness-after-repeat-20261115.json`           |
| Fresh actual HTTPS browser-console fixture; 14:59:30.134                                                   | Second browser PASS: one UI Continue, exact completed new turn, canonical ACK/GET agreement, owned fixture archived                 | `owner-remote-browser-readiness-recovered-live-20261115.json` |

All six renderer cases passed against actual Codex disposable conversations with
controlled local provider failures, without monitor source injection. Their
fixtures were archived, and no existing conversation was touched. Each receipt
explicitly reports `automaticNativeSchedulingVerified: false`: these are live
**renderer recovery scenario** results, not native automatic-scheduler proof.

Live auditing found the idle-only owner bug: a loaded `systemError` after the
latest failed turn was previously refused as `thread_not_idle`. The deployed
native view now preserves its error display and recognizes eligibility only with
the actual latest turn failed/interrupted, clear pending-operation proof and all
existing binding/action/scope/authentication guards. It does not fabricate idle
or accept unknown states.

The **14:49:25.985 UTC** native receipt verifies an authenticated real local HTTP
socket, software WebAuthn/login, Origin/CSRF checks, the bounded native view and
exact thread/model/turn binding. The failed-conversation view was `error` with
latest turn `failed` and no Continue blocker. One POST was acknowledged as
submitted, its read-only canonical operation GET matched, a duplicate was refused,
and logout was verified. One initial request and exactly one literal `continue`
reached the controlled local provider; the accepted new turn completed. The POST
took **27,328 ms**. The bounded test-only trace reached `read_ack`, with no failed
gate or evaluator error. This run's owned fixture was archived; existing chats
were untouched.

The **14:50:41.121 UTC** browser receipt is the first positive end-to-end website
proof: fresh owned headless Edge loaded the actual console HTML/JS/CSS and
localization over ephemeral loopback HTTPS. An actual browser virtual WebAuthn
authenticator completed enrollment and login, without cookie injection, a user
browser profile or trust-store installation. The browser checked the `Secure`,
`HttpOnly`, `SameSite=Strict`, host-only session-cookie attributes. Its one view
GET returned HTTP 200 before fixture shutdown and showed the exact failed
conversation, truthful `message.errorReady` copy and an enabled Continue button.
Exactly **one UI Continue POST** took **26,933 ms**; Codex accepted it, the local
provider received literal `continue`, and the exact new turn completed. The ACK
and read-only operation GET matched the canonical receipt. The owned chat was
archived, and no existing chat was touched. This browser run deliberately had
only one UI sender (`duplicateRefused: false`); duplicate refusal is proven by
the separate native HTTP run, not inferred here. `nativeTrace` is explicitly
`null` on the browser path. Conversation-history enumeration was blocked by the
audit proxy, not tested. These timings are observations, not latency promises.

The **14:51:36.525 UTC** follow-up did **not** repeat that success. It failed at
`desktop_bridge_not_ready` / `desktop_request_client_unavailable`, with zero
eligible guarded request clients even though the runtime fingerprint matched.
It created no fixture and made no provider requests. The receipt also reports
bounded discovery truncation and `asset_not_found`; it does not establish why
the guarded client was unavailable. Do not call the feature reliably available
or count this failed confirmation as another successful browser run.

A read-only check at **14:58:03.406 UTC** recovered `readinessVerified: true`
without creating a conversation or sending provider requests. A **new**, separately
owned browser fixture then passed at **14:59:30.134 UTC** on the same binary and
renderer. It again verified actual console assets, HTTPS, virtual-WebAuthn
enrollment/login, cookie attributes, logout and the exact failed-conversation
view. Exactly one UI Continue POST took **27,327 ms**; there was one initial
provider request and one literal `continue`, the exact acknowledged new turn
completed, and the canonical operation GET agreed. The owned chat was archived;
existing conversations were untouched. This was not a resend of a previous
fixture. These are **two website passes with an intervening readiness failure**,
not continuous-availability proof or an explanation of the failure.

All three successful current-binary receipts explicitly use
`nativeHarnessScope: "isolated_test_native"`: an isolated authentication home and
compiled test adapter exercised actual Codex/native/renderer paths. The browser
adds real console assets and browser WebAuthn with a **virtual**, not physical,
authenticator. All three receipts leave `installedOwnerServiceVerified`,
`automaticNativeSchedulingVerified`, `durableLedgerIoVerified` and
`remoteDeviceHttpsVerified` false. They do not certify production recovery-ledger
disk I/O, the installed production owner service, a hardware passkey, or an
actual off-device HTTPS/tablet/laptop connection. The audited production owner
service remains off, with no configured private HTTPS origin or ingress. Recent
selected-conversation content is not full Codex-window mirroring or Follow-host
navigation.

Earlier evidence remains distinct. The successful **10:30:49.590 UTC** native
receipt (`.tmp/owner-remote-canonical-receipt-live-20261115.json`) used the earlier
binary; the **11:05:57.759 UTC** current-binary readiness receipt
(`.tmp/owner-remote-browser-deployed-readiness-20261115.json`) created no thread.
The **10:15:34.570 UTC** attempt
(`.tmp/owner-remote-status-live-http-native-fresh-20261115.json`) reported
`child_refused`, unverified acknowledgement/receipt,
`ownerAuditOutcomeUncertain: true` and pending cleanup. The first browser attempt
at **11:15:05.922 UTC** (`.tmp/owner-remote-actual-browser-live-20261115.json`)
verified enrollment/login/cookies but failed before Continue; its archive timed
out and cleanup remains pending. Their causes are not established here. Later
successes do not retroactively resolve or archive either earlier fixture. Zero
observed upstream Continue requests is not positive no-mutation evidence: retain
uncertain evidence and do not resend or discard it merely to clear uncertainty.
The earlier quiet/fresh-log `runtime_fingerprint_not_observed` limitation was
not proof of a stale/missing renderer or failed remote access; positive runtime
evidence supersedes that inference, not the unresolved fixtures.

The canonical action storage key now carries a v2 envelope
`{ schemaVersion, revision, actions }`. Valid bare legacy data migrates explicitly
at runtime installation, **before** any owner reference can exist; valid v2 data
is not rewritten merely by installation. Migration preserves method/time and valid
existing action identities, assigning missing identities only at that explicit
install boundary. Every current action write uses a fresh
cryptographically random 128-bit document revision as well as per-action identity.
Owner evidence includes that revision and runtime generation, so a stale
read/modify/write cannot restore a captured valid revision. A late old writer
clobbering the envelope invalidates capability rather than being silently repaired
by a read or action. Malformed/future data is preserved and fails closed.

An observed action whose write/readback fails leaves a sticky capability failure
for both owner and automatic continuation in the same state, including
reinjection; an unrelated successful write, empty projection or changed clock
does not clear it. Local stop/start evidence is retained even when unpersisted.
If secure randomness is unavailable, owner capability is unavailable. Before any
observed failed action write, a genuine never-v2/noCrypto runtime can still use
its original strict legacy timestamp policy. Once an installed runtime has
successfully read or confirmed writing valid v2, subsequent automatic reads in
that installation require v2: null/missing/bare-legacy clobbers refuse rather
than migrate or repair, independently of owner readiness or crypto availability.
Reinjection remains the explicit installation/migration boundary; no competing
persisted downgrade flag or ledger is introduced. This cannot promise that
unpersisted failure evidence survives full renderer process loss when persistence
itself failed.

Unresolved renderer mutation markers are deliberately retained rather than aged
out. The canonical native owner journal is bounded at **256 operations per
thread** and has no positive retirement mechanism yet. Exhaustion refuses a send;
it does not erase uncertainty to restore availability. This limitation and the
remaining live-verification gates must be disclosed before calling the feature
ready for unattended use.

## 1. Setup: a private website, not an exposed model API

The implemented first deployment is:

```text
owner tablet/laptop browser
  -> configured private HTTPS hostname
  -> host HTTPS proxy, for example Tailscale Serve
  -> 127.0.0.1:15723 owner control service
  -> verified local Codex bridge
  -> exact owner-selected conversation
```

Keep the host online with CCSwitch and a compatible, accessible Codex runtime.
Keep OS lock and security policies in effect. Each remote device needs its own
access to the private network. These steps describe the current source. Live
verification of this Tailscale setup and access from another device are pending.

### Connect with Tailscale

1. Open **Settings → Connections & recovery → Remote connection (owner access)**
   or use the shortcut at the top of General. Click **Connect with Tailscale**.
2. If Tailscale is missing on Windows, CCSwitch requests a silent install of
   the official `Tailscale.Tailscale` package through WinGet. Complete a Windows
   administrator prompt if one appears. On other platforms, install the
   Tailscale client before connecting.
3. If the host needs to sign in, CCSwitch opens the Tailscale sign-in page in
   your browser and waits for the host to connect. Complete sign-in there. If
   your tailnet requires device approval, approve the host in the Tailscale admin
   console and retry **Connect with Tailscale**.
4. CCSwitch checks the tailnet hostname and the existing Serve configuration,
   starts Owner Remote on `127.0.0.1:15723`, then configures or reuses private
   HTTPS Serve on port `443` for that exact loopback target. If Tailscale asks
   for HTTPS approval, CCSwitch opens the consent page and waits for you to
   finish in the browser. A conflicting route or a hostname that differs from
   the pinned Owner Remote origin stops setup.
5. CCSwitch requests `/remote/` over HTTPS at that exact origin and checks for
   the Owner Remote page. **Verified from this computer** means the host could
   load that page. To verify off-device access, open `/remote/` on a second
   device signed in to the same tailnet, then follow the enrollment steps below.

### Manual private HTTPS setup

1. Configure the private network on the host and remote device. For manual
   Tailscale Serve setup, run this on the host:

   ```text
   tailscale serve --bg http://127.0.0.1:15723
   ```

   Tailscale supplies the private network and Serve supplies the HTTPS website.
   For a separately operated private HTTPS proxy, point it at the same loopback
   listener. CCSwitch requires no firewall or router changes for this setup.

2. Open **Settings → Connections & recovery → Remote connection (owner access)**
   (or the shortcut at the top of General). Enter the exact HTTPS origin reported
   by that deployment, for example `https://your-machine.your-tailnet.ts.net`,
   with no path, credentials, query, or fragment. Choose a stable hostname;
   existing passkey trust is not silently rebound to another origin. Once configured,
   the address is read-only here, even while access is off. Changing it requires a
   separate explicit reset and browser re-enrollment.
3. Turn on the **Remote connection (owner access)** switch. From another device
   on the private network, check that `https://<configured-host>/remote/` opens.

### Enroll and use a remote device

1. Click **Create one-use enrollment link**. Open that private link on your own
   tablet/laptop within **60 seconds** and register a passkey there. The link
   secret is removed from the address/history before the browser makes a request.
   Do not share or log the link.
2. Use `https://<configured-host>/remote/`, select the desired conversation, and
   view the recent snapshot. Continue is available only when the native adapter
   returns a fresh mutation capability and positively proves the exact thread is
   in a supported non-active state with no pending operation: idle, or explicit
   loaded `systemError` with its actual latest turn failed/interrupted. The latter
   remains visibly an error; it is not relabeled idle.
3. Press Continue once to send the literal user message `continue` to that
   conversation. **No person at the unattended host approves this action.**
   A lost acknowledgement is shown as uncertain, not retried.
4. When the browser session expires, sign in with its passkey **on the remote
   device**. An enrolled owner can invite/revoke devices while away using
   owner-side passkey reauthentication; that step-up is not required per Continue.

### Optional Cloudflare domain management

Cloudflare may manage the DNS zone for the chosen hostname, but the default
plan keeps Cloudflare out of the Codex traffic path: use a Tailscale `.ts.net`
hostname and its Serve certificate, or use a separately operated HTTPS proxy
bound only to the host's Tailscale address. A plain Cloudflare CNAME does not
provide the private-host certificate needed for a custom hostname. If a custom
hostname is required, use Cloudflare **DNS-only** with a narrowly scoped DNS
API token held by the external certificate/proxy service, obtain the certificate
with DNS-01, and pin that exact HTTPS origin in CCSwitch. Do not enable the
orange-cloud HTTP proxy, Cloudflare Tunnel, Funnel, or a second public owner
service merely because the DNS zone is on Cloudflare. Never put a DNS token in
CCSwitch configuration, a repository, a browser URL, or a log.

This optional custom-hostname path is not live-verified. The pinned origin and
WebAuthn relying-party binding must not silently switch between `.ts.net` and a
custom domain; changing it requires an explicit reset and re-enrollment.

### Optional full Cloudflare transport (not enabled by this build)

If browser-only access without a Tailscale client is a hard requirement, the
same owner website can be placed behind a dedicated Cloudflare Tunnel and
Cloudflare Access application. The intended topology is:

```text
remote browser
  -> Cloudflare Access policy (your identity + MFA)
  -> dedicated Cloudflare Tunnel connector on the host
  -> 127.0.0.1:15723 owner website
  -> CCSwitch WebAuthn/session checks
  -> exact selected Codex conversation
```

This must be a separate transport mode, not a second owner API. The connector
must be outbound-only and its ingress must map one dedicated hostname to
`http://127.0.0.1:15723`; do not publish `15721`, `15722`, `9229`, Tauri IPC,
SQLite, or a wildcard service. Keep CCSwitch's exact-origin pin and passkey
check even when Access is enabled, so a Cloudflare policy mistake cannot become
an app-level owner session.

For portability, setup should open the official Cloudflare dashboard or
`cloudflared` installer and ask the user to complete tunnel/Access setup outside
CCSwitch. Do not place Cloudflare API tokens, tunnel tokens, or IdP secrets in
CCSwitch settings, invites, URLs, logs, or the synced database. A future
wizard may verify the final HTTPS origin and display a copyable ingress snippet,
but it must not silently create a public tunnel or store a long-lived token.
Cloudflare is then in the traffic and identity path: a Cloudflare outage or
Access-policy/IdP failure can block remote access even while the host and local
Codex continue to work. Tailscale remains the safer default for the owner's own
devices because it avoids public hostname exposure and does not require a
Cloudflare account on every device.

### Optional TeamViewer desktop fallback

TeamViewer is useful only as a clearly labelled **Open host desktop (break
 glass)** fallback. With unattended/Easy Access, an owner can use the TeamViewer
web client or mobile app to see the actual Codex window when the bounded owner
snapshot is insufficient. It is not the CCSwitch transport and it must not be
used to automate Continue by clicking the desktop: TeamViewer grants broad
keyboard/mouse and screen access, exposes every host window, and has separate
licensing and account controls.

If enabled by the user, keep TeamViewer configuration entirely outside CCSwitch:
use a separate TeamViewer account with 2FA and an allowlist, disable random or
personal passwords where the plan permits, prefer view-only for diagnosis, and
open the vendor web client as an external link. CCSwitch should never store
TeamViewer credentials/API tokens or claim that a TeamViewer screen view proves
the owner website's selected-thread capability. Continue remains the signed,
idempotent owner-website operation.

The adjacent **Crash recovery** card uses the existing device-local
`watchdogEnabled` setting. Its **Auto-recover from crashes (watchdog)** switch is
independent of remote access; enabling one never enables the other. Recovery
diagnostics and restart conditions are disclosed beneath that switch. Proxy
settings remain below both cards, and Codex egress settings are collapsed.

The listener is disabled by default and binds only `127.0.0.1:15723`. Enabling it
is not a test of the HTTPS proxy, private-network permissions, Codex bridge, or
remote device. The website and narrow API use the same configured HTTPS origin.
There is no direct browser-to-CDP connection or permissive CORS.

Keep takeover `15721`, inference `15722`, CDP `9229`, Tauri IPC, SQLite, and raw
app-server methods private. Never wildcard-bind or port-forward them. The
external OpenAI-compatible API is **model inference**, not an owner console, and
its existing plaintext-copyable inference keys are not owner sessions.

A future VPN-free deployment may place this same narrow API behind an explicitly
authenticated HTTPS ingress and outbound-only host tunnel. That deployment and
identity policy are not implemented here; do not invent a second remote command
protocol, public relay/account system, or custom relay crypto. Each separately
enrolled host has its own origin and local trust. Switching devices/hosts does not
migrate a conversation, copy API/OAuth credentials, or reset account usage limits.
A second host can use its own already-configured legitimate provider/account, but
connecting to it controls that host's existing conversations; it does not move the
original conversation or replenish an exhausted account.
Open each host's separately enrolled console URL; an in-app multi-host selector
and automatic host/account failover are not implemented.

## 2. Owner authentication and state ownership

There is one owner role with two operational permissions: **view** and
**continue**. Device management is an owner authentication operation, not remote
provider/settings/shell administration.

- `webauthn-rs 0.6.2` verifies registration and assertion signatures with exact
  configured RP/HTTPS-origin binding and required user verification. Ceremony
  state stays on the server, is single-use and purpose-bound, and expires after
  60 seconds. There is no relaxed subdomain/port mode or acceptance stub.
- Invitations have at least 128 random bits, expire after 60 seconds, and are
  atomically redeemed only after verified registration. Secrets travel in the
  URL fragment and POST body, never a query string. Failed/expired ceremonies
  create no authorized session.
- Session/invitation secrets are persisted **only as hashes**. The browser uses a
  `Secure; HttpOnly; SameSite=Strict; Path=/` `__Host-ccsm-owner` cookie with no
  `Domain`. Session secrets, transcripts, and durable bearer tokens do not belong
  in localStorage, service-worker caches, logs, or connection URLs.
- Sessions expire after 12 idle hours or seven absolute days. Activity cannot
  extend the absolute limit. Monotonic deadlines supplement wall-clock expiry;
  cleanup cannot revive an expired session after a clock rollback.
- Invite/revoke step-up binds the exact authenticated session and exact
  management action to one verified ceremony. `auth/finish` executes that action
  directly; there is no second management-token or invite/revoke command system.
- A synced passkey is not one physical device. Revoking a credential revokes all
  sessions minted under it, including synced copies; session revocation can be
  narrower. Pre-enroll a second recovery credential/device. No remaining trusted
  credential means secure host re-enrollment, not a bypass.

Host-local state is separate from the exported/synced main database:

| Location under the application config directory               | Authority                                                                                            |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `owner-remote/control.json`                                   | Versioned opt-in flag and exact HTTPS origin                                                         |
| `owner-remote/owner-remote-auth.sqlite`                       | Host identity, public passkey credentials, hash-only session/invite state and revocation             |
| Existing native recovery ledger and renderer mutation markers | Continuation reservations and attempted/submitted/uncertain evidence; not copied into the auth store |

Pending ceremonies and exact-view capabilities are memory-only. Restart
invalidates unfinished invitations, ceremonies, old view epochs, and native
handles; it does not replay owner submissions or discard durable uncertainty.
Main-database backup/import/sync is not a way to enroll another host. Do not copy
this authentication database to another machine/origin.

### Request and lifecycle security

The service pins Host/Origin, rejects duplicate/malformed credentials and
cross-site requests, requires session-bound CSRF on mutations, and rate-limits
public ceremonies and authenticated commands. It does not trust arbitrary
forwarded identity headers. The reference TCP HTTPS proxy preserves the incoming
Host; proxy/network identity is still layered with application authentication.

Request bodies are capped at 64 KiB with a body-read-only timeout and concurrency
limit. A timeout must not cancel/replay an already-authorized native mutation.
Reads, view capabilities, response sizes, and command concurrency are independently
bounded. Responses use restrictive CSP, no framing, and `Cache-Control: no-store`;
local scripts/translations are served without third-party network loads.

Unauthenticated endpoints return no transcript, thread list, host paths, or
private credential state. Standard WebAuthn login challenges necessarily include
opaque public `allowCredentials` identifiers and their cardinality; this is not a
secret-key or authenticated credential-inventory endpoint.

Every operational content read and native final precommit rechecks the canonical
session/revocation state and service lifecycle. Disable/shutdown denies new
authorization even if a startup restore was queued; failure to persist a disable does not leave the old
runtime serving. Revocation prevents **new commits** and further reads. It cannot
undo an operation already durably committed/dispatched before revocation; its
later response may still be uncertain to the browser.

## 3. Viewing: a bounded selected conversation

The content authority is the owned local Codex app-server, not logs, SQLite
copies, provider request history, cached catalogs, DOM scraping, or a relay
transcript. Viewing never resumes a thread, interrupts a turn, starts a summary,
repairs caches, or invokes arbitrary retained objects/getters.

The source reader uses metadata-only `thread/read`, `thread/turns/list`, and
`thread/items/list`. It rejects unsupported or ignored page options rather than
falling back to `thread/read(includeTurns: true)`. Owner preparation/commit uses
metadata plus a latest-turn page of one; automatic recovery retains its existing
reader/policy.

| Bound                 | Current source behavior                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Conversation choices  | At most 20 IDs and bounded titles; no paths/previews/config                                                                          |
| Recent view           | At most 20 turns, 40 items per page, 120 items total                                                                                 |
| Text projection       | At most 4,096 characters per item and 32,768 total characters                                                                        |
| Renderer read work    | Four distinct in-flight reads, same-thread coalescing, five-second whole-view deadline                                               |
| Exact-view capability | At most 32 service-held views, session-bound, single-use, at most 30 seconds using native monotonic lifetime                         |
| Browser               | One selected-conversation snapshot refresh roughly every 2.5 seconds while visible/focused; no overlapping refresh or mutation retry |

These are **count/page and projection bounds**, not proof that the installed
app-server limits arbitrary raw bytes in each source message before the renderer
receives it. Native CDP/metadata response caps and browser/service response caps
are additional independent limits. Saved command output is deliberately deferred
by the bounded protocol requests; do not promise full terminal-output parity.

The projection allowlists user/assistant text, application-supplied **public**
reasoning summaries, and finite tool/action states. It excludes hidden reasoning,
raw config/auth/error/provider objects, arbitrary object coercion and recursive
crawling. For an exact latest turn whose status is `failed` or `interrupted`, the
native projection may include one sanitized `failure.category` from this fixed
set: `server_overloaded`, `usage_limit`, `rate_limit`, `internal_server_error`,
`authentication_error`, `context_length_exceeded`, `invalid_request_error`,
`connection_error`, or `unknown`. The category is display-only: it does not
authorize Continue, assert retryability, provide an ETA, or substitute for the
canonical recovery policy. Missing, unreadable, stale or unrecognized failure
metadata becomes `unknown`; no latest-log or session-log record is attached to a
turn. Tool output/prompts may themselves contain secrets intentionally shown to
the owner; do not claim arbitrary transcript text is perfectly redacted. Keep
payloads out of access/error/audit logs and telemetry.

The browser renders text, not arbitrary HTML/Markdown or remote images. It shows
truncation, freshness, and explicit unavailable states. `historyMode` is
`bounded_recent_snapshot`; `olderContentAvailable` is false. Native internal page
reads do not imply an older-history browser feature. There is no SSE/event route
or second notification cache in this implementation.

**Installed partial-output fidelity is unverified.** Snapshot polling must not be
advertised as token streaming. If installed snapshots omit in-progress output, a
future narrow read-only notification adapter must feed the same projection; do
not add another discovery path or scrape logs/DOM.

### A selected conversation is not the host's focused window

The current source always reports `currentDisplay: "unavailable"`. It offers
explicit conversation selection and does not claim screen mirroring. Neither the
last failed request, most active thread, nor recent history proves what the host
window currently displays. “Follow host's displayed chat” requires a separately
verified, narrowly owned navigation adapter and is not implemented.

The viewed model is the thread's current configured/latest persisted model, not
historical per-turn execution telemetry. Continue requires positive model
identity, supported thread/turn state and proof that no operation is pending.
Idle still requires the existing terminal-turn and current-action checks. Loaded
`systemError` is eligible only when the actual latest turn is failed/interrupted
and pending proof is clear; its displayed state stays error. Active, pending,
approval-waiting, null/unknown or unverified state cannot authorize Continue.
Unsupported installed protocol or ambiguous/unverified Codex targets produces
unavailable/read-only, not target fallback or a fabricated idle state.

## 4. Continue: explicit owner intent, one mutation authority

The button sends exactly **`continue`** as a new intentional user action. It does
not type into a visible composer, send its draft, enable automatic recovery,
approve tools, accept arbitrary prompts/RPC, switch accounts, or bypass quota.

| Decision                                                  | Automatic recovery                          | Owner Continue                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Authorization                                             | Current recovery policy/settings            | Valid owner session and fresh exact-view capability                                                                   |
| Off/Safe/Aggressive, error classification, budget/backoff | Existing policy and 5/10/20-minute schedule | Not a gate on an intentional single click                                                                             |
| Completed/cancelled/hard-limit/no-retry terminal turn     | Existing automatic refusal policy           | One deliberate new turn only in a supported non-active state with clear pending proof; upstream limits can still fail |
| Active/pending/unknown or newer action                    | Refuse                                      | Refuse; refresh the owner view, not ask the host to approve                                                           |
| Lost acknowledgement or uncertain prior mutation          | No blind resubmission                       | No automatic POST retry; read-only reconciliation                                                                     |

The renderer has one shared prepare/commit mechanism with explicit `AutoRecovery`
and `OwnerContinue` intents. Native owner transport pins the exact viewed target;
automatic discovery policy does not authorize owner fallback. Both use the
existing canonical recovery/reservation authority and renderer mutation markers,
not a separate remote sender/retry ledger.

Before mutation, the native binding pins concrete numeric CDP endpoint, exact
target/socket, full process identity including start time, renderer generation,
thread/base turn, model/provider, config paths, and a freshness-only hash of
canonical provider/settings DAO inputs. Handles are private, process-local and
monotonic-expiring; caller-supplied endpoint/epoch objects cannot manufacture
one. Runtime/client/hook/action/state/config/session checks repeat after awaited
work and immediately before commit.

Both production native paths finish the final awaited exact-thread confirmation
**before** their respective final authorization: the owner
scope/session/reservation CAS, or automatic native policy and budget
authorization. `confirmCodexContinuation` advances prepared → confirming →
confirmed without an attempted marker or mutation. The confirmed renderer commit
then runs its synchronous own-data guards, persists the attempted marker and
invokes `turn/start` before its first await. There is no further asynchronous
thread read between final native authorization and invocation.

The disposable continuation verification workflow follows this same explicit
handshake; ordinary readiness probes remain read-only. A previously confirmed
automatic job cannot be reattached as fresh native authorization.
The direct renderer automatic commit wrapper remains for compatibility, but is
not the production native/monitor path. Automatic error classification, backoff
and cap policy remain unchanged; this sequencing does not make more errors
retryable or introduce another retry loop.

An owner may supersede only an **uncommitted** automatic reservation. Reserved
work is epoch-fenced; committing/submitted/uncertain work is attach-only. Double
taps, two owners, old callbacks, automatic timers, process restart and renderer
replacement cannot authorize another mutation for the same unresolved base turn.
A dropped preparation settles without sending; a dropped committing operation
remains uncertain.

Durable attempted/commit-intent evidence is written **before** `turn/start`.
Persistence failure blocks the send. Submitted is recorded only after validated
own-data acknowledgement of a distinct accepted turn. A renderer job ending is
not proof that the native turn completed. An acknowledged submission creates a
new automatic chain only after canonical accepted-turn proof; delayed settlement
must not refund a later automatic attempt.

Proxy observations of literal `continue` are not proof of owner/automatic
provenance. Unproven incoming user input advances the canonical action epoch.
Literal equality may retain the conservative already-spent automatic cap; it does
not authorize a send or claim who sent it. Tool-only followups retain their logical
budget. No automatic-policy relaxation is hidden in the owner path.

A lost acknowledgement, late `401`, browser timeout, refresh, new operation ID,
logout, restart or elapsed TTL cannot prove no mutation happened. Preserve honest
uncertainty and reconcile by the canonical operation receipt/current exact
snapshot; never resubmit automatically. An unknown receipt/404 is not a
no-mutation proof. Only positive no-mutation evidence or canonical observed-turn
proof can resolve uncertainty. This is **at-most-once authorized mutation with
honest uncertainty**, not distributed exactly-once delivery.

## 5. Registered narrow HTTP contract

All operational routes use the same-origin owner authentication policy. Static
login assets/locales and the required enrollment/login ceremonies are the limited
public surface; they expose no generic Tauri/CDP/app-server methods.

| Operation                                                                                | Purpose                                                                               |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /remote/`                                                                           | Responsive owner website; `/` and `/remote` redirect here                             |
| `GET /remote/console.js`, `/remote/console.css`, `/remote/i18next.js`, `/remote/locales` | Local assets; locale response includes only the canonical console namespace           |
| `POST /remote/api/v1/session/enroll/options`                                             | Validate one-use invite and issue registration challenge                              |
| `POST /remote/api/v1/session/enroll/finish`                                              | Verify registration, atomically redeem invite, create session                         |
| `POST /remote/api/v1/session/auth/options`                                               | Issue login challenge or exact authenticated `managementAction` challenge             |
| `POST /remote/api/v1/session/auth/finish`                                                | Verify assertion; create session or execute the exact invite/revoke management action |
| `GET /remote/api/v1/session`                                                             | Current session/capabilities and CSRF token                                           |
| `POST /remote/api/v1/session/logout`                                                     | Revoke this browser session                                                           |
| `GET /remote/api/v1/devices`                                                             | Authenticated credential labels/revocation state                                      |
| `GET /remote/api/v1/conversations`                                                       | Bounded explicit conversation choices                                                 |
| `GET /remote/api/v1/view?threadId=...`                                                   | Typed recent view and optional fresh session-bound `viewId` capability                |
| `POST /remote/api/v1/continue`                                                           | `{ viewId, operationId }`; message fixed to literal `continue`                        |
| `GET /remote/api/v1/operations/:operationId`                                             | Read-only canonical operation receipt; no second outcome cache                        |

There are no separate `/devices/invite`, `/devices/revoke`, or `/events` routes.
Management is deliberately deduplicated into the verified auth ceremony. `viewId`,
operation IDs and host IDs are not authentication. An authenticated repeat of
Continue POST after its view was consumed returns `view_unavailable`, not a
replayed receipt. POST is not an idempotent receipt-replay or retry protocol;
use the authenticated operation GET after an ambiguous response. Reusing an
operation ID for another bound operation conflicts. Public pending is a projection
of the canonical reserved/committing state; submitted is not completed.

The browser waits up to **45 seconds only for `POST /continue`**; GET and
authentication requests keep their **20-second** transport wait. This does not
extend native capability/session/authorization lifetimes or establish a native
execution worst case. Timeout or auth loss keeps the operation uncertain and
reconciles only by GET for the exact operation ID; it never resends POST.

A receipt must match that operation ID and the canonical status, boolean and
acknowledgement shape. A same-ID malformed/inconsistent `refused` result cannot
unlock another send. A refusal resolves no-mutation only with `submitted: false`,
`mutationAttempted: false` and no acknowledged turn. A submitted receipt requires
positive booleans and a distinct accepted turn ID; submitted still is not proof
that the turn completed.

Host-local Tauri commands are limited to status, start, stop and initial invite.
The host-settings API has no direct continuation or arbitrary-RPC command. The
localization namespace is authored once in the existing four locale files;
`i18next.js` is a deterministic, licensed local dependency asset checked by the
gated renderer build, not a CDN load or second authored translation store.

## 6. Verification and remaining release gates

Source tests and independent source review cover the auth/session ceremonies,
strict request policy, native ownership/freshness, durable reservation races,
bounded projections and browser no-resend behavior. The renderer cases, successful
current-binary native HTTP flow, two successful actual local HTTPS browser flows,
intervening readiness refusal and earlier unresolved fixtures above are distinct
evidence. These scoped results do not establish repeatable bridge availability
or certify production owner deployment, an off-device HTTPS route or real
passkey/tablet/laptop acceptance.

Keep the remaining acceptance checklist here, not in another overlapping plan:

- Investigate and address the intervening `desktop_request_client_unavailable`
  readiness refusal, and verify sustained guarded bridge/browser availability
  without weakening ownership, freshness, bounded discovery or mutation guards.
  A successful fresh rerun does not establish continuous unattended reliability.
- Verify the installed production owner service and production-ledger durability.
  The isolated successful flow does not certify that deployment or later source
  changes. Run repository type/catalog/format/Rust/test/build gates for changed
  contracts; report exact outcomes.
- Verify the installed coordinated v2 action-document migration/current-writer
  contract and fresh broad regression gate. Preserve automatic timestamp policy;
  malformed/future/late legacy writers and observed failed writes must not create
  a mutation capability. No read/action may silently migrate or repair trust.
- Verify installed bounded source methods, in-progress assistant/tool output,
  approval waiting, unknown state, truncation, freshness and protocol mismatch.
- With real tablet **and** laptop browsers over the chosen private HTTPS origin:
  enroll once, view the actual selected conversation, submit one literal
  Continue with zero host prompts, observe the acknowledged/new turn, expire and
  re-login remotely, invite a second credential, revoke, and confirm access denial.
- Exercise real logout/revocation during reads/preparation, transport loss after
  commit, host offline/restart, and automatic-timer/owner races. An already
  dispatched mutation may complete; no reconnect or browser retry may resend it.
- Do not claim Follow-host or exact-window mirroring until a verified current
  navigation adapter exists. Do not claim token streaming until installed
  partial-output evidence exists.
- Add positive canonical retirement before treating long-lived journal/marker
  exhaustion as solved. Never delete unresolved evidence merely to clear a gate.

### Dependency/compiler boundary

The maintained WebAuthn verifier requires the deliberate declared Rust MSRV
increase to **1.89**. The older 1.85-compatible verifier range is affected by the
maintainer's advisory; it was not selected to preserve an outdated declaration.
Local builds/tests use Rust **1.95**. Exact Rust 1.89 compilation has not been
verified, and existing unchanged test-only `serial_test` dependencies already
require Rust 1.93.1. Do not represent the declaration as a completed minimum-
compiler compatibility test.

## 7. Deliberately excluded or retained

Excluded: per-action host-human approvals, collaborator roles/capability matrices,
mandatory passkeys per Continue, remote provider/catalog/account/shell editing,
public relay/account/E2EE infrastructure, full desktop/WebRTC capture/control,
raw protocol forwarding, a second retry scheduler/ledger, log/DOM viewer
fallbacks, whole-history scans, and a PWA offline-cache subsystem.

Retained for their existing purposes: inference API, quota collaboration,
provider/catalog/routing behavior, summary/handoff, and native automatic recovery.
They are not duplicates of owner viewing. No ownership/no-retry/mutation/catalog
guard may be weakened in the name of cleanup. The discarded per-action-host-
approval requirement was earlier design advice, not an implemented workflow.

## Reference boundaries

- [Inference relay guide](external-openai-api-relay-domain-guide-zh.md): model
  requests only, not owner console instructions.
- [Continuation audit](../audits/2026-11-14-continuation-remote-reaudit.md) and
  [installed-runtime follow-up](../audits/2026-11-14-continuation-postrestart-verification.md):
  historical verification, not evidence of remote pairing/browser access.
- Tailscale Serve: <https://tailscale.com/kb/1312/serve>.
- Tailscale connection types and coordination outages:
  <https://tailscale.com/docs/reference/connection-types> and
  <https://tailscale.com/docs/reference/coordination-server-down>.
- Cloudflare DNS records: <https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/>.
- W3C WebAuthn: <https://www.w3.org/TR/webauthn-3/>.
- Maintainer advisory: <https://github.com/kanidm/webauthn-rs/security/advisories/GHSA-22w3-693w-x895>.
- OWASP session management:
  <https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html>.
- OWASP CSRF prevention:
  <https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html>.
