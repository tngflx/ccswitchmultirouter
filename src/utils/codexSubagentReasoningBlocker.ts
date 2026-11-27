import type { Provider } from "@/types";
import { parseCodexSubagentCandidateError } from "@/lib/codexSubagentCandidateError";
import { readCodexModelCatalog } from "@/utils/codexSpawnAgentCandidates";

export interface UnknownReasoningBlocker {
  models: string[];
  message: string;
}

export function readUnknownReasoningModels(message: string): string[] {
  const parsed = parseCodexSubagentCandidateError(message);
  if (parsed.kind !== "incomplete" || !parsed.models) return [];
  const suffix = parsed.models;
  if (!suffix) return [];
  const seen = new Set<string>();
  return suffix.split(/[,，、]/).reduce<string[]>((models, raw) => {
    const model = raw.trim();
    const key = model.toLowerCase();
    if (!model || seen.has(key)) return models;
    seen.add(key);
    models.push(model);
    return models;
  }, []);
}

export function isUnknownReasoningCapabilityError(message: string): boolean {
  return parseCodexSubagentCandidateError(message).kind === "incomplete";
}

export function readUnknownReasoningBlocker(
  message: string,
): UnknownReasoningBlocker | null {
  return isUnknownReasoningCapabilityError(message)
    ? { models: readUnknownReasoningModels(message), message }
    : null;
}

export function findModelSource(
  providers: Provider[],
  model: string,
): Provider | undefined {
  const target = model.trim().toLowerCase();
  if (!target) return undefined;
  return providers.find((provider) =>
    readCodexModelCatalog(provider).models.some(
      (entry) => entry.model.trim().toLowerCase() === target,
    ),
  );
}

export function unknownReasoningBlockerDetail(models: string[]): string {
  if (models.length > 0) {
    return `These enabled Sub-Agent roles use models without declared reasoning capability: ${models.join(", ")}. Declare the capability in the matching provider, or disable the roles and save.`;
  }
  return "An enabled Sub-Agent role uses a model without declared reasoning capability. Declare the capability in its provider catalog, or disable the role and save.";
}
