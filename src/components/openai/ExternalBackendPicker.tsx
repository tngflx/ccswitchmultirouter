import {
  AlertTriangle,
  CheckCircle2,
  LockKeyhole,
  Route,
  Server,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import type { ExternalOpenAIAPIBackendOption } from "@/types/proxy";
import {
  describeBackendTarget,
  displayBackendDescription,
  type BackendGroup,
  type BackendTargetDescription,
} from "@/lib/openai/externalProfile";

/// 渲染可复用的服务来源卡片列表；不可用来源也可点击查看原因，但不能保存启用。
export function ExternalBackendPicker({
  groups,
  selectedKey,
  onSelect,
}: {
  groups: BackendGroup[];
  selectedKey: string;
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation();

  if (groups.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/40 p-5 text-sm text-muted-foreground dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-400">
        {t("externalBackend.emptyState")}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.key} className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.label}
            </div>
            <Badge className={groupBadgeClass(group.tone)}>
              {t("externalBackend.sourceCount", {
                count: group.options.length,
              })}
            </Badge>
          </div>
          <div className="grid gap-2 xl:grid-cols-2">
            {group.options.map((option) => (
              <BackendSourceCard
                key={option.key}
                option={option}
                tone={group.tone}
                selected={option.key === selectedKey}
                onSelect={() => onSelect(option.key)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/// 渲染单个服务来源，用颜色和图标区分官方 OAuth、路由规则、普通模型源和不可用来源。
function BackendSourceCard({
  option,
  tone,
  selected,
  onSelect,
}: {
  option: ExternalOpenAIAPIBackendOption;
  tone: BackendGroup["tone"];
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const details = describeBackendTarget(option);
  const Icon = option.isManagedOAuth
    ? LockKeyhole
    : option.backendType === "codex_router_route" ||
        option.description === "Codex router provider"
      ? Route
      : option.available
        ? Server
        : AlertTriangle;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "min-w-0 rounded-lg border p-3 text-left transition",
        cardToneClass(tone, selected, option.available),
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-2">
          <span className={cn("mt-0.5 rounded-md p-1.5", iconToneClass(tone))}>
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground dark:text-slate-100">
              {option.label}
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground dark:text-slate-400">
              {displayBackendDescription(option.description)}
            </div>
          </div>
        </div>
        {selected && (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-blue-300" />
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge
          className={
            option.available
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-100"
              : "bg-muted text-muted-foreground dark:bg-slate-500/15 dark:text-slate-300"
          }
        >
          {option.available
            ? t("externalBackend.compat.available")
            : t("externalBackend.compat.needsSetupShort")}
        </Badge>
        <Badge variant="outline">{details.kind}</Badge>
        <Badge variant="outline">{details.modelSource}</Badge>
      </div>

      {!option.available && option.error && (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs leading-5 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          {translateBackendError(option.error)}
        </div>
      )}
    </button>
  );
}

/// 展示已选服务来源的摘要；命名改为“对外服务来源”，避免“后端目标”这种工程术语。
export function SelectedBackendSummary({
  backend,
  description,
  hasDraftChanges,
}: {
  backend?: ExternalOpenAIAPIBackendOption;
  description: BackendTargetDescription;
  hasDraftChanges: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/70 p-4 dark:border-blue-700/40 dark:bg-blue-950/15">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-foreground dark:text-slate-100">
          {t("externalBackend.summaryTitle")}
        </div>
        <Badge variant={hasDraftChanges ? "outline" : "secondary"}>
          {hasDraftChanges
            ? t("externalBackend.draftPending")
            : t("externalBackend.saved")}
        </Badge>
      </div>
      <div className="space-y-2 text-xs text-muted-foreground dark:text-slate-400">
        <SummaryLine
          label={t("externalBackend.label.source")}
          value={backend?.label ?? t("externalBackend.notSelected")}
        />
        <SummaryLine
          label={t("externalBackend.label.type")}
          value={description.kind}
        />
        <SummaryLine
          label={t("externalBackend.label.path")}
          value={description.protocol}
        />
        <SummaryLine
          label={t("externalBackend.label.auth")}
          value={description.auth}
        />
        <SummaryLine
          label={t("externalBackend.label.model")}
          value={description.modelSource}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {description.compatibility.map((item) => (
          <Badge key={item} variant="outline">
            {item}
          </Badge>
        ))}
      </div>
      {backend && !backend.available && (
        <Button disabled className="mt-3 w-full">
          {t("externalBackend.cannotEnable")}
        </Button>
      )}
    </div>
  );
}

/// 渲染摘要行，确保长名称不会撑破布局。
function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[58px_minmax(0,1fr)] gap-2">
      <span>{label}</span>
      <span className="truncate text-foreground dark:text-slate-100">
        {value}
      </span>
    </div>
  );
}

function groupBadgeClass(tone: BackendGroup["tone"]): string {
  return {
    blue: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-100",
    emerald:
      "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100",
    amber:
      "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
    slate:
      "border-border bg-muted text-muted-foreground dark:border-slate-500/40 dark:bg-slate-500/10 dark:text-slate-200",
  }[tone];
}

function iconToneClass(tone: BackendGroup["tone"]): string {
  return {
    blue: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200",
    emerald:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200",
    amber:
      "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200",
    slate:
      "bg-muted text-muted-foreground dark:bg-slate-500/15 dark:text-slate-200",
  }[tone];
}

function cardToneClass(
  tone: BackendGroup["tone"],
  selected: boolean,
  available: boolean,
): string {
  if (!available) {
    return selected
      ? "border-slate-400 bg-muted text-foreground dark:bg-slate-800/60"
      : "border-border bg-card text-muted-foreground hover:border-slate-400 hover:bg-muted dark:border-slate-700 dark:bg-slate-950/40 dark:hover:border-slate-500 dark:hover:bg-slate-900/60";
  }
  const selectedClasses = {
    blue: "border-blue-400 bg-blue-50 text-foreground shadow-[0_0_0_1px_rgba(96,165,250,0.35)] dark:bg-blue-600/20",
    emerald:
      "border-emerald-400 bg-emerald-50 text-foreground shadow-[0_0_0_1px_rgba(52,211,153,0.35)] dark:bg-emerald-600/20",
    amber:
      "border-amber-400 bg-amber-50 text-foreground shadow-[0_0_0_1px_rgba(251,191,36,0.3)] dark:bg-amber-600/20",
    slate: "border-slate-400 bg-muted text-foreground dark:bg-slate-800/60",
  }[tone];
  const idleClasses = {
    blue: "border-blue-200 bg-card text-foreground hover:border-blue-400 hover:bg-blue-50 dark:border-blue-700/40 dark:bg-slate-950/40 dark:hover:bg-blue-950/25",
    emerald:
      "border-emerald-200 bg-card text-foreground hover:border-emerald-400 hover:bg-emerald-50 dark:border-emerald-700/40 dark:bg-slate-950/40 dark:hover:bg-emerald-950/20",
    amber:
      "border-amber-200 bg-card text-foreground hover:border-amber-400 hover:bg-amber-50 dark:border-amber-700/40 dark:bg-slate-950/40 dark:hover:bg-amber-950/20",
    slate:
      "border-border bg-card text-foreground hover:border-slate-400 hover:bg-muted dark:border-slate-700 dark:bg-slate-950/40 dark:hover:border-slate-500 dark:hover:bg-slate-900/60",
  }[tone];
  return selected ? selectedClasses : idleClasses;
}

function translateBackendError(error: string): string {
  const t = (key: string) => i18n.t(key);
  if (error.includes("native protocol")) {
    return t("externalBackend.error.nativeProtocol");
  }
  if (error.includes("no usable base URL or credential")) {
    return t("externalBackend.error.noBaseUrl");
  }
  if (error.includes("route needs managed OAuth")) {
    return t("externalBackend.error.routeNeedsManagedOAuth");
  }
  if (error.includes("route target provider not found")) {
    return t("externalBackend.error.routeTargetNotFound");
  }
  if (
    error.includes("route target provider has no usable base URL or credential")
  ) {
    return t("externalBackend.error.routeTargetNoBaseUrl");
  }
  return error;
}
