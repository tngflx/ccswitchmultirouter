const guardianV2DynamicConfigName = "2553103476";
const guardianV2FlatFeatureKey = "features.guardianv2";
const statsigModelWhitelistConfigName = "107580212";
const legacyModelWhitelistFields = [
  "available_models",
  "use_hidden_models",
  "default_model",
];
const guardianV2Enabled = (value) => value?.enabled === true;
const isGuardianV2StructuredValue = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const stripLegacyModelWhitelistPollution = (config) => {
  const value = config?.value;
  if (
    !isGuardianV2StructuredValue(value) ||
    !legacyModelWhitelistFields.some((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    )
  )
    return config;
  const nextValue = { ...value };
  for (const key of legacyModelWhitelistFields) delete nextValue[key];
  return { ...config, value: nextValue };
};
const patchGuardianV2DynamicConfig = (name, config) => {
  if (String(name || "") !== guardianV2DynamicConfigName) return config;
  return stripLegacyModelWhitelistPollution(config);
};
const prepareStatsigDynamicConfig = (
  name,
  config,
  repairLegacyPollution = false,
) => {
  const normalizedName = String(name || "");
  config = patchGuardianV2DynamicConfig(normalizedName, config);
  if (normalizedName === statsigModelWhitelistConfigName) {
    return { config, patchModelWhitelist: true };
  }
  return {
    config: repairLegacyPollution
      ? stripLegacyModelWhitelistPollution(config)
      : config,
    patchModelWhitelist: false,
  };
};
const isGuardianV2FeatureTomlError = (error) => {
  const message = String(error?.message || error || "");
  return (
    message.includes("FeatureToml") && message.includes("features.guardianv2")
  );
};
const downgradeGuardianV2Config = (config) => {
  if (!config || typeof config !== "object" || Array.isArray(config))
    return config;
  let next = config;
  let changed = false;
  const flat = config[guardianV2FlatFeatureKey];
  if (isGuardianV2StructuredValue(flat)) {
    next = { ...next, [guardianV2FlatFeatureKey]: guardianV2Enabled(flat) };
    changed = true;
  }
  const features = config.features;
  if (
    isGuardianV2StructuredValue(features) &&
    isGuardianV2StructuredValue(features.guardianv2)
  ) {
    if (!changed) next = { ...next };
    next.features = {
      ...features,
      guardianv2: guardianV2Enabled(features.guardianv2),
    };
    changed = true;
  }
  return changed ? next : config;
};
const guardianV2FallbackRequestParams = (method, params) => {
  const wrapped =
    method === "send-cli-request-for-host" &&
    params?.params &&
    typeof params.params === "object";
  const requestParams = wrapped ? params.params : params;
  if (
    !requestParams ||
    typeof requestParams !== "object" ||
    Array.isArray(requestParams)
  )
    return params;
  const nextConfig = downgradeGuardianV2Config(requestParams.config);
  if (nextConfig === requestParams.config) return params;
  const nextRequestParams = { ...requestParams, config: nextConfig };
  return wrapped ? { ...params, params: nextRequestParams } : nextRequestParams;
};
