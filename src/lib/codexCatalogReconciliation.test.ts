import { describe, expect, it } from "vitest";
import { pruneMissingRemoteCodexCatalogRows } from "./codexCatalogReconciliation";

describe("pruneMissingRemoteCodexCatalogRows", () => {
  it("removes missing remote-bound rows while preserving aliases and manual rows", () => {
    const result = pruneMissingRemoteCodexCatalogRows(
      [
        { model: "friendly", upstreamModel: "remote-kept", enabled: false },
        { model: "remote-stale", upstreamModel: "remote-stale" },
        { model: "manual-entry" },
      ],
      [{ id: "REMOTE-KEPT" }, { id: "remote-new" }],
    );

    expect(result.removed).toBe(1);
    expect(result.rows).toEqual([
      { model: "friendly", upstreamModel: "remote-kept", enabled: false },
      { model: "manual-entry" },
    ]);
  });
});
