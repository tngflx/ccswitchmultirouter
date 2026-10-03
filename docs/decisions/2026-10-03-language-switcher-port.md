# Restore Quick Language Switching With One Language Contract

- Date: 2026-10-03
- Approval: approved
- Implementation: complete
- Verification: passed
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: User instruction to port distinctive legacy behavior into the fresh BigStrongSun refork and make it the eventual foundation.
- Parent decision: `docs/decisions/2026-10-03-bigstrongsun-refork-foundation.md`

## Goal and evidence

The fresh refork has four locales and a language control inside Settings, but it
does not have the legacy header quick switcher. Its i18n bootstrap and settings
form also independently normalize languages and currently fall back to Chinese,
contrary to the fork contract that English is the default.

Reference review found no overlapping BigStrongSun change or relevant original
upstream implementation to adopt. The original repository's open Russian locale
work does not change this four-locale ownership decision.

## Decision

Add one shared supported-language parser with an English fallback, consume it at
the i18n bootstrap and settings-form boundaries, and adapt the legacy header
switcher to the fresh header action group. The switcher uses the existing
`useSaveSettingsMutation` as its only backend persistence owner. It updates i18n
and local storage optimistically, then restores both if the settings save fails.

## Alternatives and tradeoffs

- Copy the legacy component unchanged: rejected because it would create a third
  normalization implementation and leaves the UI in an unsaved language after a
  mutation failure.
- Require users to open Settings: rejected because it drops an established fork
  workflow without an architectural benefit.
- Add a separate language-save API or local settings owner: rejected because the
  fresh settings mutation already owns the persistence contract.
- Keep Chinese as the unknown/missing fallback: rejected because the fork's
  documented default and `Settings` contract require English.

## Ownership and affected files

- `src/i18n/language.ts`: supported-language parsing and English default.
- `src/i18n/index.ts` and `src/hooks/useSettingsForm.ts`: shared normalization.
- `src/components/settings/LanguageSettings.tsx`: shared language type.
- `src/components/settings/LanguageSwitcher.tsx`: header quick switch and save
  rollback behavior.
- `src/App.tsx`: existing header action-group integration.
- Existing localized settings keys and focused parser/component/hook tests.

## Verification plan

Run focused language switcher and settings-form Vitest suites, `pnpm typecheck`,
Prettier on changed frontend files, and `git diff --check`. Full suites remain
reserved for the final migration boundary.

## Status history

- 2026-10-03: decision recorded before implementation; approval is covered by
  the user's explicit fresh-refork migration instruction.
- 2026-10-03: implemented the shared language contract, header switcher,
  optimistic save rollback, and English fallback. Focused tests, dependent App
  and Settings tests, typecheck, formatting, and diff checks passed. Runtime
  freshness remains not-checked because no rebuilt desktop process was requested.
