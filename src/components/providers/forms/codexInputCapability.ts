import type { CodexCatalogModel } from "@/types";
import { catalogModelIdentity } from "@/lib/codexCatalogReconciliation";

export type CodexInputCapabilityState = "text_image" | "text_only" | "unknown";

function declaredBoolean(...values: unknown[]): boolean | undefined {
  const declarations = values.filter(
    (value): value is boolean => typeof value === "boolean",
  );
  if (declarations.length === 0) return undefined;
  return declarations.every((value) => value === declarations[0])
    ? declarations[0]
    : undefined;
}

function hasConflictingBooleanDeclarations(...values: unknown[]): boolean {
  const declarations = values.filter(
    (value): value is boolean => typeof value === "boolean",
  );
  return (
    declarations.length > 1 &&
    !declarations.every((value) => value === declarations[0])
  );
}

export function codexInputCapabilityState(
  model: CodexCatalogModel,
): CodexInputCapabilityState {
  const supportsImage = declaredBoolean(
    model.supportsImage,
    model.supports_image,
    model.vision,
  );
  const modalities = model.inputModalities ?? model.input_modalities;
  const modalityState =
    Array.isArray(modalities) && modalities.length > 0
      ? modalities.some(
          (modality) =>
            typeof modality === "string" &&
            modality.trim().toLowerCase() === "image",
        )
        ? "text_image"
        : "text_only"
      : undefined;
  const textOnly = declaredBoolean(model.textOnly, model.text_only);
  const textOnlyState =
    textOnly === undefined ? undefined : textOnly ? "text_only" : "text_image";
  const declaredStates = [
    supportsImage === undefined
      ? undefined
      : supportsImage
        ? "text_image"
        : "text_only",
    modalityState,
    textOnlyState,
  ].filter(
    (state): state is Exclude<CodexInputCapabilityState, "unknown"> =>
      state !== undefined,
  );
  if (
    hasConflictingBooleanDeclarations(
      model.supportsImage,
      model.supports_image,
      model.vision,
    ) ||
    hasConflictingBooleanDeclarations(model.textOnly, model.text_only)
  ) {
    return "unknown";
  }
  if (declaredStates.length === 0) return "unknown";
  const first = declaredStates[0];
  return declaredStates.every((state) => state === first) ? first : "unknown";
}

export function codexInputCapabilityPatch(
  state: Exclude<CodexInputCapabilityState, "unknown">,
  model?: CodexCatalogModel,
): Pick<CodexCatalogModel, "inputModalities" | "supportsImage" | "textOnly"> {
  const supportsImage = state === "text_image";
  const retained = (
    model?.inputModalities ??
    model?.input_modalities ?? ["text"]
  ).filter((modality) => modality.toLowerCase() !== "image");
  return {
    inputModalities: supportsImage ? [...retained, "image"] : retained,
    supportsImage,
    textOnly: !supportsImage,
  };
}

export function normalizeCodexInputCapability(
  model: CodexCatalogModel,
): CodexCatalogModel {
  const state = codexInputCapabilityState(model);
  if (state === "unknown") return model;
  const hasModalities =
    model.inputModalities !== undefined || model.input_modalities !== undefined;
  const hasSupportsImage =
    model.supportsImage !== undefined ||
    model.supports_image !== undefined ||
    model.vision !== undefined;
  const hasTextOnly =
    model.textOnly !== undefined || model.text_only !== undefined;
  const patch = codexInputCapabilityPatch(state, model);
  return {
    ...model,
    ...(!hasModalities ? { inputModalities: patch.inputModalities } : {}),
    ...(!hasSupportsImage ? { supportsImage: patch.supportsImage } : {}),
    // Do not add redundant textOnly metadata when both modalities and the
    // image declaration are already explicit. Incomplete references still get
    // the canonical textOnly field during hydration.
    ...(!hasTextOnly && (!hasModalities || !hasSupportsImage)
      ? { textOnly: patch.textOnly }
      : {}),
  };
}

function modelIdentities(model: CodexCatalogModel): string[] {
  const identities = new Set<string>();
  for (const value of [
    model.model,
    model.upstreamModel,
    model.upstream_model,
  ]) {
    const identity = catalogModelIdentity(value);
    if (identity) identities.add(identity);
  }
  return [...identities];
}

export function buildCodexInputCapabilityReferenceMap(
  catalogs: readonly CodexCatalogModel[][],
): Map<string, CodexCatalogModel> {
  const states = new Map<
    string,
    Set<Exclude<CodexInputCapabilityState, "unknown">>
  >();
  const candidates = new Map<string, CodexCatalogModel>();

  for (const catalog of catalogs) {
    for (const model of catalog) {
      const state = codexInputCapabilityState(model);
      if (state === "unknown") continue;
      for (const identity of modelIdentities(model)) {
        const values = states.get(identity) ?? new Set();
        values.add(state);
        states.set(identity, values);
        const existing = candidates.get(identity);
        if (
          !existing ||
          (!existing.inputModalities && !existing.input_modalities)
        ) {
          candidates.set(identity, model);
        }
      }
    }
  }

  const references = new Map<string, CodexCatalogModel>();
  for (const [identity, values] of states) {
    if (values.size === 1) {
      const candidate = candidates.get(identity);
      if (candidate) references.set(identity, candidate);
    }
  }
  return references;
}

export function hydrateCodexInputCapabilities<T extends CodexCatalogModel>(
  models: T[],
  references: ReadonlyMap<string, CodexCatalogModel>,
): T[] {
  return models.map((model) => {
    const explicitState = codexInputCapabilityState(model);
    if (explicitState !== "unknown") {
      return normalizeCodexInputCapability(model) as T;
    }

    // Unknown can mean contradictory declarations, not permission to overwrite them.
    if (
      [
        model.inputModalities,
        model.input_modalities,
        model.supportsImage,
        model.supports_image,
        model.vision,
        model.textOnly,
        model.text_only,
      ].some((value) => value !== undefined && value !== null)
    ) {
      return model;
    }

    const reference = modelIdentities(model)
      .map((identity) => references.get(identity))
      .find(
        (candidate): candidate is CodexCatalogModel => candidate !== undefined,
      );
    const normalized = reference && normalizeCodexInputCapability(reference);
    return normalized
      ? ({
          ...model,
          inputModalities: normalized.inputModalities,
          supportsImage: normalized.supportsImage,
          textOnly: normalized.textOnly,
        } as T)
      : model;
  });
}
