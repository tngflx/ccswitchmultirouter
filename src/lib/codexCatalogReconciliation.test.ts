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

  it("keeps a row when the returned canonical model only matches its alias", () => {
    const result = pruneMissingRemoteCodexCatalogRows(
      [
        {
          model: "friendly-alias",
          upstreamModel: "friendly-alias",
        },
        { model: "stale", upstreamModel: "stale" },
      ],
      [
        {
          id: "provider-canonical-id",
          aliases: ["friendly-alias"],
        },
      ],
    );

    expect(result.rows).toEqual([
      {
        model: "friendly-alias",
        upstreamModel: "friendly-alias",
      },
    ]);
    expect(result.removedModels).toEqual(["stale"]);
  });

  it("does not merge distinct IDs that share a display name", () => {
    const result = pruneMissingRemoteCodexCatalogRows(
      [
        { model: "first", upstreamModel: "first", name: "Shared Name" },
        { model: "second", upstreamModel: "second", name: "Shared Name" },
      ],
      [{ id: "first", name: "Shared Name" }],
    );

    expect(result.rows.map((row) => row.model)).toEqual(["first"]);
  });
});
