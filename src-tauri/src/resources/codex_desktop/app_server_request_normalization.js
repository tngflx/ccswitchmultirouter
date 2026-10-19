const appServerRequestPatchVersion =
  typeof rendererRuntimeFingerprint === "string"
    ? rendererRuntimeFingerprint
    : "standalone";
const appServerRequestClientNeedsPatch = (client) =>
  client?.__ccSwitchModelRequestPatch !== appServerRequestPatchVersion;
const appServerMethod = (method, params) =>
  method === "send-cli-request-for-host" && params?.method
    ? String(params.method)
    : String(method || "");
const currentModelProvider = () => {
  const value = state.payload?.modelProvider;
  return typeof value === "string" && value.trim() ? value.trim() : null;
};
const normalizeAppServerRequestParams = (method, params) => {
  const actualMethod = appServerMethod(method, params);
  if (actualMethod === "thread/list") {
    if (
      method === "send-cli-request-for-host" &&
      params?.params?.modelProviders == null
    ) {
      return {
        ...params,
        params: { ...(params?.params || {}), modelProviders: [] },
      };
    }
    if (params == null) return { modelProviders: [] };
    return params?.modelProviders == null
      ? { ...params, modelProviders: [] }
      : params;
  }
  if (actualMethod !== "thread/resume") return params;
  const modelProvider = currentModelProvider();
  if (!modelProvider) return params;
  if (method === "send-cli-request-for-host") {
    const requestParams = params?.params;
    if (
      !requestParams ||
      typeof requestParams !== "object" ||
      Array.isArray(requestParams) ||
      requestParams.modelProvider === modelProvider
    )
      return params;
    return { ...params, params: { ...requestParams, modelProvider } };
  }
  if (
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    params.modelProvider === modelProvider
  )
    return params;
  return { ...params, modelProvider };
};
