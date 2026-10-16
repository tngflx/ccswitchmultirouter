# Cline/Kilo External Integration Plan

## Research Findings

- Cline documents two different external surfaces:
  - A hosted OpenAI-compatible API at `https://api.cline.bot/api/v1/chat/completions`, authenticated with a Cline API key.
  - An OpenAI-compatible provider configuration for Cline itself, requiring a custom base URL, API key, and model ID.
  - Cline also documents an embeddable SDK (`@cline/sdk`, Node.js 22+), but that is an agent-runtime integration and is out of scope for this client-configuration feature.
- Kilo documents:
  - An OpenAI-compatible AI Gateway at `https://ai-gateway.kilo.ai/api/v1` with `/chat/completions`, `/models`, streaming, and tool-calling support.
  - OpenAI SDK/cURL usage by changing `baseURL` and using a Kilo API key.
  - Separate Kilo agent automation/integration surfaces; these are not required to consume a local OpenAI-compatible endpoint.
- The fork already has a dedicated external OpenAI-compatible API sidecar:
  - `src-tauri/src/proxy/external_openai_api.rs` owns persisted profile, generated local keys, backend/provider selection, model inventory, and validation.
  - `src-tauri/src/proxy/server.rs` exposes external-only `/v1/models`, `/v1/chat/completions`, `/v1/responses`, and `/v1/images/generations` routes.
  - `src-tauri/src/services/proxy.rs` runs this sidecar independently from app takeover on the default `127.0.0.1:15722` listener.
  - `src/components/openai/OpenAICompatibleApiPage.tsx` already provides source selection, listener configuration, key management, snippets, and a connection check.
- Therefore the minimal, safest integration is to make the existing sidecar explicitly consumable by Cline and Kilo. Do not embed Cline’s SDK or proxy requests through the hosted Cline/Kilo services in this scope.

## Decisions

- Primary direction: external Cline/Kilo clients call the fork’s local sidecar.
- Keep one canonical external API profile and key store; Cline/Kilo are presentation/setup targets, not new persistence entities.
- Keep the sidecar local by default. Treat non-loopback binding as an explicit advanced action and retain API-key authentication for every external route.
- Use OpenAI Chat Completions as the compatibility baseline because both vendors document it and the sidecar already supports it.
- Present `/v1/responses` as optional/advanced compatibility only; do not claim full Cline/Kilo agent-runtime parity from an OpenAI-compatible endpoint.

## Implementation Tasks

1. Audit the existing external API page and backend contract end to end, including startup/restart behavior, listener conflicts, `/v1/models` response shape, streaming, tool calls, and model-name routing. Reuse the existing profile and backend option helpers.
2. Add first-class Cline and Kilo setup targets to the existing external API UI rather than adding separate provider state:
   - Cline target: OpenAI-compatible provider, local sidecar base URL, generated local key, selected model.
   - Kilo target: OpenAI-compatible client configuration using the same base URL/key/model; clearly distinguish local CCSwitch endpoint from Kilo’s hosted Gateway URL.
   - Provide copyable snippets for Cline-compatible settings, Kilo/OpenAI SDK usage, cURL, and environment-variable examples without persisting secrets in diagnostics or logs.
3. Add explicit compatibility/status checks for the selected backend and model:
   - Verify authenticated `GET /v1/models` returns OpenAI list data and includes the selected model.
   - Verify authenticated streaming and non-streaming `POST /v1/chat/completions`.
   - Verify tool-call request/response forwarding where the selected upstream supports it.
   - Report unsupported capabilities instead of silently falling back to a different model or provider.
4. Add or update backend tests around the external-only router and handlers:
   - Authentication and disabled-profile behavior.
   - OpenAI model-list shape and selected-model visibility.
   - Streaming/non-streaming Chat Completions forwarding.
   - Model-based Codex MultiRouter route selection when used as the external backend.
   - No credential leakage in response bodies, status views, snippets generated from redacted state, or logs.
5. Add focused frontend tests for Cline/Kilo target selection, base URL generation, snippets, loopback versus reachable address display, and stale/empty model catalogs.
6. Update the user-facing external API help text or existing manual section with the documented setup flows and boundaries:
   - Start the external API listener in CCSwitch.
   - Generate/copy a local CCSwitch key.
   - Configure Cline’s OpenAI-compatible provider or Kilo/OpenAI-compatible client.
   - Choose a model exposed by the selected backend.
   - Explain that this integrates model access, not Cline/Kilo’s full agent UI, approvals, sessions, cloud agents, or SDK runtime.

## Failure Modes and Security

- Never expose a generated local key after it is redacted unless the user explicitly generates/copies it; never write it to logs, fixtures, or serialized diagnostics.
- Reject missing, invalid, or disabled external keys with stable OpenAI-style errors.
- Preserve fail-closed routing when a selected provider, route, or model is unavailable; do not use stale catalog fields when the canonical catalog is valid.
- Make listener restart requirements visible after address/port changes and avoid silently replacing the main takeover proxy.
- Warn that binding to `0.0.0.0` or a LAN address exposes the endpoint beyond the local machine; require the local API key and document firewall implications.
- Keep hosted Cline and Kilo URLs out of the local sidecar’s provider-selection semantics unless a separate future request explicitly adds them as upstream providers.

## Validation

- Frontend: focused external API page/profile tests, then `pnpm typecheck`, `pnpm test:unit`, `pnpm format:check`, and `git diff --check`.
- Rust: focused proxy/external API tests, `cargo fmt --check --manifest-path src-tauri/Cargo.toml`, `cargo test --manifest-path src-tauri/Cargo.toml --lib proxy::`, and `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`.
- Release-facing validation: `pnpm build:renderer` or `pnpm build` so the renderer gate runs.
- Manual contract checks using a generated local key:
  - `GET http://127.0.0.1:15722/v1/models`
  - non-streaming and `stream: true` `POST http://127.0.0.1:15722/v1/chat/completions`
  - one tool-call request when supported by the selected upstream.
- Report separately that source/tests do not prove a live Cline or Kilo account, hosted API availability, or installed-client behavior.

## Out Of Scope

- Embedding `@cline/sdk` or Kilo’s agent runtime in the Tauri app.
- Implementing Cline/Kilo cloud-agent, session, approval, connector, MCP, or enterprise APIs.
- Adding hosted Cline API or Kilo Gateway as new upstream provider presets.
- Claiming that OpenAI compatibility reproduces the full behavior of either vendor’s coding-agent product.
