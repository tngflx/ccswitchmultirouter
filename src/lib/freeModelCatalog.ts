import type { CodexCatalogModel } from "@/types";
import {
  modelIdentityValues,
  type ModelIdentityShape,
} from "@/lib/modelIdentities";

export type FreeModelFact = ModelIdentityShape & {
  isFree?: boolean | null;
};

/** Build the set of identities explicitly confirmed as free by the upstream. */
export function confirmedFreeModelIdentities(
  models: readonly FreeModelFact[],
): Set<string> {
  const identities = new Set<string>();
  for (const model of models) {
    if (model.isFree !== true) continue;
    for (const identity of modelIdentityValues(model)) {
      identities.add(identity);
    }
  }
  return identities;
}

/** A catalog row is free only when one of its stable identities was confirmed. */
export function isConfirmedFreeCatalogModel(
  model: CodexCatalogModel,
  freeIdentities: ReadonlySet<string>,
): boolean {
  return modelIdentityValues(model).some((identity) =>
    freeIdentities.has(identity),
  );
}

/**
 * Keep the complete fetched inventory while changing only routability flags.
 * Unknown and paid rows remain in the catalog for later editing.
 */
export function enableOnlyConfirmedFreeCatalogModels<
  T extends CodexCatalogModel,
>(rows: readonly T[], models: readonly FreeModelFact[]): T[] {
  const freeIdentities = confirmedFreeModelIdentities(models);
  return rows.map((row) => ({
    ...row,
    enabled: isConfirmedFreeCatalogModel(row, freeIdentities),
  })) as T[];
}
