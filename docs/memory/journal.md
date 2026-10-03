# Engineering Journal

## 2026-10-03 BigStrongSun replacement foundation started

What happened: the user approved replacing the legacy fork foundation with a fresh BigStrongSun refork and adapting distinctive behavior incrementally. Root cause: the legacy branch had diverged across hundreds of files and retained older save/probe ownership, while BigStrongSun now provides provider-set and protocol-lab boundaries. What we did: cloned `BigStrongSun/ccswitchmulti` at `b4741ade`, retained the dirty legacy checkout at `641d53c8` as read-only migration evidence, and recorded a single-owner, deletion-gated port strategy in `docs/decisions/2026-10-03-bigstrongsun-refork-foundation.md`. Evidence: clean-foundation `cargo check` passed, `pnpm install --frozen-lockfile` passed, and `pnpm typecheck` passed. What NOT to do again: do not bulk replay legacy commits or create parallel save/probe orchestration in the fresh foundation.
