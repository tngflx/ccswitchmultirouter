const normalizedHostId = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const requestHostIds = (client, params) =>
  [
    client?.hostId,
    client?.host_id,
    params?.hostId,
    params?.host_id,
    params?.host?.hostId,
    params?.host?.host_id,
    params?.params?.hostId,
    params?.params?.host_id,
    params?.params?.host?.hostId,
    params?.params?.host?.host_id,
  ]
    .map(normalizedHostId)
    .filter(Boolean);
const isLocalAppServerTarget = (client, params, sourceIsLocalView = false) => {
  const hosts = requestHostIds(client, params);
  return hosts.length > 0
    ? hosts.every((hostId) => hostId === "local")
    : sourceIsLocalView;
};
const currentManagedCatalogProvider = () => {
  const provider = currentModelProvider();
  return provider &&
    provider !== "openai" &&
    state.payload?.catalogAvailable === true
    ? provider
    : null;
};
const isModelListMethod = (method) =>
  method === "list-models-for-host" || method === "model/list";
const captureModelListScope = (
  method,
  params,
  client,
  sourceIsLocalView = false,
) => {
  if (
    !isModelListMethod(method) ||
    !isLocalAppServerTarget(client, params, sourceIsLocalView)
  )
    return null;
  const provider = currentManagedCatalogProvider();
  const providers = [
    params?.modelProvider,
    params?.model_provider,
    params?.params?.modelProvider,
    params?.params?.model_provider,
  ]
    .map(normalizedCatalogProvider)
    .filter(Boolean);
  // Current Codex Desktop sends `model/list` without a provider field. The
  // local app-server client and active catalog already establish the scope;
  // rejecting this request leaves the picker with an unpatched response.
  return provider &&
    (!providers.length || providers.every((value) => value === provider))
    ? {
        provider,
        hostId: "local",
        providerEpoch: state.catalogProviderEpoch || 0,
      }
    : null;
};
const isCurrentModelListScope = (scope, client, params) =>
  Boolean(scope) &&
  scope.provider === currentManagedCatalogProvider() &&
  scope.providerEpoch === (state.catalogProviderEpoch || 0) &&
  isLocalAppServerTarget(client || scope, params);
