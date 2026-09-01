import type { CodexCatalogModel } from "@/types";
import { catalogModelIdentity } from "./codexCatalogSync";

export type CodexInputCapabilityState = "text_image" | "text_only" | "unknown";

function declaredBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === "boolean");
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
  ].filter((state): state is Exclude<CodexInputCapabilityState, "unknown"> =>
    state !== undefined,
  );
  if (declaredStates.length === 0) return "unknown";
  const first = declaredStates[0];
  return declaredStates.every((state) => state === first) ? first : "unknown";
}

export function codexInputCapabilityPatch(
  state: Exclude<CodexInputCapabilityState, "unknown">,
): Pick<CodexCatalogModel, "inputModalities" | "supportsImage" | "textOnly"> {
  const supportsImage = state === "text_image";
  return {
    inputModalities: supportsImage ? ["text", "image"] : ["text"],
    supportsImage,
    textOnly: !supportsImage,
  };
}

export function normalizeCodexInputCapability(
  model: CodexCatalogModel,
): CodexCatalogModel {
  const state = codexInputCapabilityState(model);
  if (state === "unknown") return model;
  return {
    ...model,
    ...codexInputCapabilityPatch(state),
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
): Map<string, Exclude<CodexInputCapabilityState, "unknown">> {
  const states = new Map<
    string,
    Set<Exclude<CodexInputCapabilityState, "unknown">>
  >();

  for (const catalog of catalogs) {
    for (const model of catalog) {
      const state = codexInputCapabilityState(model);
      if (state === "unknown") continue;
      for (const identity of modelIdentities(model)) {
        const values = states.get(identity) ?? new Set();
        values.add(state);
        states.set(identity, values);
      }
    }
  }

  const references = new Map<
    string,
    Exclude<CodexInputCapabilityState, "unknown">
  >();
  for (const [identity, values] of states) {
    if (values.size === 1) references.set(identity, [...values][0]);
  }
  return references;
}

export function hydrateCodexInputCapabilities<T extends CodexCatalogModel>(
  models: T[],
  references: ReadonlyMap<
    string,
    Exclude<CodexInputCapabilityState, "unknown">
  >,
): T[] {
  return models.map((model) => {
    const explicitState = codexInputCapabilityState(model);
    if (explicitState !== "unknown") {
      return normalizeCodexInputCapability(model) as T;
    }

    const state = modelIdentities(model)
      .map((identity) => references.get(identity))
      .find(
        (
          candidate,
        ): candidate is Exclude<CodexInputCapabilityState, "unknown"> =>
          candidate !== undefined,
      );
    return state
      ? ({ ...model, ...codexInputCapabilityPatch(state) } as T)
      : model;
  });
}
