import { describe, expect, it } from "vitest";
import { reconcileFetchedCodexCatalogRows } from "./codexCatalogReconciliation";
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
});
