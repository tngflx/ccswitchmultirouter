export type DeepSeekRole = "flash" | "pro";

/** Canonicalizes the current and legacy DeepSeek role slugs. Vision models are separate. */
export function deepSeekRoleForModel(name: string): DeepSeekRole | null {
  const normalized = name.trim().toLowerCase();
  if (normalized.includes("vision")) return null;
  if (
    normalized === "deepseek-flash" ||
    normalized === "deepseek-v4-flash" ||
    normalized.startsWith("deepseek-flash-") ||
    normalized.startsWith("deepseek-v4-flash-")
  ) {
    return "flash";
  }
  if (
    normalized === "deepseek-pro" ||
    normalized === "deepseek-v4-pro" ||
    normalized.startsWith("deepseek-pro-") ||
    normalized.startsWith("deepseek-v4-pro-")
  ) {
    return "pro";
  }
  return null;
}

export function deepSeekRoleModelsMatch(a: string, b: string): boolean {
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true;
  const aRole = deepSeekRoleForModel(a);
  return aRole !== null && aRole === deepSeekRoleForModel(b);
}

export function catalogHasRoleModel(
  models: Array<{ model?: string }>,
  target: string,
): boolean {
  return models.some((model) =>
    deepSeekRoleModelsMatch(model.model?.trim() ?? "", target),
  );
}
