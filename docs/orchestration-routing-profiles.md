# Multimodel Orchestration Routing Profiles

## Decision

CCSwitchMulti should model this as a **multimodel routing profile**, not as a
special model catalog entry and not as a prompt rewrite.

The profile is the source of truth. It binds:

- an orchestrator model, initially the official Claude Messages API;
- a worker model, initially the Sublyx GPT 6.1 Sol route;
- an optional verifier model;
- execution budgets, approval policy, and failure behavior;
- the client scope where the profile is allowed to run.

The Codex model catalog remains the user-facing inventory. It receives a
derived picker entry for an enabled profile, but it does not contain the
profile's full policy.

## Runtime shape

```text
client request
  -> profile resolver
  -> orchestrator call (plan)
  -> bounded worker call(s)
  -> orchestrator critique / repair
  -> verifier evidence check
  -> original client protocol response
```

The runtime is opt-in and supports Claude Messages, Codex Chat Completions, and
Codex Responses entry points. Direct provider routing remains unchanged. A
worker call uses an explicit configured provider and real model ID, so it cannot
re-enter the public router and recursively start another run.

Text-only requests use the planner -> worker -> verifier loop directly. A
tool-bearing request is supported when the worker and client use the same
protocol: the worker receives the original tool schema and conversation plus
the orchestrator plan, and its native tool call is returned to the client. The
client remains responsible for approval and execution, then sends the tool
result back on the next request so the profile can continue and verify. A
cross-protocol tool request fails closed or uses the profile's direct fallback;
the proxy does not guess at schema translation.

## Why the profile is separate from the catalog

The same worker model may be used by several profiles with different limits or
approval rules. A catalog row cannot express those policies safely. Conversely,
the picker still needs a concise representation of a profile, so the live
Codex projection can add a synthetic entry such as:

```json
{
  "model": "ccsm-orch/claude-master-sublyx-worker",
  "displayName": "Claude Master + Sublyx Worker",
  "role": "profile",
  "orchestrationProfileId": "claude-master-sublyx-worker"
}
```

Selecting that entry chooses the profile. Selecting an ordinary model continues
to use direct routing. The Codex picker exposes the profile row and compatible
Codex role rows. Claude role rows are kept out of the Codex catalog because they
use a different protocol surface.

## Profile contract

The persisted profile should contain:

```json
{
  "id": "claude-master-sublyx-worker",
  "displayName": "Claude Master + Sublyx Worker",
  "enabled": true,
  "scope": "all",
  "orchestrator": {
    "appType": "claude",
    "providerId": "anthropic-official",
    "model": "claude-..."
  },
  "worker": {
    "appType": "codex",
    "providerId": "sublyx",
    "model": "gpt-6.1-sol"
  },
  "budget": {
    "maxRounds": 4,
    "maxWorkerCalls": 8,
    "maxParallelWorkers": 1,
    "timeoutSeconds": 900,
    "maxOutputTokens": 8192
  },
  "approvalPolicy": "client",
  "failureFallback": "direct",
  "pickerModel": "ccsm-orch/claude-master-sublyx-worker"
}
```

Provider IDs and model IDs are examples only; the UI must populate them from
the configured provider/model inventories.

## Execution bridge

An orchestrator/worker loop is not useful if the worker can only return text.
The worker needs access to the existing client-approved tool loop for:

- listing and reading files;
- `rg`-style search;
- patching files;
- running focused tests and builds;
- reading git status/diff;
- optional browser/MCP tools.

Workspace boundaries, secret redaction, approval for writes/destructive
commands, and evidence capture remain responsibilities of that existing loop.
Internal worker requests should call the provider adapter/forwarder directly
with an explicit provider selection rather than routing back through the public
proxy. This keeps orchestration bounded and avoids recursive routing.

## Safety and observability

Every run needs:

- a run ID correlated with the existing session/request trace;
- round, worker-call, repair, and verification records;
- maximum rounds/calls/parallelism;
- timeout and token budgets (monetary budgets remain disabled until pricing is
  reliable);
- cancellation and idempotency protection;
- loop detection;
- redacted prompts, tool arguments, and errors;
- an explicit direct fallback or fail-closed result.

The existing ordinary proxy request log should remain unchanged. Orchestration
records should be a separate trace family so one user request can be understood
without flattening all internal calls into a single provider row.

## Implementation order

1. Persist and validate `OrchestrationProfile` records.
2. Build the Agents page as a profile editor and run monitor.
3. Project enabled profiles and role rows into the existing Codex catalog and
   picker injection path.
4. Add the bounded planner -> worker -> verifier engine through the existing
   provider adapters.
5. Add richer cross-protocol tool-call and client-approval bridging after the
   same-protocol path has stable verification and cancellation behavior.
6. Consider a global "route every prompt" switch only after opt-in profiles,
   cancellation, fallback, and cost controls are proven.

An API subscription and API usage billing must be configured separately from
the profile. CCSwitchMulti should store provider credentials/configuration, not
infer entitlement from a consumer subscription.

## Publication And Live Audit

Open **Configure multi-model routing -> Create orchestration profile** or the
Codex toolbar's orchestration shortcut. Save publishes enabled, currently
routable profiles through the active schema-v2 MultiRouter. An ordinary direct
provider is not a publication owner; activate a MultiRouter first.

The save response distinguishes canonical settings from publication status:
`{ settings, codexProjection, publicationError }`. A failed publication keeps
the saved settings and exposes retry, without logging or returning raw errors.
Unsaved edits are not reported as published. Disabled/excluded or missing role
models are rejected at save/runtime boundaries and omitted from projections;
their canonical profiles remain available for repair.

This read-only audit exercises the installed Codex model loader without
restarting the user's desktop or sending inference requests:

```powershell
node scripts/audit-orchestration-picker.mjs C:\path\to\installed\codex.exe
```

It checks the managed catalog referenced by the live configuration, Codex cache,
local `/v1/models`, and the installed app-server's `model/list` response.
Legacy inline provider model arrays are checked when present; current strict
Desktop versions intentionally omit them and use the catalog pointer instead.
This is loader verification, not a screenshot of an already-running desktop
picker. Codex may retain its startup catalog until it is reopened. Provider
credentials and successful planner/worker inference must be verified separately.
