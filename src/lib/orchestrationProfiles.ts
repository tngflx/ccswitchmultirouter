import type {
  OrchestrationModelRef,
  OrchestrationProfile,
  OrchestrationSettings,
  Provider,
} from "@/types";
import { readCodexCatalogSettings } from "./codexCatalogSchema";

export type OrchestrationApp = "claude" | "codex";
export type OrchestrationRole = "orchestrator" | "worker" | "verifier";

export interface OrchestrationProviderChoice {
  id: string;
  name: string;
  models: string[];
  hasCatalog: boolean;
}

export type OrchestrationProviderChoices = Record<
  OrchestrationApp,
  OrchestrationProviderChoice[]
>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function providerModels(provider: Provider): string[] {
  const settings = asRecord(provider.settingsConfig);
  const catalog = readCodexCatalogSettings(settings);
  const models: string[] = [];
  if (catalog) {
    for (const item of catalog.models as unknown[]) {
      if (typeof item === "string") {
        models.push(item);
      } else {
        const entry = asRecord(item);
        if (entry?.enabled === false) continue;
        for (const key of ["model", "slug", "id", "name"]) {
          if (typeof entry?.[key] === "string") {
            models.push(entry[key] as string);
            break;
          }
        }
      }
    }
  } else {
    for (const key of ["model", "haikuModel", "sonnetModel", "opusModel"]) {
      if (typeof settings?.[key] === "string") {
        models.push(settings[key] as string);
      }
    }
    const config = asRecord(settings?.config);
    if (typeof config?.model === "string") models.push(config.model);
    const env = asRecord(settings?.env);
    for (const key of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
    ]) {
      if (typeof env?.[key] === "string") models.push(env[key] as string);
    }
  }
  return [
    ...new Set(
      models
        .map((model) => model.trim())
        .filter((model) => model && !model.startsWith("ccsm-")),
    ),
  ];
}

/** Match the backend's direct-provider boundary, including disabled routers. */
export function toOrchestrationProviderChoices(
  providers: Record<string, Provider>,
): OrchestrationProviderChoice[] {
  return Object.values(providers)
    .filter(
      (provider) =>
        !Object.prototype.hasOwnProperty.call(
          provider.settingsConfig,
          "codexRouting",
        ) &&
        !Object.prototype.hasOwnProperty.call(
          provider.settingsConfig,
          "codexProtocolSet",
        ),
    )
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: providerModels(provider),
      hasCatalog:
        readCodexCatalogSettings(provider.settingsConfig) !== undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Known included models win over manual input; never invent a fallback ID. */
export function firstOrchestrationModelRef(
  appType: OrchestrationApp,
  choices: OrchestrationProviderChoices,
): OrchestrationModelRef {
  const rank = (provider: OrchestrationProviderChoice) =>
    (provider.models.length ? 100 : provider.hasCatalog ? 0 : 50) +
    (provider.id === `${appType}-official` ? 10 : 0);
  const provider = [...choices[appType]].sort(
    (a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name),
  )[0];
  return {
    appType,
    providerId: provider?.id ?? "",
    model: provider?.models[0] ?? "",
  };
}

export function createOrchestrationDraft(
  id: string,
  choices: OrchestrationProviderChoices,
  displayName: string,
  workerGuidance: string,
): OrchestrationProfile {
  return {
    id,
    displayName,
    enabled: false,
    scope: "all",
    orchestrator: firstOrchestrationModelRef("claude", choices),
    worker: firstOrchestrationModelRef("codex", choices),
    budget: {
      maxRounds: 2,
      maxWorkerCalls: 2,
      maxParallelWorkers: 1,
      timeoutSeconds: 300,
      maxOutputTokens: 8192,
    },
    approvalPolicy: "client",
    failureFallback: "fail_closed",
    workerGuidance,
  };
}

/** Removing the active policy must not silently activate another policy. */
export function removeOrchestrationProfile(
  settings: OrchestrationSettings,
  id: string,
): OrchestrationSettings {
  const profiles = settings.profiles.filter((profile) => profile.id !== id);
  return settings.activeProfileId === id
    ? {
        ...settings,
        profiles,
        activeProfileId: undefined,
        defaultModeByApp: { claude: "direct", codex: "direct" },
      }
    : { ...settings, profiles };
}

interface ValidationIssue {
  key: string;
  values?: Record<string, string>;
}

/** Validate the entire save payload, not whichever profile is being viewed. */
export function validateOrchestrationDraft(
  settings: OrchestrationSettings,
  choices: OrchestrationProviderChoices,
): ValidationIssue | undefined {
  for (const profile of settings.profiles) {
    if (!profile.displayName.trim())
      return { key: "orchestration.nameRequired" };
    for (const role of ["orchestrator", "worker", "verifier"] as const) {
      const ref = profile[role];
      if (!ref) continue;
      const values = { name: profile.displayName, role };
      if (profile.enabled && (!ref.providerId.trim() || !ref.model.trim())) {
        return { key: "orchestration.roleRequired", values };
      }
      const provider = choices[ref.appType].find(
        (choice) => choice.id === ref.providerId,
      );
      if (
        settings.enabled &&
        profile.enabled &&
        (!provider ||
          (provider.hasCatalog && !provider.models.includes(ref.model)))
      ) {
        return { key: "orchestration.modelUnavailable", values };
      }
    }
  }
  for (const app of ["claude", "codex"] as const) {
    if (
      settings.defaultModeByApp?.[app] === "orchestrated" &&
      !settings.profiles.some(
        (profile) =>
          profile.id === settings.activeProfileId &&
          profile.enabled &&
          (profile.scope === "all" || profile.scope === app),
      )
    ) {
      return { key: "orchestration.defaultProfileRequired", values: { app } };
    }
  }
  return undefined;
}
