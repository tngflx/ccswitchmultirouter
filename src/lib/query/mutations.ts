import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { confirmDialog } from "@/lib/dialog";
import { providersApi, sessionsApi, settingsApi, type AppId } from "@/lib/api";
import type { DeleteSessionOptions } from "@/lib/api/sessions";
import type {
  SwitchResult,
  TeStaticProviderDescriptor,
} from "@/lib/api/providers";
import type { Provider, SessionMeta, Settings } from "@/types";
import {
  extractErrorMessage,
  translatePiProviderMutationError,
} from "@/utils/errorUtils";
import { generateUUID } from "@/utils/uuid";
import { openclawKeys } from "@/hooks/useOpenClaw";
import { invalidateHermesProviderCaches } from "@/hooks/useHermes";
import { proxyKeys } from "@/lib/query/proxy";
import { usageKeys } from "@/lib/query/usage";
import { invalidatePiProviderCaches } from "@/lib/query/pi";

export interface UpdateProviderMutationResult {
  provider: Provider;
  tePublishStatus?:
    "stored_not_published" | "stored_and_published" | "stored_publish_failed";
}
import {
  CODEX_OFFICIAL_PROVIDER_ID,
  GROKBUILD_OFFICIAL_PROVIDER_ID,
} from "@/utils/providerCapabilities";

interface ProviderSwitchFailureToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

interface ProviderSwitchFailureToastOptions {
  action: ProviderSwitchFailureToastAction;
  cancel?: ProviderSwitchFailureToastAction;
}

interface CreateProviderSwitchFailureToastOptionsInput {
  appId: AppId;
  providerId: string;
  detail: string;
  copy: (detail: string) => void;
  forceRepair: (providerId: string) => void | Promise<void>;
  t: (key: string, fallback: string) => string;
}

/** Build recovery actions without losing the failed provider identity. */
export function createProviderSwitchFailureToastOptions({
  appId,
  providerId,
  detail,
  copy,
  forceRepair,
  t,
}: CreateProviderSwitchFailureToastOptionsInput): ProviderSwitchFailureToastOptions {
  return {
    action: {
      label: t("common.copy", "Copy"),
      onClick: () => copy(detail),
    },
    ...(appId === "codex"
      ? {
          cancel: {
            label: t("notifications.forceRepair", "Force repair"),
            onClick: () => forceRepair(providerId),
          },
        }
      : {}),
  };
}

const codexForceRepairInFlight = new Set<string>();

/** Refresh switch-dependent UI caches without extending the switch mutation. */
export function refreshProviderSwitchQueries(
  queryClient: QueryClient,
  appId: AppId,
): void {
  const refreshes: Promise<unknown>[] = [
    queryClient.invalidateQueries({ queryKey: ["providers", appId] }),
  ];

  if (appId === "codex") {
    refreshes.push(
      queryClient.invalidateQueries({ queryKey: ["proxyStatus"] }),
      queryClient.invalidateQueries({ queryKey: ["proxyRunning"] }),
      queryClient.invalidateQueries({ queryKey: ["proxyTakeoverStatus"] }),
      queryClient.invalidateQueries({ queryKey: ["liveTakeoverActive"] }),
    );
  }
  if (appId === "claude-desktop") {
    refreshes.push(
      queryClient.invalidateQueries({ queryKey: proxyKeys.status }),
      queryClient.invalidateQueries({ queryKey: ["claudeDesktopStatus"] }),
    );
  }
  if (appId === "opencode") {
    refreshes.push(
      queryClient.invalidateQueries({
        queryKey: ["opencodeLiveProviderIds"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["opencode", "runtime-models"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["omo", "current-provider-id"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["omo-slim", "current-provider-id"],
      }),
    );
  }
  if (appId === "openclaw") {
    refreshes.push(
      queryClient.invalidateQueries({ queryKey: openclawKeys.liveProviderIds }),
      queryClient.invalidateQueries({ queryKey: openclawKeys.defaultModel }),
      queryClient.invalidateQueries({ queryKey: openclawKeys.health }),
    );
  }
  if (appId === "hermes") {
    refreshes.push(invalidateHermesProviderCaches(queryClient));
  }
  refreshes.push(providersApi.updateTrayMenu());
  void Promise.allSettled(refreshes);
}

async function warnIfActiveCodexProjectionPending(
  appId: AppId,
  warningMessage: string,
): Promise<void> {
  if (appId !== "codex") return;
  try {
    const status = await providersApi.inspectActiveCodexMultiRouterProjection();
    if (status?.state === "pending") {
      toast.warning(warningMessage, { closeButton: true });
    }
  } catch {
    toast.warning(warningMessage, { closeButton: true });
  }
}

type ProviderMutationTarget = { appId: AppId; providerId: string };

export const useAddProviderMutation = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: async ({
      appId,
      ...providerInput
    }: {
      appId: AppId;
    } & Omit<Provider, "id"> & {
        providerKey?: string;
        teDescriptor?: TeStaticProviderDescriptor;
        addToLive?: boolean;
        ensureClaudeDesktopOfficialSeed?: boolean;
        ensureCodexOfficialSeed?: boolean;
        ensureGrokBuildOfficialSeed?: boolean;
      }) => {
      const {
        providerKey: _providerKey,
        teDescriptor,
        addToLive,
        ensureClaudeDesktopOfficialSeed,
        ensureCodexOfficialSeed,
        ensureGrokBuildOfficialSeed,
        ...rest
      } = providerInput;

      if (appId === "claude-desktop" && ensureClaudeDesktopOfficialSeed) {
        await providersApi.ensureClaudeDesktopOfficialProvider();
        const providers = await providersApi.getAll(appId);
        const officialProvider = providers["claude-desktop-official"];
        if (!officialProvider) {
          throw new Error("Claude Desktop official provider was not created");
        }
        return officialProvider;
      }

      if (appId === "codex" && ensureCodexOfficialSeed) {
        await providersApi.ensureCodexOfficialProvider();
        const providers = await providersApi.getAll(appId);
        const officialProvider = providers[CODEX_OFFICIAL_PROVIDER_ID];
        if (!officialProvider) {
          throw new Error("Codex official provider was not created");
        }
        return officialProvider;
      }

      if (appId === "grokbuild" && ensureGrokBuildOfficialSeed) {
        await providersApi.ensureGrokBuildOfficialProvider();
        const providers = await providersApi.getAll(appId);
        const officialProvider = providers[GROKBUILD_OFFICIAL_PROVIDER_ID];
        if (!officialProvider) {
          throw new Error("Grok Build official provider was not created");
        }
        return officialProvider;
      }

      let id: string;

      if (
        appId === "opencode" ||
        appId === "openclaw" ||
        appId === "hermes" ||
        appId === "pi"
      ) {
        if (
          providerInput.category === "omo" ||
          providerInput.category === "omo-slim"
        ) {
          const prefix = providerInput.category === "omo" ? "omo" : "omo-slim";
          id = `${prefix}-${generateUUID()}`;
        } else {
          if (!providerInput.providerKey) {
            throw new Error(`Provider key is required for ${appId}`);
          }
          id = providerInput.providerKey;
        }
      } else {
        id = generateUUID();
      }

      const newProvider: Provider = {
        ...rest,
        id,
        createdAt: Date.now(),
      };
      delete (newProvider as any).providerKey;

      if (teDescriptor) {
        if (appId !== "openclaw")
          throw new Error("TE descriptor requires OpenClaw");
        const tePublishStatus = await providersApi.saveTeProvider(
          newProvider,
          teDescriptor,
          undefined,
          addToLive,
        );
        return { ...newProvider, tePublishStatus };
      }
      await providersApi.add(newProvider, appId, addToLive);
      return { ...newProvider, tePublishStatus: undefined };
    },
    onSuccess: async (provider, { appId }) => {
      await queryClient.invalidateQueries({ queryKey: ["providers", appId] });

      if (appId === "opencode") {
        await queryClient.invalidateQueries({
          queryKey: ["omo", "current-provider-id"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["omo", "provider-count"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["omo-slim", "current-provider-id"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["omo-slim", "provider-count"],
        });
      }

      if (appId === "openclaw") {
        await queryClient.invalidateQueries({
          queryKey: openclawKeys.health,
        });
      }

      if (appId === "hermes") {
        await invalidateHermesProviderCaches(queryClient);
      }

      try {
        await providersApi.updateTrayMenu();
      } catch (trayError) {
        console.error(
          "Failed to update tray menu after adding provider",
          trayError,
        );
      }

      if (
        "tePublishStatus" in provider &&
        provider.tePublishStatus === "stored_publish_failed"
      ) {
        toast.warning(t("notifications.teProviderSavePublishFailed"), {
          closeButton: true,
        });
      } else {
        toast.success(
          t("notifications.providerAdded", { defaultValue: "供应商已添加" }),
          { closeButton: true },
        );
      }
      await warnIfActiveCodexProjectionPending(
        appId,
        t("notifications.codexProjectionPending", {
          defaultValue:
            "The provider was saved, but MultiRouter has not synced to Codex yet. Review and retry in the MultiRouter workspace.",
        }),
      );
    },
    onError: (error: Error, { appId }) => {
      const rawDetail = extractErrorMessage(error);
      const detail =
        (appId === "pi"
          ? translatePiProviderMutationError(rawDetail, t)
          : "") ||
        rawDetail ||
        t("common.unknown");
      toast.error(
        t("notifications.addFailed", {
          defaultValue: "添加供应商失败: {{error}}",
          error: detail,
        }),
      );
    },
    onSettled: async (_data, _error, { appId }) => {
      if (appId === "pi") {
        await invalidatePiProviderCaches(queryClient);
      }
    },
  });
};

export const useUpdateProviderMutation = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: async ({
      appId,
      provider,
      originalId,
      teDescriptor,
    }: {
      appId: AppId;
      provider: Provider;
      originalId?: string;
      teDescriptor?: TeStaticProviderDescriptor;
    }) => {
      if (teDescriptor) {
        if (appId !== "openclaw")
          throw new Error("TE descriptor requires OpenClaw");
        const tePublishStatus = await providersApi.saveTeProvider(
          provider,
          teDescriptor,
          originalId,
        );
        return { provider, tePublishStatus };
      }
      await providersApi.update(provider, appId, originalId);
      return { provider };
    },
    onSuccess: async (result, { appId, originalId }) => {
      const provider = result.provider;
      await queryClient.invalidateQueries({ queryKey: ["providers", appId] });
      await queryClient.invalidateQueries({
        queryKey: usageKeys.script(provider.id, appId),
      });
      if (originalId && originalId !== provider.id) {
        await queryClient.invalidateQueries({
          queryKey: usageKeys.script(originalId, appId),
        });
      }
      if (appId === "openclaw") {
        await queryClient.invalidateQueries({
          queryKey: openclawKeys.health,
        });
      }
      if (appId === "hermes") {
        await invalidateHermesProviderCaches(queryClient);
      }
      if (result.tePublishStatus === "stored_publish_failed") {
        toast.warning(t("notifications.teProviderUpdatePublishFailed"), {
          closeButton: true,
        });
      } else {
        toast.success(
          t("notifications.updateSuccess", { defaultValue: "供应商更新成功" }),
          { closeButton: true },
        );
      }
      await warnIfActiveCodexProjectionPending(
        appId,
        t("notifications.codexProjectionPending", {
          defaultValue:
            "The provider was saved, but MultiRouter has not synced to Codex yet. Review and retry in the MultiRouter workspace.",
        }),
      );
    },
    onError: (error: Error, { appId }) => {
      const rawDetail = extractErrorMessage(error);
      const detail =
        (appId === "pi"
          ? translatePiProviderMutationError(rawDetail, t)
          : "") ||
        rawDetail ||
        t("common.unknown");
      toast.error(
        t("notifications.updateFailed", {
          defaultValue: "更新供应商失败: {{error}}",
          error: detail,
        }),
      );
    },
    onSettled: async (_data, _error, { appId }) => {
      if (appId === "pi") {
        await invalidatePiProviderCaches(queryClient);
      }
    },
  });
};

export const useDeleteProviderMutation = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: async ({ appId, providerId }: ProviderMutationTarget) => {
      await providersApi.delete(providerId, appId);
    },
    onSuccess: async (_data, { appId }) => {
      await queryClient.invalidateQueries({ queryKey: ["providers", appId] });

      if (appId === "opencode") {
        await queryClient.invalidateQueries({
          queryKey: ["omo", "current-provider-id"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["omo", "provider-count"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["omo-slim", "current-provider-id"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["omo-slim", "provider-count"],
        });
      }

      if (appId === "openclaw") {
        await queryClient.invalidateQueries({
          queryKey: openclawKeys.health,
        });
      }

      if (appId === "hermes") {
        await invalidateHermesProviderCaches(queryClient);
      }

      try {
        await providersApi.updateTrayMenu();
      } catch (trayError) {
        console.error(
          "Failed to update tray menu after deleting provider",
          trayError,
        );
      }

      toast.success(
        t("notifications.deleteSuccess", {
          defaultValue: "供应商已删除",
        }),
        {
          closeButton: true,
        },
      );
    },
    onError: (error: Error, { appId }) => {
      const rawDetail = extractErrorMessage(error);
      const detail =
        (appId === "pi"
          ? translatePiProviderMutationError(rawDetail, t)
          : "") ||
        rawDetail ||
        t("common.unknown");
      toast.error(
        t("notifications.deleteFailed", {
          defaultValue: "删除供应商失败: {{error}}",
          error: detail,
        }),
      );
    },
    onSettled: async (_data, _error, { appId }) => {
      if (appId === "pi") {
        await invalidatePiProviderCaches(queryClient);
      }
    },
  });
};

export const useSwitchProviderMutation = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: async ({
      appId,
      providerId,
    }: ProviderMutationTarget): Promise<SwitchResult> => {
      return await providersApi.switch(providerId, appId);
    },
    onSuccess: (_data, { appId }) => {
      refreshProviderSwitchQueries(queryClient, appId);
    },
    onError: (error: Error, { appId, providerId }) => {
      const detail = extractErrorMessage(error) || t("common.unknown");

      const recoveryActions = createProviderSwitchFailureToastOptions({
        appId,
        providerId,
        detail,
        copy: (text) => {
          navigator.clipboard?.writeText(text).catch(() => undefined);
        },
        forceRepair: async (failedProviderId) => {
          if (codexForceRepairInFlight.has(failedProviderId)) return;
          const confirmed = await confirmDialog(
            t("notifications.forceRepairConfirm", {
              defaultValue:
                "Back up the current Codex configuration, repair legacy fields, and rebuild CCSM-managed configuration with this provider? MCP, projects, and user customizations will be preserved.",
            }),
            {
              title: t("notifications.forceRepair", "Force repair"),
              kind: "warning",
            },
          );
          if (!confirmed) return;

          codexForceRepairInFlight.add(failedProviderId);
          try {
            const outcome =
              await providersApi.forceRepairAndSwitchCodexProvider(
                failedProviderId,
              );
            await queryClient.invalidateQueries({
              queryKey: ["providers", appId],
            });
            await queryClient.invalidateQueries({ queryKey: ["proxyStatus"] });
            await queryClient.invalidateQueries({ queryKey: ["proxyRunning"] });
            await queryClient.invalidateQueries({
              queryKey: ["proxyTakeoverStatus"],
            });
            await queryClient.invalidateQueries({
              queryKey: ["liveTakeoverActive"],
            });
            toast.success(
              t("notifications.forceRepairSuccess", {
                defaultValue:
                  "Codex configuration repaired and provider switched",
              }),
              {
                description: t("notifications.forceRepairBackup", {
                  defaultValue: "Original configuration backed up to: {{path}}",
                  path: outcome.backupDirectory,
                }),
                duration: 10000,
              },
            );
          } catch (repairError) {
            toast.error(
              t("notifications.forceRepairFailed", {
                defaultValue: "Force repair failed",
              }),
              {
                description:
                  extractErrorMessage(repairError) || t("common.unknown"),
                duration: 12000,
              },
            );
          } finally {
            codexForceRepairInFlight.delete(failedProviderId);
          }
        },
        t: (key, fallback) => t(key, { defaultValue: fallback }),
      });

      toast.error(
        t("notifications.switchFailedTitle", { defaultValue: "切换失败" }),
        {
          description: t("notifications.switchFailed", {
            defaultValue: "切换失败：{{error}}",
            error: detail,
          }),
          duration: 12000,
          ...recoveryActions,
        },
      );
    },
    onSettled: (_data, _error, { appId }) => {
      if (appId === "pi") {
        void invalidatePiProviderCaches(queryClient).catch((error) => {
          console.error(
            "Failed to refresh Pi provider caches after switching provider",
            error,
          );
        });
      }
    },
  });
};

export const useDeleteSessionMutation = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: async (input: DeleteSessionOptions) => {
      await sessionsApi.delete(input);
      return input;
    },
    onSuccess: async (input) => {
      queryClient.setQueryData<SessionMeta[]>(["sessions"], (current) =>
        (current ?? []).filter(
          (session) =>
            !(
              session.providerId === input.providerId &&
              session.sessionId === input.sessionId &&
              session.sourcePath === input.sourcePath
            ),
        ),
      );
      queryClient.removeQueries({
        queryKey: ["sessionMessages", input.providerId, input.sourcePath],
      });

      await queryClient.invalidateQueries({ queryKey: ["sessions"] });

      toast.success(
        t("sessionManager.sessionDeleted", {
          defaultValue: "会话已删除",
        }),
      );
    },
    onError: (error: Error) => {
      const detail = extractErrorMessage(error) || t("common.unknown");
      toast.error(
        t("sessionManager.deleteFailed", {
          defaultValue: "删除会话失败: {{error}}",
          error: detail,
        }),
      );
    },
  });
};

export const useSaveSettingsMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (settings: Settings) => {
      return await settingsApi.save(settings);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      await queryClient.invalidateQueries({
        queryKey: ["opencode", "runtime-models"],
      });
    },
  });
};
