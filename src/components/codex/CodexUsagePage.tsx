import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Clock,
  Database,
  Gauge,
  Info,
  LineChart,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  TimerReset,
  TrendingDown,
  TrendingUp,
  MonitorSmartphone,
  ShieldCheck,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { settingsApi } from "@/lib/api";
import { useSettingsQuery } from "@/lib/query";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSubscriptionQuota } from "@/lib/query/subscription";
import {
  useModelStats,
  useQuotaCollaborationOverview,
  useSyncQuotaCollaboration,
  useUsageSummary,
} from "@/lib/query/usage";
import type {
  QuotaTier,
  ResetCreditInfo,
  SubscriptionQuota,
} from "@/types/subscription";
import type { ModelStats, UsageSummary } from "@/types/usage";
import type { QuotaCollaborationOverview } from "@/types/usage";

const TRACKED_TIERS = new Set(["five_hour", "seven_day"]);
const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TODAY_RANGE = { preset: "today" } as const;
const SEVEN_DAY_RANGE = { preset: "7d" } as const;

const TIER_LABELS: Record<string, string> = {
  five_hour: "5-hour window",
  seven_day: "Weekly window",
  weekly_limit: "Weekly window",
};

interface UsageWindowCardProps {
  tier: QuotaTier;
}

interface ResetCreditRowProps {
  credit: ResetCreditInfo;
  index: number;
}

interface GuideStepProps {
  index: number;
  title: string;
  detail: string;
}

interface UsageReadingHintProps {
  title: string;
  detail: string;
  tone: "ok" | "warn" | "info";
}

interface WindowForecast {
  /** 已过周期的平均官方窗口消耗速度，单位为百分点/小时。 */
  percentPerHour: number;
  /** 在当前平均速度不变时的预计耗尽时刻；无法计算时为 null。 */
  depletionAt: Date | null;
  /** 预计耗尽是否发生在本次官方重置前。 */
  depletesBeforeReset: boolean;
  /** 预测的可解释性等级，固定为近似估算。 */
  confidence: "low" | "medium";
}

/** 页面级配色：每个 surface 都显式维护 light 与 dark 两套颜色，避免主题切换时只继承单套颜色。 */
const USAGE_PAGE_COLORS = {
  shell:
    "border-slate-200 bg-white text-slate-950 dark:border-slate-700/80 dark:bg-slate-950/30 dark:text-slate-100",
  header:
    "bg-gradient-to-r from-sky-50 via-white to-emerald-50 dark:from-blue-950/45 dark:via-slate-900 dark:to-emerald-950/30",
  chip: "border-slate-200 bg-white/80 text-slate-600 dark:border-slate-700/80 dark:bg-slate-950/40 dark:text-slate-300",
  guide:
    "border-sky-200 bg-sky-50/80 text-sky-950 dark:border-blue-700/40 dark:bg-blue-950/15 dark:text-blue-100",
  guideStep:
    "border-sky-200 bg-white/90 text-slate-950 dark:border-blue-700/40 dark:bg-slate-950/40 dark:text-slate-100",
  card: "border-slate-200 bg-white text-slate-950 dark:border-slate-700/80 dark:bg-slate-950/30 dark:text-slate-100",
  inset:
    "border-slate-200 bg-slate-50 text-slate-950 dark:border-slate-700/70 dark:bg-slate-950/40 dark:text-slate-100",
  progressTrack: "bg-slate-200 dark:bg-slate-800",
  warning:
    "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100",
  warningButton:
    "border-amber-300 bg-white text-amber-950 hover:bg-amber-100 dark:border-amber-700 dark:bg-slate-950/40 dark:text-amber-100 dark:hover:bg-amber-900/40",
  resetSummary: "bg-sky-100 text-sky-800 dark:bg-sky-500/10 dark:text-sky-300",
  analytics:
    "border-violet-200 bg-violet-50/60 text-slate-950 dark:border-violet-800/50 dark:bg-violet-950/15 dark:text-slate-100",
  analyticsInset:
    "border-slate-200 bg-white/85 text-slate-950 dark:border-slate-700/70 dark:bg-slate-950/35 dark:text-slate-100",
};

/** 读数提示卡配色：ok/warn/info 各自维护浅色和深色配色。 */
const READING_HINT_COLORS: Record<UsageReadingHintProps["tone"], string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-700/40 dark:bg-emerald-950/20 dark:text-emerald-100",
  warn: "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-700/40 dark:bg-amber-950/20 dark:text-amber-100",
  info: "border-sky-200 bg-sky-50 text-sky-950 dark:border-blue-700/40 dark:bg-blue-950/20 dark:text-blue-100",
};

/** 将百分比限制在进度条可安全渲染的 0-100 区间。 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 100);
}

/** 根据已用百分比返回容量状态文案。 */
function describeCapacity(utilization: number): string {
  if (utilization >= 95) return "Nearly exhausted";
  if (utilization >= 75) return "Tight";
  if (utilization >= 50) return "Normal";
  return "Healthy";
}

/** 根据已用百分比返回页面上的语义颜色。 */
function capacityTone(utilization: number): string {
  if (utilization >= 95) return "text-red-600 dark:text-red-400";
  if (utilization >= 75) return "text-amber-600 dark:text-amber-400";
  if (utilization >= 50) return "text-blue-600 dark:text-blue-400";
  return "text-emerald-600 dark:text-emerald-400";
}

/** 根据已用百分比返回进度条颜色。 */
function capacityBarTone(utilization: number): string {
  if (utilization >= 95) return "bg-red-500";
  if (utilization >= 75) return "bg-amber-500";
  if (utilization >= 50) return "bg-blue-500";
  return "bg-emerald-500";
}

/** 把 ISO 时间格式化为本地可读时间；无效或缺失时返回兜底文案。 */
function formatDateTime(value: string | null | undefined): string {
  if (!value) return "Not returned";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unable to parse";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 把毫秒时间戳格式化为最近刷新时间。 */
function formatCheckedAt(value: number | null | undefined): string {
  if (!value) return "Not refreshed yet";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 将 token 数量压缩成适合仪表盘阅读的本地化格式。 */
function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: value >= 1000000 ? 1 : 0,
  }).format(value);
}

/** 将官方窗口的重置时间换算为剩余小时数；无法解析时返回 null。 */
function getHoursUntil(value: string | null | undefined): number | null {
  if (!value) return null;
  const resetMs = new Date(value).getTime();
  if (!Number.isFinite(resetMs)) return null;
  return Math.max(0, (resetMs - Date.now()) / (60 * 60 * 1000));
}

/** 根据窗口类型返回可用于推算平均速率的理论周期长度。 */
function getWindowDurationMs(tierName: string): number | null {
  if (tierName === "five_hour") return FIVE_HOUR_WINDOW_MS;
  if (tierName === "seven_day" || tierName === "weekly_limit") {
    return SEVEN_DAY_WINDOW_MS;
  }
  return null;
}

/**
 * 根据当前官方百分比与已过周期时间估算窗口耗尽点。
 *
 * 官方接口不会返回窗口总 token 数，因此这里严格只在“官方百分比”维度做
 * 线性外推，不能把本地 token 日志换算为官方配额。
 */
function buildWindowForecast(tier: QuotaTier): WindowForecast | null {
  const durationMs = getWindowDurationMs(tier.name);
  const resetsAtMs = tier.resetsAt ? new Date(tier.resetsAt).getTime() : NaN;
  const used = clampPercent(tier.utilization);
  if (!durationMs || !Number.isFinite(resetsAtMs) || used <= 0) return null;

  const windowStartMs = resetsAtMs - durationMs;
  const elapsedHours = Math.max(
    (Date.now() - windowStartMs) / (60 * 60 * 1000),
    1 / 60,
  );
  const percentPerHour = used / elapsedHours;
  const remaining = Math.max(0, 100 - used);
  const hoursUntilFull = remaining / percentPerHour;
  const depletionAt = new Date(Date.now() + hoursUntilFull * 60 * 60 * 1000);

  return {
    percentPerHour,
    depletionAt,
    depletesBeforeReset: depletionAt.getTime() < resetsAtMs,
    confidence: elapsedHours >= 1 ? "medium" : "low",
  };
}

/** 根据窗口预测生成一条明确但不过度承诺的行动建议。 */
function getWindowRecommendation(
  tier: QuotaTier,
  forecast: WindowForecast | null,
): { title: string; detail: string; tone: "ok" | "warn" | "risk" } {
  const hoursUntilReset = getHoursUntil(tier.resetsAt);
  if (!forecast || hoursUntilReset === null) {
    return {
      title: "Waiting for more window data",
      detail:
        "The official service has not provided enough valid window readings to show a depletion forecast.",
      tone: "warn",
    };
  }
  if (forecast.depletesBeforeReset) {
    return {
      title: "May deplete before reset at the current pace",
      detail: `Expected to deplete around ${formatDateTime(forecast.depletionAt?.toISOString())}; reduce concurrency or move lightweight work to another model.`,
      tone: "risk",
    };
  }
  if (forecast.percentPerHour >= 15) {
    return {
      title: "Usage pace is fast",
      detail: `About ${Math.ceil(hoursUntilReset)} hours remain before reset; avoid resubmitting large contexts.`,
      tone: "warn",
    };
  }
  return {
    title: "Current pace should last until reset",
    detail: `At the average pace so far, capacity should remain through ${formatDateTime(tier.resetsAt)}.`,
    tone: "ok",
  };
}

/** 计算今天已过去的小时数，保证新的一天不会除以零。 */
function getElapsedTodayHours(nowMs: number = Date.now()): number {
  const now = new Date(nowMs);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max((nowMs - start.getTime()) / (60 * 60 * 1000), 1 / 60);
}

/** 选出 token 消耗最高的若干模型，并稳定处理同值排序。 */
function getTopModels(stats: ModelStats[] | undefined): ModelStats[] {
  return [...(stats ?? [])]
    .filter((item) => item.totalTokens > 0)
    .sort(
      (left, right) =>
        right.totalTokens - left.totalTokens ||
        right.requestCount - left.requestCount ||
        left.model.localeCompare(right.model),
    )
    .slice(0, 4);
}

/** 计算 reset credit 到期紧迫度，用于提示即将过期的额度。 */
function resetCreditUrgency(expiresAt: string | null | undefined): {
  label: string;
  className: string;
} {
  if (!expiresAt) {
    return {
      label: "No expiry record",
      className: "text-muted-foreground",
    };
  }
  const expiresAtMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiresAtMs)) {
    return {
      label: "Invalid expiry time",
      className: "text-amber-600 dark:text-amber-400",
    };
  }
  const hoursLeft = (expiresAtMs - Date.now()) / (1000 * 60 * 60);
  if (hoursLeft <= 0) {
    return {
      label: "Expired",
      className: "text-red-600 dark:text-red-400",
    };
  }
  if (hoursLeft <= 24) {
    return {
      label: "Expires today",
      className: "text-red-600 dark:text-red-400",
    };
  }
  if (hoursLeft <= 72) {
    return {
      label: "Expiring soon",
      className: "text-amber-600 dark:text-amber-400",
    };
  }
  if (hoursLeft <= 24 * 7) {
    return {
      label: "Expires this week",
      className: "text-blue-600 dark:text-blue-400",
    };
  }
  return {
    label: "Available",
    className: "text-emerald-600 dark:text-emerald-400",
  };
}

/** 判断 reset credit 是否仍处于官方 available 状态。 */
function isAvailableCredit(credit: ResetCreditInfo): boolean {
  return credit.status?.toLowerCase() === "available";
}

/** 从额度响应中挑出主页面展示的 Codex 速率窗口。 */
function getVisibleTiers(quota: SubscriptionQuota | undefined): QuotaTier[] {
  return (quota?.tiers ?? []).filter(
    (tier) => TRACKED_TIERS.has(tier.name) || tier.name in TIER_LABELS,
  );
}

/** 引导步骤条目：说明从哪里进入页面以及读数顺序。 */
const GuideStep: React.FC<GuideStepProps> = ({ index, title, detail }) => (
  <div
    className={`flex gap-3 rounded-lg border p-3 text-sm ${USAGE_PAGE_COLORS.guideStep}`}
  >
    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-600 text-xs font-semibold text-white dark:bg-blue-500">
      {index}
    </div>
    <div className="min-w-0">
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-1 text-xs leading-5 text-muted-foreground">
        {detail}
      </div>
    </div>
  </div>
);

/** 读数提示条目：把颜色和阈值解释成可执行判断。 */
const UsageReadingHint: React.FC<UsageReadingHintProps> = ({
  title,
  detail,
  tone,
}) => {
  return (
    <div className={`rounded-lg border px-3 py-2 ${READING_HINT_COLORS[tone]}`}>
      <div className="text-xs font-semibold">{title}</div>
      <div className="mt-1 text-xs leading-5 opacity-80">{detail}</div>
    </div>
  );
};

/** 页面引导区：补齐入口、刷新和读数判断，避免用户只看到一组静态数字。 */
const UsageGuidePanel: React.FC = () => (
  <section className={`rounded-lg border p-4 ${USAGE_PAGE_COLORS.guide}`}>
    <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
      <Info className="h-4 w-4" />
      Quick guide
    </div>
    <div className="grid gap-3 lg:grid-cols-3">
      <GuideStep
        index={1}
        title="Open from the Codex toolbar"
        detail="Switch the main view to Codex, then click the chart button beside multi-model routing."
      />
      <GuideStep
        index={2}
        title="Refresh the current login first"
        detail="This page reads the local Codex Desktop / CLI login; refresh only queries again and does not redeem resets."
      />
      <GuideStep
        index={3}
        title="Decide using windows and expiry"
        detail="Check the 5-hour and weekly remaining capacity, then check whether reset credits are near expiry."
      />
    </div>
    <div className="mt-3 grid gap-2 lg:grid-cols-3">
      <UsageReadingHint
        tone="ok"
        title="Green / blue"
        detail="Capacity is available; continue working or preserve the reset."
      />
      <UsageReadingHint
        tone="warn"
        title="Yellow / red"
        detail="The window is tight; if reset is not soon, plan usage or wait."
      />
      <UsageReadingHint
        tone="info"
        title="Expiry alerts"
        detail="Expiring today, soon, or this week is highlighted so reset credits are not wasted."
      />
    </div>
  </section>
);

/** 预测提示使用的单一图标和语义配色，避免分散在调用位置判断。 */
function ForecastStatusIcon({
  tone,
}: {
  tone: "ok" | "warn" | "risk";
}): React.ReactNode {
  if (tone === "risk") {
    return <ShieldAlert className="h-4 w-4 text-red-600 dark:text-red-400" />;
  }
  if (tone === "warn") {
    return (
      <TrendingUp className="h-4 w-4 text-amber-600 dark:text-amber-400" />
    );
  }
  return (
    <TrendingDown className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
  );
}

/** 渲染单个 5 小时/每周用量窗口。 */
const UsageWindowCard: React.FC<UsageWindowCardProps> = ({ tier }) => {
  const used = clampPercent(tier.utilization);
  const remaining = Math.max(0, 100 - used);
  const label = TIER_LABELS[tier.name] ?? tier.name;
  const forecast = buildWindowForecast(tier);
  const recommendation = getWindowRecommendation(tier, forecast);

  return (
    <section className={`rounded-lg border p-4 ${USAGE_PAGE_COLORS.card}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-foreground">{label}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Reset time: {formatDateTime(tier.resetsAt)}
          </div>
        </div>
        <div className={`text-right ${capacityTone(used)}`}>
          <div className="text-2xl font-semibold tabular-nums">
            {Math.round(remaining)}%
          </div>
          <div className="text-xs font-medium">Remaining</div>
        </div>
      </div>

      <div
        className={`h-2 overflow-hidden rounded-full ${USAGE_PAGE_COLORS.progressTrack}`}
      >
        <div
          className={`h-full rounded-full transition-all ${capacityBarTone(used)}`}
          style={{ width: `${used}%` }}
        />
      </div>

      <div className="mt-3 flex items-center justify-between text-xs">
        <span className={capacityTone(used)}>{describeCapacity(used)}</span>
        <span className="text-muted-foreground tabular-nums">
          Used {Math.round(used)}%
        </span>
      </div>

      <div
        className={`mt-4 rounded-md border px-3 py-2.5 ${
          recommendation.tone === "risk"
            ? USAGE_PAGE_COLORS.warning
            : USAGE_PAGE_COLORS.inset
        }`}
      >
        <div className="flex items-start gap-2">
          <ForecastStatusIcon tone={recommendation.tone} />
          <div className="min-w-0">
            <div className="text-xs font-semibold">{recommendation.title}</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">
              {recommendation.detail}
            </div>
          </div>
        </div>
        {forecast && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-current/10 pt-2 text-[11px] text-muted-foreground">
            <span className="tabular-nums">
              Average {forecast.percentPerHour.toFixed(1)}% / hour
            </span>
            <span>
              Confidence: {forecast.confidence === "medium" ? "medium" : "low"}
            </span>
          </div>
        )}
      </div>
    </section>
  );
};

/**
 * 本地日志分析区：把 token、模型和缓存数据独立于官方窗口展示。
 *
 * 该区域只描述本机已同步的 Codex 会话/代理日志，避免与官方百分比混用。
 */
const LocalUsageAnalytics: React.FC<{
  summary: UsageSummary | undefined;
  modelStats: ModelStats[] | undefined;
  isLoading: boolean;
}> = ({ summary, modelStats, isLoading }) => {
  const topModels = getTopModels(modelStats);
  const tokensPerHour = summary
    ? summary.realTotalTokens / getElapsedTodayHours()
    : 0;
  const cachePercent = summary
    ? Math.round(Math.max(0, Math.min(summary.cacheHitRate, 1)) * 100)
    : 0;
  const heavyModel = topModels[0];
  const highBurn =
    tokensPerHour >= 200000 || (summary?.totalRequests ?? 0) >= 50;
  const topModelsTotalTokens = topModels.reduce(
    (total, item) => total + item.totalTokens,
    0,
  );

  return (
    <section className={`rounded-lg border p-5 ${USAGE_PAGE_COLORS.analytics}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-2">
          <LineChart className="mt-0.5 h-4 w-4 text-violet-700 dark:text-violet-300" />
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Local usage pace
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              From locally synced Codex sessions and proxy logs; used only to
              identify token and model usage trends, not to convert official
              window capacity.
            </p>
          </div>
        </div>
        <span className="inline-flex w-fit items-center gap-1 rounded-md border border-violet-200 bg-white/80 px-2 py-1 text-xs text-violet-800 dark:border-violet-800/70 dark:bg-slate-950/35 dark:text-violet-200">
          <Database className="h-3.5 w-3.5" />
          Local log scope
        </span>
      </div>

      {isLoading && !summary ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Summarizing local Codex usage...
        </div>
      ) : !summary || summary.totalRequests === 0 ? (
        <div
          className={`mt-4 rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground ${USAGE_PAGE_COLORS.analyticsInset}`}
        >
          No local Codex usage records are available. Complete a Codex session
          sync or make a request through the local proxy to see token pace and
          model distribution.
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div
              className={`rounded-md border p-3 ${USAGE_PAGE_COLORS.analyticsInset}`}
            >
              <div className="text-xs text-muted-foreground">
                Today's tokens
              </div>
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {formatTokens(summary.realTotalTokens)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {summary.totalRequests} requests
              </div>
            </div>
            <div
              className={`rounded-md border p-3 ${USAGE_PAGE_COLORS.analyticsInset}`}
            >
              <div className="text-xs text-muted-foreground">
                Current usage pace
              </div>
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {formatTokens(tokensPerHour)}
                <span className="ml-1 text-xs font-medium text-muted-foreground">
                  token / hour
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Average over elapsed time today
              </div>
            </div>
            <div
              className={`rounded-md border p-3 ${USAGE_PAGE_COLORS.analyticsInset}`}
            >
              <div className="text-xs text-muted-foreground">
                Cache hit rate
              </div>
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {cachePercent}%
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {cachePercent < 30
                  ? "Reuse repeated context first"
                  : "Context reuse is normal"}
              </div>
            </div>
            <div
              className={`rounded-md border p-3 ${USAGE_PAGE_COLORS.analyticsInset}`}
            >
              <div className="text-xs text-muted-foreground">
                Request success rate
              </div>
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {Math.round(summary.successRate)}%
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Successful requests counted
              </div>
            </div>
          </div>

          <div
            className={`mt-4 rounded-md border p-3 ${USAGE_PAGE_COLORS.analyticsInset}`}
          >
            <div className="flex items-start gap-2">
              <Sparkles className="mt-0.5 h-4 w-4 text-violet-700 dark:text-violet-300" />
              <div className="min-w-0 text-sm">
                <div className="font-semibold text-foreground">
                  {highBurn
                    ? "Reduce high-context task density first"
                    : "Local token pace is within an observable range"}
                </div>
                <p className="mt-1 leading-5 text-muted-foreground">
                  {highBurn
                    ? `About ${formatTokens(tokensPerHour)} tokens/hour. Split large tasks, avoid pasting long contexts repeatedly, and move lightweight tasks to lower-cost models to reduce usage.`
                    : heavyModel
                      ? `${heavyModel.model} used the most tokens in the last 7 days, about ${Math.round((heavyModel.totalTokens / Math.max(topModelsTotalTokens, 1)) * 100)}% of displayed model usage.`
                      : "Keep collecting local session records to unlock model-level usage recommendations."}
                </p>
              </div>
            </div>
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <BarChart3 className="h-4 w-4 text-violet-700 dark:text-violet-300" />
              Model distribution over the last 7 days
            </div>
            {topModels.length > 0 ? (
              <div className="divide-y rounded-md border bg-white/70 dark:divide-slate-700/70 dark:bg-slate-950/20">
                {topModels.map((item) => {
                  const share = Math.min(
                    100,
                    Math.round(
                      (item.totalTokens / Math.max(topModelsTotalTokens, 1)) *
                        100,
                    ),
                  );
                  return (
                    <div
                      key={item.model}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2.5 text-sm sm:grid-cols-[minmax(0,1fr)_110px_90px]"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground">
                          {item.model}
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-violet-100 dark:bg-violet-950/60">
                          <div
                            className="h-full rounded-full bg-violet-500"
                            style={{ width: `${share}%` }}
                          />
                        </div>
                      </div>
                      <div className="text-right text-xs text-muted-foreground tabular-nums">
                        {formatTokens(item.totalTokens)} token
                      </div>
                      <div className="text-right text-xs text-muted-foreground tabular-nums">
                        {item.requestCount} requests
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                Local logs returned no model-level token records to display.
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
};

/** 渲染已接入 CCSwitchMulti 的设备汇总，避免将 token 错当官方窗口额度。 */
const QuotaCollaborationPanel: React.FC<{
  overview: QuotaCollaborationOverview | undefined;
  isLoading: boolean;
  onSync: () => void;
  isSyncing: boolean;
}> = ({ overview, isLoading, onSync, isSyncing }) => {
  const queryClient = useQueryClient();
  const { data: settings } = useSettingsQuery();
  const [deviceName, setDeviceName] = useState("");
  const [mode, setMode] = useState<"observe" | "enforce">("observe");
  const [threshold, setThreshold] = useState(20);
  const [confirmEnforceOpen, setConfirmEnforceOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  /** 以持久化配置为准同步编辑控件，避免概览缓存短暂落后时覆盖用户输入。 */
  useEffect(() => {
    if (!settings?.quotaCollaboration) return;
    const config = settings.quotaCollaboration;
    setDeviceName(config.deviceName ?? "");
    setMode(config.mode ?? "observe");
    setThreshold(
      Math.min(90, Math.max(1, config.enforceRemainingPercent ?? 20)),
    );
  }, [settings?.quotaCollaboration]);

  /** 保存本机协作配置，并让页面同时刷新设置和远端报告缓存。 */
  const saveCollaborationSettings = async (
    nextMode: "observe" | "enforce" = mode,
  ) => {
    if (!settings) {
      toast.error("Settings are not loaded yet; try again shortly.");
      return;
    }
    setIsSaving(true);
    try {
      const current = settings.quotaCollaboration;
      await settingsApi.save({
        ...settings,
        quotaCollaboration: {
          deviceId: current?.deviceId ?? overview?.deviceId ?? "",
          deviceName: deviceName.trim(),
          mode: nextMode,
          enforceRemainingPercent: Math.min(90, Math.max(1, threshold)),
          latestWindowUtilization: current?.latestWindowUtilization ?? {},
          latestWindowCapturedAt: current?.latestWindowCapturedAt ?? null,
        },
      });
      setMode(nextMode);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({
          queryKey: ["usage", "quota-collaboration"],
        }),
      ]);
      toast.success("Multi-device collaboration settings saved.");
    } catch (error) {
      toast.error(
        `Failed to save multi-device collaboration settings: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setIsSaving(false);
    }
  };

  /** 在用户确认边界后才写入 enforce，防止误以为它能控制旁路流量。 */
  const confirmEnforce = () => {
    setConfirmEnforceOpen(false);
    void saveCollaborationSettings("enforce");
  };

  if (isLoading && !overview) {
    return (
      <section className={`rounded-lg border p-5 ${USAGE_PAGE_COLORS.card}`}>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading multi-device collaboration cache...
        </div>
      </section>
    );
  }

  const reports = overview?.reports ?? [];
  const todayTokens = reports.reduce(
    (sum, report) => sum + report.todayTokens,
    0,
  );
  const weekTokens = reports.reduce(
    (sum, report) => sum + report.sevenDayTokens,
    0,
  );
  const isEnforcing = overview?.mode === "enforce";
  return (
    <section className={`rounded-lg border p-5 ${USAGE_PAGE_COLORS.card}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-2">
          <MonitorSmartphone className="mt-0.5 h-4 w-4 text-emerald-700 dark:text-emerald-300" />
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Multi-device quota collaboration
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Official windows are totals for the same Codex account; this table
              only summarizes device tokens connected to CCSwitchMulti and does
              not convert between the two measures.
            </p>
          </div>
        </div>
        <span
          className={`inline-flex w-fit items-center gap-1 rounded-md border px-2 py-1 text-xs ${
            isEnforcing
              ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
              : "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200"
          }`}
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          {isEnforcing ? "Enforce mode" : "Observe mode"}
        </span>
      </div>
      <div className="mt-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-2"
          onClick={onSync}
          disabled={isSyncing}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${isSyncing ? "animate-spin" : ""}`}
          />
          Sync device reports
        </Button>
      </div>

      <div className={`mt-4 rounded-md border p-3 ${USAGE_PAGE_COLORS.inset}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold text-foreground">
              Collaboration settings
            </h4>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Each device uses the same WebDAV or S3 directory; the device name
              only affects display.
            </p>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Open the multi-device collaboration guide"
            title="Open the multi-device collaboration guide"
            onClick={() =>
              void settingsApi.openExternal(
                "https://github.com/tngflx/ccswitchmultirouter/blob/main/docs/guides/codex-multi-device-quota-collaboration-zh.md",
              )
            }
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="quota-collaboration-device-name">Device name</Label>
            <Input
              id="quota-collaboration-device-name"
              value={deviceName}
              maxLength={64}
              placeholder="For example: Office Windows"
              onChange={(event) => setDeviceName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Collaboration mode</Label>
            <div className="flex rounded-md border p-1">
              <Button
                type="button"
                size="sm"
                variant={mode === "observe" ? "default" : "ghost"}
                onClick={() => setMode("observe")}
              >
                Observe
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === "enforce" ? "default" : "ghost"}
                onClick={() => {
                  if (mode !== "enforce") setConfirmEnforceOpen(true);
                }}
              >
                Enforce
              </Button>
            </div>
          </div>
        </div>
        {mode === "enforce" ? (
          <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_96px] md:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="quota-collaboration-threshold">
                Window remaining threshold
              </Label>
              <input
                id="quota-collaboration-threshold"
                className="h-2 w-full cursor-pointer accent-amber-600"
                type="range"
                min="1"
                max="90"
                value={threshold}
                onChange={(event) => setThreshold(Number(event.target.value))}
              />
            </div>
            <Input
              aria-label="Window remaining threshold percentage"
              type="number"
              min="1"
              max="90"
              value={threshold}
              onChange={(event) =>
                setThreshold(
                  Math.min(90, Math.max(1, Number(event.target.value) || 1)),
                )
              }
            />
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => void saveCollaborationSettings()}
            disabled={!settings || isSaving}
          >
            {isSaving ? "Saving..." : "Save collaboration settings"}
          </Button>
          {!overview?.configured ? (
            <span className="text-xs text-amber-700 dark:text-amber-300">
              Enable WebDAV or S3 in Settings before syncing other devices.
            </span>
          ) : null}
        </div>
      </div>

      <ol className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <li
          className={`rounded-md border px-3 py-2 ${USAGE_PAGE_COLORS.inset}`}
        >
          1. Enable the same WebDAV or S3 on each device
        </li>
        <li
          className={`rounded-md border px-3 py-2 ${USAGE_PAGE_COLORS.inset}`}
        >
          2. Refresh official quota on each device
        </li>
        <li
          className={`rounded-md border px-3 py-2 ${USAGE_PAGE_COLORS.inset}`}
        >
          3. Click Sync device reports on each device
        </li>
        <li
          className={`rounded-md border px-3 py-2 ${USAGE_PAGE_COLORS.inset}`}
        >
          4. Return to any device and confirm the list is aggregated
        </li>
      </ol>

      {overview?.warning ? (
        <div
          className={`mt-4 rounded-md border px-3 py-3 text-sm ${USAGE_PAGE_COLORS.warning}`}
        >
          {overview.warning}
        </div>
      ) : reports.length === 0 ? (
        <div
          className={`mt-4 rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground ${USAGE_PAGE_COLORS.inset}`}
        >
          Only the local cache is available. Refresh official quota once to
          create a local report; synced devices appear here after collaboration
          is configured.
        </div>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto rounded-md border">
            <div className="min-w-[620px] divide-y">
              <div className="grid grid-cols-[minmax(150px,1fr)_110px_110px_80px_130px] gap-3 bg-slate-50 px-3 py-2 text-xs font-medium text-muted-foreground dark:bg-slate-900/50">
                <span>Device</span>
                <span className="text-right">Today's tokens</span>
                <span className="text-right">7-day tokens</span>
                <span className="text-right">Requests</span>
                <span className="text-right">Last report</span>
              </div>
              {reports.map((report) => (
                <div
                  key={report.deviceId}
                  className="grid grid-cols-[minmax(150px,1fr)_110px_110px_80px_130px] gap-3 px-3 py-2.5 text-sm"
                >
                  <div className="min-w-0 truncate font-medium">
                    {report.deviceName}
                    {report.deviceId === overview?.deviceId
                      ? "(this device)"
                      : ""}
                  </div>
                  <span className="text-right tabular-nums">
                    {formatTokens(report.todayTokens)}
                  </span>
                  <span className="text-right tabular-nums">
                    {formatTokens(report.sevenDayTokens)}
                  </span>
                  <span className="text-right tabular-nums">
                    {report.sevenDayRequests}
                  </span>
                  <span className="text-right text-xs text-muted-foreground">
                    {formatDateTime(
                      new Date(report.capturedAt * 1000).toISOString(),
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{reports.length} devices covered</span>
            <span>Today total: {formatTokens(todayTokens)} tokens</span>
            <span>7-day total: {formatTokens(weekTokens)} tokens</span>
          </div>
        </>
      )}
      <div
        className={`mt-4 rounded-md border px-3 py-2.5 text-xs leading-5 ${isEnforcing ? USAGE_PAGE_COLORS.warning : USAGE_PAGE_COLORS.inset}`}
      >
        {isEnforcing
          ? `When official window capacity is at or below ${Math.round(overview?.enforceRemainingPercent ?? 20)}%, the local gateway will stop forwarding Codex requests. Native Codex App instances outside CCSwitchMulti are unaffected.`
          : "Observe mode does not block requests. Enforce mode applies only to instances using the CCSwitchMulti gateway."}
      </div>
      <ConfirmDialog
        isOpen={confirmEnforceOpen}
        title="Enable enforce mode?"
        message={
          "When official window capacity falls below the threshold, the local CCSwitchMulti gateway will stop forwarding Codex requests.\n\nNative Codex App, CLI, or other requests outside this gateway are unaffected and still consume the same account quota."
        }
        confirmText="I understand; enable enforce"
        cancelText="Keep observe"
        variant="info"
        onConfirm={confirmEnforce}
        onCancel={() => setConfirmEnforceOpen(false)}
      />
    </section>
  );
};

/** 渲染单条 banked reset credit 到期记录。 */
const ResetCreditRow: React.FC<ResetCreditRowProps> = ({ credit, index }) => {
  const urgency = resetCreditUrgency(credit.expiresAt);

  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-lg border px-3 py-2 text-sm ${USAGE_PAGE_COLORS.inset}`}
    >
      <div className="min-w-0">
        <div className="truncate font-medium text-foreground">
          {credit.title || `Reset ${index + 1}`}
        </div>
        <div className="text-xs text-muted-foreground">
          Status: {credit.status ?? "unknown"}
        </div>
      </div>
      <div className="text-xs text-muted-foreground tabular-nums">
        {formatDateTime(credit.expiresAt)}
      </div>
      <div className={`text-xs font-medium ${urgency.className}`}>
        {urgency.label}
      </div>
    </div>
  );
};

/** 渲染凭据缺失、过期或接口失败时的页面级状态。 */
function renderQuotaProblem(
  quota: SubscriptionQuota | undefined,
  loading: boolean,
  refetch: () => void,
): React.ReactNode {
  if (loading && !quota) {
    return (
      <div
        className={`rounded-lg border p-6 text-sm text-muted-foreground ${USAGE_PAGE_COLORS.card}`}
      >
        Reading local Codex login status...
      </div>
    );
  }

  if (!quota) return null;

  const isCredentialProblem =
    quota.credentialStatus === "not_found" ||
    quota.credentialStatus === "expired" ||
    quota.credentialStatus === "reauth_required" ||
    quota.credentialStatus === "parse_error";

  if (!isCredentialProblem && quota.success) return null;

  const title = isCredentialProblem
    ? "Codex login unavailable"
    : "Quota query failed";
  const detail =
    quota.credentialMessage ||
    quota.error ||
    "Confirm Codex Desktop / CLI is signed in, then refresh.";

  return (
    <section
      className={`rounded-lg border p-5 text-sm shadow-sm ${USAGE_PAGE_COLORS.warning}`}
    >
      <div className="mb-3 flex items-center gap-2 font-semibold">
        <AlertCircle className="h-4 w-4" />
        {title}
      </div>
      <p className="mb-4 opacity-90">{detail}</p>
      <Button
        type="button"
        onClick={refetch}
        disabled={loading}
        size="sm"
        variant="outline"
        className={`gap-2 ${USAGE_PAGE_COLORS.warningButton}`}
      >
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        Refresh again
      </Button>
    </section>
  );
}

/** Codex 用量与 banked reset credits 的独立工具页。 */
export const CodexUsagePage: React.FC = () => {
  const { t } = useTranslation();
  const {
    data: quota,
    isFetching,
    refetch,
  } = useSubscriptionQuota("codex", true, true, 5);
  const {
    data: todayUsage,
    isFetching: isTodayUsageFetching,
    refetch: refetchTodayUsage,
  } = useUsageSummary(TODAY_RANGE, { appType: "codex" });
  const { data: modelStats, refetch: refetchModelStats } = useModelStats(
    SEVEN_DAY_RANGE,
    { appType: "codex" },
  );
  const {
    data: quotaCollaboration,
    isFetching: isQuotaCollaborationFetching,
    refetch: refetchQuotaCollaboration,
  } = useQuotaCollaborationOverview();
  const syncQuotaCollaboration = useSyncQuotaCollaboration();
  const visibleTiers = getVisibleTiers(quota);
  const availableCredits = (quota?.resetCredits?.credits ?? []).filter(
    isAvailableCredit,
  );
  const availableCount = Math.max(quota?.resetCredits?.availableCount ?? 0, 0);
  const missingExpiryCount = Math.max(
    availableCount - availableCredits.length,
    0,
  );
  const problem = renderQuotaProblem(quota, isFetching, () => void refetch());

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-6">
      <section
        className={`overflow-hidden rounded-lg border ${USAGE_PAGE_COLORS.shell}`}
      >
        <div
          className={`flex flex-col gap-4 px-4 py-3 lg:flex-row lg:items-center lg:justify-between ${USAGE_PAGE_COLORS.header}`}
        >
          <div className="min-w-0 space-y-2">
            <div className="flex items-center gap-2 text-base font-semibold">
              <Gauge className="h-4 w-4 text-sky-600 dark:text-blue-300" />
              Codex usage and reset credits
            </div>
            <p className="max-w-4xl text-xs leading-5 text-muted-foreground dark:text-slate-400">
              This page shows rate windows and stored reset credits for the
              current Codex account. Read-only: it does not redeem resets,
              modify the account, or write to Codex configuration.
            </p>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 ${USAGE_PAGE_COLORS.chip}`}
              >
                Codex toolbar
                <ArrowRight className="h-3 w-3" />
                chart button
              </span>
              <span
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 ${USAGE_PAGE_COLORS.chip}`}
              >
                Read-only query
              </span>
              <span
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 ${USAGE_PAGE_COLORS.chip}`}
              >
                Auto-refresh every 5 minutes
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-sm">
            <div
              className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 ${USAGE_PAGE_COLORS.chip}`}
            >
              <Clock className="h-4 w-4" />
              {formatCheckedAt(quota?.queriedAt)}
            </div>
            <Button
              type="button"
              onClick={() => {
                void refetch();
                void refetchTodayUsage();
                void refetchModelStats();
                void refetchQuotaCollaboration();
              }}
              disabled={isFetching}
              size="sm"
              className="gap-2 bg-sky-600 hover:bg-sky-500 dark:bg-blue-600 dark:hover:bg-blue-500"
            >
              <RefreshCw
                className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
              />
              {t("common.refresh", { defaultValue: "Refresh" })}
            </Button>
          </div>
        </div>
      </section>

      <UsageGuidePanel />

      {problem}

      {quota?.success && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {visibleTiers.map((tier) => (
              <UsageWindowCard key={tier.name} tier={tier} />
            ))}
            {visibleTiers.length === 0 && (
              <section
                className={`rounded-lg border p-5 text-sm text-muted-foreground lg:col-span-2 ${USAGE_PAGE_COLORS.card}`}
              >
                Codex returned no 5-hour or weekly usage windows.
              </section>
            )}
          </div>

          <LocalUsageAnalytics
            summary={todayUsage}
            modelStats={modelStats}
            isLoading={isTodayUsageFetching}
          />

          <QuotaCollaborationPanel
            overview={quotaCollaboration}
            isLoading={isQuotaCollaborationFetching}
            isSyncing={syncQuotaCollaboration.isPending}
            onSync={() => {
              void syncQuotaCollaboration.mutateAsync().catch((error) => {
                toast.error(
                  `Failed to sync device reports: ${error instanceof Error ? error.message : "Check your WebDAV or S3 configuration."}`,
                );
              });
            }}
          />

          <section
            className={`rounded-lg border p-5 ${USAGE_PAGE_COLORS.card}`}
          >
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <RotateCcw className="h-4 w-4 text-sky-600 dark:text-sky-400" />
                <h3 className="text-base font-semibold text-foreground">
                  Stored reset credits
                </h3>
              </div>
              <div
                className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${USAGE_PAGE_COLORS.resetSummary}`}
              >
                <TimerReset className="h-4 w-4" />
                {availableCount} available
              </div>
            </div>

            {availableCount > 0 ? (
              <div className="flex flex-col gap-2">
                {availableCredits.map((credit, index) => (
                  <ResetCreditRow
                    key={`${credit.expiresAt ?? "missing"}-${index}`}
                    credit={credit}
                    index={index}
                  />
                ))}
                {missingExpiryCount > 0 && (
                  <div
                    className={`rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground ${USAGE_PAGE_COLORS.inset}`}
                  >
                    {missingExpiryCount} available reset credits have no
                    displayable expiry details.
                  </div>
                )}
              </div>
            ) : (
              <div
                className={`flex items-center gap-2 rounded-lg border px-3 py-3 text-sm text-muted-foreground ${USAGE_PAGE_COLORS.inset}`}
              >
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                There are no stored reset credits.
              </div>
            )}

            {quota.resetCreditsError && (
              <div
                className={`mt-3 rounded-lg border px-3 py-2 text-sm ${USAGE_PAGE_COLORS.warning}`}
              >
                Reset credit details are incomplete: {quota.resetCreditsError}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
};
