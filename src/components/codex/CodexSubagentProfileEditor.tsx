import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Code2, Database, Search, SlidersHorizontal } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  codexSubagentV2Api,
  type CodexSubagentV2MutationProvider,
  type CodexSubagentV2ReconcileAction,
} from "@/lib/api/codexSubagentV2";
import type { Provider } from "@/types";
import {
  createDefaultCodexSubagentV2Config,
  type CodexSubagentExplicitReasoningEffort,
  type CodexSubagentInputModalitySource,
  type CodexSubagentProfilePreview,
  type CodexSubagentReasoningCapabilities,
  type CodexSubagentReasoningCapability,
  type CodexSubagentProfileStatus,
  type CodexSubagentProfileStatuses,
  type CodexSubagentTaskStrength,
  type CodexSubagentV2Config,
  type CodexSubagentV2Profile,
} from "@/types/codexSubagentV2";

const TASK_STRENGTHS: Array<{
  value: CodexSubagentTaskStrength;
  label: string;
}> = [
  { value: "long_context_reading", label: "Long-context reading" },
  { value: "repository_exploration", label: "Repository exploration" },
  { value: "evidence_collection", label: "Evidence collection" },
  { value: "summarization", label: "Summarization" },
  { value: "complex_debugging", label: "Complex debugging" },
  { value: "architecture_design", label: "Architecture design" },
  { value: "bounded_implementation", label: "Bounded implementation" },
  { value: "complex_implementation", label: "Complex implementation" },
  { value: "testing", label: "Testing and validation" },
  { value: "high_risk_review", label: "High-risk review" },
];

type ProfileFilter = "enabled" | "draft" | "unroutable" | "all";
type ProfileTone = "enabled-routable" | "draft" | "unroutable";

const PROFILE_FILTERS: Array<{ value: ProfileFilter; label: string }> = [
  { value: "enabled", label: "Enabled" },
  { value: "draft", label: "Not configured" },
  { value: "unroutable", label: "Unroutable" },
  { value: "all", label: "All" },
];

const EXPLICIT_REASONING_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const TASK_STRENGTH_VALUES = new Set<string>(
  TASK_STRENGTHS.map(({ value }) => value),
);
const OPTIMIZATION_VALUES = new Set<string>(["speed", "balanced", "quality"]);
const WRITE_SCOPE_VALUES = new Set<string>([
  "read_only",
  "bounded_changes",
  "complex_changes",
]);
const PREFERENCE_VALUES = new Set<string>([
  "preferred",
  "eligible",
  "fallback",
]);
function profileToneFor(
  profile: CodexSubagentV2Profile,
  status?: CodexSubagentProfileStatus,
): ProfileTone {
  // 只有真不可路由（编译状态 Unroutable）才标"不可路由"；
  // 未启用的可路由 profile（编译状态 Disabled）应显示为草稿。
  if (status?.status === "unroutable") return "unroutable";
  return profile.enabled ? "enabled-routable" : "draft";
}

function profileToneClassName(tone: ProfileTone): string {
  switch (tone) {
    case "unroutable":
      return "border-border/70 bg-muted/35 dark:border-slate-700/70 dark:bg-slate-900/35";
    case "draft":
      return "border-amber-200 bg-amber-50/65 dark:border-amber-500/40 dark:bg-amber-950/20";
    case "enabled-routable":
    default:
      return "border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/40 dark:bg-emerald-950/25";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function includedModelCatalog(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const rawModels = Array.isArray(value.models) ? value.models : [];
  const models = rawModels.filter(
    (model) => !isRecord(model) || model.enabled !== false,
  );
  const includedIds = new Set(
    models
      .filter(
        (model): model is Record<string, unknown> =>
          isRecord(model) && typeof model.model === "string",
      )
      .map((model) =>
        typeof model.model === "string" ? model.model.trim() : "",
      )
      .filter(Boolean),
  );
  const rawSpawnAgentModels = Array.isArray(value.spawnAgentModels)
    ? value.spawnAgentModels
    : Array.isArray(value.spawn_agent_models)
      ? value.spawn_agent_models
      : [];
  return {
    ...value,
    models,
    spawnAgentModels: rawSpawnAgentModels.filter(
      (model): model is string =>
        typeof model === "string" && includedIds.has(model.trim()),
    ),
  };
}

function evaluateMutationResult(
  result: CodexSubagentV2MutationProvider,
): string {
  const verification = result.verification;
  if (!verification) {
    throw new Error(
      "Backend did not return Codex Agent file-write verification.",
    );
  }
  if (!verification.databasePersisted) {
    throw new Error(
      "Backend did not confirm that the V2 sub-agent configuration was written to the database.",
    );
  }
  if (verification.activation !== "restart_codex_and_start_new_session") {
    throw new Error(
      "Backend returned inconsistent Codex Agent activation conditions.",
    );
  }

  switch (result.projection?.status) {
    case "applied": {
      const filesVerified =
        Array.isArray(verification.roleFiles) &&
        verification.roleFiles.every(
          (file) => file.exists && file.contentMatches,
        );
      if (verification.roleFilesStatus !== "verified" || !filesVerified) {
        throw new Error(
          "Codex Agent file read-back verification failed after writing.",
        );
      }
      return "Database and Codex Agent file were written and read back successfully; restart Codex/app-server and create a new session to apply";
    }
    case "not_required":
      if (
        verification.roleFilesStatus !== "not_required" ||
        !Array.isArray(verification.roleFiles) ||
        verification.roleFiles.length !== 0
      ) {
        throw new Error(
          "Codex Agent file verification is inconsistent for a non-active plan.",
        );
      }
      return "Database saved; the current plan is inactive, so the Codex Agent file was not changed";
    case "pending_retry":
      if (
        verification.roleFilesStatus !== "pending_retry" ||
        !Array.isArray(verification.roleFiles) ||
        verification.roleFiles.length !== 0
      ) {
        throw new Error(
          "Codex Agent pending-retry state failed backend consistency checks.",
        );
      }
      return "Database saved; Codex Agent file projection is pending an automatic retry";
    default:
      throw new Error(
        "Backend did not return a clear Codex Agent projection state.",
      );
  }
}

function isUsableProfile(value: unknown): value is CodexSubagentV2Profile {
  if (!isRecord(value) || typeof value.model !== "string") return false;
  if (typeof value.enabled !== "boolean" || !isRecord(value.questionnaire)) {
    return false;
  }
  const questionnaire = value.questionnaire;
  const inputModalities = value.inputModalities;
  if (!(
    (inputModalities === undefined ||
      (Array.isArray(inputModalities) &&
        (inputModalities.length === 1 || inputModalities.length === 2) &&
        inputModalities[0] === "text" &&
        (inputModalities.length === 1 || inputModalities[1] === "image"))) &&
    Array.isArray(questionnaire.taskStrengths) &&
    questionnaire.taskStrengths.every(
      (strength) =>
        typeof strength === "string" && TASK_STRENGTH_VALUES.has(strength),
    ) &&
    typeof questionnaire.optimization === "string" &&
    OPTIMIZATION_VALUES.has(questionnaire.optimization) &&
    typeof questionnaire.writeScope === "string" &&
    WRITE_SCOPE_VALUES.has(questionnaire.writeScope) &&
    typeof questionnaire.preference === "string" &&
    PREFERENCE_VALUES.has(questionnaire.preference)
  )) {
    return false;
  }
  if (
    !isRecord(value.reasoning) ||
    typeof value.reasoning.policy !== "string"
  ) {
    return false;
  }
  const reasoning = value.reasoning;
  const policy = reasoning.policy as string;
  if (policy === "fixed") {
    if (
      typeof reasoning.effort !== "string" ||
      !EXPLICIT_REASONING_EFFORTS.has(reasoning.effort)
    ) {
      return false;
    }
  } else if (
    !["delegated", "model_default", "disabled"].includes(policy) ||
    reasoning.effort !== undefined
  ) {
    return false;
  }
  if (value.overrides === undefined) return true;
  if (!isRecord(value.overrides)) return false;
  const overrides = value.overrides;
  return (
    (overrides.roleName === undefined ||
      typeof overrides.roleName === "string") &&
    (overrides.description === undefined ||
      typeof overrides.description === "string") &&
    (overrides.developerInstructions === undefined ||
      typeof overrides.developerInstructions === "string") &&
    (overrides.nicknameCandidates === undefined ||
      (Array.isArray(overrides.nicknameCandidates) &&
        overrides.nicknameCandidates.every(
          (nickname) => typeof nickname === "string",
        )))
  );
}

function readRawProfiles(
  config: CodexSubagentV2Config,
): Record<string, unknown> {
  return isRecord(config.profiles) ? config.profiles : {};
}

function defaultProfileForModel(model: string): CodexSubagentV2Profile | null {
  const defaults = createDefaultCodexSubagentV2Config().profiles;
  return (
    Object.values(defaults).find((profile) => profile.model === model) ?? null
  );
}

function readPersistedConfig(provider: Provider): CodexSubagentV2Config | null {
  const routing = provider.settingsConfig?.codexRouting;
  if (!isRecord(routing) || !isRecord(routing.subagentV2)) return null;
  const config = routing.subagentV2;
  if (config.schemaVersion === 2) {
    return config as unknown as CodexSubagentV2Config;
  }
  if (config.schemaVersion !== 1 || !isRecord(config.profiles)) return null;
  const profiles: Record<string, unknown> = {};
  for (const [key, rawProfile] of Object.entries(config.profiles)) {
    if (!isRecord(rawProfile) || !isRecord(rawProfile.questionnaire)) {
      profiles[key] = rawProfile;
      continue;
    }
    const questionnaire = rawProfile.questionnaire;
    const legacyEffort = questionnaire.reasoningEffort;
    const rawOverrides = rawProfile.overrides;
    if (rawOverrides !== undefined && !isRecord(rawOverrides)) {
      profiles[key] = rawProfile;
      continue;
    }
    const overrideEffort = rawOverrides?.modelReasoningEffort;
    if (
      typeof legacyEffort !== "string" ||
      !["auto", "low", "medium", "high", "xhigh"].includes(legacyEffort) ||
      (overrideEffort !== undefined &&
        (typeof overrideEffort !== "string" ||
          !EXPLICIT_REASONING_EFFORTS.has(overrideEffort)))
    ) {
      profiles[key] = rawProfile;
      continue;
    }
    const { reasoningEffort: _legacyEffort, ...nextQuestionnaire } =
      questionnaire;
    const { modelReasoningEffort: _overrideEffort, ...nextOverrides } =
      rawOverrides ?? {};
    const fixedEffort =
      typeof overrideEffort === "string"
        ? overrideEffort
        : legacyEffort === "auto"
          ? undefined
          : legacyEffort;
    profiles[key] = {
      ...rawProfile,
      questionnaire: nextQuestionnaire,
      reasoning: fixedEffort
        ? { policy: "fixed", effort: fixedEffort }
        : { policy: "delegated" },
      ...(Object.keys(nextOverrides).length > 0
        ? { overrides: nextOverrides }
        : {}),
    };
  }
  return {
    schemaVersion: 2,
    selectionPolicy:
      config.selectionPolicy === "official_first" ||
      config.selectionPolicy === "third_party_first"
        ? config.selectionPolicy
        : "balanced",
    profiles: profiles as Record<string, CodexSubagentV2Profile>,
  };
}

function inferredInputModalities(
  provider: Provider,
  profile: CodexSubagentV2Profile,
  projectedModelCatalog?: unknown,
): CodexSubagentV2Profile["inputModalities"] {
  if (profile.inputModalities) return profile.inputModalities;
  const catalog =
    includedModelCatalog(projectedModelCatalog) ??
    includedModelCatalog(provider.settingsConfig?.modelCatalog);
  const models = catalog && Array.isArray(catalog.models) ? catalog.models : [];
  const entry = models.find(
    (candidate) =>
      isRecord(candidate) &&
      typeof candidate.model === "string" &&
      candidate.model.localeCompare(profile.model, undefined, {
        sensitivity: "accent",
      }) === 0,
  );
  if (!isRecord(entry)) return undefined;
  const declared = entry.inputModalities ?? entry.input_modalities;
  if (Array.isArray(declared)) {
    const hasText = declared.includes("text");
    const hasImage = declared.includes("image");
    if (hasText && hasImage) return ["text", "image"];
    if (hasText) return ["text"];
  }
  const textOnly = entry.textOnly ?? entry.text_only;
  if (textOnly === true) return ["text"];
  const supportsImage =
    entry.supportsImage ??
    entry.supports_image ??
    entry.vision ??
    entry.supportsImageDetailOriginal ??
    entry.supports_image_detail_original;
  if (supportsImage === true) return ["text", "image"];
  if (supportsImage === false) return ["text"];
  return undefined;
}

function formatInputModalities(modalities?: string[]): string {
  if (!modalities || modalities.length === 0) return "Unknown";
  if (modalities.some((m) => m.toLowerCase() === "image"))
    return "Text + image";
  return "Text only";
}

function formatModalitySource(
  source: CodexSubagentInputModalitySource,
): string {
  switch (source) {
    case "profile_explicit":
      return "Explicit profile declaration";
    case "route":
      return "Route capability";
    case "catalog":
      return "Model catalog";
    case "name_registry":
      return "Built-in model name registry";
    case "unknown":
      return "Unknown (no source declaration)";
  }
}

function settingsWithConfig(
  provider: Provider,
  config: CodexSubagentV2Config,
): Record<string, unknown> {
  const rawSettings = isRecord(provider.settingsConfig)
    ? provider.settingsConfig
    : {};
  const rawRouting = isRecord(rawSettings.codexRouting)
    ? rawSettings.codexRouting
    : {};
  return {
    ...rawSettings,
    codexRouting: {
      ...rawRouting,
      subagentV2: config,
    },
  };
}

function settingsForDiagnostics(
  provider: Provider,
  config: CodexSubagentV2Config,
  projectedModelCatalog?: unknown,
): Record<string, unknown> {
  const rawProfiles = readRawProfiles(config);
  const profiles = Object.fromEntries(
    Object.entries(rawProfiles).filter(([, profile]) =>
      isUsableProfile(profile),
    ),
  ) as Record<string, CodexSubagentV2Profile>;
  let invalidOrdinal = 1;
  for (const [, profile] of Object.entries(rawProfiles)) {
    if (isUsableProfile(profile)) continue;
    let diagnosticKey = `invalid-profile-${invalidOrdinal}`;
    while (diagnosticKey in profiles) {
      invalidOrdinal += 1;
      diagnosticKey = `invalid-profile-${invalidOrdinal}`;
    }
    profiles[diagnosticKey] = {} as CodexSubagentV2Profile;
    invalidOrdinal += 1;
  }
  const settings = settingsWithConfig(provider, { ...config, profiles });
  const catalog =
    includedModelCatalog(projectedModelCatalog) ??
    includedModelCatalog(provider.settingsConfig?.modelCatalog);
  return catalog ? { ...settings, modelCatalog: catalog } : settings;
}

function parseNicknames(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function nicknameError(profiles: Record<string, unknown>) {
  for (const profile of Object.values(profiles)) {
    if (!isUsableProfile(profile)) continue;
    const values = profile.overrides?.nicknameCandidates;
    if (!values) continue;
    const unique = new Set(values);
    if (
      values.length < 1 ||
      values.length > 3 ||
      unique.size !== values.length ||
      values.some((value) => !/^[A-Za-z0-9 _-]+$/.test(value))
    ) {
      return "Nickname candidates must be 1–3 unique ASCII letters, digits, spaces, hyphens, or underscores";
    }
  }
  return null;
}

function strengthError(profiles: Record<string, unknown>) {
  return Object.values(profiles).some(
    (profile) =>
      (isUsableProfile(profile) &&
        profile.questionnaire.taskStrengths.length < 1) ||
      (isUsableProfile(profile) &&
        (profile.questionnaire.taskStrengths.length > 5 ||
          new Set(profile.questionnaire.taskStrengths).size !==
            profile.questionnaire.taskStrengths.length)),
  )
    ? "Choose 1–5 unique task strengths for each model"
    : null;
}

export function CodexSubagentProfileEditor({
  provider,
  modelCatalog,
  onPersisted,
}: {
  provider: Provider;
  modelCatalog?: unknown;
  onPersisted?: (provider: Provider) => void;
}) {
  const queryClient = useQueryClient();
  const persistedConfig = readPersistedConfig(provider);
  const persistedKey = JSON.stringify(persistedConfig);
  const [draft, setDraft] = useState<CodexSubagentV2Config | null>(
    persistedConfig,
  );
  const [previews, setPreviews] = useState<
    Record<string, CodexSubagentProfilePreview>
  >({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>(
    {},
  );
  const [nicknameDrafts, setNicknameDrafts] = useState<Record<string, string>>(
    {},
  );
  const [statuses, setStatuses] = useState<CodexSubagentProfileStatuses | null>(
    null,
  );
  const [statusError, setStatusError] = useState<string | null>(null);
  const [reasoningCapabilities, setReasoningCapabilities] =
    useState<CodexSubagentReasoningCapabilities>({});
  const [strengthLimitMessage, setStrengthLimitMessage] = useState<
    string | null
  >(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [projectionWarning, setProjectionWarning] = useState<string | null>(
    null,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [profileSearch, setProfileSearch] = useState("");
  const [profileFilter, setProfileFilter] = useState<ProfileFilter>("all");
  const [showOfficialProfiles, setShowOfficialProfiles] = useState(false);
  const [openProfileKey, setOpenProfileKey] = useState("");
  const backendAdoptedPersistedKey = useRef<{
    providerId: string;
    persistedKey: string;
  } | null>(null);
  const usableProfileEntries = useMemo(
    () =>
      draft
        ? Object.entries(readRawProfiles(draft)).filter(
            (entry): entry is [string, CodexSubagentV2Profile] =>
              isUsableProfile(entry[1]),
          )
        : [],
    [draft],
  );
  const usableProfileKeySignature = usableProfileEntries
    .map(([profileKey]) => profileKey)
    .join("\n");
  const defaultOpenProfileKey =
    usableProfileEntries.find(([, profile]) => profile.enabled)?.[0] ??
    usableProfileEntries[0]?.[0] ??
    "";
  const effectivePersistedKey =
    backendAdoptedPersistedKey.current?.providerId === provider.id
      ? backendAdoptedPersistedKey.current.persistedKey
      : persistedKey;
  const isDirty =
    draft !== null && JSON.stringify(draft) !== effectivePersistedKey;

  useEffect(() => {
    const usableKeys = new Set(
      usableProfileKeySignature.split("\n").filter(Boolean),
    );
    setOpenProfileKey((current) =>
      usableKeys.has(current) ? current : defaultOpenProfileKey,
    );
  }, [provider.id, usableProfileKeySignature, defaultOpenProfileKey]);

  useEffect(() => {
    const adopted = backendAdoptedPersistedKey.current;
    const isBackendAdoptedRefresh =
      adopted?.providerId === provider.id &&
      adopted.persistedKey === persistedKey;
    backendAdoptedPersistedKey.current = null;
    setDraft(readPersistedConfig(provider));
    setSaveMessage(null);
    setSaveError(null);
    if (!isBackendAdoptedRefresh) setProjectionWarning(null);
    setStrengthLimitMessage(null);
    setNicknameDrafts({});
    setStatusError(null);
  }, [provider.id, persistedKey]);

  const diagnosticSettings = draft
    ? settingsForDiagnostics(provider, draft, modelCatalog)
    : includedModelCatalog(modelCatalog)
      ? {
          ...provider.settingsConfig,
          modelCatalog: includedModelCatalog(modelCatalog),
        }
      : provider.settingsConfig;
  const diagnosticSettingsKey = JSON.stringify(diagnosticSettings);

  useEffect(() => {
    if (!draft) {
      setReasoningCapabilities({});
      return;
    }
    let ignore = false;
    codexSubagentV2Api
      .getReasoningCapabilities(diagnosticSettings)
      .then((result) => {
        if (!ignore) setReasoningCapabilities(result);
      })
      .catch(() => {
        if (!ignore) setReasoningCapabilities({});
      });
    return () => {
      ignore = true;
    };
  }, [diagnosticSettingsKey]);

  useEffect(() => {
    if (!draft) {
      setStatuses(null);
      setStatusError(null);
      return;
    }
    let ignore = false;
    setStatusError(null);
    codexSubagentV2Api
      .getProfileStatuses(diagnosticSettings)
      .then((result) => {
        if (!ignore) setStatuses(result);
      })
      .catch((error) => {
        if (!ignore) {
          setStatuses(null);
          setStatusError(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    return () => {
      ignore = true;
    };
  }, [diagnosticSettingsKey]);

  useEffect(() => {
    if (!draft) {
      setPreviews({});
      setPreviewErrors({});
      return;
    }
    let ignore = false;
    const entries = Object.entries(readRawProfiles(draft)).filter(
      (entry): entry is [string, CodexSubagentV2Profile] =>
        isUsableProfile(entry[1]),
    );
    Promise.all(
      entries.map(async ([profileKey, profile]) => {
        try {
          const preview = await codexSubagentV2Api.previewProfile(
            diagnosticSettings,
            profile.model,
            profile,
          );
          return { profileKey, preview } as const;
        } catch (error) {
          return {
            profileKey,
            error: error instanceof Error ? error.message : String(error),
          } as const;
        }
      }),
    ).then((results) => {
      if (ignore) return;
      const nextPreviews: Record<string, CodexSubagentProfilePreview> = {};
      const nextErrors: Record<string, string> = {};
      for (const result of results) {
        if ("preview" in result && result.preview)
          nextPreviews[result.profileKey] = result.preview;
        else nextErrors[result.profileKey] = result.error;
      }
      setPreviews(nextPreviews);
      setPreviewErrors(nextErrors);
    });
    return () => {
      ignore = true;
    };
  }, [diagnosticSettingsKey]);

  async function adoptBackendProvider(
    nextProvider: CodexSubagentV2MutationProvider,
  ) {
    const nextConfig = readPersistedConfig(nextProvider);
    if (!nextConfig) {
      throw new Error(
        "Backend did not return the saved V2 sub-agent capability configuration.",
      );
    }
    backendAdoptedPersistedKey.current = {
      providerId: nextProvider.id,
      persistedKey: JSON.stringify(nextConfig),
    };
    setDraft(nextConfig);
    setProjectionWarning(nextProvider.projection?.warning?.message ?? null);
    onPersisted?.(nextProvider);
    await queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
  }

  async function persist(nextConfig: CodexSubagentV2Config) {
    const nextProvider = await codexSubagentV2Api.updateProviderConfig(
      provider.id,
      nextConfig,
    );
    await adoptBackendProvider(nextProvider);
    return nextProvider;
  }

  async function initialize() {
    setIsSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const nextProvider = await codexSubagentV2Api.initializeProviderConfig(
        provider.id,
      );
      await adoptBackendProvider(nextProvider);
      setSaveMessage(
        `V2 sub-agent capability configuration initialized;${evaluateMutationResult(nextProvider)}`,
      );
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  async function reconcile(
    action: CodexSubagentV2ReconcileAction,
    currentDraft: CodexSubagentV2Config,
  ) {
    setIsSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const nextProvider = await codexSubagentV2Api.reconcileProviderProfiles(
        provider.id,
        action,
        currentDraft,
      );
      await adoptBackendProvider(nextProvider);
      const actionMessage =
        action === "sync_catalog"
          ? "Missing model profiles repaired; existing settings were preserved"
          : action === "remove_all_invalid"
            ? "Invalid capability configuration deleted"
            : action === "prune_unroutable"
              ? "Removed invalid configurations for models no longer in the catalog"
              : "Invalid capability configurations restored from the model catalog";
      setSaveMessage(
        `${actionMessage}; ${evaluateMutationResult(nextProvider)}`,
      );
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  function updateProfile(
    profileKey: string,
    updater: (profile: CodexSubagentV2Profile) => CodexSubagentV2Profile,
  ) {
    setSaveMessage(null);
    setSaveError(null);
    setDraft((current) =>
      current
        ? {
            ...current,
            profiles: {
              ...current.profiles,
              [profileKey]: updater(current.profiles[profileKey]),
            },
          }
        : current,
    );
  }

  function repairProfile(profileKey: string) {
    const replacement = defaultProfileForModel(profileKey);
    if (!replacement) {
      setSaveError(
        "This invalid capability configuration cannot be repaired safely.",
      );
      return;
    }
    setSaveMessage(null);
    setSaveError(null);
    setDraft((current) =>
      current
        ? {
            ...current,
            profiles: {
              ...readRawProfiles(current),
              [profileKey]: replacement,
            } as Record<string, CodexSubagentV2Profile>,
          }
        : current,
    );
  }

  function setOverride<
    K extends keyof NonNullable<CodexSubagentV2Profile["overrides"]>,
  >(
    profileKey: string,
    key: K,
    value: NonNullable<CodexSubagentV2Profile["overrides"]>[K],
  ) {
    updateProfile(profileKey, (profile) => ({
      ...profile,
      overrides: { ...profile.overrides, [key]: value },
    }));
  }

  function restoreOverride(
    profileKey: string,
    key: keyof NonNullable<CodexSubagentV2Profile["overrides"]>,
  ) {
    if (key === "nicknameCandidates") {
      setNicknameDrafts((current) => {
        const next = { ...current };
        delete next[profileKey];
        return next;
      });
    }
    updateProfile(profileKey, (profile) => {
      const overrides = { ...profile.overrides };
      delete overrides[key];
      return {
        ...profile,
        ...(Object.keys(overrides).length > 0
          ? { overrides }
          : { overrides: undefined }),
      };
    });
  }

  async function save() {
    if (!draft) return;
    const rawProfiles = readRawProfiles(draft);
    const localError = strengthError(rawProfiles) ?? nicknameError(rawProfiles);
    if (localError) {
      setSaveError(localError);
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const authoritativeStatuses =
        await codexSubagentV2Api.getProfileStatuses(diagnosticSettings);
      setStatuses(authoritativeStatuses);
      setStatusError(null);
      const blocking = authoritativeStatuses.profiles.filter(
        (profile) =>
          profile.status === "collision" ||
          profile.status === "invalid" ||
          (profile.status === "generated" &&
            profile.enabled === true &&
            profile.routable &&
            profile.reasoningCapability?.supportKind === "unknown"),
      );
      if (blocking.length > 0) {
        const incompleteReasoning = blocking.filter(
          (profile) =>
            profile.reasoningCapability?.supportKind === "unknown" &&
            profile.status === "generated",
        );
        if (incompleteReasoning.length > 0) {
          throw new Error(
            incompleteReasoning
              .map(
                (profile) =>
                  `${profile.profileKey ?? profile.model ?? "V2 profile"}: Reasoning capability is not configured. Declare it in the model catalog before saving.`,
              )
              .join("; "),
          );
        }
        if (
          Object.values(rawProfiles).some(
            (profile) => !isUsableProfile(profile),
          )
        ) {
          throw new Error(
            "Invalid capability configurations exist; cannot save.",
          );
        }
        const details = blocking.flatMap((profile) => profile.warnings);
        throw new Error(
          details[0] ??
            blocking
              .map(
                (profile) =>
                  `${profile.profileKey ?? profile.model ?? "V2 profile"}: ${profile.status}`,
              )
              .join("; "),
        );
      }
      const result = await persist(draft);
      setSaveMessage(evaluateMutationResult(result));
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  if (!draft) {
    return (
      <section className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4 dark:border-emerald-700/50 dark:bg-emerald-950/20">
        <p className="text-sm text-muted-foreground">
          The current plan still uses compatibility legacy managed roles.
          Explicit questionnaire input is persisted after initialization.
        </p>
        <Button className="mt-3" onClick={initialize} disabled={isSaving}>
          Initialize V2 sub-agent capabilities
        </Button>
        {saveError ? (
          <p className="mt-2 text-sm text-rose-600">{saveError}</p>
        ) : null}
      </section>
    );
  }

  const rawProfileEntries = Object.entries(readRawProfiles(draft));
  const profileEntries = usableProfileEntries;
  const invalidProfileEntries = rawProfileEntries.filter(
    ([, profile]) => !isUsableProfile(profile),
  );
  const backendReconciliableProfileCount = (statuses?.profiles ?? []).filter(
    ({ status }) => status === "invalid" || status === "collision",
  ).length;
  const reconciliableProfileCount = Math.max(
    invalidProfileEntries.length,
    backendReconciliableProfileCount,
  );
  // parse-valid 但模型已离开可路由 catalog 的 profile（“失效”配置），
  // 与“无效能力配置”（parse-invalid/collision）区分开，供“与目录同步”按钮使用。
  const unroutableProfileCount = (statuses?.profiles ?? []).filter(
    ({ status }) => status === "unroutable",
  ).length;
  const usableProfileKeys = new Set(
    profileEntries.map(([profileKey]) => profileKey),
  );
  const statusByProfileKey = new Map(
    (statuses?.profiles ?? [])
      .filter(
        (status) =>
          status.profileKey !== undefined &&
          usableProfileKeys.has(status.profileKey),
      )
      .map((status) => [status.profileKey!, status]),
  );
  const unassignedStatuses = (statuses?.profiles ?? []).filter(
    (status) => !status.profileKey || !usableProfileKeys.has(status.profileKey),
  );
  const officialProfileCount = profileEntries.filter(([profileKey]) => {
    const status = statusByProfileKey.get(profileKey);
    const preview = previews[profileKey];
    return (status?.providerKind ?? preview?.providerKind) === "official";
  }).length;
  const visibleProfileEntries = [...profileEntries]
    .sort(([leftKey, left], [rightKey, right]) => {
      const leftStatus = statusByProfileKey.get(leftKey);
      const rightStatus = statusByProfileKey.get(rightKey);
      return (
        Number(right.enabled) - Number(left.enabled) ||
        Number(rightStatus?.routable ?? false) -
          Number(leftStatus?.routable ?? false) ||
        left.model.localeCompare(right.model, "en")
      );
    })
    .filter(([profileKey, profile]) => {
      const status = statusByProfileKey.get(profileKey);
      const preview = previews[profileKey];
      const providerKind = status?.providerKind ?? preview?.providerKind;
      if (providerKind === "official" && !showOfficialProfiles) return false;
      if (profileFilter === "enabled" && !profile.enabled) return false;
      if (profileFilter === "draft" && profile.enabled) return false;
      if (profileFilter === "unroutable" && status?.status !== "unroutable") {
        return false;
      }
      const haystack = [
        profile.model,
        profileKey,
        preview?.requestedRoleName,
        preview?.effectiveRoleName,
        status?.requestedRoleName,
        status?.effectiveRoleName,
        status?.providerKind,
        preview?.providerKind,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return haystack.includes(profileSearch.trim().toLocaleLowerCase());
    });

  const saveState = saveError ? "error" : isDirty ? "dirty" : "saved";

  return (
    <section
      data-theme-contract="codex-subagent-v2"
      className="space-y-4 rounded-xl border border-blue-200/80 bg-gradient-to-br from-blue-50/80 via-background to-violet-50/70 p-4 shadow-sm dark:border-blue-500/30 dark:from-blue-950/25 dark:via-slate-950/40 dark:to-violet-950/20"
    >
      <fieldset disabled={isSaving} className="contents">
        <section
          data-subagent-panel="strategy"
          className="space-y-3 rounded-lg border border-blue-200 bg-blue-50/70 p-3 dark:border-blue-500/40 dark:bg-blue-950/20"
        >
          <div className="flex items-center gap-2 text-blue-900 dark:text-blue-100">
            <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
            <h3 className="text-sm font-semibold">Selection policy</h3>
          </div>
          <label className="grid gap-1 text-sm">
            <span className="font-medium text-blue-950 dark:text-blue-100">
              Third-party sub-agent selection policy
            </span>
            <select
              className="rounded-md border border-blue-200 bg-background/90 px-3 py-2 dark:border-blue-500/35 dark:bg-slate-950/60"
              value={draft.selectionPolicy}
              onChange={(event) => {
                setSaveMessage(null);
                setSaveError(null);
                setDraft({
                  ...draft,
                  selectionPolicy: event.target
                    .value as CodexSubagentV2Config["selectionPolicy"],
                });
              }}
            >
              <option value="balanced">Balanced</option>
              <option value="official_first">Official first</option>
              <option value="third_party_first">Third-party first</option>
            </select>
          </label>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <label
              htmlFor="codex-subagent-profile-search"
              className="grid gap-1 text-sm"
            >
              <span className="font-medium text-blue-950 dark:text-blue-100">
                Search sub-agent models
              </span>
              <span className="relative">
                <Search
                  aria-hidden="true"
                  className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-blue-600 dark:text-blue-300"
                />
                <Input
                  id="codex-subagent-profile-search"
                  type="search"
                  value={profileSearch}
                  onChange={(event) => setProfileSearch(event.target.value)}
                  placeholder="Model, role name, or provider type"
                  className="border-blue-200 bg-background/90 pl-9 dark:border-blue-500/35 dark:bg-slate-950/60"
                />
              </span>
            </label>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Sub-agent model filter"
            >
              {PROFILE_FILTERS.map((filter) => (
                <Button
                  key={filter.value}
                  type="button"
                  size="sm"
                  variant={
                    profileFilter === filter.value ? "default" : "outline"
                  }
                  className={cn(
                    profileFilter === filter.value
                      ? "bg-blue-600 text-white hover:bg-blue-500"
                      : "border-blue-200 bg-background/80 text-blue-800 hover:bg-blue-100 dark:border-blue-500/35 dark:bg-blue-950/25 dark:text-blue-100 dark:hover:bg-blue-500/20",
                  )}
                  aria-pressed={profileFilter === filter.value}
                  onClick={() => setProfileFilter(filter.value)}
                >
                  {filter.label}
                </Button>
              ))}
            </div>
          </div>
        </section>

        <div
          data-subagent-panel="catalog"
          className="space-y-3 rounded-lg border border-cyan-200/70 bg-cyan-50/60 p-3 dark:border-cyan-500/30 dark:bg-cyan-950/15"
        >
          <div className="flex flex-wrap items-start gap-3">
            <Button
              type="button"
              variant="outline"
              className="border-cyan-200 bg-background/85 text-cyan-800 hover:bg-cyan-100 dark:border-cyan-500/40 dark:bg-cyan-950/30 dark:text-cyan-100 dark:hover:bg-cyan-500/20"
              onClick={() => reconcile("sync_catalog", draft)}
            >
              <Database aria-hidden="true" className="h-4 w-4" />
              Repair missing model profiles
            </Button>
            <p className="max-w-2xl text-xs leading-5 text-cyan-900/75 dark:text-cyan-100/75">
              Normally, new models are added automatically when the provider is
              saved and disabled by default. Use this only to repair missing
              entries caused by historical config or interrupted operations;
              existing questionnaires and manual settings are preserved.
            </p>
          </div>
          {reconciliableProfileCount > 0 ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => reconcile("remove_all_invalid", draft)}
              >
                Delete all invalid capability configurations (
                {reconciliableProfileCount} items)
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  reconcile("recover_all_invalid_from_catalog", draft)
                }
              >
                Restore all invalid capability configurations from the model
                catalog ({reconciliableProfileCount} items)
              </Button>
            </div>
          ) : null}
          {unroutableProfileCount > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="border-amber-300 bg-background/85 text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100 dark:hover:bg-amber-500/20"
                onClick={() => reconcile("prune_unroutable", draft)}
              >
                Sync with catalog: delete unavailable models (
                {unroutableProfileCount} items)
              </Button>
              <p className="max-w-2xl text-xs leading-5 text-amber-900/75 dark:text-amber-100/75">
                The models in these configurations are no longer in the current
                MultiRouter catalog. Syncing deletes them; add them again if the
                models return to the catalog.
              </p>
            </div>
          ) : null}
        </div>

        {officialProfileCount > 0 ? (
          <div className="rounded-lg border border-border/60 bg-muted/25 p-3">
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-between px-2 text-left"
              aria-expanded={showOfficialProfiles}
              onClick={() => setShowOfficialProfiles((current) => !current)}
            >
              <span>
                Official models (advanced) · {officialProfileCount} profiles
              </span>
              <span className="text-xs text-muted-foreground">
                {showOfficialProfiles ? "Collapse" : "View"}
              </span>
            </Button>
            {showOfficialProfiles ? (
              <p className="px-2 pt-2 text-xs leading-5 text-muted-foreground">
                Official models usually do not need fixed roles; Codex built-in
                roles inherit the current official model. Enable this only when
                you explicitly need to pin an official model.
              </p>
            ) : null}
          </div>
        ) : null}

        {visibleProfileEntries.length > 0 ? (
          <Accordion
            type="single"
            collapsible
            value={openProfileKey}
            onValueChange={setOpenProfileKey}
            className="space-y-2"
          >
            {visibleProfileEntries.map(
              ([profileKey, profile], profileIndex) => {
                const preview = previews[profileKey];
                const status = statusByProfileKey.get(profileKey);
                const reasoningCapability =
                  Object.entries(reasoningCapabilities).find(
                    ([model]) =>
                      model.localeCompare(profile.model, undefined, {
                        sensitivity: "accent",
                      }) === 0,
                  )?.[1] ??
                  preview?.reasoningCapability ??
                  status?.reasoningCapability;
                const selectableFixedEfforts = (
                  reasoningCapability?.codexSelectableEfforts ?? []
                ).filter(
                  (effort): effort is CodexSubagentExplicitReasoningEffort =>
                    effort !== "none" && EXPLICIT_REASONING_EFFORTS.has(effort),
                );
                const reasoningPolicyOptions: Array<[string, string]> = [
                  ["delegated", "Allow the parent agent / spawn to specify"],
                ];
                if (reasoningCapability?.providerDefaultEffort) {
                  reasoningPolicyOptions.push([
                    "model_default",
                    "Use model default (fixed)",
                  ]);
                }
                if (selectableFixedEfforts.length > 0) {
                  reasoningPolicyOptions.push(["fixed", "Fixed effort"]);
                }
                if (reasoningCapability?.disableAllowed) {
                  reasoningPolicyOptions.push([
                    "disabled",
                    "Disable reasoning",
                  ]);
                }
                const profileTone = profileToneFor(profile, status);
                const overrides = profile.overrides ?? {};
                const effectiveInputModalities = inferredInputModalities(
                  provider,
                  profile,
                  modelCatalog,
                );
                const nicknameValue =
                  nicknameDrafts[profileKey] ??
                  (
                    overrides.nicknameCandidates ??
                    preview?.nicknameCandidates ??
                    []
                  ).join(", ");
                return (
                  <AccordionItem
                    key={profileKey}
                    value={profileKey}
                    data-profile-tone={profileTone}
                    className={cn(
                      "rounded-xl border px-4 shadow-sm transition-colors",
                      profileToneClassName(profileTone),
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <AccordionTrigger
                          aria-label={`Configure ${profile.model}`}
                          className="py-3 hover:no-underline"
                        >
                          <ProfileSummary
                            profile={profile}
                            preview={preview}
                            status={status}
                          />
                        </AccordionTrigger>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={`Edit ${profile.model}`}
                        onClick={() => setOpenProfileKey(profileKey)}
                        // 真不可路由（编译状态 Unroutable）一律禁止编辑；
                        // 未启用的可路由 profile（编译状态 Disabled）必须可编辑，
                        // 否则死锁（v28 回归：未启用 → routable=false → 禁编辑）。
                        disabled={isSaving || status?.status === "unroutable"}
                        className="shrink-0"
                      >
                        Edit
                      </Button>
                      <label className="flex shrink-0 items-center gap-2 text-xs">
                        <Switch
                          aria-label={`Enable ${profile.model} as a V2 sub-agent`}
                          checked={profile.enabled}
                          // 用 status.status 区分"未启用（disabled）"与"真不可路由
                          // （unroutable）"：未启用 profile 的后端编译状态是 Disabled，
                          // routable=false 会把它误判成不可路由，导致永远无法启用。
                          disabled={
                            status?.status === "unroutable" && !profile.enabled
                          }
                          onCheckedChange={(checked) =>
                            updateProfile(profileKey, (current) => ({
                              ...current,
                              enabled: checked,
                            }))
                          }
                        />
                        {profile.enabled ? "Enabled" : "Disabled"}
                      </label>
                    </div>
                    <AccordionContent
                      role="region"
                      aria-labelledby={`codex-subagent-${profileIndex}-region-label`}
                      className="space-y-4 rounded-lg border border-border/60 bg-background/75 p-4 dark:bg-slate-950/35"
                    >
                      <span
                        id={`codex-subagent-${profileIndex}-region-label`}
                        className="sr-only"
                      >
                        {profile.model} sub-agent configuration
                      </span>
                      <fieldset
                        className="grid gap-3 rounded-lg border border-sky-200 bg-sky-50/60 p-3 dark:border-sky-500/40 dark:bg-sky-950/20"
                        aria-label="Task strengths"
                      >
                        <legend className="px-1 text-sm font-semibold text-sky-900 dark:text-sky-100">
                          Task strengths
                        </legend>
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                          {TASK_STRENGTHS.map((strength) => (
                            <label
                              key={strength.value}
                              className={cn(
                                "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors",
                                profile.questionnaire.taskStrengths.includes(
                                  strength.value,
                                )
                                  ? "border-sky-300 bg-sky-100/80 text-sky-950 shadow-sm dark:border-sky-500/50 dark:bg-sky-500/15 dark:text-sky-100"
                                  : "border-slate-200 bg-background/70 text-slate-700 hover:border-sky-300 hover:bg-sky-50 dark:border-slate-700 dark:bg-slate-950/35 dark:text-slate-300 dark:hover:border-sky-500/40 dark:hover:bg-sky-950/25",
                              )}
                            >
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-sky-600"
                                value={strength.value}
                                checked={profile.questionnaire.taskStrengths.includes(
                                  strength.value,
                                )}
                                onChange={(event) => {
                                  const selected =
                                    profile.questionnaire.taskStrengths;
                                  if (
                                    event.target.checked &&
                                    selected.length >= 5
                                  ) {
                                    setStrengthLimitMessage(
                                      "Choose at most 5 task strengths",
                                    );
                                    return;
                                  }
                                  setStrengthLimitMessage(null);
                                  const taskStrengths = event.target.checked
                                    ? selected.includes(strength.value)
                                      ? selected
                                      : [...selected, strength.value]
                                    : selected.filter(
                                        (item) => item !== strength.value,
                                      );
                                  updateProfile(profileKey, (current) => ({
                                    ...current,
                                    questionnaire: {
                                      ...current.questionnaire,
                                      taskStrengths,
                                    },
                                  }));
                                }}
                              />
                              {strength.label}
                            </label>
                          ))}
                        </div>
                      </fieldset>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <QuestionnaireSelect
                          label="Input capability"
                          value={
                            effectiveInputModalities?.[1] === "image"
                              ? "text_and_image"
                              : effectiveInputModalities?.[0] === "text"
                                ? "text_only"
                                : "unknown"
                          }
                          options={[
                            ["unknown", "Undeclared"],
                            ["text_only", "Text only"],
                            ["text_and_image", "Text and image"],
                          ]}
                          onChange={(value) =>
                            updateProfile(profileKey, (current) => {
                              if (value === "unknown") {
                                const { inputModalities: _, ...rest } = current;
                                return rest;
                              }
                              return {
                                ...current,
                                inputModalities:
                                  value === "text_and_image"
                                    ? ["text", "image"]
                                    : ["text"],
                              };
                            })
                          }
                        />
                        <QuestionnaireSelect
                          label="Optimization target"
                          value={profile.questionnaire.optimization}
                          options={[
                            ["speed", "Speed"],
                            ["balanced", "Balanced"],
                            ["quality", "Quality"],
                          ]}
                          onChange={(value) =>
                            updateProfile(profileKey, (current) => ({
                              ...current,
                              questionnaire: {
                                ...current.questionnaire,
                                optimization:
                                  value as typeof current.questionnaire.optimization,
                              },
                            }))
                          }
                        />
                        <QuestionnaireSelect
                          label="Write scope"
                          value={profile.questionnaire.writeScope}
                          options={[
                            ["read_only", "Read-only"],
                            ["bounded_changes", "Bounded changes"],
                            ["complex_changes", "Complex changes"],
                          ]}
                          onChange={(value) =>
                            updateProfile(profileKey, (current) => ({
                              ...current,
                              questionnaire: {
                                ...current.questionnaire,
                                writeScope:
                                  value as typeof current.questionnaire.writeScope,
                              },
                            }))
                          }
                        />
                        <QuestionnaireSelect
                          label="Model preference"
                          value={profile.questionnaire.preference}
                          options={[
                            ["preferred", "Preferred"],
                            ["eligible", "Eligible"],
                            ["fallback", "Fallback"],
                          ]}
                          onChange={(value) =>
                            updateProfile(profileKey, (current) => ({
                              ...current,
                              questionnaire: {
                                ...current.questionnaire,
                                preference:
                                  value as typeof current.questionnaire.preference,
                              },
                            }))
                          }
                        />
                        <QuestionnaireSelect
                          label="Reasoning policy"
                          value={profile.reasoning.policy}
                          options={reasoningPolicyOptions}
                          onChange={(value) =>
                            updateProfile(profileKey, (current) => ({
                              ...current,
                              reasoning:
                                value === "fixed"
                                  ? {
                                      policy: "fixed",
                                      effort:
                                        current.reasoning.policy === "fixed"
                                          ? current.reasoning.effort
                                          : (selectableFixedEfforts.find(
                                              (effort) =>
                                                effort ===
                                                reasoningCapability?.providerDefaultEffort,
                                            ) ??
                                            (selectableFixedEfforts[0] as CodexSubagentExplicitReasoningEffort)),
                                    }
                                  : {
                                      policy: value as
                                        | "delegated"
                                        | "model_default"
                                        | "disabled",
                                    },
                            }))
                          }
                        />
                        <ReasoningCapabilitySummary
                          capability={reasoningCapability}
                          policy={profile.reasoning}
                        />
                      </div>

                      <Collapsible>
                        <CollapsibleTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            className="border-violet-200 bg-violet-50 text-violet-800 hover:bg-violet-100 dark:border-violet-500/40 dark:bg-violet-950/25 dark:text-violet-100 dark:hover:bg-violet-500/20"
                          >
                            <SlidersHorizontal
                              aria-hidden="true"
                              className="h-4 w-4"
                            />
                            Advanced fields
                          </Button>
                        </CollapsibleTrigger>
                        <CollapsibleContent className="mt-3 space-y-3 rounded-lg border border-violet-200 bg-violet-50/55 p-3 dark:border-violet-500/35 dark:bg-violet-950/20">
                          <OverrideField
                            id={`codex-subagent-${profileIndex}-role-name`}
                            label="Role name"
                            value={
                              overrides.roleName ??
                              preview?.requestedRoleName ??
                              ""
                            }
                            automatic={overrides.roleName === undefined}
                            restoreLabel="Restore automatic role name"
                            onChange={(value) =>
                              setOverride(profileKey, "roleName", value)
                            }
                            onRestore={() =>
                              restoreOverride(profileKey, "roleName")
                            }
                          />
                          <OverrideField
                            id={`codex-subagent-${profileIndex}-description`}
                            label="Role description"
                            value={
                              overrides.description ??
                              preview?.description ??
                              ""
                            }
                            automatic={overrides.description === undefined}
                            restoreLabel="Restore automatic role description"
                            multiline
                            onChange={(value) =>
                              setOverride(profileKey, "description", value)
                            }
                            onRestore={() =>
                              restoreOverride(profileKey, "description")
                            }
                          />
                          <OverrideField
                            id={`codex-subagent-${profileIndex}-developer-instructions`}
                            label="Developer instructions"
                            value={
                              overrides.developerInstructions ??
                              preview?.developerInstructions ??
                              ""
                            }
                            automatic={
                              overrides.developerInstructions === undefined
                            }
                            restoreLabel="Restore automatic developer instructions"
                            multiline
                            onChange={(value) =>
                              setOverride(
                                profileKey,
                                "developerInstructions",
                                value,
                              )
                            }
                            onRestore={() =>
                              restoreOverride(
                                profileKey,
                                "developerInstructions",
                              )
                            }
                          />
                          <OverrideField
                            id={`codex-subagent-${profileIndex}-nickname-candidates`}
                            label="Nickname candidates"
                            value={nicknameValue}
                            automatic={
                              overrides.nicknameCandidates === undefined
                            }
                            restoreLabel="Restore automatic nickname candidates"
                            onChange={(value) => {
                              setNicknameDrafts((current) => ({
                                ...current,
                                [profileKey]: value,
                              }));
                              setOverride(
                                profileKey,
                                "nicknameCandidates",
                                parseNicknames(value),
                              );
                            }}
                            onRestore={() =>
                              restoreOverride(profileKey, "nicknameCandidates")
                            }
                          />
                          <div className="grid gap-1 text-sm">
                            <span className="flex items-center justify-between gap-2">
                              <label
                                htmlFor={`codex-subagent-${profileIndex}-model-reasoning`}
                              >
                                Model reasoning effort
                              </label>
                              <span className="text-xs text-muted-foreground">
                                {profile.reasoning.policy === "fixed"
                                  ? "Fixed"
                                  : "Not fixed"}
                              </span>
                            </span>
                            <div className="flex gap-2">
                              <select
                                id={`codex-subagent-${profileIndex}-model-reasoning`}
                                className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2"
                                value={
                                  profile.reasoning.policy === "fixed"
                                    ? profile.reasoning.effort
                                    : (preview?.modelReasoningEffort ?? "")
                                }
                                disabled={profile.reasoning.policy !== "fixed"}
                                onChange={(event) =>
                                  updateProfile(profileKey, (current) => ({
                                    ...current,
                                    reasoning: {
                                      policy: "fixed",
                                      effort: event.target
                                        .value as CodexSubagentExplicitReasoningEffort,
                                    },
                                  }))
                                }
                              >
                                {profile.reasoning.policy !== "fixed" ? (
                                  <option value="" disabled>
                                    Waiting for backend capability
                                  </option>
                                ) : null}
                                {selectableFixedEfforts.map((effort) => (
                                  <option key={effort} value={effort}>
                                    {effort}
                                  </option>
                                ))}
                              </select>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() =>
                                  updateProfile(profileKey, (current) => ({
                                    ...current,
                                    reasoning: { policy: "delegated" },
                                  }))
                                }
                              >
                                Allow the parent agent / spawn to specify
                              </Button>
                            </div>
                          </div>
                        </CollapsibleContent>
                      </Collapsible>

                      <Collapsible>
                        <CollapsibleTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            className="border-cyan-200 bg-cyan-50 text-cyan-800 hover:bg-cyan-100 dark:border-cyan-500/40 dark:bg-cyan-950/25 dark:text-cyan-100 dark:hover:bg-cyan-500/20"
                          >
                            <Code2 aria-hidden="true" className="h-4 w-4" />
                            Generated result and TOML
                          </Button>
                        </CollapsibleTrigger>
                        <CollapsibleContent className="mt-3 space-y-3 rounded-lg border border-cyan-200 bg-cyan-50/55 p-3 dark:border-cyan-500/35 dark:bg-cyan-950/20">
                          {previewErrors[profileKey] ? (
                            <p role="alert" className="text-xs text-rose-600">
                              {previewErrors[profileKey]}
                            </p>
                          ) : null}
                          <ProfileBackendOutput
                            profileKey={profileKey}
                            profile={profile}
                            preview={preview}
                            status={status}
                          />
                        </CollapsibleContent>
                      </Collapsible>
                    </AccordionContent>
                  </AccordionItem>
                );
              },
            )}
          </Accordion>
        ) : (
          <div className="rounded-lg border border-dashed bg-background/70 p-6 text-center">
            <p className="text-sm font-medium">
              No sub-agent models match the filters
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-3"
              onClick={() => {
                setProfileSearch("");
                setProfileFilter("all");
              }}
            >
              Clear filters
            </Button>
          </div>
        )}

        {invalidProfileEntries.length > 0 ? (
          <section
            aria-label="Needs attention"
            className="space-y-3 rounded-lg border border-rose-300 bg-rose-50/40 p-3 dark:bg-rose-950/15"
          >
            <h3 className="text-sm font-semibold text-rose-800 dark:text-rose-100">
              Needs attention
            </h3>
            <div className="grid gap-3 lg:grid-cols-2">
              {invalidProfileEntries.map(([profileKey], index) => {
                const ordinal = index + 1;
                const title = `Invalid capability configuration ${ordinal}`;
                return (
                  <section
                    key={profileKey}
                    aria-label={title}
                    className="space-y-3 rounded-lg border border-rose-300 bg-background/80 p-4"
                  >
                    <div className="font-medium">{title}</div>
                    <p className="text-sm text-rose-700">
                      The persisted profile structure is invalid; the original
                      entry has not been modified.
                    </p>
                    <ProfileBackendOutput status={undefined} />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => repairProfile(profileKey)}
                    >
                      Repair invalid capability configuration {ordinal}
                    </Button>
                  </section>
                );
              })}
            </div>
          </section>
        ) : null}
      </fieldset>

      {strengthLimitMessage ? (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-200">
          {strengthLimitMessage}
        </p>
      ) : null}

      {statusError ? (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-300">
          {statusError}
        </p>
      ) : null}
      {statuses ? (
        <div className="space-y-2 rounded-lg border border-indigo-200 bg-indigo-50/65 p-4 text-sm text-indigo-950 dark:border-indigo-500/35 dark:bg-indigo-950/20 dark:text-indigo-100">
          <p className="font-medium">
            Generation source:{statuses.generationSource}
          </p>
          {unassignedStatuses.map((status, index) => (
            <ProfileBackendOutput key={`unassigned-${index}`} status={status} />
          ))}
          {statuses.warnings.map((warning) => (
            <p key={warning} className="text-amber-700 dark:text-amber-200">
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      <div
        data-save-state={saveState}
        className={cn(
          "sticky bottom-0 z-10 flex flex-wrap items-center gap-3 rounded-lg border p-3 shadow-lg backdrop-blur",
          saveState === "error"
            ? "border-rose-200 bg-rose-50/95 dark:border-rose-500/40 dark:bg-rose-950/90"
            : saveState === "dirty"
              ? "border-blue-200 bg-blue-50/95 dark:border-blue-500/40 dark:bg-blue-950/90"
              : "border-emerald-200 bg-emerald-50/95 dark:border-emerald-500/40 dark:bg-emerald-950/90",
        )}
      >
        <span
          className={cn(
            "text-sm font-medium",
            saveState === "error"
              ? "text-rose-800 dark:text-rose-100"
              : saveState === "dirty"
                ? "text-blue-800 dark:text-blue-100"
                : "text-emerald-800 dark:text-emerald-100",
          )}
        >
          {isDirty ? "Unsaved changes" : "All changes saved"}
        </span>
        <Button
          className="bg-blue-600 text-white hover:bg-blue-500"
          onClick={save}
          disabled={isSaving || !isDirty}
        >
          {isSaving ? "Saving…" : "Save V2 sub-agent configuration"}
        </Button>
        {saveMessage ? (
          <span
            aria-live="polite"
            className="text-sm text-emerald-700 dark:text-emerald-200"
          >
            {saveMessage}
          </span>
        ) : null}
        {saveError ? (
          <span
            role="alert"
            className="text-sm text-rose-600 dark:text-rose-200"
          >
            {saveError}
          </span>
        ) : null}
        {projectionWarning ? (
          <span
            role="status"
            aria-live="polite"
            className="text-sm text-amber-700 dark:text-amber-200"
          >
            {projectionWarning}
          </span>
        ) : null}
      </div>
    </section>
  );
}

function ReasoningCapabilitySummary({
  capability,
  policy,
}: {
  capability?: CodexSubagentReasoningCapability;
  policy: CodexSubagentV2Profile["reasoning"];
}) {
  if (!capability) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900 dark:border-amber-500/35 dark:bg-amber-950/20 dark:text-amber-100">
        Reading reasoning capabilities parsed by the backend; fixed effort or
        disabled reasoning will not be applied until confirmed.
      </div>
    );
  }

  const mappings = capability.codexSelectableEfforts
    .filter((effort) => effort !== "none" && capability.effortMap[effort])
    .map((effort) => `${effort}→${capability.effortMap[effort]}`)
    .join(", ");
  const behavior =
    policy.policy === "delegated"
      ? "Determined by the parent agent, spawn parameters, or Codex defaults"
      : policy.policy === "model_default"
        ? `Fixed to the model’s current default ${capability.providerDefaultEffort ?? "Undeclared"}`
        : policy.policy === "fixed"
          ? `Fixed at ${policy.effort}; the parent agent cannot override it`
          : "Reasoning disabled; the upstream uses the provider’s confirmed disabled semantics";
  const ultraEnabled = capability.codexUltraOrchestrationEnabled;

  return (
    <div className="space-y-1 rounded-md border border-indigo-200 bg-indigo-50/70 p-3 text-xs text-indigo-950 dark:border-indigo-500/35 dark:bg-indigo-950/20 dark:text-indigo-100">
      <p>
        Capability source:{capability.source ?? "Undeclared"} (
        {capability.confidence})
      </p>
      <p>
        Provider-native efforts:
        {capability.providerAcceptedEfforts.join(" / ") || "Undeclared"}
      </p>
      <p>
        Codex-selectable efforts:
        {capability.codexSelectableEfforts.join(" / ") || "Unconfirmed"}
      </p>
      <p>Model default:{capability.providerDefaultEffort ?? "Undeclared"}</p>
      <p>Disable allowed:{capability.disableAllowed ? "Yes" : "No"}</p>
      {mappings ? <p>Mapping:{mappings}</p> : null}
      {ultraEnabled ? (
        <p>
          Ultra enabled: this is Codex V2’s “maximum reasoning + active
          sub-agent delegation” mode; The third-party provider receives{" "}
          {capability.effortMap.ultra ?? "max"}.
        </p>
      ) : (
        <p>
          Ultra disabled: if the parent agent uses Ultra, the current role
          should use the model default or a fixed compatible effort, or enable
          Codex Ultra orchestration in the model’s reasoning capabilities.
        </p>
      )}
      <p className="font-medium">{behavior}</p>
      {capability.supportKind === "unknown" ? (
        <p className="font-medium text-rose-700 dark:text-rose-300">
          Reasoning capability is not configured; the current routable role
          cannot be saved. First declare it in the provider model catalog, or
          complete a read-only capability probe and adopt its result.
        </p>
      ) : null}
    </div>
  );
}

function ProfileSummary({
  profile,
  preview,
  status,
}: {
  profile: CodexSubagentV2Profile;
  preview?: CodexSubagentProfilePreview;
  status?: CodexSubagentProfileStatus;
}) {
  const preferenceLabels = {
    preferred: "Preferred",
    eligible: "Eligible",
    fallback: "Fallback",
  } as const;
  const providerKind = status?.providerKind ?? preview?.providerKind;
  const reasoning =
    profile.reasoning.policy === "fixed"
      ? profile.reasoning.effort
      : profile.reasoning.policy;
  const strengthLabels = profile.questionnaire.taskStrengths
    .slice(0, 3)
    .map((value) => TASK_STRENGTHS.find((item) => item.value === value)?.label)
    .filter((label): label is string => Boolean(label));
  const hasOverrides = Boolean(
    profile.overrides && Object.keys(profile.overrides).length > 0,
  );

  return (
    <div className="min-w-0 flex-1 text-left">
      <div className="truncate text-sm font-semibold">{profile.model}</div>
      <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
        <Badge
          variant="outline"
          className={
            providerKind === "official"
              ? "border-blue-200 bg-blue-100/80 text-blue-800 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-100"
              : "border-violet-200 bg-violet-100/80 text-violet-800 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-100"
          }
        >
          {providerKind === "official" ? "Official" : "Third-party"}
        </Badge>
        <Badge
          variant="outline"
          className={
            status?.status === "unroutable"
              ? "border-border bg-muted text-muted-foreground dark:border-slate-600 dark:bg-slate-800/70 dark:text-slate-300"
              : "border-emerald-200 bg-emerald-100/80 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-100"
          }
        >
          {status?.status === "unroutable" ? "Unroutable" : "Routable"}
        </Badge>
        <Badge
          variant="outline"
          className={
            profile.enabled
              ? "border-teal-200 bg-teal-100/80 text-teal-800 dark:border-teal-500/40 dark:bg-teal-500/15 dark:text-teal-100"
              : "border-amber-200 bg-amber-100/80 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100"
          }
        >
          {profile.enabled ? "Enabled" : "Not configured"}
        </Badge>
        <Badge
          variant="outline"
          className="border-amber-200 bg-amber-100/70 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100"
        >
          {preferenceLabels[profile.questionnaire.preference]}
        </Badge>
        <Badge
          variant="outline"
          className="border-sky-200 bg-sky-100/70 text-sky-800 dark:border-sky-500/40 dark:bg-sky-500/15 dark:text-sky-100"
        >
          Reasoning {reasoning}
        </Badge>
        <Badge
          variant="outline"
          className="border-indigo-200 bg-indigo-100/70 text-indigo-800 dark:border-indigo-500/40 dark:bg-indigo-500/15 dark:text-indigo-100"
        >
          {hasOverrides ? "Manual overrides" : "Auto-generated"}
        </Badge>
        {strengthLabels.map((label) => (
          <Badge
            key={label}
            variant="outline"
            className="border-cyan-200 bg-cyan-100/70 text-cyan-800 dark:border-cyan-500/40 dark:bg-cyan-500/15 dark:text-cyan-100"
          >
            {label}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function ProfileBackendOutput({
  profileKey,
  profile,
  preview,
  status,
}: {
  profileKey?: string;
  profile?: CodexSubagentV2Profile;
  preview?: CodexSubagentProfilePreview;
  status?: CodexSubagentProfileStatus;
}) {
  if (!preview && !status) return null;
  const requestedRoleName =
    status?.requestedRoleName ?? preview?.requestedRoleName;
  const effectiveRoleName =
    status?.effectiveRoleName ?? preview?.effectiveRoleName;
  const warnings = Array.from(
    new Set([...(preview?.warnings ?? []), ...(status?.warnings ?? [])]),
  );

  return (
    <div
      role="region"
      aria-label={`${profileKey ?? "Unrecognized profile"} backend preview status`}
      className="space-y-2 rounded-lg border border-cyan-200 bg-cyan-50/65 p-3 text-sm text-cyan-950 dark:border-cyan-500/35 dark:bg-cyan-950/20 dark:text-cyan-100"
    >
      {status ? (
        <>
          <p>
            {profileKey
              ? `${profileKey}: ${status.status}`
              : `Generation status:${status.status}`}
          </p>
          <p>Generation status:{status.status}</p>
          <p>
            Provider type:
            {status.providerKind ?? preview?.providerKind ?? "Unknown"}
          </p>
          <p>Routable:{status.routable ? "Yes" : "No"}</p>
          <p>
            Enabled:
            {(status.enabled ?? profile?.enabled) ? "Yes" : "No"}
          </p>
          {status.fieldSources ? (
            <>
              <p>Role name source:{status.fieldSources.roleName}</p>
              <p>Role description source:{status.fieldSources.description}</p>
              <p>
                Developer instructions source:
                {status.fieldSources.developerInstructions}
              </p>
              <p>
                Nickname candidates source:
                {status.fieldSources.nicknameCandidates}
              </p>
              <p>
                Model reasoning effort source:
                {status.fieldSources.modelReasoningEffort}
              </p>
            </>
          ) : null}
          {status.inputModality ? (
            <>
              <p>
                Input capability:
                {formatInputModalities(status.inputModality.modalities)}
                (source:{formatModalitySource(status.inputModality.source)})
              </p>
              {status.inputModality.declarations.length > 0 ? (
                <div className="space-y-0.5 rounded-md border border-cyan-200/70 bg-background/45 px-2 py-1.5 text-xs dark:border-cyan-500/25 dark:bg-slate-950/25">
                  <p className="font-medium">Decision chain</p>
                  {status.inputModality.declarations.map((declaration) => (
                    <p key={declaration.source}>
                      {formatModalitySource(declaration.source)}:
                      {formatInputModalities(declaration.declared)}
                      {declaration.adopted ? "(adopted)" : ""}
                    </p>
                  ))}
                </div>
              ) : null}
              {status.inputModality.conflict ? (
                <p className="text-amber-600 dark:text-amber-400">
                  {status.inputModality.conflict}
                </p>
              ) : null}
            </>
          ) : null}
          {status.roleFilePath ? <p>{status.roleFilePath}</p> : null}
          {status.model ? <p>Model:{status.model}</p> : null}
          {status.modelProvider ? (
            <p>Model provider:{status.modelProvider}</p>
          ) : null}
          {status.modelReasoningEffort ? (
            <p>Reasoning effort:{status.modelReasoningEffort}</p>
          ) : null}
          {status.nonGenerationReason ? (
            <p>Why not generated:{status.nonGenerationReason}</p>
          ) : null}
        </>
      ) : null}

      {requestedRoleName || effectiveRoleName ? (
        <div className="grid gap-2 md:grid-cols-2">
          <div>
            <span className="font-medium">Requested role name</span>
            <div>{requestedRoleName ?? "Backend did not return"}</div>
          </div>
          <div>
            <span className="font-medium">Effective role name</span>
            <div>{effectiveRoleName ?? "Backend did not return"}</div>
          </div>
        </div>
      ) : null}

      {preview ? (
        <>
          <p>{preview.description}</p>
          <p>{preview.developerInstructions}</p>
          <div className="flex flex-wrap gap-2">
            {preview.nicknameCandidates.map((nickname) => (
              <span key={nickname}>{nickname}</span>
            ))}
          </div>
          <p>{preview.modelProvider}</p>
          <p>{preview.modelReasoningEffort}</p>
          <p>{preview.modelContextWindow}</p>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border bg-slate-950 p-3 text-xs text-slate-100">
            {preview.tomlPreview}
          </pre>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Backend preview unavailable.
        </p>
      )}

      {warnings.map((warning) => (
        <p key={warning} className="text-amber-700 dark:text-amber-200">
          {warning}
        </p>
      ))}
    </div>
  );
}

function QuestionnaireSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 rounded-lg border border-violet-200 bg-violet-50/60 p-3 text-sm dark:border-violet-500/35 dark:bg-violet-950/20">
      <span className="font-medium text-violet-900 dark:text-violet-100">
        {label}
      </span>
      <select
        className="rounded-md border border-violet-200 bg-background/90 px-3 py-2 dark:border-violet-500/35 dark:bg-slate-950/60"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

function OverrideField({
  id,
  label,
  value,
  automatic,
  restoreLabel,
  multiline = false,
  onChange,
  onRestore,
}: {
  id: string;
  label: string;
  value: string;
  automatic: boolean;
  restoreLabel: string;
  multiline?: boolean;
  onChange: (value: string) => void;
  onRestore: () => void;
}) {
  const control = multiline ? (
    <textarea
      id={id}
      className="min-h-24 min-w-0 flex-1 rounded-md border bg-background px-3 py-2"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ) : (
    <input
      id={id}
      className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
  return (
    <div className="grid gap-1 text-sm">
      <span className="flex items-center justify-between gap-2">
        <label htmlFor={id}>{label}</label>
        <span className="text-xs text-muted-foreground">
          {automatic ? "Automatic" : "Manual override"}
        </span>
      </span>
      <div className="flex gap-2">
        {control}
        <Button type="button" variant="outline" onClick={onRestore}>
          {restoreLabel}
        </Button>
      </div>
    </div>
  );
}
