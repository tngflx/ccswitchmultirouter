import { useTranslation } from "react-i18next";
import type {
  CodexCompatibilityRule,
  CodexProtocolProbeReadiness,
  CodexProtocolTransport,
  CodexReasoningSemantic,
  CodexReasoningSource,
} from "@/lib/api/protocol-compatibility";
import type { CodexHistoryReplay, CodexToolSchemaDialect } from "@/types";

interface Props {
  transport: CodexProtocolTransport;
  readiness: CodexProtocolProbeReadiness | null;
  baselinePassed: boolean;
  reasoningSemantic: CodexReasoningSemantic | null;
  reasoningSource: CodexReasoningSource | null;
  toolSchemaDialect: CodexToolSchemaDialect | null;
  historyReplay: CodexHistoryReplay | null;
  retries: CodexCompatibilityRule[];
  running: boolean;
  selected: boolean;
}

export function CodexCompatibilitySummary(props: Props) {
  const { t } = useTranslation();
  const rows: string[] = [];
  const rules = new Set(props.retries);
  if (props.toolSchemaDialect === "moonshot_mfjs") rules.add("tool_schema");
  if (props.historyReplay === "responses_reasoning_text_content")
    rules.add("reasoning_text_replay");
  if (props.historyReplay === "omit") rules.add("omit_reasoning");
  if (props.transport === "open_ai_chat" && props.baselinePassed) {
    rows.push(
      t("codexCompatibilitySummary.chatConversion", {
        defaultValue:
          "The upstream uses the Chat response shape while Codex uses Responses. CCSM converts content, tool calls, and streaming events without changing the meaning of the model's answer.",
      }),
    );
    if (
      props.reasoningSource &&
      props.reasoningSource !== "none" &&
      props.reasoningSource !== "native_responses"
    ) {
      rows.push(
        t(
          props.reasoningSemantic === "readable"
            ? "codexCompatibilitySummary.reasoningReadable"
            : props.reasoningSemantic === "summary"
              ? "codexCompatibilitySummary.reasoningSummary"
              : "codexCompatibilitySummary.reasoningInvisible",
          {
            source: props.reasoningSource,
            defaultValue:
              props.reasoningSemantic === "readable"
                ? "The upstream returned {{source}}; CCSM reads that source and maps it to Codex-readable reasoning events."
                : props.reasoningSemantic === "summary"
                  ? "The upstream returned {{source}}; CCSM reads that source and maps it to a reasoning summary event."
                  : "The upstream returned {{source}}; CCSM reads that source and does not generate visible reasoning text.",
          },
        ),
      );
    }
  }
  if (rules.has("tool_schema"))
    rows.push(
      t("codexCompatibilitySummary.toolSchema", {
        defaultValue:
          "The default tool request was rejected or returned no valid tool call. CCSM retried with the compatible Moonshot MFJS tool schema; this adapts request structure, not response text, and does not infer tool incompatibility from an HTTP error alone.",
      }),
    );
  if (rules.has("reasoning_text_replay"))
    rows.push(
      t("codexCompatibilitySummary.reasoningReplay", {
        defaultValue:
          "The native reasoning-history shape was rejected. CCSM rebuilt readable reasoning as reasoning_text content and re-tested the tool continuation.",
      }),
    );
  if (rules.has("omit_reasoning"))
    rows.push(
      t("codexCompatibilitySummary.reasoningOmitted", {
        defaultValue:
          "The reasoning history was still rejected. CCSM removed only reasoning items while keeping tool calls and results; this fallback sends less reasoning history back to the model.",
      }),
    );
  const hasAdaptation = rows.length > 0;
  const title =
    props.readiness === "verified"
      ? hasAdaptation
        ? t("codexCompatibilitySummary.adaptedPassed", {
            defaultValue: "Passed after adaptation",
          })
        : t("codexCompatibilitySummary.passed", {
            defaultValue: "This check passed",
          })
      : props.readiness !== null
        ? hasAdaptation
          ? t("codexCompatibilitySummary.adaptationFailed", {
              defaultValue: "Adaptation did not pass",
            })
          : t("codexCompatibilitySummary.unverified", {
              defaultValue: "Compatibility not verified",
            })
        : props.running
          ? props.retries.length > 0
            ? t("codexCompatibilitySummary.retrying", {
                defaultValue: "Automatically adapting and retrying",
              })
            : t("codexCompatibilitySummary.checking", {
                defaultValue: "Checking response and protocol differences",
              })
          : t("codexCompatibilitySummary.incomplete", {
              defaultValue: "Verification incomplete",
            });
  return (
    <div
      className="space-y-2 rounded-md border border-sky-500/25 bg-sky-500/5 p-3 text-xs leading-relaxed"
      aria-label={t("codexCompatibilitySummary.label", {
        defaultValue: "Automatic compatibility handling",
      })}
    >
      <p className="font-medium text-foreground" role="status">
        {title}
      </p>
      {rows.length > 0 ? (
        <ul className="list-disc space-y-1 pl-4">
          {rows.map((row) => (
            <li key={row}>{row}</li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">
          {props.readiness === "verified"
            ? t("codexCompatibilitySummary.noAdaptation", {
                defaultValue:
                  "No additional compatibility strategy was recorded; this does not mean every response field exactly matches the official API.",
              })
            : t("codexCompatibilitySummary.notFixed", {
                defaultValue:
                  "No confirmed automatic fix exists yet; an in-progress probe or failed request must not be treated as fixed.",
              })}
        </p>
      )}
      {props.baselinePassed &&
        (props.reasoningSemantic === "opaque" ||
          props.reasoningSemantic === "none") && (
          <p className="text-amber-700 dark:text-amber-300">
            {t("codexCompatibilitySummary.noReasoning", {
              defaultValue:
                "The upstream returned no displayable reasoning text; CCSM does not generate, decrypt, or fabricate thinking content.",
            })}
          </p>
        )}
      {props.readiness === "verified" && (
        <p>
          {props.selected
            ? t("codexCompatibilitySummary.recommended", {
                defaultValue: "This branch was recommended automatically.",
              })
            : t("codexCompatibilitySummary.fallback", {
                defaultValue:
                  "This is a verified fallback branch; it is not necessarily selected.",
              })}
        </p>
      )}
      <p className="border-t pt-2 text-muted-foreground">
        {t("codexCompatibilitySummary.evidenceOnly", {
          defaultValue:
            "This is probe evidence, not proof that the current configuration is active. Probes are not saved; runtime requests use the selected adaptation only after the provider is saved and enabled. A manual override is not a passing verification.",
        })}
      </p>
    </div>
  );
}
