import { describe, expect, it } from "vitest";
import { applyCodexCatalogModelOrder } from "@/lib/codexModelCatalogOrder";

describe("applyCodexCatalogModelOrder", () => {
  it("保留模型按上一次自定义顺序补位，并压缩 sortIndex 空洞", () => {
    const previous = [
      { model: "e", sortIndex: 0 },
      { model: "c", sortIndex: 1 },
      { model: "a", sortIndex: 2 },
      { model: "d", sortIndex: 3 },
      { model: "b", sortIndex: 4 },
    ];
    // 删除某个供应商后重建结果只剩它以外的模型，且顺序来自 route 迭代。
    const rebuilt = [{ model: "a" }, { model: "b" }, { model: "e" }];

    expect(applyCodexCatalogModelOrder(rebuilt, previous)).toEqual([
      { model: "e", sortIndex: 0 },
      { model: "a", sortIndex: 1 },
      { model: "b", sortIndex: 2 },
    ]);
  });

  it("新增模型统一追加到末尾", () => {
    const previous = [
      { model: "b", sortIndex: 0 },
      { model: "a", sortIndex: 1 },
    ];
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

  it("没有 Router 自定义排序时按当前路由目录顺序，不继承旧快照", () => {
    const previous = [{ model: "e" }, { model: "c" }, { model: "a" }];
    const rebuilt = [{ model: "a" }, { model: "new" }, { model: "e" }];

    expect(applyCodexCatalogModelOrder(rebuilt, previous)).toEqual([
      { model: "a" },
      { model: "new" },
      { model: "e" },
    ]);
  });

  it("上游 provider 带来的 sortIndex 不会污染未自定义排序的聚合目录", () => {
    const previous = [{ model: "a" }, { model: "b" }];
    const rebuilt = [
      { model: "b", sortIndex: 7 },
      { model: "a", sortIndex: 3 },
    ];

    expect(applyCodexCatalogModelOrder(rebuilt, previous)).toEqual([
      { model: "b" },
      { model: "a" },
    ]);
  });

  it("recovers a saved rank after a unique visible model is renamed", () => {
    const next = [
      { model: "other", providerName: "Other" },
      { model: "shared-relay", upstreamModel: "shared", providerName: "Relay" },
    ];
    expect(
      applyCodexCatalogModelOrder(next, [
        { model: "shared", sortIndex: 0 },
        { model: "other", sortIndex: 1 },
      ]).map((model) => model.model),
    ).toEqual(["shared-relay", "other"]);
  });

  it("keeps a saved rank when a model's casing changes", () => {
    expect(
      applyCodexCatalogModelOrder(
        [{ model: "OTHER" }, { model: "MODEL-A" }],
        [
          { model: "model-a", sortIndex: 0 },
          { model: "other", sortIndex: 1 },
        ],
      ).map((model) => model.model),
    ).toEqual(["MODEL-A", "OTHER"]);
  });
});
