# Codex Traffic Policy Port

## Goal

Port the legacy Codex traffic admission and recognized rejection replay behavior
into the BigStrongSun foundation without creating a second request/retry owner.

## Evidence

- The fresh foundation already owns ordinary transport retry, capacity/429 retry,
  route resolution, and protocol compatibility.
- The legacy implementation adds provider-specific admission limits and a narrow
  OpenCode-style pre-inference rejection replay policy that are absent from the
  fresh tree.
- A direct legacy cherry-pick overlaps fresh grouped-credential and protocol
  changes in `forwarder.rs` and provider adapters, so it must be adapted by
  conflict review rather than accepted wholesale.

## Decision

Add one canonical `codex_traffic_policy` resolver and integrate it with the
fresh provider-router/forwarder owners. Admission permits will live with the
full response lifetime. Rejection replay will be limited to explicit recognized
signatures and will reuse the immutable finalized request payload. Existing
transport and capacity retry paths remain authoritative for their current error
classes.

## Alternatives

- Keep the legacy implementation in a parallel forwarder path: rejected because
  it would duplicate request mutation and retry ownership.
- Copy the entire legacy commit unchanged: rejected because it predates the
  fresh grouped credential and protocol policy contracts.
- Omit the feature: rejected because provider-specific overload handling remains
  unavailable and the fresh route admission surface is incomplete.

## Ownership boundary

- `ProviderMeta` stores only the persisted policy declaration.
- `codex_traffic_policy` resolves defaults and clamps user values.
- `ProviderRouter` owns route-scoped admission semaphores.
- `RequestForwarder` owns the single finalized payload and invokes the resolver;
  it does not implement a second credential or transform pipeline.

## Affected files

Backend provider metadata, proxy policy/router/forwarder/error layers, and the
Codex provider form plus all locale files. Existing protocol and grouped-key
tests remain regression coverage.

## Approval / implementation / verification / runtime freshness

- Approval: approved by user on 2026-10-03.
- Implementation: in-progress.
- Verification: not-run for this slice.
- Runtime freshness: not-checked.

## Status transitions

- 2026-10-03: decision recorded before implementation; approval is explicit,
  implementation and verification remain separate.
