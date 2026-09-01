import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import type { Provider, CustomEndpoint, UniversalProvider } from "@/types";
import type { AppId } from "@/lib/api";
import { universalProvidersApi } from "@/lib/api";
import {
  ProviderForm,
  type ProviderFormValues,
} from "@/components/providers/forms/ProviderForm";
import { UniversalProviderFormModal } from "@/components/universal/UniversalProviderFormModal";
import { UniversalProviderPanel } from "@/components/universal";
import { providerPresets } from "@/config/claudeProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { geminiProviderPresets } from "@/config/geminiProviderPresets";
import { claudeDesktopProviderPresets } from "@/config/claudeDesktopProviderPresets";
import { extractCodexBaseUrl } from "@/utils/providerConfigUtils";
import { extractGrokBuildBaseUrl } from "@/utils/grokBuildConfig";
import { inferProviderIconFromConfig } from "@/utils/providerIcon";
import { GROKBUILD_OFFICIAL_PROVIDER_ID } from "@/utils/providerCapabilities";
import type { OpenClawSuggestedDefaults } from "@/config/openclawProviderPresets";
import type { UniversalProviderPreset } from "@/config/universalProviderPresets";
import type { CodexProviderSplitSuggestion } from "@/components/providers/forms/CodexFormFields";

interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appId: AppId;
  panelZIndexClassName?: string;
  onSubmit: (
    provider: Omit<Provider, "id"> & {
      providerKey?: string;
      suggestedDefaults?: OpenClawSuggestedDefaults;
      ensureClaudeDesktopOfficialSeed?: boolean;
      ensureCodexOfficialSeed?: boolean;
      ensureGrokBuildOfficialSeed?: boolean;
    },
  ) => Promise<void> | void;
}

// 读取目录条目的真实上游模型名；协议分组必须按 upstreamModel 匹配，避免别名模型被漏分组。
function getCodexCatalogModelKey(model: Record<string, unknown>): string {
  return String(
    model.upstreamModel ?? model.upstream_model ?? model.model ?? "",
  )
    .trim()
    .toLocaleLowerCase();
}

// 将混合协议模型保留在一个 provider 中；每个 catalog row 携带自己的传输协议。
export function buildMixedCodexProviderData(
  providerData: Omit<Provider, "id">,
  split: CodexProviderSplitSuggestion,
): Omit<Provider, "id"> {
  const responses = new Set(
    split.responsesModels.map((model) => model.trim().toLocaleLowerCase()),
  );
  const chat = new Set(
    split.chatModels.map((model) => model.trim().toLocaleLowerCase()),
  );
  const settingsConfig = structuredClone(providerData.settingsConfig ?? {});
  const rawCatalog = settingsConfig.modelCatalog as
    | { models?: Array<Record<string, unknown>>; spawnAgentModels?: string[] }
    | undefined;
  const models = rawCatalog?.models ?? [];
  const mixedModels = models.map((model) => {
    const key = getCodexCatalogModelKey(model);
    const apiFormat = responses.has(key)
      ? "openai_responses"
      : chat.has(key)
        ? "openai_chat"
        : undefined;
    if (!apiFormat) {
      const {
        apiFormat: _apiFormat,
        api_format: _legacyApiFormat,
        apiFormatSource: _apiFormatSource,
        api_format_source: _legacySource,
        ...withoutProtocol
      } = model;
      return withoutProtocol;
    }
    return {
      ...model,
      apiFormat,
      api_format: apiFormat,
      apiFormatSource: split.apiFormatSource,
      api_format_source: split.apiFormatSource,
    };
  });
  settingsConfig.modelCatalog = {
    ...(rawCatalog ?? {}),
    models: mixedModels,
  };
  return {
    ...providerData,
    settingsConfig,
    meta: {
      ...(providerData.meta ?? {}),
      // Keep the provider-level value as a legacy fallback; catalog rows are authoritative.
      apiFormat: providerData.meta?.apiFormat ?? "openai_responses",
      apiFormatSource: split.apiFormatSource,
    },
  };
}

export function AddProviderDialog({
  open,
  onOpenChange,
  appId,
  panelZIndexClassName,
  onSubmit,
}: AddProviderDialogProps) {
  const { t } = useTranslation();
  // OpenCode and OpenClaw don't support universal providers
  const showUniversalTab =
    appId !== "opencode" &&
    appId !== "openclaw" &&
    appId !== "hermes" &&
    appId !== "grokbuild" &&
    appId !== "claude-desktop";
  const isCodexRouterEntry = appId === "codex";
  const [activeTab, setActiveTab] = useState<"app-specific" | "universal">(
    isCodexRouterEntry ? "universal" : "app-specific",
  );
  const [universalFormOpen, setUniversalFormOpen] = useState(false);
  const [selectedUniversalPreset, setSelectedUniversalPreset] =
    useState<UniversalProviderPreset | null>(null);
  const [isFormSubmitting, setIsFormSubmitting] = useState(false);

  useEffect(() => {
    // Codex 的添加入口实际是在创建多路路由，默认引导到模型源选择页。
    setActiveTab(isCodexRouterEntry ? "universal" : "app-specific");
  }, [isCodexRouterEntry, open]);

  const handleUniversalProviderSave = useCallback(
    async (provider: UniversalProvider) => {
      try {
        await universalProvidersApi.upsert(provider);
      } catch (error) {
        console.error(
          "[AddProviderDialog] Failed to save universal provider",
          error,
        );
        toast.error(
          t("universalProvider.addFailed", {
            defaultValue: "统一供应商添加失败",
          }),
        );
        return;
      }

      try {
        await universalProvidersApi.sync(provider.id);
        toast.success(
          t("universalProvider.addedAndSynced", {
            defaultValue: "统一供应商已添加并同步",
          }),
        );
      } catch (error) {
        console.error(
          "[AddProviderDialog] Provider saved but sync failed",
          error,
        );
        toast.warning(
          t("universalProvider.addedButSyncFailed", {
            defaultValue: "统一供应商已添加，但同步失败",
          }),
        );
      }

      setUniversalFormOpen(false);
      setSelectedUniversalPreset(null);
      onOpenChange(false);
    },
    [t, onOpenChange],
  );

  const handleUniversalFormClose = useCallback(() => {
    setUniversalFormOpen(false);
    setSelectedUniversalPreset(null);
  }, []);

  const handleSubmit = useCallback(
    async (values: ProviderFormValues) => {
      const parsedConfig = JSON.parse(values.settingsConfig) as Record<
        string,
        unknown
      >;

      // 构造基础提交数据
      const providerData: Omit<Provider, "id"> & {
        providerKey?: string;
        suggestedDefaults?: OpenClawSuggestedDefaults;
        ensureClaudeDesktopOfficialSeed?: boolean;
        ensureCodexOfficialSeed?: boolean;
        ensureGrokBuildOfficialSeed?: boolean;
      } = {
        name: values.name.trim(),
        notes: values.notes?.trim() || undefined,
        websiteUrl: values.websiteUrl?.trim() || undefined,
        settingsConfig: parsedConfig,
        icon:
          appId === "grokbuild"
            ? values.icon?.trim() || undefined
            : inferProviderIconFromConfig(
                values.icon,
                parsedConfig,
                values.websiteUrl,
              ) || undefined,
        iconColor: values.iconColor?.trim() || undefined,
        ...(values.presetCategory ? { category: values.presetCategory } : {}),
        ...(values.meta ? { meta: values.meta } : {}),
      };

      if (appId === "claude-desktop" && values.presetId) {
        const presetIndex = parseInt(
          values.presetId.replace("claude-desktop-", ""),
        );
        const preset = claudeDesktopProviderPresets[presetIndex];
        providerData.ensureClaudeDesktopOfficialSeed =
          values.presetCategory === "official" &&
          preset?.category === "official";
      }

      if (appId === "codex" && values.presetId) {
        const presetIndex = parseInt(values.presetId.replace("codex-", ""));
        const preset = codexProviderPresets[presetIndex];
        providerData.ensureCodexOfficialSeed =
          values.presetCategory === "official" &&
          preset?.category === "official";
      }

      if (appId === "grokbuild" && values.presetId) {
        providerData.ensureGrokBuildOfficialSeed =
          values.presetCategory === "official" &&
          values.presetId === GROKBUILD_OFFICIAL_PROVIDER_ID;
      }

      // OpenCode/OpenClaw: pass providerKey for ID generation
      if (
        (appId === "opencode" || appId === "openclaw" || appId === "hermes") &&
        values.providerKey
      ) {
        providerData.providerKey = values.providerKey;
      }

      const hasCustomEndpoints =
        providerData.meta?.custom_endpoints &&
        Object.keys(providerData.meta.custom_endpoints).length > 0;

      if (!hasCustomEndpoints && values.presetCategory !== "omo") {
        const urlSet = new Set<string>();

        const addUrl = (rawUrl?: string) => {
          const url = (rawUrl || "").trim().replace(/\/+$/, "");
          if (url && url.startsWith("http")) {
            urlSet.add(url);
          }
        };

        if (values.presetId) {
          if (appId === "claude") {
            const presets = providerPresets;
            const presetIndex = parseInt(
              values.presetId.replace("claude-", ""),
            );
            if (
              !isNaN(presetIndex) &&
              presetIndex >= 0 &&
              presetIndex < presets.length
            ) {
              const preset = presets[presetIndex];
              if (preset?.endpointCandidates) {
                preset.endpointCandidates.forEach(addUrl);
              }
            }
          } else if (appId === "codex") {
            const presets = codexProviderPresets;
            const presetIndex = parseInt(values.presetId.replace("codex-", ""));
            if (
              !isNaN(presetIndex) &&
              presetIndex >= 0 &&
              presetIndex < presets.length
            ) {
              const preset = presets[presetIndex];
              if (Array.isArray(preset.endpointCandidates)) {
                preset.endpointCandidates.forEach(addUrl);
              }
            }
          } else if (appId === "gemini") {
            const presets = geminiProviderPresets;
            const presetIndex = parseInt(
              values.presetId.replace("gemini-", ""),
            );
            if (
              !isNaN(presetIndex) &&
              presetIndex >= 0 &&
              presetIndex < presets.length
            ) {
              const preset = presets[presetIndex];
              if (Array.isArray(preset.endpointCandidates)) {
                preset.endpointCandidates.forEach(addUrl);
              }
            }
          } else if (appId === "claude-desktop") {
            const presets = claudeDesktopProviderPresets;
            const presetIndex = parseInt(
              values.presetId.replace("claude-desktop-", ""),
            );
            if (
              !isNaN(presetIndex) &&
              presetIndex >= 0 &&
              presetIndex < presets.length
            ) {
              const preset = presets[presetIndex];
              if (Array.isArray(preset.endpointCandidates)) {
                preset.endpointCandidates.forEach(addUrl);
              }
              addUrl(preset.baseUrl);
            }
          }
        }

        if (appId === "claude") {
          const env = parsedConfig.env as Record<string, any> | undefined;
          if (env?.ANTHROPIC_BASE_URL) {
            addUrl(env.ANTHROPIC_BASE_URL);
          }
        } else if (appId === "claude-desktop") {
          const env = parsedConfig.env as Record<string, any> | undefined;
          if (env?.ANTHROPIC_BASE_URL) {
            addUrl(env.ANTHROPIC_BASE_URL);
          }
        } else if (appId === "codex") {
          const config = parsedConfig.config as string | undefined;
          if (config) {
            const extractedBaseUrl = extractCodexBaseUrl(config);
            if (extractedBaseUrl) {
              addUrl(extractedBaseUrl);
            }
          }
        } else if (appId === "gemini") {
          const env = parsedConfig.env as Record<string, any> | undefined;
          if (env?.GOOGLE_GEMINI_BASE_URL) {
            addUrl(env.GOOGLE_GEMINI_BASE_URL);
          }
        } else if (appId === "grokbuild") {
          const config = parsedConfig.config as string | undefined;
          if (config) {
            addUrl(extractGrokBuildBaseUrl(config));
          }
        } else if (appId === "opencode") {
          const options = parsedConfig.options as
            | Record<string, any>
            | undefined;
          if (options?.baseURL) {
            addUrl(options.baseURL);
          }
        } else if (appId === "openclaw") {
          // OpenClaw uses baseUrl directly
          if (parsedConfig.baseUrl) {
            addUrl(parsedConfig.baseUrl as string);
          }
        } else if (appId === "hermes") {
          if (parsedConfig.base_url) {
            addUrl(parsedConfig.base_url as string);
          }
        }

        const urls = Array.from(urlSet);
        if (urls.length > 0) {
          const now = Date.now();
          const customEndpoints: Record<string, CustomEndpoint> = {};
          urls.forEach((url) => {
            customEndpoints[url] = {
              url,
              addedAt: now,
              lastUsed: undefined,
            };
          });

          providerData.meta = {
            ...(providerData.meta ?? {}),
            custom_endpoints: customEndpoints,
          };
        }
      }

      // OpenClaw: pass suggestedDefaults for model registration
      if (appId === "openclaw" && values.suggestedDefaults) {
        providerData.suggestedDefaults = values.suggestedDefaults;
      }

      const codexProviderSplit = values.codexProviderSplit;
      if (appId === "codex" && codexProviderSplit) {
        await onSubmit(
          buildMixedCodexProviderData(providerData, codexProviderSplit),
        );
        toast.success(
          t("codexConfig.splitProvidersCreated", {
            defaultValue:
              "已创建一个混合协议 provider（Responses / Chat 自动路由）",
          }),
        );
      } else {
        await onSubmit(providerData);
      }
      onOpenChange(false);
    },
    [appId, onSubmit, onOpenChange, t],
  );

  const footer =
    !showUniversalTab || activeTab === "app-specific" ? (
      <>
        <span className="mr-auto min-w-0 text-xs text-muted-foreground truncate">
          {t("provider.addFooterHint")}
        </span>
        <Button
          variant="outline"
          onClick={() => onOpenChange(false)}
          className="border-border/20 hover:bg-accent hover:text-accent-foreground"
        >
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          form="provider-form"
          disabled={isFormSubmitting}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4 mr-2" />
          {t("common.add")}
        </Button>
      </>
    ) : (
      <>
        <Button
          variant="outline"
          onClick={() => onOpenChange(false)}
          className="border-border/20 hover:bg-accent hover:text-accent-foreground"
        >
          {t("common.cancel")}
        </Button>
        <Button
          onClick={() => setUniversalFormOpen(true)}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4 mr-2" />
          {isCodexRouterEntry
            ? t("codexMultiRouter.addSourceAction", {
                defaultValue: "Add model source",
              })
            : t("universalProvider.add")}
        </Button>
      </>
    );

  return (
    <FullScreenPanel
      isOpen={open}
      title={
        isCodexRouterEntry
          ? t("codexMultiRouter.addSourceTitle", {
              defaultValue: "Add Codex model source",
            })
          : t("provider.addNewProvider")
      }
      onClose={() => onOpenChange(false)}
      footer={footer}
      zIndexClassName={panelZIndexClassName}
      contentClassName="pt-3"
    >
      {isCodexRouterEntry && (
        <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-sm text-muted-foreground">
          <div className="font-medium text-foreground">
            {t("codexMultiRouter.addSourceNoticeTitle", {
              defaultValue: "This creates a reusable provider",
            })}
          </div>
          <p className="mt-1 text-xs leading-5">
            {t("codexMultiRouter.addSourceNoticeDescription", {
              defaultValue:
                "Choose a provider preset, configure credentials, models, and protocol groups here, then return to the MultiRouter wizard to select this source.",
            })}
          </p>
        </div>
      )}

      {showUniversalTab ? (
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as "app-specific" | "universal")}
        >
          <TabsList className="grid w-full grid-cols-2 mb-6">
            <TabsTrigger value="app-specific">
              {isCodexRouterEntry
                ? t("codexMultiRouter.codexProviderTab", {
                    defaultValue: "New Codex provider",
                  })
                : `${t(`apps.${appId}`)} ${t("provider.tabProvider")}`}
            </TabsTrigger>
            <TabsTrigger value="universal">
              {isCodexRouterEntry
                ? t("codexMultiRouter.universalProviderTab", {
                    defaultValue: "Universal providers",
                  })
                : t("provider.tabUniversal")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="app-specific" className="mt-0">
            <ProviderForm
              appId={appId}
              submitLabel={t("common.add")}
              onSubmit={handleSubmit}
              onCancel={() => onOpenChange(false)}
              onSubmittingChange={setIsFormSubmitting}
              showButtons={false}
            />
          </TabsContent>

          <TabsContent value="universal" className="mt-0">
            <UniversalProviderPanel
              context={isCodexRouterEntry ? "codex-router-source" : "default"}
            />
          </TabsContent>
        </Tabs>
      ) : (
        // OpenCode/OpenClaw: directly show form without tabs
        <ProviderForm
          appId={appId}
          submitLabel={t("common.add")}
          onSubmit={handleSubmit}
          onCancel={() => onOpenChange(false)}
          onSubmittingChange={setIsFormSubmitting}
          showButtons={false}
        />
      )}

      {showUniversalTab && (
        <UniversalProviderFormModal
          isOpen={universalFormOpen}
          onClose={handleUniversalFormClose}
          onSave={handleUniversalProviderSave}
          initialPreset={selectedUniversalPreset}
        />
      )}
    </FullScreenPanel>
  );
}
