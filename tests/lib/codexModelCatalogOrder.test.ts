import { describe, expect, it } from "vitest";
import {
  applyCodexCatalogModelOrder,
  groupCodexCatalogModelsByProvider,
} from "@/lib/codexModelCatalogOrder";

describe("applyCodexCatalogModelOrder", () => {
  it("keeps route-owned provider blocks contiguous when saved ranks interleave and inventory grows", () => {
    const models = [
      { model: "a1", targetProviderId: "alpha", providerName: "Alpha" },
      { model: "a2", targetProviderId: "alpha", providerName: "Alpha" },
      { model: "a-new", targetProviderId: "alpha", providerName: "Alpha" },
      { model: "b1", targetProviderId: "beta", providerName: "Beta" },
      { model: "b2", targetProviderId: "beta", providerName: "Beta" },
      { model: "b-new", targetProviderId: "beta", providerName: "Beta" },
    ];
    expect(
      applyCodexCatalogModelOrder(models, [
        "b2",
        "a2",
        "b1",
        "a1",
        "removed",
      ]).map((row) => row.model),
    ).toEqual(["a2", "a1", "a-new", "b2", "b1", "b-new"]);
  });

  it("groups repeated routes by provider ID without merging providers sharing a display name", () => {
    const models = [
      { model: "a1", targetProviderId: "alpha", providerName: "Same name" },
      { model: "b1", targetProviderId: "beta", providerName: "Same name" },
      { model: "a2", targetProviderId: "alpha", providerName: "Renamed Alpha" },
    ];
    expect(
      applyCodexCatalogModelOrder(models, []).map((row) => row.model),
    ).toEqual(["a1", "a2", "b1"]);
  });

  it("normalizes an arbitrary UI reorder against canonical route-owned provider order", () => {
    const reference = [
      { model: "a1", targetProviderId: "alpha" },
      { model: "a2", targetProviderId: "alpha" },
      { model: "b1", targetProviderId: "beta" },
      { model: "b2", targetProviderId: "beta" },
    ];
    const reordered = [reference[3], reference[1], reference[2], reference[0]];
    expect(
      groupCodexCatalogModelsByProvider(reordered, reference).map(
        (row) => row.model,
      ),
    ).toEqual(["a2", "a1", "b2", "b1"]);
    expect(
      applyCodexCatalogModelOrder(reordered, [], reference).map(
        (row) => row.model,
      ),
    ).toEqual(["a2", "a1", "b2", "b1"]);
    expect(reordered.map((row) => row.model)).toEqual(["b2", "a2", "b1", "a1"]);
  });

  it("preserves router ordering and compresses deleted ranks", () => {
    const previous = ["e", "c", "a", "d", "b"];
    // 删除某个供应商后重建结果只剩它以外的模型，且顺序来自 route 迭代。
    const rebuilt = [{ model: "a" }, { model: "b" }, { model: "e" }];

    expect(applyCodexCatalogModelOrder(rebuilt, previous)).toEqual([
      { model: "e", sortIndex: 0 },
      { model: "a", sortIndex: 1 },
      { model: "b", sortIndex: 2 },
    ]);
  });

  it("appends new models after saved router ranks", () => {
    const previous = ["b", "a"];
    const rebuilt = [
      { model: "a" },
      { model: "new-1" },
      { model: "b" },
      { model: "new-2" },
    ];

    expect(applyCodexCatalogModelOrder(rebuilt, previous)).toEqual([
      { model: "b", sortIndex: 0 },
      { model: "a", sortIndex: 1 },
      { model: "new-1", sortIndex: 2 },
      { model: "new-2", sortIndex: 3 },
    ]);
  });

  it("restores default source array order when router ordering is empty", () => {
    const previous: string[] = [];
    const rebuilt = [{ model: "a" }, { model: "new" }, { model: "e" }];

    expect(applyCodexCatalogModelOrder(rebuilt, previous)).toEqual([
      { model: "a" },
      { model: "new" },
      { model: "e" },
    ]);
  });

  it("ignores source indexes when the router has no custom order", () => {
    const previous: string[] = [];
    const rebuilt = [
      { model: "b", sortIndex: 7 },
      { model: "a", sortIndex: 3 },
    ];

    expect(applyCodexCatalogModelOrder(rebuilt, previous)).toEqual([
      { model: "b" },
      { model: "a" },
    ]);
    expect(rebuilt[0].sortIndex).toBe(7);
  });

  it("ignores unavailable saved names rather than inventing custom ranks", () => {
    expect(
      applyCodexCatalogModelOrder([{ model: "a", sortIndex: 4 }], ["removed"]),
    ).toEqual([{ model: "a" }]);
  });

  it("matches mixed case and first duplicates, with exact IDs winning over recovery", () => {
    expect(
      applyCodexCatalogModelOrder(
        [{ model: "alias", upstreamModel: "wire" }, { model: "b" }],
        ["WIRE", "b", "ALIAS", "alias"],
      ),
    ).toEqual([
      { model: "b", sortIndex: 0 },
      { model: "alias", upstreamModel: "wire", sortIndex: 1 },
    ]);
  });

  it("recovers unique upstream identities after alias changes", () => {
    expect(
      applyCodexCatalogModelOrder(
        [{ model: "a" }, { model: "new-alias", upstream_model: "wire" }],
        ["WIRE"],
      ).map((model) => model.model),
    ).toEqual(["new-alias", "a"]);
  });

  it("does not choose an arbitrary source for ambiguous identities", () => {
    const models = [
      { model: "one", upstreamModel: "wire" },
      { model: "two", upstreamModel: "wire" },
    ];
    expect(applyCodexCatalogModelOrder(models, ["wire"])).toEqual(models);
  });

  it("recovers old provider suffixes without moving their provider block", () => {
    expect(
      applyCodexCatalogModelOrder(
        [
          { model: "one", upstreamModel: "wire", providerName: "First Source" },
          {
            model: "two",
            upstreamModel: "wire",
            providerName: "Second Source",
          },
        ],
        ["WIRE-SECOND-SOURCE"],
      ).map((model) => model.model),
    ).toEqual(["one", "two"]);
  });
});
