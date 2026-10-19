const normalizedCatalogProvider = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const selectCatalogPayload = (previousPayload, incomingPayload) => {
  if (incomingPayload?.catalogReleased === true) return incomingPayload;
  const incomingProvider = normalizedCatalogProvider(
    incomingPayload?.modelProvider,
  );
  const previousProvider = normalizedCatalogProvider(
    previousPayload?.modelProvider,
  );
  const preservePreviousCatalog =
    incomingPayload?.catalogAvailable !== true &&
    previousPayload?.catalogAvailable === true &&
    incomingProvider !== null &&
    incomingProvider === previousProvider;
  if (!preservePreviousCatalog) return incomingPayload;
  return {
    ...incomingPayload,
    defaultModel: previousPayload.defaultModel,
    modelNames: Array.isArray(previousPayload.modelNames)
      ? [...previousPayload.modelNames]
      : [],
    models: Array.isArray(previousPayload.models)
      ? [...previousPayload.models]
      : [],
    catalogAvailable: true,
  };
};
