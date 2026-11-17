# Reversible Sub-Agent reasoning effort

In **Codex MultiRouter → Sub-Agent → Sub-agent settings**, use **All Sub-Agent
reasoning effort**. Changing the selection saves it for the selected router plan:

- **High**: the default new Sub-Agent choice; it is applied only when the
  current model capability advertises native `high`.
- **Max**: an explicit opt-in Sub-Agent choice; it is applied only when the
  current model capability advertises native `max`.
- **Profile settings (override off)**: restore the original saved per-profile or
  model-default policy. An explicitly saved selection remains unchanged.
- Existing saved lower, Extra high, None, or Ultra values remain preserved as
  legacy read-only values; they are not offered as new choices and are not silently
  migrated. Provider-native/main-agent controls keep their full capability lists.

The native effort settings apply to both Sub-Agent V1 and V2; Ultra is inactive
in V1. They do **not** change the main
agent's effort, saved profile reasoning policies, model catalogs, routes, or
candidate selections. Unsupported or unknown models retain their existing policy;
V2 previews/status explain when a model cannot use the override.

Wait for the save/projection result. For an active plan, restart Codex Desktop or
its app-server and start a **new session** after successful projection so cached
role files and parent guidance are reloaded. An inactive plan is saved without
changing the current Codex files; it takes effect when that plan is activated.
A pending projection requires a successful retry before treating activation as
complete. Toggling off does not retrospectively rewrite an already running
Sub-Agent's cached configuration.

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
explicit saved override, including Profile settings or Max. Select **High** in
**All Sub-Agent reasoning effort** to apply that reversible override to current
child requests. **Profile settings** restores saved profile policies.

Generated managed role files, previews, and status are derived from current
canonical settings. At the proxy request boundary, explicit Codex child markers
(`x-openai-subagent` header or its top-level `client_metadata` equivalent)
authorize the same override before protocol conversion. It overrides an explicit
child `max` request while High is selected. Requests without a child marker are
not reclassified by their model name or prompt text, so main-agent requests stay
unchanged. Generation requests are scoped explicitly to Responses and Chat;
compact, search, and image-control endpoints are left unchanged. For native Chat,
the same capability mapping chooses the provider's actual effort parameter.
Conflicting advanced provider request-body overrides fail before forwarding,
with instructions to remove the conflicting controls or select Profile settings;
they cannot silently turn High back into Max. Unrelated body overrides remain
allowed, and protocol thinking-history/output-budget safety guards remain in force.
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

For example, a marked child explicitly requesting Max under the High override
can show `is_subagent=true`,
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
