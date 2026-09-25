import { Button } from "@/components/ui/button";
import type { CodexReasoningEffort } from "@/types";
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation();
  const displayModel =
    model || t("codexReasoning.unnamedModel", { defaultValue: "未命名模型" });
  const canConfigureUltra = ultraEfforts.length > 0;

  return (
    <div
      className={`grid gap-3 text-xs lg:items-center ${canConfigureUltra || ultraEnabled ? "lg:grid-cols-[minmax(10rem,1fr)_minmax(12rem,1.2fr)_minmax(16rem,1.2fr)_auto]" : "lg:grid-cols-[minmax(10rem,1fr)_minmax(12rem,1.2fr)_auto]"}`}
    >
      <div className="min-w-0">
        <p className="font-medium text-foreground">{displayModel}</p>
      </div>
      <div className="space-y-1 border-t pt-3 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
        <p className="text-muted-foreground">
          {t("codexReasoning.summarySource", {
            source,
            defaultValue: `能力来源：${source}`,
          })}
        </p>
        <p className="text-muted-foreground">
          {t("codexReasoning.summaryEfforts", {
            efforts:
              selectableEfforts.join(" / ") ||
              t("codexReasoning.undeclared", { defaultValue: "未声明" }),
            defaultValue: `Codex 档位：${selectableEfforts.join(" / ")}`,
          })}
        </p>
        <p className="text-muted-foreground">
          {t("codexReasoning.summaryDefaultValue", {
            value:
              defaultEffort ??
              t("codexReasoning.modelDefault", { defaultValue: "模型默认" }),
            defaultValue: `默认值：${defaultEffort ?? "模型默认"}`,
          })}
        </p>
      </div>
      {(canConfigureUltra || ultraEnabled) && (
        <div className="space-y-1 border-t pt-3 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
          <span className="label text-muted-foreground">Ultra</span>
          <label className="flex items-center gap-2 font-medium">
            <input
              type="checkbox"
              aria-label={t("codexReasoning.ariaUltraToggle", {
                model: displayModel,
                defaultValue: `为 ${displayModel} 启用 Codex Ultra`,
              })}
              checked={ultraEnabled}
              disabled={!canConfigureUltra && !ultraEnabled}
              onChange={(event) => {
                onUltraChange({
                  enabled: event.target.checked,
                  providerEffort: ultraEffort,
                });
              }}
            />
            {t("codexReasoning.unlockUltra", {
              defaultValue: "启用 Codex Ultra",
            })}
          </label>
          <select
            className="w-full rounded border bg-background px-2 py-1"
            aria-label={t("codexReasoning.ariaUltraSelect", {
              model: displayModel,
              defaultValue: `${displayModel} Ultra 对应的 Provider 推理强度`,
            })}
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
            <option value="">
              {t("codexReasoning.selectProviderEffort", {
                defaultValue: "选择 Provider 强度…",
              })}
            </option>
            {ultraEfforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
          <p className="text-muted-foreground">
            {ultraEnabled && !canConfigureUltra
              ? t("codexReasoning.needSetup", {
                  defaultValue:
                    "该映射暂无已确认的供应商推理强度。请配置模型能力或关闭 Codex Ultra 后再保存。",
                })
              : ultraEnabled && ultraEffort
                ? t("codexReasoning.unlockedUsing", {
                    effort: ultraEffort,
                    defaultValue: `已解锁，使用 ${ultraEffort}`,
                  })
                : t("codexReasoning.independent", {
                    defaultValue:
                      "Codex orchestration mapped to a provider effort; not native Ultra support",
                  })}
          </p>
        </div>
      )}
      <Button
        type="button"
        variant={expanded ? "secondary" : "outline"}
        size="sm"
        aria-label={
          expanded
            ? t("codexReasoning.ariaCollapse", {
                model: displayModel,
                defaultValue: `收起 ${displayModel} 的推理能力`,
              })
            : t("codexReasoning.ariaConfigure", {
                model: displayModel,
                defaultValue: `配置 ${displayModel} 的推理能力`,
              })
        }
        onClick={onToggle}
      >
        {expanded
          ? t("codexReasoning.collapseConfig", { defaultValue: "收起配置" })
          : t("codexReasoning.configureCapability", {
              defaultValue: "配置推理能力",
            })}
      </Button>
    </div>
  );
}
