import { Button } from "@/components/ui/button";
import type { CodexCatalogModel, CodexReasoningEffort } from "@/types";
import type { CodexModelReasoningResolution } from "@/types/codexSubagentV2";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

const CAPABILITY_SOURCE_LABELS: Record<string, string> = {
  automatic: "Automatic discovery or server default",
  detection: "Automatic detection",
  library: "Maintained capability catalog",
  builtin: "CCSM-maintained declaration",
  user: "User declaration",
  自动发现: "Automatic detection",
  用户声明: "User declaration",
  自动发现或服务端默认: "Automatic discovery or server default",
  "CCSM 受维护声明": "CCSM-maintained declaration",
  "用户声明（已覆盖维护值）": "User declaration (overrides maintained value)",
};

function formatCapabilitySource(source: string): string {
  return (
    CAPABILITY_SOURCE_LABELS[source] ?? (source || "Unknown capability source")
  );
}

type CatalogUltra = NonNullable<CodexCatalogModel["codexUltra"]>;

export interface CodexModelReasoningSummaryProps {
  model: string;
  source: string;
  supportKind?: CodexModelReasoningResolution["resolved"]["supportKind"];
  selectableEfforts: string[];
  defaultEffort?: string;
  ultraEnabled: boolean;
  ultraEffort?: CodexReasoningEffort;
  ultraEffortSource?: CatalogUltra["providerEffortSource"];
  ultraEfforts: CodexReasoningEffort[];
  onUltraChange: (ultra: CatalogUltra) => void;
  expanded: boolean;
  onToggle: () => void;
}

export function CodexModelReasoningSummary({
  model,
  source,
  supportKind,
  selectableEfforts,
  defaultEffort,
  ultraEnabled,
  ultraEffort,
  ultraEffortSource,
  ultraEfforts,
  onUltraChange,
  expanded,
  onToggle,
}: CodexModelReasoningSummaryProps) {
  const { t } = useTranslation();
  const displayModel = model || "Unnamed model";
  const displaySource = formatCapabilitySource(source);
  const isBooleanOnly = supportKind === "boolean_only";
  const [requestedUltraSetup, setRequestedUltraSetup] = useState(false);
  const ultraStatusId = useId();
  const sendUltraAs = t("codexModelUltra.sendAs", {
    defaultValue: "Send Ultra as",
  });
  const formatUltraEffort = (effort: CodexReasoningEffort) => {
    if (effort === "max") {
      return t("codexModelUltra.max", { defaultValue: "Max" });
    }
    if (effort === "xhigh") {
      return t("codexModelUltra.xhigh", { defaultValue: "Extra High (xhigh)" });
    }
    return effort;
  };
  const unavailableUltraEffort =
    ultraEffort && !ultraEfforts.includes(ultraEffort)
      ? ultraEffort
      : undefined;
  let ultraStatus: string | undefined;
  if (ultraEnabled && unavailableUltraEffort) {
    const effort = formatUltraEffort(unavailableUltraEffort);
    ultraStatus =
      ultraEfforts.length > 0
        ? t("codexModelUltra.unsupported", {
            effort,
            defaultValue:
              "Saved provider level {{effort}} is unavailable. Choose a currently supported level before saving.",
          })
        : t("codexModelUltra.unsupportedWithoutOptions", {
            effort,
            defaultValue:
              "Saved provider level {{effort}} is unavailable. Confirm this model's reasoning capabilities, then choose a supported level before saving.",
          });
  } else if (
    ultraEfforts.length === 0 &&
    (requestedUltraSetup || ultraEnabled)
  ) {
    ultraStatus = t("codexModelUltra.needsCapabilities", {
      defaultValue:
        "Confirm this model's supported reasoning levels before saving.",
    });
  }

  return (
    <div className="grid gap-3 rounded-md border bg-background p-3 text-xs lg:grid-cols-[minmax(10rem,1fr)_minmax(12rem,1.2fr)_minmax(16rem,1.2fr)_auto] lg:items-center">
      <div className="min-w-0">
        <p className="break-words font-medium text-foreground">
          {displayModel}
        </p>
      </div>
      <div className="space-y-1 border-t pt-3 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
        <p className="text-muted-foreground">
          Capability source: {displaySource}
        </p>
        {isBooleanOnly ? (
          <p className="text-muted-foreground">
            Reasoning control: Thinking on/off
          </p>
        ) : (
          <>
            <p className="text-muted-foreground">
              Codex levels: {selectableEfforts.join(" / ") || "Not declared"}
            </p>
            <p className="text-muted-foreground">
              Default: {defaultEffort ?? "Model default"}
            </p>
          </>
        )}
      </div>
      <div className="space-y-2 border-t pt-3 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
        <p className="font-medium text-foreground">
          {t("codexModelUltra.title", { defaultValue: "Main agent Ultra" })}
        </p>
        <label className="flex items-center gap-2 font-medium">
          <input
            type="checkbox"
            aria-label={t("codexModelUltra.unlockForModel", {
              model: displayModel,
              defaultValue: "Unlock Ultra for {{model}}",
            })}
            checked={ultraEnabled}
            onChange={(event) => {
              setRequestedUltraSetup(
                event.target.checked && ultraEfforts.length === 0,
              );
              if (
                event.target.checked &&
                ultraEfforts.length === 0 &&
                !expanded
              ) {
                onToggle();
              }
              onUltraChange({
                enabled: event.target.checked,
                providerEffort: ultraEffort,
                ...(ultraEffortSource
                  ? { providerEffortSource: ultraEffortSource }
                  : {}),
              });
            }}
          />
          {t("codexModelUltra.unlock", { defaultValue: "Unlock Ultra" })}
        </label>
        <label className="grid gap-1 text-muted-foreground">
          {sendUltraAs}
          <select
            className="w-full min-w-0 rounded border bg-background px-2 py-1 text-foreground disabled:opacity-60"
            aria-label={`${sendUltraAs} (${displayModel})`}
            aria-describedby={ultraStatus ? ultraStatusId : undefined}
            value={ultraEffort ?? ""}
            disabled={!ultraEnabled || ultraEfforts.length === 0}
            onChange={(event) => {
              const providerEffort = ultraEfforts.find(
                (effort) => effort === event.target.value,
              );
              onUltraChange({
                enabled: ultraEnabled,
                providerEffort,
                ...(providerEffort ? { providerEffortSource: "user" } : {}),
              });
            }}
          >
            <option value="">
              {t("codexModelUltra.placeholder", {
                defaultValue: "Select provider level…",
              })}
            </option>
            {unavailableUltraEffort && (
              <option value={unavailableUltraEffort} disabled>
                {t("codexModelUltra.unavailableOption", {
                  effort: formatUltraEffort(unavailableUltraEffort),
                  defaultValue: "{{effort}} (unavailable)",
                })}
              </option>
            )}
            {ultraEfforts.map((effort) => (
              <option key={effort} value={effort}>
                {formatUltraEffort(effort)}
              </option>
            ))}
          </select>
        </label>
        {ultraStatus && (
          <p id={ultraStatusId} className="text-muted-foreground">
            {ultraStatus}
          </p>
        )}
      </div>
      <Button
        type="button"
        variant={expanded ? "secondary" : "outline"}
        size="sm"
        aria-label={`${expanded ? "Collapse" : "Configure"} reasoning capabilities for ${displayModel}`}
        onClick={onToggle}
      >
        {expanded ? "Collapse configuration" : "Configure reasoning"}
      </Button>
    </div>
  );
}
