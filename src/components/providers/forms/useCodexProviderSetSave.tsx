import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { providersApi } from "@/lib/api";
import type {
  CodexProviderSetCommitOutcome,
  CodexProviderSetPreview,
} from "@/lib/api/protocol-compatibility";
import { restoreCodexProviderProtocolEvidence } from "@/lib/api/protocol-compatibility";
import { createSingleCodexProtocolLabAdapter } from "@/lib/protocol-lab/codex-adapters";
import {
  ProtocolLabCancelled,
  useProtocolLabWorkflow,
} from "@/lib/protocol-lab/useProtocolLabWorkflow";
import type { Provider } from "@/types";
import { prepareUnverifiedCodexProvider } from "@/lib/protocol-lab/unverified-save";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CodexProtocolProbeProgressDialog } from "./CodexProtocolProbeProgressDialog";
import { CodexProviderSetPreviewDialog } from "./CodexProviderSetPreviewDialog";

export class CodexProviderSetCancelled extends ProtocolLabCancelled {}

export function isCodexProviderSetCancelled(error: unknown): boolean {
  return error instanceof CodexProviderSetCancelled;
}

export function useCodexProviderSetSave() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const adapter = useMemo(() => createSingleCodexProtocolLabAdapter(), []);
  const workflow = useProtocolLabWorkflow(adapter);

  const refreshProviderViews = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
    await queryClient.invalidateQueries({
      queryKey: ["codex-provider-adaptation-summaries"],
    });
    try {
      await providersApi.updateTrayMenu();
    } catch (error) {
      console.warn(
        "Failed to refresh tray menu after Provider Set commit",
        error,
      );
      toast.warning(
        t("providerSet.trayRefreshFailed", {
          defaultValue:
            "The model source was saved, but the tray menu could not refresh. Reopen the app to restore it.",
        }),
      );
    }
  }, [queryClient, t]);

  const persistCodexProviderSet = useCallback(
    async (
      provider: Provider,
      receiptIds: string[] = [],
      options: { allowUnverifiedSave?: boolean } = {},
    ) => {
      // UI receipts are intentionally short-lived and can be discarded when an
      // asynchronous form update changes its presentation identity. Before an
      // automatic save asks for a new paid probe, let the backend compile the
      // current Provider and reissue receipts from matching persisted evidence.
      // The restore command is read-only: it neither contacts the upstream nor
      // extends observation expiry, and it fails closed when the real target or
      // request policy changed.
      let reusableReceiptIds = receiptIds;
      if (
        reusableReceiptIds.length === 0 &&
        adapter.requiresProbe(provider, reusableReceiptIds)
      ) {
        const restored = await restoreCodexProviderProtocolEvidence(provider);
        if (restored?.receiptIds.length) {
          reusableReceiptIds = restored.receiptIds;
        }
      }
      const saveUnverified =
        options.allowUnverifiedSave === true &&
        reusableReceiptIds.length === 0 &&
        adapter.requiresProbe(provider, reusableReceiptIds);
      const draft = saveUnverified
        ? prepareUnverifiedCodexProvider(provider)
        : provider;
      const outcome = await workflow.save(draft, reusableReceiptIds);
      await refreshProviderViews();
      if (
        (outcome as CodexProviderSetCommitOutcome).status ===
        "committed_with_projection_error"
      ) {
        toast.warning(
          t("providerSet.projectionPending", {
            defaultValue:
              "The model source was saved, but the current Codex configuration has not refreshed. Reproject or reactivate the source later.",
          }),
        );
      } else if (saveUnverified) {
        toast.warning(
          t("providerSet.unverified", {
            defaultValue:
              "The model source was saved with its current protocol without deep verification. You can test Chat / Responses later.",
          }),
        );
      }
    },
    [adapter, refreshProviderViews, workflow, t],
  );

  const handleBack = useCallback(() => {
    workflow.cancel(new CodexProviderSetCancelled());
  }, [workflow]);

  const handleRetry = useCallback(() => {
    workflow.retry();
  }, [workflow]);

  const expectedModels = providerModels(workflow.state.draft ?? undefined);
  const awaitingConsent =
    workflow.state.phase === "awaiting_probe_consent" ||
    workflow.state.phase === "stale_retry";
  const probeOpen =
    workflow.state.phase === "probing" ||
    workflow.state.phase === "failed" ||
    workflow.state.phase === "action_required";
  const preview =
    workflow.state.phase === "blocked"
      ? (workflow.state.preparePreview as CodexProviderSetPreview | null)
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
                {t("providerSet.probeConsent", {
                  defaultValue:
                    "Before saving, a few real upstream requests will test Responses and Chat Completions. They consume model tokens, may incur charges, and may trigger rate limits. Reported token usage and estimated costs based on current model pricing will be shown afterward.",
                })}
              </span>
              <span className="block">
                {t("providerSet.probeStages", {
                  defaultValue:
                    "Each enabled model is tested for basic responses, SSE streaming, reasoning content, forced tool calls, and tool-result continuation. Authentication failures, rate limits, network errors, HTTP 521, and other 5xx errors are reported as upstream unavailability, not unsupported protocols.",
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
        actionRequired={workflow.state.phase === "action_required"}
        expectedModels={expectedModels}
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
        preview={preview}
        pending={workflow.state.phase === "committing"}
        onBack={handleBack}
        onConfirmSplit={() => undefined}
        onRetry={handleRetry}
      />
    </>
  );

  return {
    persistCodexProviderSet,
    dialogs,
    workflow,
  };
}

function providerModels(provider: Provider | undefined): string[] {
  const catalog = provider?.settingsConfig.modelCatalog as
    { models?: Array<{ model?: unknown; enabled?: unknown }> } | undefined;
  return (catalog?.models ?? [])
    .filter((model) => model.enabled !== false)
    .map((model) => (typeof model.model === "string" ? model.model.trim() : ""))
    .filter(Boolean);
}
