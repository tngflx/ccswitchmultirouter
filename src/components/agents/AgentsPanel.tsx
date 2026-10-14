import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleX,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { orchestrationApi, providersApi } from "@/lib/api";
import { readCodexCatalogSettings } from "@/lib/codexCatalogSchema";
import {
  isUserCodexRoutingPlan,
  isCodexProtocolSetMember,
} from "@/lib/codexProviderKind";
import type { CodexRoutingProjectionStatus } from "@/lib/api/providers";
import { useTranslation } from "react-i18next";
import type {
  OrchestrationModelRef,
  OrchestrationProfile,
  OrchestrationRun,
  OrchestrationSettings,
  Provider,
} from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

interface AgentsPanelProps {
  onOpenChange: (open: boolean) => void;
}

type RoleKey = "orchestrator" | "worker" | "verifier";
type AppType = "claude" | "codex";

interface ProviderChoice {
  id: string;
  name: string;
  models: string[];
  hasCatalog: boolean;
}

const EMPTY_SETTINGS: OrchestrationSettings = {
  enabled: false,
  profiles: [],
  defaultModeByApp: { claude: "direct", codex: "direct" },
};

const EMPTY_BUDGET = {
  maxRounds: 2,
  maxWorkerCalls: 2,
  maxParallelWorkers: 1,
  timeoutSeconds: 300,
  maxOutputTokens: 8192,
};

const roleLabels: Record<RoleKey, string> = {
  orchestrator: "Orchestrator",
  worker: "Worker",
  verifier: "Verifier",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function uniqueModels(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value && !value.startsWith("ccsm-")),
    ),
  ];
}

function getProviderModels(provider: Provider): string[] {
  const settings = asRecord(provider.settingsConfig);
  const models: string[] = [];
  const catalog = readCodexCatalogSettings(settings);
  const catalogModels = catalog?.models;
  const hasExplicitCatalog = Array.isArray(catalogModels);
  if (hasExplicitCatalog) {
    for (const item of catalogModels) {
      if (typeof item === "string") {
        models.push(item);
        continue;
      }
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
  if (hasExplicitCatalog) return uniqueModels(models);
  for (const key of ["model", "haikuModel", "sonnetModel", "opusModel"]) {
    if (typeof settings?.[key] === "string") {
      models.push(settings[key] as string);
    }
  }
  const nestedConfig = asRecord(settings?.config);
  if (typeof nestedConfig?.model === "string") {
    models.push(nestedConfig.model);
  }
  const env = asRecord(settings?.env);
  for (const key of [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
  ]) {
    if (typeof env?.[key] === "string") models.push(env[key] as string);
  }
  return uniqueModels(models);
}

function toProviderChoices(
  providers: Record<string, Provider>,
): ProviderChoice[] {
  return Object.values(providers)
    .filter(
      (provider) =>
        !isUserCodexRoutingPlan(provider) &&
        !isCodexProtocolSetMember(provider),
    )
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: getProviderModels(provider),
      hasCatalog:
        readCodexCatalogSettings(provider.settingsConfig) !== undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function firstModelRef(
  appType: AppType,
  choices: Record<AppType, ProviderChoice[]>,
): OrchestrationModelRef {
  const provider = choices[appType][0];
  return {
    appType,
    providerId: provider?.id ?? "",
    model: provider?.models[0] ?? "",
  };
}

function createProfile(
  index: number,
  choices: Record<AppType, ProviderChoice[]>,
): OrchestrationProfile {
  return {
    id: `profile-${Date.now()}-${index}`,
    displayName: "Claude planner + Sublyx worker",
    enabled: true,
    scope: "all",
    orchestrator: firstModelRef("claude", choices),
    worker: firstModelRef("codex", choices),
    budget: { ...EMPTY_BUDGET },
    approvalPolicy: "client",
    failureFallback: "fail_closed",
    workerGuidance:
      "Break the task into bounded steps, preserve the user's intent, and report uncertainty instead of inventing facts.",
  };
}

function statusVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "verified" || status === "completed") return "default";
  if (status === "failed" || status === "cancelled") return "destructive";
  if (status === "running" || status === "planned") return "secondary";
  return "outline";
}

function formatRunTime(timestamp: number): string {
  if (!timestamp) return "Unknown";
  return new Date(timestamp * 1000).toLocaleString();
}

export function AgentsPanel({ onOpenChange }: AgentsPanelProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<OrchestrationSettings>(EMPTY_SETTINGS);
  const [runs, setRuns] = useState<OrchestrationRun[]>([]);
  const [providers, setProviders] = useState<
    Record<AppType, Record<string, Provider>>
  >({ claude: {}, codex: {} });
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [projection, setProjection] =
    useState<CodexRoutingProjectionStatus | null>(null);
  const [publicationError, setPublicationError] = useState<string | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const dirty = JSON.stringify(draft) !== savedSnapshot;

  const providerChoices = useMemo<Record<AppType, ProviderChoice[]>>(
    () => ({
      claude: toProviderChoices(providers.claude),
      codex: toProviderChoices(providers.codex),
    }),
    [providers],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [settings, recentRuns, claudeProviders, codexProviders, status] =
        await Promise.all([
          orchestrationApi.getSettings(),
          orchestrationApi.listRuns(),
          providersApi.getAll("claude"),
          providersApi.getAll("codex"),
          providersApi.inspectActiveCodexMultiRouterProjection(),
        ]);
      setDraft(settings);
      setSavedSnapshot(JSON.stringify(settings));
      setRuns(recentRuns);
      setProviders({ claude: claudeProviders, codex: codexProviders });
      setProjection(status);
      setPublicationError(null);
      setSelectedProfileId(
        settings.activeProfileId ?? settings.profiles[0]?.id ?? "",
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const selectedProfile = draft.profiles.find(
    (profile) => profile.id === selectedProfileId,
  );

  const updateSelectedProfile = useCallback(
    (update: (profile: OrchestrationProfile) => OrchestrationProfile) => {
      setDraft((current) => ({
        ...current,
        profiles: current.profiles.map((profile) =>
          profile.id === selectedProfileId ? update(profile) : profile,
        ),
      }));
    },
    [selectedProfileId],
  );

  const updateRole = useCallback(
    (role: RoleKey, patch: Partial<OrchestrationModelRef>) => {
      updateSelectedProfile((profile) => {
        const current = profile[role];
        if (!current) return profile;
        return { ...profile, [role]: { ...current, ...patch } };
      });
    },
    [updateSelectedProfile],
  );

  const handleAppTypeChange = (role: RoleKey, appType: AppType) => {
    const next = firstModelRef(appType, providerChoices);
    updateRole(role, next);
  };

  const handleProviderChange = (role: RoleKey, providerId: string) => {
    const roleRef = selectedProfile?.[role];
    if (!roleRef) return;
    const provider = providerChoices[roleRef.appType].find(
      (choice) => choice.id === providerId,
    );
    updateRole(role, {
      providerId,
      model: provider?.models[0] ?? "",
    });
  };

  const addProfile = () => {
    const profile = createProfile(draft.profiles.length, providerChoices);
    setDraft((current) => ({
      ...current,
      enabled: true,
      activeProfileId: profile.id,
      profiles: [...current.profiles, profile],
    }));
    setSelectedProfileId(profile.id);
  };

  const removeSelectedProfile = () => {
    if (!selectedProfile) return;
    const remaining = draft.profiles.filter(
      (profile) => profile.id !== selectedProfile.id,
    );
    const nextActive = remaining[0]?.id;
    setDraft((current) => ({
      ...current,
      activeProfileId: nextActive,
      profiles: remaining,
    }));
    setSelectedProfileId(nextActive ?? "");
  };

  const save = async () => {
    setSaving(true);
    try {
      const result = await orchestrationApi.saveSettings({
        ...draft,
        activeProfileId: selectedProfileId || undefined,
      });
      const saved = result.settings;
      setDraft(saved);
      setSavedSnapshot(JSON.stringify(saved));
      setProjection(result.codexProjection);
      setPublicationError(result.publicationError);
      setSelectedProfileId(
        saved.activeProfileId ?? saved.profiles[0]?.id ?? "",
      );
      if (
        result.publicationError ||
        result.codexProjection?.state === "pending"
      ) {
        toast.warning(t("orchestration.publicationPending"));
      } else {
        toast.success(t("orchestration.saved"));
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const cancelRun = async (runId: string) => {
    try {
      await orchestrationApi.cancelRun(runId);
      await reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const validationMessage = useMemo(() => {
    for (const profile of draft.profiles) {
      for (const role of ["orchestrator", "worker"] as const) {
        const ref = profile[role];
        if (!ref.providerId || !ref.model) {
          return `${profile.displayName}: choose a provider and model for the ${role}.`;
        }
      }
      if (!profile.displayName.trim()) return t("orchestration.nameRequired");
      for (const role of ["orchestrator", "worker", "verifier"] as const) {
        const ref = profile[role];
        if (!ref) continue;
        const provider = providerChoices[ref.appType].find(
          (choice) => choice.id === ref.providerId,
        );
        if (
          draft.enabled &&
          profile.enabled &&
          (!provider ||
            (provider.hasCatalog && !provider.models.includes(ref.model)))
        ) {
          return t("orchestration.modelUnavailable", {
            name: profile.displayName,
            role: roleLabels[role],
          });
        }
      }
      if (
        profile.verifier &&
        (!profile.verifier.providerId || !profile.verifier.model)
      ) {
        return `${profile.displayName}: choose a provider and model for the verifier.`;
      }
    }
    return undefined;
  }, [draft.profiles, draft.enabled, providerChoices, t]);

  if (loading) {
    return (
      <div className="px-6 flex flex-1 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-6 flex flex-1 items-center justify-center">
        <div className="max-w-md space-y-3 text-center">
          <CircleX className="mx-auto h-10 w-10 text-red-500" />
          <h3 className="text-lg font-semibold">
            Unable to load orchestration
          </h3>
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" onClick={() => void reload()}>
            <RefreshCw className="h-4 w-4" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 pt-6 flex flex-col flex-1 min-h-0 overflow-y-auto pb-12">
      <div className="mx-auto w-full max-w-6xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-blue-500" />
              <h2 className="text-xl font-semibold">
                Multimodel orchestration
              </h2>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Let Claude plan and critique while a Codex/Sublyx model performs
              the bounded work. Direct provider routing stays unchanged until
              you opt in.
            </p>
          </div>
          <div className="flex items-center gap-2 pr-10">
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            <Button
              size="sm"
              disabled={saving || !!validationMessage}
              onClick={() => void save()}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between border-b border-border-default pb-4">
          <div>
            <div className="font-medium">Enable orchestration</div>
            <div className="text-sm text-muted-foreground">
              Profiles are opt-in and remain bounded by the limits below.
            </div>
          </div>
          <Switch
            checked={draft.enabled}
            onCheckedChange={(enabled) =>
              setDraft((current) => ({ ...current, enabled }))
            }
            aria-label="Enable orchestration"
          />
        </div>

        {validationMessage && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{validationMessage}</span>
          </div>
        )}

        {draft.profiles.length > 0 && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 border-b border-border-default pb-4 text-sm"
          >
            <span>
              {dirty
                ? t("orchestration.unsaved")
                : publicationError || projection?.state === "pending"
                  ? t("orchestration.publicationPending")
                  : !draft.enabled
                    ? t("orchestration.disabled")
                    : projection?.state === "ready"
                      ? t("orchestration.publicationReady")
                      : t("orchestration.routerRequired")}
            </span>
            {(publicationError || projection?.state === "pending") && (
              <Button
                variant="outline"
                size="sm"
                disabled={saving || !!validationMessage}
                onClick={() => void save()}
              >
                <RefreshCw className="h-4 w-4" />
                {t("orchestration.retryPublication")}
              </Button>
            )}
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Profiles
              </h3>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={addProfile}
                title="Add profile"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {draft.profiles.length === 0 ? (
              <div className="space-y-3 rounded-lg border border-dashed border-border-default p-3 text-sm text-muted-foreground">
                <p>
                  Create a profile to expose an orchestration model in the Codex
                  picker.
                </p>
                <Button variant="outline" size="sm" onClick={addProfile}>
                  <Plus className="h-4 w-4" />
                  Create profile
                </Button>
              </div>
            ) : (
              <div className="space-y-1">
                {draft.profiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() => {
                      setSelectedProfileId(profile.id);
                      setDraft((current) => ({
                        ...current,
                        activeProfileId: profile.id,
                      }));
                    }}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                      selectedProfileId === profile.id
                        ? "border-blue-500/60 bg-blue-500/10"
                        : "border-transparent hover:border-border-default hover:bg-muted/50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {profile.displayName}
                      </span>
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          profile.enabled
                            ? "bg-emerald-500"
                            : "bg-muted-foreground/40"
                        }`}
                      />
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {profile.id}
                    </div>
                  </button>
                ))}
              </div>
            )}
            <div className="space-y-2 border-t border-border-default pt-3">
              <label className="text-xs font-medium text-muted-foreground">
                Default mode
              </label>
              {(["claude", "codex"] as const).map((appType) => (
                <div key={appType} className="flex items-center gap-2">
                  <span className="w-14 text-xs capitalize">{appType}</span>
                  <Select
                    value={draft.defaultModeByApp?.[appType] ?? "direct"}
                    onValueChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        defaultModeByApp: {
                          ...current.defaultModeByApp,
                          [appType]: value as "direct" | "orchestrated",
                        },
                      }))
                    }
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="direct">Direct</SelectItem>
                      <SelectItem value="orchestrated">Orchestrated</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </div>

          {selectedProfile ? (
            <div className="space-y-5">
              <Card>
                <CardHeader className="pb-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-lg">Profile editor</CardTitle>
                      <CardDescription>
                        The picker alias is{" "}
                        <code className="rounded bg-muted px-1 py-0.5">
                          ccsm-orch/{selectedProfile.id}
                        </code>
                        .
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">
                        Profile enabled
                      </span>
                      <Switch
                        checked={selectedProfile.enabled}
                        onCheckedChange={(enabled) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            enabled,
                          }))
                        }
                        aria-label="Profile enabled"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-red-500"
                        onClick={removeSelectedProfile}
                        title="Delete profile"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="space-y-1.5 text-sm">
                      <span className="font-medium">Display name</span>
                      <Input
                        value={selectedProfile.displayName}
                        onChange={(event) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            displayName: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="space-y-1.5 text-sm">
                      <span className="font-medium">Scope</span>
                      <Select
                        value={selectedProfile.scope}
                        onValueChange={(scope) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            scope: scope as OrchestrationProfile["scope"],
                          }))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Claude + Codex</SelectItem>
                          <SelectItem value="claude">Claude only</SelectItem>
                          <SelectItem value="codex">Codex only</SelectItem>
                        </SelectContent>
                      </Select>
                    </label>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    {(["orchestrator", "worker", "verifier"] as const).map(
                      (role) => {
                        const roleRef = selectedProfile[role];
                        if (!roleRef) return null;
                        const choices = providerChoices[roleRef.appType];
                        const selectedProvider = choices.find(
                          (choice) => choice.id === roleRef.providerId,
                        );
                        const models = selectedProvider?.models ?? [];
                        return (
                          <div
                            key={role}
                            className="space-y-3 rounded-lg border border-border-default p-3"
                          >
                            <div>
                              <div className="font-medium">
                                {roleLabels[role]}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {role === "orchestrator"
                                  ? "Plans the work and decides when to verify."
                                  : role === "worker"
                                    ? "Carries out the actual implementation or analysis."
                                    : "Checks the result and can request a bounded repair."}
                              </div>
                            </div>
                            <div className="grid gap-2 sm:grid-cols-2">
                              <Select
                                value={roleRef.appType}
                                onValueChange={(value) =>
                                  handleAppTypeChange(role, value as AppType)
                                }
                              >
                                <SelectTrigger
                                  aria-label={`${roleLabels[role]} app`}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="claude">Claude</SelectItem>
                                  <SelectItem value="codex">
                                    Codex / Sublyx
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                              <Select
                                value={roleRef.providerId || undefined}
                                onValueChange={(value) =>
                                  handleProviderChange(role, value)
                                }
                              >
                                <SelectTrigger
                                  aria-label={`${roleLabels[role]} provider`}
                                >
                                  <SelectValue placeholder="Provider" />
                                </SelectTrigger>
                                <SelectContent>
                                  {choices.length === 0 ? (
                                    <SelectItem value="__none" disabled>
                                      No {roleRef.appType} providers
                                    </SelectItem>
                                  ) : (
                                    choices.map((choice) => (
                                      <SelectItem
                                        key={choice.id}
                                        value={choice.id}
                                      >
                                        {choice.name}
                                      </SelectItem>
                                    ))
                                  )}
                                </SelectContent>
                              </Select>
                            </div>
                            {models.length > 0 ? (
                              <Select
                                value={roleRef.model || undefined}
                                onValueChange={(model) =>
                                  updateRole(role, { model })
                                }
                              >
                                <SelectTrigger
                                  aria-label={`${roleLabels[role]} model`}
                                >
                                  <SelectValue placeholder="Model" />
                                </SelectTrigger>
                                <SelectContent>
                                  {models.map((model) => (
                                    <SelectItem key={model} value={model}>
                                      {model}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : selectedProvider?.hasCatalog ? (
                              <Input
                                disabled
                                value=""
                                placeholder={t(
                                  "orchestration.noIncludedModels",
                                )}
                                aria-label={`${roleLabels[role]} model ID`}
                              />
                            ) : (
                              <Input
                                value={roleRef.model}
                                onChange={(event) =>
                                  updateRole(role, {
                                    model: event.target.value,
                                  })
                                }
                                placeholder="Type the provider model ID"
                                aria-label={`${roleLabels[role]} model ID`}
                              />
                            )}
                          </div>
                        );
                      },
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {selectedProfile.verifier ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            verifier: undefined,
                          }))
                        }
                      >
                        <CircleX className="h-4 w-4" />
                        Remove verifier
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            verifier: firstModelRef("claude", providerChoices),
                          }))
                        }
                      >
                        <Plus className="h-4 w-4" />
                        Add verifier
                      </Button>
                    )}
                    <span className="text-xs text-muted-foreground">
                      Tool calls stay client-approved when the worker uses the
                      same protocol as this client.
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-4">
                  <CardTitle className="text-lg">Execution limits</CardTitle>
                  <CardDescription>
                    Hard bounds keep a planner from creating an unbounded loop
                    or bill.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                  {(
                    [
                      ["maxRounds", "Rounds", 1, 8],
                      ["maxWorkerCalls", "Worker calls", 1, 8],
                      ["maxParallelWorkers", "Parallel", 1, 1],
                      ["timeoutSeconds", "Timeout (s)", 10, 1800],
                      ["maxOutputTokens", "Output tokens", 256, 32768],
                    ] as const
                  ).map(([key, label, min, max]) => (
                    <label key={key} className="space-y-1.5 text-sm">
                      <span className="font-medium">{label}</span>
                      <Input
                        type="number"
                        min={min}
                        max={max}
                        value={selectedProfile.budget[key]}
                        onChange={(event) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            budget: {
                              ...profile.budget,
                              [key]: Number(event.target.value),
                            },
                          }))
                        }
                      />
                    </label>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-4">
                  <CardTitle className="text-lg">
                    Failure handling and guidance
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="space-y-1.5 text-sm">
                      <span className="font-medium">
                        When orchestration fails
                      </span>
                      <Select
                        value={selectedProfile.failureFallback}
                        onValueChange={(value) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            failureFallback:
                              value as OrchestrationProfile["failureFallback"],
                          }))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="fail_closed">
                            Stop and report
                          </SelectItem>
                          <SelectItem value="direct">
                            Fall back to direct routing
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </label>
                    <div className="space-y-1.5 text-sm">
                      <span className="font-medium">Approval policy</span>
                      <div className="flex h-9 items-center rounded-md border border-border-default px-3 text-muted-foreground">
                        Client approval
                      </div>
                    </div>
                  </div>
                  <label className="space-y-1.5 text-sm">
                    <span className="font-medium">Worker guidance</span>
                    <Textarea
                      rows={5}
                      value={selectedProfile.workerGuidance}
                      onChange={(event) =>
                        updateSelectedProfile((profile) => ({
                          ...profile,
                          workerGuidance: event.target.value,
                        }))
                      }
                      placeholder="Add constraints, repository conventions, or verification rules."
                    />
                  </label>
                </CardContent>
              </Card>
            </div>
          ) : (
            <div className="flex min-h-72 items-center justify-center rounded-lg border border-dashed border-border-default p-8 text-center">
              <div className="max-w-sm space-y-3">
                <Bot className="mx-auto h-9 w-9 text-muted-foreground" />
                <h3 className="font-semibold">No orchestration profile yet</h3>
                <p className="text-sm text-muted-foreground">
                  Add a Claude provider for planning and a Codex/Sublyx provider
                  for execution, then create your first profile.
                </p>
                <Button variant="outline" onClick={() => onOpenChange(true)}>
                  Open providers
                </Button>
              </div>
            </div>
          )}
        </div>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
            <div>
              <CardTitle className="text-lg">Recent runs</CardTitle>
              <CardDescription>
                Bounded planner, worker, and verifier traces.
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => void reload()}
              title="Refresh runs"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent>
            {runs.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No orchestration runs recorded yet.
              </div>
            ) : (
              <div className="divide-y divide-border-default">
                {runs.map((run) => (
                  <div
                    key={run.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium">
                          {run.profileId}
                        </span>
                        <Badge variant={statusVariant(run.status)}>
                          {run.status}
                        </Badge>
                        {run.status === "verified" && (
                          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        )}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {run.appType} · {formatRunTime(run.startedAt)} ·{" "}
                        {run.events.length} events
                      </div>
                    </div>
                    {run.status === "running" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void cancelRun(run.id)}
                      >
                        <CircleX className="h-4 w-4" />
                        Cancel
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
