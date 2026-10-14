import { Button } from "@/components/ui/button";
import type {
  CodexModelReasoningResolution,
  CodexReasoningControlKind,
  CodexReasoningSupportStatus,
} from "@/types/codexSubagentV2";

/**
 * P3 模型卡片：展示单模型「最终生效」的推理能力（与 catalog / 请求 / Sub-Agent
 * 同源），以及 unknown 状态下的动作。
 *
 * 设计原则：
 * - 只读展示 resolved 结果，不在此处编辑（编辑走下方既有手动声明 UI）。
 * - 具体模型只显示其 resolved capability 的子集，不因公共词表存在就宣称全部支持。
 * - unknown 状态默认「使用服务端默认」，并提供重新检测 / 采用检测结果 /
 *   手动声明 / 恢复内置值 动作。
 */

const CONTROL_KIND_LABEL: Record<CodexReasoningControlKind, string> = {
  none: "No control",
  boolean: "Boolean toggle",
  graded: "Effort levels",
  budget: "Token budget",
  unknown: "Unknown",
};

const SOURCE_LABEL: Record<string, string> = {
  user: "User declaration",
  detection: "Automatic detection",
  library: "Maintained capability library",
  builtin: "Built-in preset",
  official: "Official model",
  unknown: "Unknown",
};

export type CodexReasoningCardStatus = "supported" | "unsupported" | "unknown";

/** 由 resolution 推导卡片状态（三态）。 */
export function reasoningCardStatus(
  resolution: CodexModelReasoningResolution,
): CodexReasoningCardStatus {
  const status: CodexReasoningSupportStatus | undefined =
    resolution.capability?.supportStatus;
  if (status === "confirmed_supported") return "supported";
  if (status === "confirmed_unsupported") return "unsupported";
  // 无三态字段时回退到 resolved.supportKind。
  switch (resolution.resolved.supportKind) {
    case "effort_levels":
    case "boolean_only":
      return "supported";
    case "unsupported":
      return "unsupported";
    case "unknown":
    default:
      return "unknown";
  }
}

export const REASONING_STATUS_LABEL: Record<CodexReasoningCardStatus, string> =
  {
    supported: "Reasoning supported",
    unsupported: "Reasoning unsupported",
    unknown: "Unknown (using server default)",
  };

/** 控制类型：优先用声明的 controlKind，否则由 resolved.supportKind 推导。 */
export function reasoningControlKind(
  resolution: CodexModelReasoningResolution,
): CodexReasoningControlKind {
  const declared = resolution.capability?.controlKind;
  if (declared) return declared;
  switch (resolution.resolved.supportKind) {
    case "effort_levels":
      return "graded";
    case "boolean_only":
      return "boolean";
    case "unsupported":
    case "unknown":
    default:
      return "unknown";
  }
}

/** 最终行为：描述 Codex 实际会向上游发送什么。 */
export function describeFinalBehavior(
  resolution: CodexModelReasoningResolution,
): string {
  const { resolved } = resolution;
  const parameter = resolution.capability?.upstream?.parameter;
  switch (resolved.supportKind) {
    case "effort_levels": {
      const selectable = resolved.codexSelectableEfforts.join(" / ") || "None";
      const def = resolved.providerDefaultEffort ?? "Model default";
      const param = parameter ? ` (parameter ${parameter})` : "";
      return `Sends reasoning effort by level${param}; Codex options: ${selectable}; default: ${def}.`;
    }
    case "boolean_only": {
      const param = parameter ? ` (parameter ${parameter})` : "";
      return `Sends a boolean toggle${param}; levels are not distinguished.`;
    }
    case "unsupported":
      return "Does not send a reasoning parameter (the model does not support reasoning).";
    case "unknown":
    default:
      return "Uses the server default (no reasoning parameter is sent).";
  }
}

function formatFetchedAt(ms: number): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function EffortList({ efforts }: { efforts: string[] }) {
  if (!efforts.length)
    return <span className="text-muted-foreground">None</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {efforts.map((e) => (
        <code
          key={e}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]"
        >
          {e}
        </code>
      ))}
    </span>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}

export interface CodexModelReasoningCardProps {
  resolution: CodexModelReasoningResolution;
  /** 是否存在内置预设（决定「恢复内置值」动作是否可用）。 */
  hasBuiltinPreset: boolean;
  redetecting: boolean;
  onRedetect: () => void;
  onAdoptDetection: () => void;
  onManualDeclare: () => void;
  /** 将当前自动解析的能力复制为用户声明，之后可编辑档位与映射。 */
  onCustomizeEffective?: () => void;
  onRestoreBuiltin: () => void;
}

export function CodexModelReasoningCard({
  resolution,
  hasBuiltinPreset,
  redetecting,
  onRedetect,
  onAdoptDetection,
  onManualDeclare,
  onCustomizeEffective,
  onRestoreBuiltin,
}: CodexModelReasoningCardProps) {
  const status = reasoningCardStatus(resolution);
  const controlKind = reasoningControlKind(resolution);
  const { resolved, detection } = resolution;
  const isUnknown = status === "unknown";
  const hasUsableDetection =
    resolution.hasDetectionCandidate &&
    Boolean(
      detection?.reasoning?.supportedEfforts?.some(
        (effort) => effort && effort !== "none",
      ),
    );

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Effective capability</span>
        <span
          className={
            "rounded-full px-2 py-0.5 text-[11px] " +
            (status === "supported"
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : status === "unsupported"
                ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                : "bg-amber-500/15 text-amber-600 dark:text-amber-400")
          }
        >
          {REASONING_STATUS_LABEL[status]}
        </span>
      </div>

      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Control type">{CONTROL_KIND_LABEL[controlKind]}</Field>
        <Field label="Capability source">
          {SOURCE_LABEL[resolution.source] ?? resolution.source}
        </Field>
        <Field label="Capability fingerprint">
          <code
            className="font-mono text-[11px]"
            title={resolution.fingerprint || "Not generated"}
          >
            {resolution.fingerprint
              ? `${resolution.fingerprint.slice(0, 16)}…`
              : "Not generated (unknown capability)"}
          </code>
        </Field>
        {detection ? (
          <Field label="Verified at">
            {formatFetchedAt(detection.fetchedAt)}
            <span className="ml-1 text-muted-foreground">
              ({detection.source})
            </span>
          </Field>
        ) : null}
        <Field label="Provider-native levels">
          <EffortList efforts={resolved.providerAcceptedEfforts} />
        </Field>
        <Field label="Codex selectable levels">
          <EffortList efforts={resolved.codexSelectableEfforts} />
        </Field>
        <Field label="Default">
          {resolved.providerDefaultEffort ?? "Model default"}
        </Field>
        <Field label="Disable">
          {resolved.disableAllowed ? "Allowed (none)" : "Not allowed"}
        </Field>
        <Field label="Mapping">
          {Object.keys(resolved.effortMap).length ? (
            <span className="font-mono text-[11px]">
              {Object.entries(resolved.effortMap)
                .map(([k, v]) => `${k}→${v}`)
                .join("，")}
            </span>
          ) : (
            <span className="text-muted-foreground">Identity</span>
          )}
        </Field>
      </dl>

      <div className="rounded-md border bg-background p-2">
        <div className="text-muted-foreground">Effective behavior</div>
        <div>{describeFinalBehavior(resolution)}</div>
      </div>

      {onCustomizeEffective ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 p-2">
          <p className="text-muted-foreground">
            This is an automatically discovered result and may change with its
            source. Create a user override when you need to adjust Provider
            capabilities or level mappings.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCustomizeEffective}
          >
            Customize from current result
          </Button>
        </div>
      ) : null}

      {isUnknown ? (
        <div className="space-y-2">
          <p className="text-muted-foreground">
            No reasoning capability declaration was found for this model, so the
            server default is used. You can:
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRedetect}
              disabled={redetecting}
            >
              {redetecting ? "Detecting…" : "Detect again"}
            </Button>
            {hasUsableDetection ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onAdoptDetection}
              >
                Use detected result
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onManualDeclare}
            >
              Declare manually
            </Button>
            {hasBuiltinPreset ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onRestoreBuiltin}
              >
                Restore built-in value
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
