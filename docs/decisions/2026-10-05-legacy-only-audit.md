# Legacy-Only Candidate Audit

## Goal

Finish the fresh-refork migration by classifying legacy files that have no
direct counterpart in the fresh tree, without reintroducing duplicate owners
or preserving code that the reference architecture intentionally removed.

## Evidence

The remaining legacy-only candidates were:

- `src/components/common/DeferredContent.tsx`
- `src/contexts/GlobalLoadingContext.tsx`
- `tests/components/DeferredContent.test.tsx`
- `tests/components/GlobalLoadingProvider.test.tsx`
- `src/components/providers/forms/hooks/useLoadCommonConfigSnippet.ts`
- `tests/hooks/useLoadCommonConfigSnippet.test.tsx`
- `src-tauri/src/resources/codex_app_compat_template.js`

The fresh refork has no global-loading or deferred-render consumers. Its
common-config behavior is implemented directly by the app-specific
`useCommonConfigSnippet`, `useCodexCommonConfig`, and
`useGeminiCommonConfig` hooks. Its Codex Desktop injector includes the
standalone `codex_model_picker_core.js` and does not reference the legacy
template.

The verified BigStrongSun reference contains `useCommonConfigSnippet` but no
`useLoadCommonConfigSnippet`, and its history includes the deliberate removal
of dead common-config plumbing (`69ff69dd7`, “drop dead common-config code”).
The original reference was inspected for the same paths; the global-loading
and compatibility-template files are fork-specific additions rather than
reference architecture.

## Decision

- **Reject** `codex_app_compat_template.js` and its tests as a duplicate. The
  fresh standalone model-picker core is the single Codex Desktop compatibility
  injector owner.
- **Reject** `useLoadCommonConfigSnippet.ts` and its tests as a duplicate. The
  fresh app-specific hooks own loading, validation, migration, and persistence
  with their format-specific state machines.
- **Defer** `DeferredContent.tsx`, `GlobalLoadingContext.tsx`, and their tests.
  They are a legacy global UX layer with no fresh consumers or upstream
  equivalent. Reintroducing the provider would add cross-cutting loading
  behavior without a current fresh ownership boundary. Revisit only if a
  concrete fresh workflow demonstrates the need for deferred mounting or a
  global progress surface.

## Alternatives

- Copy all remaining legacy files: rejected because it would restore a second
  common-config owner and a second Codex compatibility injector, while adding
  unused global UI infrastructure.
- Port global loading immediately: deferred because the fresh UI uses local
  query/mutation loading states and the reference architecture intentionally
  does not expose this global layer.

## Ownership Boundary

The fresh app-specific form hooks own common-config state and persistence.
`codex_desktop.rs` plus `codex_model_picker_core.js` own Codex Desktop
compatibility injection. Existing fresh components own their local loading
states. No legacy-only file is copied into the production path by this audit.

## Affected Files

- `docs/decisions/2026-10-05-legacy-only-audit.md`
- `docs/memory/journal.md`

## Approval / implementation / verification

- Approval: approved by the user's instruction to complete the fresh-refork
  migration and make it the replacement foundation.
- Implementation: complete (2026-10-05); no legacy-only source file was
  reintroduced.
- Verification: audit completed with `git ls-remote`, reference-history
  inspection, fresh-tree searches, and fresh upstream tree inspection. No
  source tests were required for this documentation-only decision. Full
  migration verification remains pending.
- Runtime freshness: not checked; the desktop app has not been rebuilt and
  restarted.
