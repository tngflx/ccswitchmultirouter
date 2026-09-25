/**
 * MultiRouter 聚合模型目录的预览排序，与编译器的 Router modelOrder 对齐。
 *
 * 默认顺序来自当前 route × provider 目录；只有 Router 保存了 modelOrder 时才
 * 按旧名次补位，新增模型追加到末尾。源 provider 的 sortIndex 不参与全局排序。
 */

export interface CodexOrderableCatalogModel {
  model?: string;
  sortIndex?: number;
  upstreamModel?: string;
  upstream_model?: string;
  providerName?: string;
}

/**
 * 读取上一次目录的有效顺序：`sortIndex` 优先，缺失时退回数组下标。
 *
 * 返回“模型 -> 名次”映射；重复模型只记录第一次出现的名次。
 */
function buildPreviousRankByModel(
  previousModels: readonly CodexOrderableCatalogModel[],
): Map<string, number> {
  const ranked = previousModels
    .map((model, index) => ({
      id: model.model?.trim() ?? "",
      index,
      sortIndex: model.sortIndex,
    }))
    .filter((entry) => Boolean(entry.id))
    .sort(
      (left, right) =>
        (left.sortIndex ?? Number.MAX_SAFE_INTEGER) -
          (right.sortIndex ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    );

  const rankByModel = new Map<string, number>();
  for (const entry of ranked) {
    const key = entry.id.toLowerCase();
    if (!rankByModel.has(key)) rankByModel.set(key, rankByModel.size);
  }
  return rankByModel;
}

/** 判断目录是否启用过自定义排序（存在任意 `sortIndex`）。 */
export function hasCustomCatalogOrder(
  models: readonly CodexOrderableCatalogModel[],
): boolean {
  return models.some((model) => model.sortIndex !== undefined);
}

/**
 * 按当前数组顺序落地 `sortIndex`。
 *
 * 启用自定义排序时写入稠密序号（0 起），删除中间模型不留空洞、新增模型拿到末尾序号；
 * 未启用时清掉可能从上游 provider 继承来的 `sortIndex`，让数组顺序继续表达默认顺序。
 */
function writeCatalogSortIndexes<T extends CodexOrderableCatalogModel>(
  models: readonly T[],
  useCustomOrder: boolean,
): T[] {
  if (useCustomOrder) {
    return models.map((model, index) => ({ ...model, sortIndex: index }));
  }
  return models.map((model) => {
    if (model.sortIndex === undefined) return model;
    const { sortIndex: _sortIndex, ...rest } = model;
    return rest as T;
  });
}

/**
 * 有 Router 自定义顺序时按旧名次重排，并把新增模型追加到末尾。
 *
 * 自定义顺序写入稠密 `sortIndex`（0 起）；无自定义顺序时清除继承的索引，
 * 保持当前 route/catalog 数组顺序。
 *
 * 上游 provider 目录里的 `sortIndex` 不参与聚合排序：聚合目录的顺序偏好只属于
 * MultiRouter 自身，否则模型源刷新会把无关序号带进方案。
 */
export function applyCodexCatalogModelOrder<
  T extends CodexOrderableCatalogModel,
>(
  nextModels: readonly T[],
  previousModels: readonly CodexOrderableCatalogModel[],
): T[] {
  if (!hasCustomCatalogOrder(previousModels)) {
    return writeCatalogSortIndexes(nextModels, false);
  }
  const rankByModel = buildPreviousRankByModel(previousModels);
  for (const [savedName, rank] of rankByModel) {
    if (
      nextModels.some(
        (model) => model.model?.toLowerCase() === savedName.toLowerCase(),
      )
    ) {
      continue;
    }
    const key = savedName.toLowerCase();
    const identityMatches = nextModels.filter(
      (model) =>
        model.upstreamModel?.toLowerCase() === key ||
        model.upstream_model?.toLowerCase() === key,
    );
    const suffixMatches = nextModels.filter((model) => {
      const suffix = (model.providerName ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      return (
        Boolean(suffix) &&
        key ===
          `${model.upstreamModel ?? model.upstream_model ?? model.model}-${suffix}`.toLowerCase()
      );
    });
    const matches =
      identityMatches.length === 1 ? identityMatches : suffixMatches;
    if (matches.length === 1 && matches[0].model) {
      rankByModel.set(matches[0].model, rank);
    }
  }
  const ordered = nextModels
    .map((model, index) => ({
      model,
      index,
      rank: rankByModel.get(model.model?.trim().toLowerCase() ?? ""),
    }))
    .sort(
      (left, right) =>
        (left.rank ?? Number.MAX_SAFE_INTEGER) -
          (right.rank ?? Number.MAX_SAFE_INTEGER) || left.index - right.index,
    )
    .map((entry) => entry.model);

  return writeCatalogSortIndexes(
    ordered,
    hasCustomCatalogOrder(previousModels),
  );
}

/**
 * 用户在向导里显式给出顺序时，数组顺序即最终顺序，只需要落地 `sortIndex`。
 *
 * 上一次目录用过自定义排序就继续写稠密序号，否则清掉继承来的序号，避免后端
 * 因残留 `sortIndex` 与数组顺序冲突而回落到默认供应商启发式排序。
 */
export function applyCodexCatalogExplicitOrder<
  T extends CodexOrderableCatalogModel,
>(
  nextModels: readonly T[],
  previousModels: readonly CodexOrderableCatalogModel[],
): T[] {
  return writeCatalogSortIndexes(
    nextModels,
    hasCustomCatalogOrder(previousModels),
  );
}
