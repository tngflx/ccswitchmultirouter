import { describe, expect, it } from "vitest";
import { applyCodexCatalogModelOrder } from "@/lib/codexModelCatalogOrder";

describe("applyCodexCatalogModelOrder", () => {
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

  it("recovers old provider suffixes without conflating providers", () => {
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
    ).toEqual(["two", "one"]);
  });
});
