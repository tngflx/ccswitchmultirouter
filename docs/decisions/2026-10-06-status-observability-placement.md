# Status Observability Placement

## Goal

Put operational Request Health diagnostics in the Codex MultiRouter Status
page, and keep stream-retry activity out of the general Link status view.

## Evidence

- `RequestHealthPanel` is currently mounted under the Settings > Advanced
  accordion, even though it reads proxy runtime diagnostics and is not a
  general application preference.
- `StreamRetryActivityPanel` is mounted twice in `StatusTab`: once in the
  general Link view and once in the dedicated Stream retry view.

## Decision

- Move the Request Health snapshot/loading state and panel mount into
  `CodexRouterWorkspacePage`'s Status tab.
- Expose Request Health as its own Status subview so the Link view remains
  focused on listener, takeover, route, and forwarding readiness.
- Remove the Request Health accordion from Settings.
- Render StreamRetryActivityPanel only in its dedicated Stream retry subview.
- Keep the existing global retry event bridge and backend APIs unchanged.

## Alternatives

- Keep Request Health inside Link: rejected because the diagnostic/configuration
  panel would make the primary link-readiness view noisy.
- Keep retry activity in both views: rejected because it duplicates the same
  live event feed and makes the source of truth unclear.

## Ownership

Frontend ownership is limited to `SettingsPage.tsx` and
`CodexRouterWorkspacePage.tsx`, plus focused tests. The existing
`RequestHealthPanel`, proxy API, and retry event bridge remain reusable and
unchanged.

## Approval

- status: not-approved
- basis: routine UI relocation explicitly requested by the user

## Implementation

- status: implemented
- date: 2026-10-06

## Verification

- status: verified-targeted
- frontend: `CodexRouterWorkspacePage.test.ts` targeted placement test passed;
  stream-retry/settings dependents passed 3 files / 21 tests;
  `pnpm typecheck` passed; scoped Prettier check and `git diff --check` passed.
  The full `CodexRouterWorkspacePage.test.ts` file was 115 passed / 1 failed;
  the remaining failure is an unrelated localization assertion for
  `Codex egress environment monitoring`.
- runtime freshness: pending user restart of `pnpm dev` if live inspection is
  required

## Correction

The workspace header had also mounted `StreamRetryHeaderToggle`, which duplicated
the global Providers-header control. It was removed so the main Providers header
is the single retry control. Link status renders no retry activity feed; the
dedicated Stream retry status subview renders exactly one activity panel.
