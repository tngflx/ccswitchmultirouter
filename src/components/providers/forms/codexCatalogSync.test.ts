import { describe, expect, it } from "vitest";

import {
  reconcileFetchedCodexCatalogRows,
  type CodexCatalogRowLike,
} from "./codexCatalogSync";

const source = { providerName: "Sublyx", baseUrl: "https://api.example.com" };

function createRow(seed: CodexCatalogRowLike): CodexCatalogRowLike {
  return { ...seed };
}

const remoteModels = [
  { id: "keep-me", contextWindow: 128000, inputModalities: ["text"] },
  { id: "blocked-model", contextWindow: 64000 },
  { id: "new-model" },
];

describe("reconcileFetchedCodexCatalogRows", () => {
  it("does not confuse an alias with another fetched upstream id", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [{ model: "new-upstream", upstreamModel: "real-upstream" }],
      [{ id: "real-upstream" }, { id: "new-upstream" }],
      source,
      { appendNew: true, createRow },
    );
    expect(result.rows.map((row) => [row.model, row.upstreamModel])).toEqual([
      ["new-upstream", "real-upstream"],
      ["new-upstream", "new-upstream"],
    ]);
  });

  it("keeps disabled rows excluded and does not re-add their identities", () => {
    const initial: CodexCatalogRowLike[] = [
      { model: "Keep Me", upstreamModel: "keep-me", contextWindow: "" },
      { model: "blocked-model", enabled: false },
    ];

    const result = reconcileFetchedCodexCatalogRows(
      initial,
      remoteModels,
      source,
      { appendNew: true, createRow },
    );

    expect(result.rows.map((row) => row.model)).toEqual([
      "Keep Me",
      "blocked-model",
      "new-model",
    ]);
    expect(result.added).toBe(1);
    expect(result.updated).toEqual(["keep-me", "blocked-model"]);
    expect(result.rows[0].enabled).toBeUndefined();
    expect(result.rows[1].enabled).toBe(false);
    expect(result.rows[0].contextWindow).toBe("128000");
  });

  it("fills only empty fields and never appends during refill", () => {
    const initial: CodexCatalogRowLike[] = [
      {
        model: "manual-alias",
        upstreamModel: "",
        contextWindow: "200000",
        supportsImage: false,
      },
      { model: "", contextWindow: "" },
    ];

    const result = reconcileFetchedCodexCatalogRows(
      initial,
      [
        {
          id: "manual-alias",
          contextWindow: 999,
          inputModalities: ["text", "image"],
          supportsImage: true,
        },
        { id: "should-not-append" },
      ],
      source,
      { appendNew: false, createRow },
    );

    expect(result.rows).toHaveLength(2);
    expect(result.added).toBe(0);
    // The visible name already equals the remote id, so there is no alias to
    // record. Writing `upstreamModel: "manual-alias"` here would be a no-op
    // that reclassifies a manually maintained row as remotely bound, and
    // `pruneMissingRemoteCodexCatalogRows` would then delete it on the first
    // refresh that omits it.
    expect(result.hydrated).toBe(0);
    expect(result.updated).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      model: "manual-alias",
      upstreamModel: "",
      contextWindow: "200000",
      supportsImage: false,
    });
  });

  it("records an upstream binding when the visible name is a real alias", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [
        {
          model: "gpt-5.6-sol-sublyx",
          upstreamModel: "gpt-5.6-sol",
          contextWindow: "",
        },
      ],
      [{ id: "gpt-5.6-sol", contextWindow: 999 }],
      source,
      { appendNew: false, createRow },
    );

    // The alias is matched through the upstream id the wizard persisted, so
    // the remote refresh hydrates the alias row instead of appending a
    // duplicate plain `gpt-5.6-sol` row beside it.
    expect(result.rows[0]).toMatchObject({
      model: "gpt-5.6-sol-sublyx",
      upstreamModel: "gpt-5.6-sol",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.added).toBe(0);
  });

  it("does not prune a bound alias while its upstream model is still offered", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [
        { model: "gpt-5.6-sol-sublyx", upstreamModel: "gpt-5.6-sol" },
        { model: "gpt-6-astra", upstreamModel: "gpt-6-astra" },
        { model: "gpt-6-luna", upstreamModel: "gpt-6-luna" },
        { model: "gpt-6-sol", upstreamModel: "gpt-6-sol" },
      ],
      [{ id: "gpt-5.6-sol" }, { id: "gpt-6-sol" }],
      source,
      {
        appendNew: true,
        createRow,
        existingMetadataMode: "refresh",
        removeMissingRemote: true,
        maxRemovalRatio: 1,
      },
    );

    // The wizard's alias must survive a refresh that legitimately drops the
    // other models; it is still routable through `gpt-5.6-sol`.
    expect(result.rows.map((row) => row.model)).toContain("gpt-5.6-sol-sublyx");
  });

  it("keeps every catalog row when a refresh returns a truncated list", () => {
    const initial: CodexCatalogRowLike[] = [
      { model: "gpt-5.6-sol", upstreamModel: "gpt-5.6-sol" },
      { model: "gpt-6-astra", upstreamModel: "gpt-6-astra" },
      { model: "gpt-6-luna", upstreamModel: "gpt-6-luna" },
      { model: "gpt-6-sol", upstreamModel: "gpt-6-sol" },
    ];

    const result = reconcileFetchedCodexCatalogRows(
      initial,
      [{ id: "gpt-6-sol" }],
      source,
      {
        appendNew: true,
        createRow,
        existingMetadataMode: "refresh",
        removeMissingRemote: true,
        maxRemovalRatio: 0.5,
      },
    );

    // A single-model response is not authoritative evidence that the other
    // three were retired upstream; keep them and say the removal was declined.
    expect(result.rows.map((row) => row.model)).toEqual([
      "gpt-5.6-sol",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-6-sol",
    ]);
    expect(result.removed).toBe(0);
    expect(result.removalSuppressed).toBe(true);
    expect(result.removedModels).toEqual([
      "gpt-5.6-sol",
      "gpt-6-astra",
      "gpt-6-luna",
    ]);
  });

  it("still removes a small genuinely-missing set", () => {
    const initial: CodexCatalogRowLike[] = [
      { model: "a", upstreamModel: "a" },
      { model: "b", upstreamModel: "b" },
      { model: "c", upstreamModel: "c" },
      { model: "d", upstreamModel: "d" },
    ];

    const result = reconcileFetchedCodexCatalogRows(
      initial,
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
      source,
      {
        appendNew: true,
        createRow,
        existingMetadataMode: "refresh",
        removeMissingRemote: true,
      },
    );

    expect(result.rows.map((row) => row.model)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(result.removed).toBe(0);
    expect(result.removalSuppressed).toBe(false);
  });

  it("preserves catalog order and existing row state when syncing", () => {
    const initial: CodexCatalogRowLike[] = [
      { model: "z-existing", displayName: "Custom", enabled: true },
      { model: "hidden", enabled: false },
    ];

    const result = reconcileFetchedCodexCatalogRows(
      initial,
      [{ id: "a-new" }, { id: "z-existing" }],
      source,
      { appendNew: true, createRow },
    );

    expect(result.rows.map((row) => row.model)).toEqual([
      "z-existing",
      "hidden",
      "a-new",
    ]);
    expect(result.rows[0].displayName).toBe("Custom");
    expect(result.rows[0].enabled).toBe(true);
    expect(result.rows[1].enabled).toBe(false);
  });

  it("refreshes stale provider metadata without changing user-owned catalog fields", () => {
    const initial: CodexCatalogRowLike[] = [
      {
        model: "friendly-gpt",
        upstreamModel: "gpt-5.5",
        displayName: "My GPT",
        contextWindow: "128000",
        inputModalities: ["text"],
        supportsImage: false,
        textOnly: true,
        enabled: false,
        sortIndex: 7,
        reasoning: {
          schemaVersion: 2,
          supportStatus: "unknown",
          controlKind: "none",
          supportedEfforts: [],
          disableAllowed: true,
          upstream: { format: "none", parameter: "none" },
          source: "user",
        },
      },
    ];

    const result = reconcileFetchedCodexCatalogRows(
      initial,
      [
        {
          id: "gpt-5.5",
          contextWindow: 272000,
          inputModalities: ["text", "image"],
          supportsImage: true,
        },
      ],
      source,
      { appendNew: false, createRow, existingMetadataMode: "refresh" },
    );

    expect(result.hydrated).toBe(1);
    expect(result.updated).toEqual(["gpt-5.5"]);
    expect(result.rows[0]).toMatchObject({
      model: "friendly-gpt",
      upstreamModel: "gpt-5.5",
      displayName: "My GPT",
      contextWindow: "272000",
      inputModalities: ["text", "image"],
      supportsImage: true,
      textOnly: false,
      enabled: false,
      sortIndex: 7,
    });
    expect(result.rows[0].reasoning?.source).toBe("user");
  });
});
