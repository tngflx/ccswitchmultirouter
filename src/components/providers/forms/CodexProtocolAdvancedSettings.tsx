import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  CodexApiFormat,
  CodexHistoryReplay,
  CodexProtocolMode,
  CodexReasoningProjection,
  CodexToolSchemaDialect,
} from "@/types";
import { useTranslation } from "react-i18next";

interface CodexProtocolAdvancedSettingsProps {
  mode: CodexProtocolMode;
  apiFormat: CodexApiFormat;
  reasoningProjection: CodexReasoningProjection;
  toolSchemaDialect: CodexToolSchemaDialect;
  historyReplay: CodexHistoryReplay;
  onModeChange: (value: CodexProtocolMode) => void;
  onApiFormatChange: (value: CodexApiFormat) => void;
  onReasoningProjectionChange: (value: CodexReasoningProjection) => void;
  onToolSchemaDialectChange: (value: CodexToolSchemaDialect) => void;
  onHistoryReplayChange: (value: CodexHistoryReplay) => void;
}

export function CodexProtocolAdvancedSettings({
  mode,
  apiFormat,
  reasoningProjection,
  toolSchemaDialect,
  historyReplay,
  onModeChange,
  onApiFormatChange,
  onReasoningProjectionChange,
  onToolSchemaDialectChange,
  onHistoryReplayChange,
}: CodexProtocolAdvancedSettingsProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-3 rounded-md border border-border-default p-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Edit CCSM protocol and field adaptation rules here; this does not modify
        the model service or historical response text. Review “Automatic
        compatibility handling” in the probe details for detected differences,
        automatic adaptations, and verification results. Changes apply to later
        requests only after the provider is saved and enabled; re-run
        verification after changing rules manually.
      </p>
      <div className="space-y-1.5">
        <Label>Protocol configuration</Label>
        <Select value={mode} onValueChange={onModeChange}>
          <SelectTrigger aria-label="Protocol configuration">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Automatic probe (recommended)</SelectItem>
            <SelectItem value="manual">Manual override (advanced)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {mode === "auto" ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Before saving, CCSM tests Responses and Chat, streaming, tool calls,
          and history continuation. The automatic recommendation comes from
          probe evidence; saving selects the protocol that can complete a real
          Codex workflow.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Protocol used at runtime</Label>
            <Select
              value={apiFormat}
              onValueChange={(value) =>
                onApiFormatChange(value as CodexApiFormat)
              }
            >
              <SelectTrigger aria-label="Protocol used at runtime">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai_chat">Chat Completions</SelectItem>
                <SelectItem value="openai_responses">Responses</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs leading-relaxed text-muted-foreground">
              This overrides only the protocol saved and used at runtime; it
              does not rewrite or delete the independent Responses/Chat probe
              evidence or automatic recommendation.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Tool schema</Label>
            <Select
              value={toolSchemaDialect}
              onValueChange={onToolSchemaDialectChange}
            >
              <SelectTrigger aria-label="Tool schema">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI JSON Schema</SelectItem>
                <SelectItem value="moonshot_mfjs">
                  Moonshot MFJS (Kimi)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {apiFormat === "openai_chat" ? (
            <>
              <div className="space-y-1.5">
                <Label>Chat reasoning display</Label>
                <Select
                  value={reasoningProjection}
                  onValueChange={onReasoningProjectionChange}
                >
                  <SelectTrigger aria-label="Chat reasoning display">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="raw_reasoning_text">
                      Raw reasoning text
                    </SelectItem>
                    <SelectItem value="none">Hide reasoning</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                Chat history continuation always writes reasoning_content so
                display fields are not mixed with continuation fields.
              </p>
            </>
          ) : (
            <div className="space-y-1.5">
              <Label>Responses history continuation</Label>
              <Select
                value={historyReplay}
                onValueChange={onHistoryReplayChange}
              >
                <SelectTrigger aria-label="Responses history continuation">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="native_only">Native Responses</SelectItem>
                  <SelectItem value="responses_reasoning_text_content">
                    reasoning_text content compatibility
                  </SelectItem>
                  <SelectItem value="responses_reasoning_summary_only">
                    {t("provider.codexHistoryReplaySummaryOnly")}
                  </SelectItem>
                  <SelectItem value="omit">
                    Do not replay reasoning items
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-900 dark:text-amber-200">
            Completed automatic probes are retained. Without Verified evidence
            for the selected protocol, a manual override may cause HTTP 400/422
            responses, tool-continuation failures, or invisible reasoning.
          </div>
        </div>
      )}
    </div>
  );
}
