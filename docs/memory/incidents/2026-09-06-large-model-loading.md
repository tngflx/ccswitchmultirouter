# Large model catalogs and loading feedback

## Findings and changes

- Opening the shared model dropdown mounted the entire fetched catalog. A loading
  icon cannot make that synchronous React work interruptible. The picker now
  searches the full catalog but mounts at most 20 choices, after a loading shell
  has had a chance to paint. Its search input receives focus after deferred mount.
- OpenCode already paged its structured model editor at 40 rows, and Codex already
  paged its catalog editor. Their existing paging was not the missing invariant.
  The raw provider JSON editors could still grow to thousands of lines; OpenCode,
  OMO, OpenClaw, and Hermes now supply a 280px editor height so CodeMirror can
  render its viewport rather than the entire expanded document.
- OpenClaw/Hermes model editors, OMO choices, protocol-probe model progress,
  OpenAI API model choices, and router hidden/include/candidate model lists now
  use bounded pages. Filtering happens before paging and editor callbacks retain
  the original index. Adding an editor item reveals its page; no models are
  removed from persisted configuration or silently truncated.
- Cached fetched models used to hide the refresh spinner. Loading now takes
  precedence over cached choices in ModelInputWithFetch.
- EditProviderDialog now waits for its live-config read before mounting the form,
  avoiding a redundant expensive initialization. Failed current-provider lookups
  and empty live responses settle readiness and allow the stored config fallback.
  Add/edit dialogs defer form mounting until their loading shell can paint.
- Initial observed TanStack queries now participate in the global loading banner.
  Cached background refreshes remain quiet; query metadata can opt out. The OMO
  live-provider-ID lookup participates in manual loading with finally/cleanup.
- OpenCode initial configuration parsing is lazy, avoiding repeated parsing on
  unrelated form renders.
- Router model ordering uses the existing TanStack virtualizer with measured
  rows and a 480px scroll viewport. The active sortable stays mounted outside the
  viewport during dragging, preserving cross-catalog reordering. A memoized
  provider/model index replaces repeated catalog parsing/scanning for each row.

## Reference verdict

Inspected recent commits, open/closed pull requests, nearby OpenCode form history,
and the shared dropdown implementation in BigStrongSun/ccswitchmulti and
farion1231/cc-switch. BigStrongSun still groups/maps the whole dropdown. Farion's
searchable cmdk interaction also mounts the whole matching catalog. Adapted the
searchable interaction with bounded rendering locally; neither supplied a
complete fix. Relevant implementation history included 2deee109 (shared dropdown),
50170029 (model fetching), and 6245caa6 (OpenCode known fields).

## Verification scope

- Targeted run: 14 files, 69 tests passed, covering shared paging/loading,
  OpenCode/OpenClaw/Hermes editors, add/edit dialogs, probe progress, OMO merge,
  OpenCode state, and related provider forms/hooks.
- Related router wizard run: 2 files, 76 tests passed. The large-editor tests also
  passed again after correcting their Hermes callback's optional-name typing.
- Headless Chromium using the existing renderer at localhost:3000: 431-model
  OpenCode/OpenClaw/Hermes forms at 1280x900 and 375x812. Mounted model rows were
  40/20/20 respectively. Searching/editing the last model and revisiting the
  filtered result preserved its edit. No horizontal overflow or page errors.
- Shared dropdown at both sizes: 20 choices, next page, search/select model 431,
  and focused search input passed. The 280px CodeMirror rendered 36 visible lines
  from the large JSON fixture. Screenshots inspected for the mobile picker/form.
- Router ordering at both viewport sizes: 13 of 431 rows mounted; keyboard reorder,
  scrolling to the last model, and dragging the first model across the full scroll
  range to position 431 passed. No horizontal overflow or page errors. The mobile
  screenshot was inspected.
- Existing Node localStorage, unmatched MSW handler, and wizard act warnings remain.
- Live Tauri runtime, backend/full suites, and a codebase-wide latency benchmark
  were not run. Browser fixtures are component checks, not live Tauri evidence.
- Router selection lists were changed, but their full route-edit/save workflows
  were not exercised in the browser. These bounded rendering checks do not prove
  that every asynchronous operation throughout the application has a loader.

## Follow-up audit

The follow-up inventoried 131 frontend files containing async/query/pending paths.
That inventory is a search aid, not evidence that every screen was exercised.

| Area | Result |
| --- | --- |
| Usage model/source filters | Replaced eager options with the shared searchable 20-item picker; preserved encoded `all` sentinel semantics. |
| Common provider config | ProviderForm now consumes Claude/Codex/Gemini loading flags, displays LoadingStatus, and reports busy state to dialog save controls. |
| Provider identity | Opening another provider/app/takeover mode remounts the edit session so live readiness/data cannot belong to the previous provider. |
| Workspace files | Session identity and read cancellation prevent stale content; failed reads display an error and disable saving. |
| Skill storage | Pending spinner exists in both migration directions. |
| Pricing retry | Retry with no data keeps the loading state while fetching. Existing pricing row cap remains. |
| Export/deep links | Direct export and config merging now participate in global loading. |
| Settings metadata | Loading already flows through useSettings' combined loading state. |
| Environment deletion / xAI OAuth | Existing operation-specific pending states found. |
| Event bridges/theme/zoom | Background synchronization and listener setup do not warrant a permanent action loader. |

Additional evidence: the co-located router suite passed 90/90 after providing
jsdom a viewport (it has no browser layout). The first new workspace regression
fixture had an unstable translation function, causing repeated reads; stabilizing
that fixture yielded both regression passes. Seven related files passed 33 tests.
Migration passed 2 tests, shared picker passed 3, and delayed common initialization
passed 1. A broader Codex consumer rerun passed 67/72: four preset tests still
expect the old GLM endpoint/models, while the unchanged preset source supplies
`https://open.bigmodel.cn/api/v1` and `glm-5.3`/`glm-5-turbo`; one key-group test
expects Rotation to be absent despite another edit making it always visible.
The failed assertions were preserved. Typecheck still fails on the unrelated
unused readiness callback. Full suites and the live Tauri process remain untested.

The prior browser checks were repeated for the shared picker/JSON viewport at
desktop/mobile sizes and passed. This is renderer fixture evidence, not evidence
that a running packaged desktop app has loaded these source changes.

## Do not repeat

Do not treat adding a spinner as a fix for synchronous rendering stalls. Bound
the rendered work at its owner and preserve all source data. Do not replace
sortable lists with pagination without retaining cross-page reorder semantics.
Do not attribute the pre-existing dirty Codex/Rust files to this loading task.
