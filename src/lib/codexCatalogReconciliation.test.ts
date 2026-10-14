import { describe, expect, it } from "vitest";
import {
  isCompleteCodexCatalogFetch,
  pruneMissingRemoteCodexCatalogRows,
  reconcileFetchedCodexCatalogRows,
} from "./codexCatalogReconciliation";
import type { CodexCatalogRowLike } from "./codexCatalogReconciliation";

const createRow = (seed: Record<string, unknown>): CodexCatalogRowLike =>
  ({
    model: String(seed.model ?? ""),
    displayName: String(seed.displayName ?? seed.model ?? ""),
    enabled: seed.enabled !== false,
    ...seed,
  }) as CodexCatalogRowLike;

describe("reconcileFetchedCodexCatalogRows", () => {
  it("matches aliases and preserves an explicit disabled choice", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [
        createRow({
          model: "visible",
          upstreamModel: "upstream",
          enabled: false,
        }),
      ],
      [{ id: "upstream", aliases: ["visible-alias"], supportsImage: true }],
      {},
      { appendNew: true, createRow },
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].enabled).toBe(false);
    expect(result.rows[0].supportsImage).toBe(true);
  });

  it("does not bind a manually maintained row when its visible name is fetched", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [createRow({ model: "manual-model" })],
      [{ id: "manual-model", supportsImage: false }],
      {},
      { appendNew: true, createRow },
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].upstreamModel).toBeUndefined();
  });

  it("appends newly discovered inventory as disabled", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [],
      [{ id: "new-model", inputModalities: ["text", "image"] }],
      {},
      { appendNew: true, createRow },
    );
    expect(result.added).toBe(1);
    expect(result.rows[0]).toMatchObject({
      model: "new-model",
      enabled: false,
      supportsImage: true,
    });
  });

  it("infers known context and refreshes provider-owned metadata without replacing user fields", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [
        createRow({
          model: "deepseek-chat",
          displayName: "My DeepSeek",
          contextWindow: "64000",
          reasoning: { source: "user", supportStatus: "unknown" },
        }),
      ],
      [
        {
          id: "deepseek-chat",
          inputModalities: ["text", "image"],
          supportsImage: true,
          reasoning: {
            schemaVersion: 2,
            supportStatus: "confirmed_supported",
            controlKind: "graded",
            supportedEfforts: ["low"],
            disableAllowed: false,
            upstream: {
              format: "reasoning_object",
              parameter: "reasoning.effort",
            },
            source: "protocol",
          },
        },
      ],
      {},
      { appendNew: true, createRow, existingMetadataMode: "refresh" },
    );
    expect(result.rows[0]).toMatchObject({
      model: "deepseek-chat",
      displayName: "My DeepSeek",
      contextWindow: "64000",
      supportsImage: true,
    });
    expect(result.rows[0].reasoning?.source).toBe("user");
  });

  it("removes only explicitly remote-bound rows and suppresses suspicious mass deletion", () => {
    const rows = [
      createRow({ model: "remote-one", upstreamModel: "remote-one" }),
      createRow({ model: "manual-one" }),
    ];
    const removed = reconcileFetchedCodexCatalogRows(
      rows,
      [],
      {},
      {
        appendNew: false,
        createRow,
        removeMissingRemote: true,
      },
    );
    expect(removed.removed).toBe(1);
    expect(removed.rows.map((row) => row.model)).toEqual(["manual-one"]);

    const suppressed = reconcileFetchedCodexCatalogRows(
      rows,
      [],
      {},
      {
        appendNew: false,
        createRow,
        removeMissingRemote: true,
        maxRemovalRatio: 0.5,
      },
    );
    expect(suppressed.removed).toBe(0);
    expect(suppressed.removalSuppressed).toBe(true);
    expect(suppressed.rows).toHaveLength(2);
    expect(suppressed.removedModels).toEqual(["remote-one"]);
  });

  it("can demote omitted unbound rows without touching explicitly hidden rows", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [
        createRow({ model: "kept-model" }),
        createRow({ model: "removed-model" }),
        createRow({ model: "hidden-model", enabled: false }),
      ],
      [{ id: "kept-model" }],
      {},
      {
        appendNew: false,
        createRow,
        removeMissingRemote: true,
        includeUnboundRemoteRows: true,
        markMissingRemoteDisabled: true,
      },
    );

    expect(result.rows).toEqual([
      expect.objectContaining({ model: "kept-model", enabled: true }),
      expect.objectContaining({ model: "removed-model", enabled: false }),
      expect.objectContaining({ model: "hidden-model", enabled: false }),
    ]);
    expect(result.removed).toBe(0);
    expect(result.removedModels).toEqual(["removed-model"]);
  });

  it("does not append a duplicate when a fetched alias matches an existing binding", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [createRow({ model: "visible-name", upstreamModel: "upstream-name" })],
      [{ id: "upstream-name", aliases: ["visible-name"] }],
      {},
      { appendNew: true, createRow },
    );
    expect(result.added).toBe(0);
    expect(result.rows).toHaveLength(1);
  });

  it("uses stable binding identities for unbound rows during authoritative pruning", () => {
    const kept = createRow({
      model: "visible-model",
      canonicalSlug: "wire-model",
    });
    const removed = createRow({
      model: "wire-model",
      upstreamModel: "removed-wire-model",
    });
    const result = pruneMissingRemoteCodexCatalogRows(
      [kept, removed],
      [{ id: "wire-model" }],
      { includeUnboundRows: true, markMissingDisabled: true },
    );

    expect(result.rows[0]).toBe(kept);
    expect(result.rows[1]).toMatchObject({
      model: "wire-model",
      upstreamModel: "removed-wire-model",
      enabled: false,
    });
  });

  it("still deletes absent hidden remote rows when physical removal is requested", () => {
    const result = pruneMissingRemoteCodexCatalogRows(
      [createRow({ model: "hidden", upstreamModel: "wire", enabled: false })],
      [],
    );

    expect(result.rows).toEqual([]);
    expect(result.removed).toBe(1);
    expect(result.removedModels).toEqual(["hidden"]);
  });

  it("applies mass-removal protection to unbound enabled inventory too", () => {
    const rows = [
      createRow({ model: "kept" }),
      createRow({ model: "removed" }),
      createRow({ model: "hidden", enabled: false }),
    ];
    const result = pruneMissingRemoteCodexCatalogRows(rows, [{ id: "kept" }], {
      includeUnboundRows: true,
      markMissingDisabled: true,
      maxRemovalRatio: 0.25,
    });

    expect(result.removalSuppressed).toBe(true);
    expect(result.rows).toBe(rows);
    expect(result.removedModels).toEqual(["removed"]);
  });

  it("does not treat a single-key fetch as complete when independent key groups exist", () => {
    expect(isCompleteCodexCatalogFetch(undefined)).toBe(true);
    expect(isCompleteCodexCatalogFetch([])).toBe(true);
    expect(isCompleteCodexCatalogFetch([{ apiKeys: [" "] }])).toBe(true);
    expect(isCompleteCodexCatalogFetch([{ apiKeys: ["group-key"] }])).toBe(
      false,
    );
  });
});
