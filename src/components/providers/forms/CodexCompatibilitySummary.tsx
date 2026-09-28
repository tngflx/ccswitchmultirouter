import { useTranslation } from "react-i18next";

import type {
  CodexProtocolCompatibilityRule,
  CodexProtocolHistoryReplay,
  CodexProtocolProbeReadiness,
  CodexProtocolToolSchemaDialect,
  CodexProtocolTransport,
  CodexReasoningSemantic,
  CodexReasoningSource,
} from "@/lib/api/protocol-compatibility";

interface Props {
  transport: CodexProtocolTransport;
  readiness: CodexProtocolProbeReadiness | null;
  baselinePassed: boolean;
  reasoningSemantic: CodexReasoningSemantic | null;
  reasoningSource: CodexReasoningSource | null;
  toolSchemaDialect: CodexProtocolToolSchemaDialect | null;
  historyReplay: CodexProtocolHistoryReplay | null;
  retries: CodexProtocolCompatibilityRule[];
  running: boolean;
  selected: boolean;
}

export function CodexCompatibilitySummary({
  transport,
  readiness,
  baselinePassed,
  reasoningSemantic,
  reasoningSource,
  toolSchemaDialect,
  historyReplay,
  retries,
  running,
  selected,
}: Props) {
  const { t } = useTranslation();
  const rows: string[] = [];

  if (transport === "open_ai_chat" && baselinePassed) {
    rows.push(
      t("codexProbe.summaryChatMapping", {
        defaultValue:
          "The upstream uses Chat Completions while Codex uses Responses; CCSM converts messages, tools, and stream events without changing answer meaning.",
      }),
    );
    if (
      reasoningSource &&
      reasoningSource !== "none" &&
      reasoningSource !== "native_responses"
    ) {
      rows.push(
        t("codexProbe.summaryReasoningSource", {
          defaultValue:
            "Reasoning source {{arg0}} is mapped into Codex-compatible reasoning events.",
          arg0: reasoningSource,
        }),
      );
    }
  }
  if (toolSchemaDialect === "moonshot_mfjs") {
    rows.push(
      t("codexProbe.summaryToolSchema", {
        defaultValue:
          "The provider accepted the Moonshot MFJS tool schema fallback; this is request-shape adaptation, not a rewrite of response text.",
      }),
    );
  }
  if (historyReplay === "responses_reasoning_text_content") {
    rows.push(
      t("codexProbe.summaryReasoningReplay", {
        defaultValue:
          "Reasoning history is replayed as reasoning_text content for continuation requests.",
      }),
    );
  }
  if (historyReplay === "omit") {
    rows.push(
      t("codexProbe.summaryOmitReasoning", {
        defaultValue:
          "Incompatible reasoning items are omitted during replay while tool calls and results are retained.",
      }),
    );
  }
  if (retries.includes("tool_schema") && toolSchemaDialect === null) {
    rows.push(
      t("codexProbe.summaryToolRetry", {
        defaultValue:
          "A tool-schema compatibility retry was requested; the final dialect is not confirmed yet.",
      }),
    );
  }
  if (retries.includes("reasoning_text_replay") && historyReplay === null) {
    rows.push(
      t("codexProbe.summaryReasoningRetry", {
        defaultValue:
          "A reasoning-history compatibility retry was requested; the final replay mode is not confirmed yet.",
      }),
    );
  }

  const hasAdaptation = rows.length > 0;
  const title =
    readiness === "verified"
      ? hasAdaptation
        ? t("codexProbe.summaryAdaptedPassed", {
            defaultValue: "Passed with compatibility adaptations",
          })
        : t("codexProbe.summaryPassed", { defaultValue: "Probe passed" })
      : readiness !== null
        ? hasAdaptation
          ? t("codexProbe.summaryAdaptedIncomplete", {
              defaultValue: "Compatibility adaptations did not fully pass",
            })
          : t("codexProbe.summaryNotPassed", {
              defaultValue: "Compatibility probe did not pass",
            })
        : running
          ? t("codexProbe.summaryRunning", {
              defaultValue: "Detecting protocol differences and adaptations",
            })
          : t("codexProbe.summaryIncomplete", {
              defaultValue: "Probe evidence is incomplete",
            });

  return (
    <div
      className="space-y-2 rounded-md border border-sky-500/25 bg-sky-500/5 p-3 text-xs leading-relaxed"
      aria-label={t("codexProbe.summaryAria", {
        defaultValue: "Automatic compatibility handling",
      })}
    >
      <p className="font-medium text-foreground">
        {title}
      </p>
      {rows.length > 0 ? (
        <ul className="list-disc space-y-1 pl-4">
          {rows.map((row, index) => (
            <li key={`${index}-${row}`}>{row}</li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">
          {readiness === "verified"
            ? t("codexProbe.summaryNoAdaptation", {
                defaultValue:
                  "No additional compatibility strategy was recorded.",
              })
            : t("codexProbe.summaryNoEvidence", {
                defaultValue:
                  "No confirmed automatic adaptation is available yet.",
              })}
        </p>
      )}
      {baselinePassed &&
        (reasoningSemantic === "opaque" || reasoningSemantic === "none") && (
          <p className="text-amber-700 dark:text-amber-300">
            {t("codexProbe.summaryOpaqueReasoning", {
              defaultValue:
                "The provider did not return readable reasoning; CCSM does not generate or decrypt thinking content.",
            })}
          </p>
        )}
      {readiness === "verified" && (
        <p>
          {selected
            ? t("codexProbe.summarySelected", {
                defaultValue: "This branch was selected automatically.",
              })
            : t("codexProbe.summaryAlternate", {
                defaultValue:
                  "This is a verified fallback branch and is not the selected transport.",
              })}
        </p>
      )}
    </div>
  );
}
