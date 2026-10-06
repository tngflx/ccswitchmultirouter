import { Button } from "@/components/ui/button";
import type { CodexReasoningEffort } from "@/types";
import { useState } from "react";

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

export interface CodexModelReasoningSummaryProps {
  model: string;
  source: string;
  selectableEfforts: string[];
  defaultEffort?: string;
  ultraEnabled: boolean;
  ultraEffort?: CodexReasoningEffort;
  ultraEfforts: CodexReasoningEffort[];
  onUltraChange: (ultra: {
    enabled: boolean;
    providerEffort?: CodexReasoningEffort;
  }) => void;
  expanded: boolean;
  onToggle: () => void;
}

export function CodexModelReasoningSummary({
  model,
  source,
  selectableEfforts,
  defaultEffort,
  ultraEnabled,
  ultraEffort,
  ultraEfforts,
  onUltraChange,
  expanded,
  onToggle,
}: CodexModelReasoningSummaryProps) {
  const displayModel = model || "Unnamed model";
  const displaySource = formatCapabilitySource(source);
  const [requestedUltraSetup, setRequestedUltraSetup] = useState(false);

  return (
    <div className="grid gap-3 rounded-md border bg-background p-3 text-xs lg:grid-cols-[minmax(10rem,1fr)_minmax(12rem,1.2fr)_minmax(16rem,1.2fr)_auto] lg:items-center">
      <div className="min-w-0">
        <p className="font-medium text-foreground">{displayModel}</p>
      </div>
      <div className="space-y-1 border-t pt-3 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
        <p className="text-muted-foreground">
          Capability source: {displaySource}
        </p>
        <p className="text-muted-foreground">
          Codex levels: {selectableEfforts.join(" / ") || "Not declared"}
        </p>
        <p className="text-muted-foreground">
          Default: {defaultEffort ?? "Model default"}
        </p>
      </div>
      <div className="space-y-1 border-t pt-3 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
        <span className="label text-muted-foreground">Ultra</span>
        <label className="flex items-center gap-2 font-medium">
          <input
            type="checkbox"
            aria-label={`Unlock Ultra for ${displayModel}`}
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
              });
            }}
          />
          Unlock Ultra
        </label>
        <select
          className="w-full rounded border bg-background px-2 py-1"
          aria-label={`Provider reasoning effort used by ${displayModel} Ultra`}
          value={ultraEffort ?? ""}
          disabled={!ultraEnabled || ultraEfforts.length === 0}
          onChange={(event) =>
            onUltraChange({
              enabled: ultraEnabled,
              providerEffort: (event.target.value || undefined) as
                CodexReasoningEffort | undefined,
            })
          }
        >
          <option value="">Select provider level…</option>
          {ultraEfforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
        <p className="text-muted-foreground">
          {requestedUltraSetup || (ultraEnabled && ultraEfforts.length === 0)
            ? "First confirm that this model accepts reasoning levels. The capability editor is open; complete it before saving."
            : ultraEnabled && ultraEffort
              ? `Unlocked; uses ${ultraEffort}`
              : "Independent of the capability source; select a level after unlocking"}
        </p>
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
