# Reversible Sub-Agent reasoning effort

In **Codex MultiRouter → Sub-Agent → Sub-agent settings**, use **All Sub-Agent
reasoning effort**. Changing the selection saves it for the selected router plan:

- **High** uses `high` where supported and is the default for plans with no
  saved Sub-Agent effort.
- **Max** uses `max` when the current model declares native `max`.
- **Profile settings (override off)** uses each Sub-Agent's saved profile or
  model-default policy.
- Existing saved lower, Extra high, None, or Ultra values remain preserved as
  legacy read-only values; they are not offered as new choices and are not silently
  migrated. Provider-native/main-agent controls keep their full capability lists.

The plan-level effort applies to Sub-Agent V1 and V2. Saved Ultra applies in V2
only. A model with unknown capabilities or without the selected effort keeps its
existing policy. The V2 preview and status report when a model cannot use the
override.

Wait for the save/projection result. For an active plan, restart Codex Desktop or
its app-server and start a **new session** after successful projection so cached
role files and parent guidance are reloaded. The router reads the latest saved
plan policy when it prepares a marked Sub-Agent request, including requests from
existing sessions. An inactive plan's projected role settings take effect when
that plan is activated. A pending projection needs a successful retry before
Codex can reload the updated role files.

## Configuration contract

The single canonical field is in the router plan's persisted `settingsConfig`:

```json
{
  "codexRouting": {
    "subagentReasoningEffort": "high"
  }
}
```

Allowed values are `"profile"`, `"none"`, `"minimal"`, `"low"`, `"medium"`,
`"high"`, `"xhigh"`, `"max"`, and `"ultra"`; omission is equivalent to
`"high"`, including older plans. Reading an omitted field does not write it back. Every reader, API patch, persistence validator and runtime parser
accepts the same canonical vocabulary. This snippet shows only the field
location, not a complete router configuration. The UI uses
`update_codex_subagent_policy`, an atomic focused mutation, rather than replacing
the provider or rewriting `subagentV2.profiles`.

New fixed profile choices in the Sub-Agent profile editor are limited to
**High** and **Max**, with **High** preferred when the current model supports it.
Max remains available when High is unavailable but native Max is supported.
If neither choice is supported, the UI does not invent a fixed effort; use the
model-default, delegated, or disabled policy instead. Existing saved lower,
extra-high, Ultra, or otherwise unavailable fixed policies remain canonical and
are preserved as read-only choices rather than being silently rewritten. This
per-profile UI restriction does not narrow the native effort vocabulary or the
parser/runtime contract. The High default does not change an active plan's
explicit saved Profile settings or Max. **Profile settings** restores saved
profile policies.

Generated managed role files, previews, and status are derived from current
canonical settings. At the proxy request boundary, explicit Codex child markers
(`x-openai-subagent` header or its top-level `client_metadata` equivalent)
authorize the same override before protocol conversion. For a marked child,
the router uses the plan's saved effort and the routed model's capabilities. A
High child policy is promoted to native Max for Sublyx when the same router and
installation observed an exact parent turn requesting Max or Ultra within the
six-hour lineage window. The match requires the parent thread and turn ids,
and unrelated routers, installations, turns, expired observations, and
non-generation requests do not promote a child. This lineage evidence is
bounded to the most recent 1,024 turns and is kept in memory only.
In **Profile settings** mode, the child uses its own reasoning policy. Main-agent
reasoning follows the main request and the provider model's mapping. The
Sub-Agent override applies to Responses and Chat generation endpoints. For
native Chat, the same capability mapping chooses the provider's effort parameter.
The canonical reasoning boundary also applies to main-agent generation requests:
flat and nested effort aliases must agree, and explicit Boolean intent must not
contradict the effort. Native Chat maps controls once without rebuilding messages
or passing its mapped body through the Responses mapper again. Synthetic Ultra
must resolve to a declared provider-native value; it is never sent literally.

Conflicting advanced provider request-body overrides fail before forwarding for
both main and child requests. They cannot silently turn High back into Max,
restore literal Ultra, add a competing effort alias, or re-enable guarded-off
thinking. Remove the conflicting controls from the advanced body settings.
Selecting **Profile settings** disables the plan-level override but does not
disable canonical capability validation. Unrelated body overrides and ancillary
reasoning summary fields remain allowed, and protocol thinking-history/output-budget
safety guards remain in force.
Clients that omit the explicit child marker cannot receive the
request-boundary override; managed role defaults and parent guidance still apply.

## Verifying the prepared request without exposing content

After the updated backend is loaded, the existing router timeline at
`logs/codex-router.log` includes four allowlisted fields on
`event=request_prepared`:

- `is_subagent`: whether the original request supplied explicit child metadata.
- `subagent_reasoning_override_applied`: whether the plan override was applied.
- `requested_reasoning_effort`: the original canonical effort, or
  `unset`, `unknown`, or `conflict`.
- `upstream_reasoning_effort`: the final prepared provider-native effort using
  the same safe vocabulary. Budget/boolean-only controls do not invent a tier;
  an absent effort is reported as `unset`.

For example, a marked child requesting Max for a model that supports High can
show `is_subagent=true` when the plan has High selected, with
`subagent_reasoning_override_applied=true`,
`requested_reasoning_effort=max`, and `upstream_reasoning_effort=high`.
This is an example, not a live verification receipt. The fields never serialize
prompt content, raw child metadata, credentials, or unrecognized effort strings.
A prepared request is not proof of provider acceptance or billing; correlate its
trace with the subsequent send/outcome events. Old usage rows cannot be
retroactively identified as child requests from these new fields.

Source tests and a renderer build do not update an installed desktop executable.
Rebuild the native app using the repository's gated `pnpm build` path before
using the new backend command contract in a packaged installation.
