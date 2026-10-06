import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { CodexProtocolProbeProgressDialog } from "@/components/providers/forms/CodexProtocolProbeProgressDialog";
import { CodexProviderSetPreviewDialog } from "@/components/providers/forms/CodexProviderSetPreviewDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { providersApi } from "@/lib/api";
import type {
  UniversalProviderSetCommitOutcome,
  UniversalProviderSetPreview,
} from "@/lib/api/protocol-compatibility";
import { createUniversalCodexProtocolLabAdapter } from "@/lib/protocol-lab/codex-adapters";
import {
  ProtocolLabCancelled,
  useProtocolLabWorkflow,
} from "@/lib/protocol-lab/useProtocolLabWorkflow";
import type { UniversalProvider } from "@/types";
import { prepareUnverifiedUniversalProvider } from "@/lib/protocol-lab/unverified-save";

export class UniversalProviderSetCancelled extends ProtocolLabCancelled {}

export function isUniversalProviderSetCancelled(error: unknown): boolean {
  return error instanceof UniversalProviderSetCancelled;
}

interface UseUniversalProviderSetSaveOptions {
  onCommitted?: () => void | Promise<void>;
}

export function useUniversalProviderSetSave({
  onCommitted,
}: UseUniversalProviderSetSaveOptions = {}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const adapter = useMemo(() => createUniversalCodexProtocolLabAdapter(), []);
  const workflow = useProtocolLabWorkflow(adapter);

  const refreshProviderViews = useCallback(async () => {
    const refreshes = await Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: ["providers"] }),
      queryClient.invalidateQueries({
        queryKey: ["codex-provider-adaptation-summaries"],
      }),
      Promise.resolve(onCommitted?.()),
    ]);
    if (refreshes.some((refresh) => refresh.status === "rejected")) {
      console.warn(
        "Universal Provider Set committed, but one or more views failed to refresh",
        refreshes,
      );
      toast.warning(
        t("providerSet.viewsRefreshFailed", {
          defaultValue:
            "The model source was saved, but some pages could not refresh. Reopen those pages to restore them.",
        }),
      );
    }
    try {
      await providersApi.updateTrayMenu();
    } catch (error) {
      console.warn(
        "Failed to refresh tray menu after Universal Provider Set commit",
        error,
      );
      toast.warning(
        t("providerSet.trayRefreshFailed", {
          defaultValue:
            "The model source was saved, but the tray menu could not refresh. Reopen the app to restore it.",
        }),
      );
    }
  }, [onCommitted, queryClient, t]);

  const persistUniversalProviderSet = useCallback(
    async (
      provider: UniversalProvider,
      options: { allowUnverifiedSave?: boolean } = {},
    ) => {
      const saveUnverified =
        options.allowUnverifiedSave === true &&
        adapter.requiresProbe(provider, []);
      const draft = saveUnverified
        ? prepareUnverifiedUniversalProvider(provider)
        : provider;
      const outcome = await workflow.save(draft);
      await refreshProviderViews();
      return outcome;
    },
    [adapter, refreshProviderViews, workflow],
  );

  const retryProjection = useCallback(
    async (outcome: UniversalProviderSetCommitOutcome) => {
      const routerIds = Array.from(
        new Set(
          outcome.projections
            .filter((projection) => projection.state === "pending")
            .map((projection) => projection.routerProviderId),
        ),
      );
      if (routerIds.length === 0) {
        throw new Error("codex_provider_set_projection_retry_target_missing");
      }
      const projections = await Promise.all(
        routerIds.map((providerId) =>
          providersApi.retryCodexMultiRouterProjection(providerId),
        ),
      );
      await refreshProviderViews();
      if (projections.some((projection) => projection.state !== "ready")) {
        throw new Error("codex_provider_set_live_projection_failed");
      }
      return projections;
    },
    [refreshProviderViews],
  );

  const handleBack = useCallback(() => {
    workflow.cancel(new UniversalProviderSetCancelled());
  }, [workflow]);

  const handleRetry = useCallback(() => {
    workflow.retry();
  }, [workflow]);

  const probeModel = workflow.state.draft?.models.codex?.model?.trim();
  const awaitingConsent =
    workflow.state.phase === "awaiting_probe_consent" ||
    workflow.state.phase === "stale_retry";
  const probeOpen =
    workflow.state.phase === "probing" || workflow.state.phase === "failed";
  const preview =
    workflow.state.phase === "blocked"
      ? (workflow.state.preparePreview as UniversalProviderSetPreview | null)
      : null;
  const dialogs = (
    <>
      <Dialog
        open={awaitingConsent}
        onOpenChange={(open) => {
          if (!open) handleBack();
        }}
      >
        <DialogContent className="max-w-lg" zIndex="top">
          <DialogHeader>
            <DialogTitle>
              {t("providerSet.confirmTitle", {
                defaultValue: "Confirm Chat / Responses test",
              })}
            </DialogTitle>
            <DialogDescription className="space-y-2 text-left">
              <span className="block">
                {t("providerSet.universalConsent", {
                  defaultValue:
                    "Save and sync first tests the Codex model with real Responses and Chat Completions requests, then saves the final configuration in one atomic transaction.",
                })}
              </span>
              <span className="block">
                {t("providerSet.universalProbeWarning", {
                  defaultValue:
                    "Tests may consume a small amount of quota or traffic. Authentication, rate-limit, network, HTTP 521, and other 5xx errors are reported separately as availability problems and will not recommend an incorrect protocol.",
                })}
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleBack}>
              {t("providerSet.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button type="button" onClick={() => void workflow.confirmProbe()}>
              {t("providerSet.confirm", { defaultValue: "Confirm test" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CodexProtocolProbeProgressDialog
        open={probeOpen}
        running={workflow.state.phase === "probing"}
        expectedModels={probeModel ? [probeModel] : []}
        events={workflow.state.progress}
        outcome={workflow.probeOutcome}
        error={workflow.state.errorDetail ?? ""}
        onOpenChange={(open) => {
          if (!open) handleBack();
        }}
        onRetry={handleRetry}
      />
      <CodexProviderSetPreviewDialog
        open={preview !== null}
        preview={preview?.codex ?? null}
        pending={workflow.state.phase === "committing"}
        onBack={handleBack}
        onConfirmSplit={() => undefined}
        onRetry={handleRetry}
      />
    </>
  );

  return {
    persistUniversalProviderSet,
    retryProjection,
    dialogs,
    workflow,
  };
}
