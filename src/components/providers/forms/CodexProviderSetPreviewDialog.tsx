import type { CodexProviderSetPreview } from "@/lib/api/protocol-compatibility";
import { AlertTriangle, GitBranch } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface CodexProviderSetPreviewDialogProps {
  open: boolean;
  preview: CodexProviderSetPreview | null;
  pending: boolean;
  onBack: () => void;
  onConfirmSplit: () => void;
  onRetry: () => void;
}

export function CodexProviderSetPreviewDialog(
  props: CodexProviderSetPreviewDialogProps,
) {
  const { open, preview, pending, onBack, onConfirmSplit, onRetry } = props;
  if (!preview || preview.plan.kind === "single") return null;

  const blocked = preview.plan.kind === "blocked";
  const title = blocked ? "Cannot save yet" : "Split by protocol";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !pending) onBack();
      }}
    >
      <DialogContent className="max-w-2xl" zIndex="top">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {blocked ? (
              <AlertTriangle className="h-5 w-5 text-amber-600" />
            ) : (
              <GitBranch className="h-5 w-5 text-sky-600" />
            )}
            {title}
          </DialogTitle>
          <DialogDescription>
            {blocked
              ? "At least one enabled model has no single protocol that can safely execute Codex tool transactions. Nothing was written; probe again or go back and adjust the models."
              : "Models in this source passed different best-fit Codex protocols. The source remains one entry after saving; CCSM creates two single-protocol providers internally and routes automatically."}
          </DialogDescription>
        </DialogHeader>

        {preview.plan.kind === "split" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <ModelGroup
              title="Responses models"
              models={preview.responsesModels}
            />
            <ModelGroup
              title="Chat Completions models"
              models={preview.chatModels}
            />
          </div>
        ) : (
          <div className="space-y-2">
            {preview.plan.models.map((model) => (
              <article
                key={`${model.model}:${model.upstreamModel}`}
                className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3"
              >
                <div className="font-medium">{model.model}</div>
                {model.upstreamModel !== model.model && (
                  <div className="text-xs text-muted-foreground">
                    {model.upstreamModel}
                  </div>
                )}
                <div className="mt-1 text-sm text-amber-700 dark:text-amber-300">
                  {blockedReasonLabel(model.reason)}
                </div>
                {model.stage && (
                  <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                    <div>Failed stage: {blockedStageLabel(model.stage)}</div>
                    {model.failureKind && (
                      <div>
                        Failure type: {blockedFailureLabel(model.failureKind)}
                        {model.statusCode ? ` (${model.statusCode})` : ""}
                      </div>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onBack} disabled={pending}>
            Back to adjust models
          </Button>
          {blocked ? (
            <Button onClick={onRetry} disabled={pending}>
              Probe again
            </Button>
          ) : (
            <Button onClick={onConfirmSplit} disabled={pending}>
              Confirm split
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModelGroup({ title, models }: { title: string; models: string[] }) {
  return (
    <section className="rounded-lg border bg-muted/20 p-3">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
        {models.map((model) => (
          <li key={model} className="rounded bg-background px-2 py-1">
            {model}
          </li>
        ))}
      </ul>
    </section>
  );
}

function blockedReasonLabel(reason: string) {
  switch (reason) {
    case "probe_required":
      return "The deep protocol probe is not complete";
    case "probe_stale":
      return "Probe results are stale; run the probe again";
    case "probe_not_verified":
      return "Probe results have not passed full verification";
    case "probe_has_no_selection":
      return "Neither protocol produced a unique usable conclusion";
    case "conflicting_probe_records":
      return "Probe results conflict; run the probe again";
    case "probe_target_mismatch":
      return "Probe results do not match the current model configuration";
    case "duplicate_model_identity":
      return "Duplicate model identifiers exist in the catalog";
    default:
      return "The current probe results cannot be used for automatic saving";
  }
}

function blockedStageLabel(stage: string) {
  switch (stage) {
    case "baseline":
      return "Baseline request";
    case "streaming":
      return "Streaming response";
    case "reasoning":
      return "Reasoning content";
    case "forced_tool":
      return "Forced tool call";
    case "continuation":
      return "Tool continuation";
    default:
      return stage;
  }
}

function blockedFailureLabel(kind: string) {
  switch (kind) {
    case "http_status":
      return "HTTP status";
    case "timeout":
      return "Request timed out";
    case "network":
      return "Network error";
    case "response_too_large":
      return "Response too large";
    case "invalid_response":
      return "Invalid response format";
    case "invalid_request":
      return "Invalid request";
    default:
      return kind;
  }
}
