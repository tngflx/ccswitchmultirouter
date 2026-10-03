import { describe, expect, it } from "vitest";
import { reconcileFetchedCodexCatalogRows } from "./codexCatalogReconciliation";
import type { CodexCatalogRowLike } from "./codexCatalogReconciliation";

const createRow = (seed: Record<string, unknown>): CodexCatalogRowLike => ({
  model: String(seed.model ?? ""),
  displayName: String(seed.displayName ?? seed.model ?? ""),
  enabled: seed.enabled !== false,
  ...seed,
}) as CodexCatalogRowLike;

describe("reconcileFetchedCodexCatalogRows", () => {
  it("matches aliases and preserves an explicit disabled choice", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [createRow({ model: "visible", upstreamModel: "upstream", enabled: false })],
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
    expect(result.rows[0]).toMatchObject({ model: "new-model", enabled: false, supportsImage: true });
  });
});
