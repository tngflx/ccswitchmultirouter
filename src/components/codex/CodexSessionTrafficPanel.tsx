import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronDown, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  CodexSubagentParentUsageGroup,
  CodexSubagentUsageAgent,
  CodexSubagentUsageStats,
  SessionCollectionStatus,
} from "@/types/usage";

type Props = {
  stats?: CodexSubagentUsageStats;
  isLoading: boolean;
  error: unknown;
  rangeLabel: string;
  isSyncing: boolean;
  onSync: () => void;
  syncMessage?: string | null;
  collectionStatus?: SessionCollectionStatus;
  collectionStatusError?: unknown;
};
type SortKey = "tokens" | "model";
type Filter = "all" | "priced" | "unpriced" | "missing";
type Detail =
  | { kind: "model"; row: CodexSubagentUsageStats["modelStats"][number] }
  | { kind: "agent"; agent: CodexSubagentUsageAgent }
  | {
      kind: "task";
      group: CodexSubagentParentUsageGroup;
      children: CodexSubagentUsageAgent[];
    };

const tokens = (value: number) => value.toLocaleString();
const costValue = (value: string) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const cost = (t: TFunction, value: string) => {
  const n = costValue(value);
  return n === null
    ? t("codexSessionTraffic.unpriced", {
        defaultValue: "Unpriced / needs verification",
      })
    : `~ $${n.toFixed(n < 0.01 ? 6 : 4)}`;
};
const observed = (row: CodexSubagentUsageStats["modelStats"][number]) =>
  row.observedUsageAgents ?? row.agentCount;
const collectorTime = (t: TFunction, value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toLocaleString(undefined, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : t("codexSessionTraffic.notRecorded", { defaultValue: "Not recorded" });
const collectorLabel = (
  t: TFunction,
  phase: SessionCollectionStatus["phase"],
) =>
  ({
    idle: t("codexSessionTraffic.collectorIdle", {
      defaultValue: "Collector idle",
    }),
    running: t("codexSessionTraffic.collectorRunning", {
      defaultValue: "Collector running",
    }),
    degraded: t("codexSessionTraffic.collectorDegraded", {
      defaultValue: "Collector degraded",
    }),
    not_started: t("codexSessionTraffic.collectorNotStarted", {
      defaultValue: "Collector not started",
    }),
  })[phase];

/** Local bounded session evidence; never add it to proxy request traffic. */
export function CodexSessionTrafficPanel({
  stats,
  isLoading,
  error,
  rangeLabel,
  isSyncing,
  onSync,
  syncMessage,
  collectionStatus,
  collectionStatusError,
}: Props) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<SortKey>("tokens");
  const [filter, setFilter] = useState<Filter>("all");
  const [modelQuery, setModelQuery] = useState("");
  const [view, setView] = useState("models");
  const [detail, setDetail] = useState<Detail | null>(null);
  const rows = stats?.modelStats ?? [];
  const agents = stats?.agents ?? [];
  const overview = useMemo(
    () => ({
      requestCount: rows.reduce((sum, row) => sum + row.requestCount, 0),
      tokenCount: rows.reduce((sum, row) => sum + row.totalTokens, 0),
      priced: rows.reduce(
        (sum, row) => sum + (costValue(row.totalCost) ?? 0),
        0,
      ),
      incompletePrice: rows.some(
        (row) => observed(row) > 0 && costValue(row.totalCost) === null,
      ),
    }),
    [rows],
  );
  const visibleRows = useMemo(
    () =>
      rows
        .filter((row) => {
          if (
            !row.model
              .toLocaleLowerCase()
              .includes(modelQuery.trim().toLocaleLowerCase())
          )
            return false;
          if (filter === "priced") return costValue(row.totalCost) !== null;
          if (filter === "unpriced")
            return observed(row) > 0 && costValue(row.totalCost) === null;
          if (filter === "missing") return (row.missingUsageAgents ?? 0) > 0;
          return true;
        })
        .sort((a, b) =>
          sort === "model"
            ? a.model.localeCompare(b.model)
            : b.totalTokens - a.totalTokens || a.model.localeCompare(b.model),
        ),
    [filter, modelQuery, rows, sort],
  );
  const groups = stats?.parentGroups ?? [];
  const parentIds = new Set(groups.map((group) => group.parentSessionId));
  const ungrouped = agents.filter(
    (agent) => !agent.parentThreadId || !parentIds.has(agent.parentThreadId),
  );
  const observedCount =
    stats?.observedUsageAgents ??
    rows.reduce((sum, row) => sum + observed(row), 0);
  const missingCount =
    stats?.missingUsageAgents ??
    rows.reduce((sum, row) => sum + (row.missingUsageAgents ?? 0), 0);
  const hasSnapshot = stats !== undefined;
  const summaryState = isLoading
    ? "loading"
    : !hasSnapshot
      ? "absent"
      : observedCount === 0 && missingCount > 0
        ? "missing"
        : "ready";
  return (
    <section className="rounded-lg border border-border bg-card p-4 text-foreground shadow-sm dark:border-slate-700">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">
            {t("codexSessionTraffic.title", {
              defaultValue: "{{range}} sub-agent session traffic",
              range: rangeLabel,
            })}
          </h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            <Trans
              t={t}
              i18nKey="codexSessionTraffic.description"
              defaults="Based only on the local Codex session index and synchronized <code>codex_session</code> usage; request and session totals are independent and must not be added together."
              components={{ code: <code /> }}
            />
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={onSync}
          disabled={isSyncing}
          className="gap-2"
        >
          <RefreshCw className={`h-4 w-4 ${isSyncing ? "animate-spin" : ""}`} />
          {t("codexSessionTraffic.sync", {
            defaultValue: "Sync session usage now",
          })}
        </Button>
      </div>
      {syncMessage ? (
        <div className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {syncMessage}
        </div>
      ) : null}
      <CollectorStatus
        status={collectionStatus}
        error={collectionStatusError}
      />
      {error ? (
        <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {t("codexSessionTraffic.readFailed", {
            defaultValue: "Failed to read sub-agent usage: {{error}}",
            error: error instanceof Error ? error.message : String(error),
          })}
        </div>
      ) : null}
      {stats?.skippedReason ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {t("codexSessionTraffic.indexSkipped", {
            defaultValue: "Session usage index skipped: {{reason}}",
            reason: stats.skippedReason,
          })}
        </div>
      ) : null}
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <Summary
          label={t("codexSessionTraffic.observedTokens", {
            defaultValue: "Observed subtask tokens",
          })}
          value={
            summaryState === "ready"
              ? tokens(overview.tokenCount)
              : summaryState === "loading"
                ? t("codexSessionTraffic.loading", { defaultValue: "Loading" })
                : "—"
          }
          detail={
            summaryState === "missing"
              ? t("codexSessionTraffic.missingTokens", {
                  defaultValue:
                    "Only uncollected sessions; not counted as 0 tokens",
                })
              : summaryState === "absent"
                ? t("codexSessionTraffic.noSnapshot", {
                    defaultValue: "No collected snapshot yet",
                  })
                : t("codexSessionTraffic.tokensScope", {
                    defaultValue:
                      "Only synchronized subtask usage; not the parent/subtask count",
                  })
          }
        />
        <Summary
          label={t("codexSessionTraffic.observedRequests", {
            defaultValue: "Observed requests",
          })}
          value={
            summaryState === "ready"
              ? tokens(overview.requestCount)
              : summaryState === "loading"
                ? t("codexSessionTraffic.loading", { defaultValue: "Loading" })
                : "—"
          }
          detail={t("codexSessionTraffic.recordCounts", {
            defaultValue:
              "{{observed}} usage records; {{missing}} uncollected (not counted as 0)",
            observed: observedCount,
            missing: missingCount,
          })}
        />
        <Summary
          label={t("codexSessionTraffic.knownEstimate", {
            defaultValue: "Known price-table estimate",
          })}
          value={
            summaryState === "ready"
              ? overview.priced
                ? cost(t, String(overview.priced))
                : t("codexSessionTraffic.unpriced", {
                    defaultValue: "Unpriced / needs verification",
                  })
              : summaryState === "loading"
                ? t("codexSessionTraffic.loading", { defaultValue: "Loading" })
                : "—"
          }
          detail={
            summaryState === "missing"
              ? t("codexSessionTraffic.missingCost", {
                  defaultValue:
                    "Only uncollected sessions; this does not imply $0",
                })
              : summaryState === "absent"
                ? t("codexSessionTraffic.noSnapshot", {
                    defaultValue: "No collected snapshot yet",
                  })
                : overview.incompletePrice
                  ? t("codexSessionTraffic.partialPrice", {
                      defaultValue:
                        "Partially priced; some observed usage is still unpriced",
                    })
                  : t("codexSessionTraffic.estimateScope", {
                      defaultValue:
                        "Local price-table estimate; not an upstream bill",
                    })
          }
        />
      </div>
      {stats?.unknownRangeAgents ? (
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
          {t("codexSessionTraffic.unknownRange", {
            defaultValue:
              "{{total}} sessions have an unknown range and are excluded; they are not uncollected usage.",
            total: stats.unknownRangeAgents,
          })}
        </p>
      ) : null}
      {stats?.historyTruncated ? (
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
          {t("codexSessionTraffic.truncated", {
            defaultValue:
              "The local session index is truncated; statistics cover only the current database snapshot.",
          })}
        </p>
      ) : null}
      <Tabs value={view} onValueChange={setView} className="mt-4">
        <TabsList className="w-full justify-start sm:w-auto">
          <TabsTrigger value="models" className="min-w-0">
            {t("codexSessionTraffic.byModel", { defaultValue: "By model" })}
          </TabsTrigger>
          <TabsTrigger value="tasks" className="min-w-0">
            {t("codexSessionTraffic.byTask", { defaultValue: "By task" })}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="models" className="mt-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t("codexSessionTraffic.filterScope", {
                defaultValue:
                  "Model statistics include only observed subtasks; the overview is not affected by these filters.",
              })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Input
                aria-label={t("codexSessionTraffic.search", {
                  defaultValue: "Search models",
                })}
                value={modelQuery}
                onChange={(event) => setModelQuery(event.target.value)}
                className="h-8 w-[132px] text-xs"
                placeholder={t("codexSessionTraffic.search", {
                  defaultValue: "Search models",
                })}
              />
              <Select
                value={filter}
                onValueChange={(value) => setFilter(value as Filter)}
              >
                <SelectTrigger
                  aria-label={t("codexSessionTraffic.filter", {
                    defaultValue: "Filter models",
                  })}
                  className="h-8 w-[132px] text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t("codexSessionTraffic.allModels", {
                      defaultValue: "All models",
                    })}
                  </SelectItem>
                  <SelectItem value="priced">
                    {t("codexSessionTraffic.pricedModels", {
                      defaultValue: "Has an estimated price",
                    })}
                  </SelectItem>
                  <SelectItem value="unpriced">
                    {t("codexSessionTraffic.unpricedModels", {
                      defaultValue: "Unpriced only",
                    })}
                  </SelectItem>
                  <SelectItem value="missing">
                    {t("codexSessionTraffic.missingModels", {
                      defaultValue: "Includes uncollected sessions",
                    })}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="h-8 text-xs"
                aria-label={t("codexSessionTraffic.sortModel", {
                  defaultValue: "Sort by model name",
                })}
                aria-pressed={sort === "model"}
                variant={sort === "model" ? "secondary" : "outline"}
                onClick={() => setSort("model")}
              >
                {t("codexSessionTraffic.modelName", {
                  defaultValue: "Model name",
                })}
              </Button>
              <Button
                size="sm"
                className="h-8 text-xs"
                aria-label={t("codexSessionTraffic.sortTokens", {
                  defaultValue: "Sort by tokens",
                })}
                aria-pressed={sort === "tokens"}
                variant={sort === "tokens" ? "secondary" : "outline"}
                onClick={() => setSort("tokens")}
              >
                {t("codexSessionTraffic.tokens", { defaultValue: "Tokens" })}
              </Button>
            </div>
          </div>
          <ModelRows
            rows={visibleRows}
            isLoading={isLoading}
            onDetail={(row) => setDetail({ kind: "model", row })}
          />
        </TabsContent>
        <TabsContent value="tasks" className="mt-3">
          <TaskRows
            groups={groups}
            agents={agents}
            ungrouped={ungrouped}
            isLoading={isLoading}
            hasSnapshot={hasSnapshot}
            onDetail={(group, children) =>
              setDetail({ kind: "task", group, children })
            }
            onAgentDetail={(agent) => setDetail({ kind: "agent", agent })}
          />
        </TabsContent>
      </Tabs>
      <div className="mt-3 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs leading-6 text-muted-foreground">
        {t("codexSessionTraffic.accountingCaveat", {
          defaultValue:
            "Request latency is not collected reliably for sessions, so it is not shown as 0 ms. Costs use the local price table; zero values are marked for verification and are not upstream billing. Source: CCSM local session usage ledger.",
        })}
      </div>
      <DetailSheet
        detail={detail}
        onOpenChange={(open) => !open && setDetail(null)}
      />
    </section>
  );
}

function CollectorStatus({
  status,
  error,
}: {
  status?: SessionCollectionStatus;
  error: unknown;
}) {
  const { t } = useTranslation();
  if (error)
    return (
      <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        {t("codexSessionTraffic.collectorUnavailable", {
          defaultValue: "Collector status unavailable: {{error}}",
          error: error instanceof Error ? error.message : String(error),
        })}
      </div>
    );
  if (!status) return null;
  const notStarted = status.phase === "not_started";
  const alert =
    notStarted || status.phase === "degraded" || status.deferred > 0;
  return (
    <Collapsible
      className={`mt-3 rounded-md border px-3 py-2 text-xs ${alert ? "border-amber-200 bg-amber-50 text-amber-900" : "border-border bg-muted/20 text-muted-foreground"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <strong>{collectorLabel(t, status.phase)}</strong>
          {notStarted
            ? t("codexSessionTraffic.collectorWaiting", {
                defaultValue:
                  " · No successful collection yet; sync now or wait for the background collector to start.",
              })
            : t("codexSessionTraffic.collectorSummary", {
                defaultValue:
                  " · Last success {{last}} · {{imported}} · deferred {{deferred}} · errors {{errors}}",
                last: collectorTime(t, status.lastSuccessAt),
                imported: status.imported
                  ? t("codexSessionTraffic.collectorAdded", {
                      defaultValue: "added this run {{total}}",
                      total: status.imported,
                    })
                  : t("codexSessionTraffic.collectorNone", {
                      defaultValue: "none added this run",
                    }),
                deferred: status.deferred,
                errors: status.errorsCount,
              })}
        </span>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-1 text-xs">
            {t("codexSessionTraffic.collectorDiagnostics", {
              defaultValue: "Collection diagnostics",
            })}
            <ChevronDown className="h-3 w-3" />
          </Button>
        </CollapsibleTrigger>
      </div>
      {status.lastErrorSummary ? (
        <div className="mt-1">
          {t("codexSessionTraffic.errorSummary", {
            defaultValue: "Error summary: {{error}}",
            error: status.lastErrorSummary,
          })}
        </div>
      ) : null}
      <CollapsibleContent className="mt-2 border-t border-current/15 pt-2 leading-5">
        {t("codexSessionTraffic.collectorTimes", {
          defaultValue: "Started {{started}}; completed {{completed}}.",
          started: collectorTime(t, status.lastStartedAt),
          completed: collectorTime(t, status.lastCompletedAt),
        })}
        {status.nextRunAt
          ? t("codexSessionTraffic.collectorNext", {
              defaultValue: "Next around {{time}}",
              time: collectorTime(t, status.nextRunAt),
            })
          : t("codexSessionTraffic.collectorNextUnknown", {
              defaultValue: "Next run time not recorded",
            })}
        {t("codexSessionTraffic.collectorInterval", {
          defaultValue: "; interval {{seconds}} seconds.",
          seconds: status.intervalSecs,
        })}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ModelRows({
  rows,
  isLoading,
  onDetail,
}: {
  rows: CodexSubagentUsageStats["modelStats"];
  isLoading: boolean;
  onDetail: (row: CodexSubagentUsageStats["modelStats"][number]) => void;
}) {
  const { t } = useTranslation();
  if (isLoading)
    return (
      <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
        {t("codexSessionTraffic.readingModels", {
          defaultValue: "Reading session statistics for this period…",
        })}
      </div>
    );
  if (!rows.length)
    return (
      <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
        {t("codexSessionTraffic.noModelUsage", {
          defaultValue:
            "No collected sub-agent usage for this period; uncollected sessions are not shown as $0.",
        })}
      </div>
    );
  const max = Math.max(...rows.map((row) => row.totalTokens), 1);
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <div className="min-w-[720px] grid grid-cols-[1.35fr_.55fr_.65fr_.8fr_.8fr_.8fr_.8fr] gap-2 bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground">
        <span>{t("codexSessionTraffic.model", { defaultValue: "Model" })}</span>
        <span className="text-right">
          {t("codexSessionTraffic.sessions", { defaultValue: "Sessions" })}
        </span>
        <span className="text-right">
          {t("codexSessionTraffic.requests", { defaultValue: "Requests" })}
        </span>
        <span className="text-right">
          {t("codexSessionTraffic.input", { defaultValue: "Uncached input" })}
        </span>
        <span className="text-right">
          {t("codexSessionTraffic.cache", { defaultValue: "Cache reads" })}
        </span>
        <span className="text-right">
          {t("codexSessionTraffic.output", { defaultValue: "Output tokens" })}
        </span>
        <span className="text-right">
          {t("codexSessionTraffic.estimate", { defaultValue: "Estimate" })}
        </span>
      </div>
      <div data-testid="model-rows">
        {rows.map((row) => {
          const seen = observed(row);
          const missing = row.missingUsageAgents ?? 0;
          return (
            <button
              key={row.model}
              type="button"
              className="min-w-[720px] grid w-full grid-cols-[1.35fr_.55fr_.65fr_.8fr_.8fr_.8fr_.8fr] gap-2 border-t border-border px-3 py-2 text-left text-xs hover:bg-muted/50"
              onClick={() => onDetail(row)}
            >
              <span className="min-w-0">
                <span className="block truncate font-mono">{row.model}</span>
                <span className="mt-1 block h-1.5 overflow-hidden rounded bg-muted">
                  <span
                    className="block h-full bg-slate-500"
                    style={{ width: `${(row.totalTokens / max) * 100}%` }}
                  />
                </span>
              </span>
              <span className="text-right tabular-nums">
                {seen + missing}
                {missing ? (
                  <em className="ml-1 not-italic text-amber-700">
                    {t("codexSessionTraffic.missingCount", {
                      defaultValue: "({{total}} uncollected)",
                      total: missing,
                    })}
                  </em>
                ) : null}
              </span>
              <span className="text-right tabular-nums">
                {seen
                  ? row.requestCount
                  : t("codexSessionTraffic.uncollected", {
                      defaultValue: "Uncollected",
                    })}
              </span>
              <span className="text-right tabular-nums">
                {seen
                  ? tokens(row.inputTokens)
                  : t("codexSessionTraffic.uncollected", {
                      defaultValue: "Uncollected",
                    })}
              </span>
              <span className="text-right tabular-nums">
                {seen
                  ? tokens(row.cacheReadTokens)
                  : t("codexSessionTraffic.uncollected", {
                      defaultValue: "Uncollected",
                    })}
              </span>
              <span className="text-right tabular-nums">
                {seen
                  ? tokens(row.outputTokens)
                  : t("codexSessionTraffic.uncollected", {
                      defaultValue: "Uncollected",
                    })}
              </span>
              <span className="text-right tabular-nums">
                {seen
                  ? cost(t, row.totalCost)
                  : t("codexSessionTraffic.uncollected", {
                      defaultValue: "Uncollected",
                    })}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TaskRows({
  groups,
  agents,
  ungrouped,
  isLoading,
  hasSnapshot,
  onDetail,
  onAgentDetail,
}: {
  groups: CodexSubagentParentUsageGroup[];
  agents: CodexSubagentUsageAgent[];
  ungrouped: CodexSubagentUsageAgent[];
  isLoading: boolean;
  hasSnapshot: boolean;
  onDetail: (
    group: CodexSubagentParentUsageGroup,
    children: CodexSubagentUsageAgent[],
  ) => void;
  onAgentDetail: (agent: CodexSubagentUsageAgent) => void;
}) {
  const { t } = useTranslation();
  if (isLoading)
    return (
      <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
        {t("codexSessionTraffic.readingTasks", {
          defaultValue: "Reading task relationships for this period…",
        })}
      </div>
    );
  if (!hasSnapshot)
    return (
      <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
        {t("codexSessionTraffic.noTaskSnapshot", {
          defaultValue:
            "No collected snapshot yet; task relationships cannot be determined.",
        })}
      </div>
    );
  return (
    <div className="space-y-2">
      <p className="text-xs leading-5 text-muted-foreground">
        <Trans
          t={t}
          i18nKey="codexSessionTraffic.taskScope"
          defaults="Grouped only by the explicit <code>session_meta.parent_thread_id</code> relationship; parent models are not inferred, and ordinary forks or nested relationships are not merged into a tree."
          components={{ code: <code /> }}
        />
      </p>
      {groups.map((group) => {
        const children = agents.filter(
          (agent) => agent.parentThreadId === group.parentSessionId,
        );
        return (
          <details
            key={group.parentSessionId}
            className="rounded-lg border border-border bg-muted/10"
            open
          >
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
              <span className="font-mono">
                {t("codexSessionTraffic.parent", {
                  defaultValue: "Parent {{id}}",
                  id: group.parentSessionId,
                })}
              </span>
              <span>
                {t("codexSessionTraffic.childCounts", {
                  defaultValue:
                    "Child sessions {{total}} (collected {{observed}}; uncollected {{missing}})",
                  total: group.childSessionCount,
                  observed: group.observedUsageChildren,
                  missing: group.missingUsageChildren,
                })}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                aria-label={t("codexSessionTraffic.viewDetails", {
                  defaultValue: "View {{id}} Details",
                  id: group.parentSessionId,
                })}
                onClick={(event) => {
                  event.preventDefault();
                  onDetail(group, children);
                }}
              >
                {t("codexSessionTraffic.details", { defaultValue: "Details" })}
              </Button>
            </summary>
            <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              {group.observedUsageChildren > 0
                ? t("codexSessionTraffic.childUsage", {
                    defaultValue:
                      "Subtask usage is counted only in child sessions: requests {{requests}}; tokens {{tokens}}.",
                    requests: group.childRequestCount,
                    tokens: tokens(group.childTotalTokens),
                  })
                : t("codexSessionTraffic.missingChildUsage", {
                    defaultValue:
                      "Subtask usage is uncollected; it is not represented as 0 requests or 0 tokens.",
                  })}{" "}
              {group.parentUsageStatus === "unknown_may_overlap"
                ? t("codexSessionTraffic.parentOverlap", {
                    defaultValue:
                      "Parent sync records may include child usage; it is not counted for now.",
                  })
                : group.parentDirectUsage
                  ? t("codexSessionTraffic.parentDirect", {
                      defaultValue:
                        "Parent direct usage is recorded but is not added to child usage.",
                    })
                  : t("codexSessionTraffic.parentMissing", {
                      defaultValue: "Parent direct usage is uncollected.",
                    })}
            </div>
            {children.length ? (
              <div className="space-y-1 border-t border-border px-3 py-2">
                {children.map((child) => (
                  <div
                    key={child.sessionId}
                    className="flex flex-wrap items-center justify-between gap-2 rounded bg-background/60 px-2 py-1.5 text-xs"
                  >
                    <span className="min-w-0 break-all">
                      <strong>
                        {child.title ||
                          t("codexSessionTraffic.unnamedSubtask", {
                            defaultValue: "Unnamed subtask",
                          })}
                      </strong>{" "}
                      ·{" "}
                      {child.primaryModel ||
                        child.models[0] ||
                        t("codexSessionTraffic.unknownModel", {
                          defaultValue: "Unknown model",
                        })}{" "}
                      ·{" "}
                      <span className="tabular-nums">
                        {child.usageStatus === "observed"
                          ? t("codexSessionTraffic.agentUsage", {
                              defaultValue: "{{tokens}} Tokens · {{cost}}",
                              tokens: tokens(child.totalTokens),
                              cost: cost(t, child.totalCost),
                            })
                          : t("codexSessionTraffic.uncollected", {
                              defaultValue: "Uncollected",
                            })}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs"
                      aria-label={t("codexSessionTraffic.viewDetails", {
                        defaultValue: "View {{id}} Details",
                        id: child.sessionId,
                      })}
                      onClick={() => onAgentDetail(child)}
                    >
                      {t("codexSessionTraffic.details", {
                        defaultValue: "Details",
                      })}
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                {t("codexSessionTraffic.summaryOnly", {
                  defaultValue:
                    "The current snapshot contains only the parent-group summary and no child-session entries.",
                })}
              </div>
            )}
          </details>
        );
      })}
      {ungrouped.length ? (
        <details className="rounded-lg border border-border bg-muted/10" open>
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
            {t("codexSessionTraffic.unlinked", {
              defaultValue: "Unlinked sessions ({{total}})",
              total: ungrouped.length,
            })}
          </summary>
          <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            {ungrouped.map((agent) => (
              <div
                key={agent.sessionId}
                className="flex flex-wrap items-center justify-between gap-2 py-1"
              >
                <span>
                  <span className="font-mono">{agent.sessionId}</span> ·{" "}
                  {agent.title ||
                    t("codexSessionTraffic.unnamedSession", {
                      defaultValue: "Unnamed session",
                    })}{" "}
                  ·{" "}
                  {agent.usageStatus === "observed"
                    ? t("codexSessionTraffic.agentUsage", {
                        defaultValue: "{{tokens}} Tokens · {{cost}}",
                        tokens: tokens(agent.totalTokens),
                        cost: cost(t, agent.totalCost),
                      })
                    : t("codexSessionTraffic.uncollected", {
                        defaultValue: "Uncollected",
                      })}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs"
                  aria-label={t("codexSessionTraffic.viewDetails", {
                    defaultValue: "View {{id}} Details",
                    id: agent.sessionId,
                  })}
                  onClick={() => onAgentDetail(agent)}
                >
                  {t("codexSessionTraffic.details", {
                    defaultValue: "Details",
                  })}
                </Button>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {!groups.length && !ungrouped.length ? (
        <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
          {t("codexSessionTraffic.noTasks", {
            defaultValue: "No explicit task relationships to display.",
          })}
        </div>
      ) : null}
    </div>
  );
}

function DetailSheet({
  detail,
  onOpenChange,
}: {
  detail: Detail | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={detail !== null} onOpenChange={onOpenChange}>
      <DialogContent className="fixed left-auto right-0 top-0 h-dvh max-h-none w-full max-w-xl translate-x-0 translate-y-0 rounded-none border-l p-0 sm:w-[36rem]">
        <DialogHeader>
          <DialogTitle>
            {detail?.kind === "model"
              ? t("codexSessionTraffic.modelDetails", {
                  defaultValue: "{{model}} usage details",
                  model: detail.row.model,
                })
              : detail?.kind === "agent"
                ? t("codexSessionTraffic.agentDetails", {
                    defaultValue: "{{title}} details",
                    title:
                      detail.agent.title ||
                      t("codexSessionTraffic.subtask", {
                        defaultValue: "Subtask",
                      }),
                  })
                : detail
                  ? t("codexSessionTraffic.taskDetails", {
                      defaultValue: "Parent {{id}} task details",
                      id: detail.group.parentSessionId,
                    })
                  : t("codexSessionTraffic.usageDetails", {
                      defaultValue: "Usage details",
                    })}
          </DialogTitle>
          <DialogDescription>
            {t("codexSessionTraffic.detailScope", {
              defaultValue:
                "This page shows only current local session evidence; unknown values are never converted to zero.",
            })}
          </DialogDescription>
        </DialogHeader>
        {detail?.kind === "model" ? (
          <div className="space-y-4 overflow-y-auto p-5 text-sm">
            {observed(detail.row) ? (
              <Breakdown
                input={detail.row.inputTokens}
                cache={detail.row.cacheReadTokens}
                creation={detail.row.cacheCreationTokens}
                output={detail.row.outputTokens}
              />
            ) : (
              <p className="text-muted-foreground">
                {t("codexSessionTraffic.noEvidence", {
                  defaultValue:
                    "No usage evidence yet; uncollected data is not shown as 0 tokens or $0.",
                })}
              </p>
            )}
            <p>
              {t("codexSessionTraffic.sourceCost", {
                defaultValue: "Source: {{source}}. Cost: {{cost}}.",
                source: observed(detail.row)
                  ? t("codexSessionTraffic.observedSource", {
                      defaultValue: "Observed local session evidence",
                    })
                  : t("codexSessionTraffic.uncollected", {
                      defaultValue: "Uncollected",
                    }),
                cost: cost(t, detail.row.totalCost),
              })}
            </p>
            {(detail.row.missingUsageAgents ?? 0) > 0 ? (
              <p className="text-amber-700">
                {t("codexSessionTraffic.missingExcluded", {
                  defaultValue:
                    "{{total}} sessions are uncollected and excluded from tokens, requests, and cost.",
                  total: detail.row.missingUsageAgents,
                })}
              </p>
            ) : null}
          </div>
        ) : detail?.kind === "agent" ? (
          <div className="space-y-4 overflow-y-auto p-5 text-sm">
            {detail.agent.usageStatus === "observed" ? (
              <Breakdown
                input={detail.agent.inputTokens}
                cache={detail.agent.cacheReadTokens}
                creation={detail.agent.cacheCreationTokens}
                output={detail.agent.outputTokens}
              />
            ) : (
              <p className="text-muted-foreground">
                {t("codexSessionTraffic.noEvidence", {
                  defaultValue:
                    "No usage evidence yet; uncollected data is not shown as 0 tokens or $0.",
                })}
              </p>
            )}
            <p>
              {t("codexSessionTraffic.sourceCost", {
                defaultValue: "Source: {{source}}. Cost: {{cost}}.",
                source:
                  detail.agent.usageSource === "session_sync"
                    ? t("codexSessionTraffic.syncSource", {
                        defaultValue: "Local session sync ledger",
                      })
                    : detail.agent.usageSource === "rollout"
                      ? t("codexSessionTraffic.rolloutSource", {
                          defaultValue: "Local rollout usage evidence",
                        })
                      : t("codexSessionTraffic.uncollected", {
                          defaultValue: "Uncollected",
                        }),
                cost:
                  detail.agent.usageStatus === "observed"
                    ? cost(t, detail.agent.totalCost)
                    : t("codexSessionTraffic.unpriced", {
                        defaultValue: "Unpriced / needs verification",
                      }),
              })}
            </p>
            <p className="break-all text-muted-foreground">
              {t("codexSessionTraffic.sessionId", {
                defaultValue: "Session {{id}}",
                id: detail.agent.sessionId,
              })}
            </p>
          </div>
        ) : detail ? (
          <div className="space-y-4 overflow-y-auto p-5 text-sm">
            {detail.group.observedUsageChildren > 0 ? (
              <Breakdown
                input={detail.group.childInputTokens}
                cache={detail.group.childCacheReadTokens}
                creation={detail.group.childCacheCreationTokens}
                output={detail.group.childOutputTokens}
              />
            ) : (
              <p className="text-muted-foreground">
                {t("codexSessionTraffic.noEvidence", {
                  defaultValue:
                    "No usage evidence yet; uncollected data is not shown as 0 tokens or $0.",
                })}
              </p>
            )}
            <p>
              {t("codexSessionTraffic.source", {
                defaultValue: "Source: {{source}}.",
                source:
                  detail.children.length === 0
                    ? t("codexSessionTraffic.sourceUnavailable", {
                        defaultValue:
                          "The current snapshot has no per-child entries, so the source cannot be confirmed individually",
                      })
                    : detail.children.every(
                          (child) => child.usageSource === "session_sync",
                        )
                      ? t("codexSessionTraffic.syncSource", {
                          defaultValue: "Local session sync ledger",
                        })
                      : detail.children.every(
                            (child) => child.usageSource === "rollout",
                          )
                        ? t("codexSessionTraffic.rolloutSource", {
                            defaultValue: "Local rollout usage evidence",
                          })
                        : detail.children.some(
                              (child) => child.usageSource === "none",
                            )
                          ? t("codexSessionTraffic.incompleteSource", {
                              defaultValue:
                                "Local session evidence (including uncollected)",
                            })
                          : t("codexSessionTraffic.mixedSource", {
                              defaultValue:
                                "Local session evidence (mixed sources)",
                            }),
              })}
            </p>
            {detail.group.parentUsageStatus === "unknown_may_overlap" ? (
              <p className="text-amber-700">
                {t("codexSessionTraffic.parentOverlap", {
                  defaultValue:
                    "Parent sync records may include child usage; it is not counted for now.",
                })}
              </p>
            ) : null}
            <div>
              <h4 className="font-medium">
                {t("codexSessionTraffic.explicitChildren", {
                  defaultValue: "Explicit child sessions",
                })}
              </h4>
              {detail.children.length ? (
                detail.children.map((child) => (
                  <div
                    key={child.sessionId}
                    className="mt-2 rounded border border-border p-2"
                  >
                    <div className="font-mono text-xs">{child.sessionId}</div>
                    <div>
                      {child.title ||
                        t("codexSessionTraffic.unnamedSession", {
                          defaultValue: "Unnamed session",
                        })}{" "}
                      ·{" "}
                      {child.usageStatus === "observed"
                        ? t("codexSessionTraffic.observed", {
                            defaultValue: "Observed",
                          })
                        : t("codexSessionTraffic.uncollected", {
                            defaultValue: "Uncollected",
                          })}
                    </div>
                  </div>
                ))
              ) : (
                <p className="mt-1 text-muted-foreground">
                  {t("codexSessionTraffic.noChildEntries", {
                    defaultValue:
                      "The current DTO has no expandable child-session entries.",
                  })}
                </p>
              )}
            </div>
          </div>
        ) : null}
        <div className="border-t border-border p-3 text-right">
          <DialogClose asChild>
            <Button size="sm" variant="outline">
              {t("codexSessionTraffic.close", { defaultValue: "Close" })}
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Breakdown({
  input,
  cache,
  creation,
  output,
}: {
  input: number;
  cache: number;
  creation: number;
  output: number;
}) {
  const { t } = useTranslation();
  const total = Math.max(input + cache + creation + output, 1);
  return (
    <div>
      <div className="mb-2 flex justify-between text-xs text-muted-foreground">
        <span>
          {t("codexSessionTraffic.breakdown", {
            defaultValue: "Token breakdown",
          })}
        </span>
        <span>
          {t("codexSessionTraffic.totalTokens", {
            defaultValue: "Total {{total}}",
            total: tokens(input + cache + creation + output),
          })}
        </span>
      </div>
      <div
        className="flex h-3 overflow-hidden rounded bg-muted"
        aria-label={t("codexSessionTraffic.breakdownLabel", {
          defaultValue:
            "Token breakdown: uncached input {{input}}, cache reads {{cache}}, cache writes {{creation}}, output {{output}}",
          input,
          cache,
          creation,
          output,
        })}
      >
        <span
          className="bg-slate-500"
          style={{ width: `${(input / total) * 100}%` }}
        />
        <span
          className="bg-slate-300"
          style={{ width: `${(cache / total) * 100}%` }}
        />
        <span
          className="bg-slate-400"
          style={{ width: `${(creation / total) * 100}%` }}
        />
        <span
          className="bg-sky-500"
          style={{ width: `${(output / total) * 100}%` }}
        />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
        <span>
          {t("codexSessionTraffic.inputValue", {
            defaultValue: "Uncached input {{total}}",
            total: tokens(input),
          })}
        </span>
        <span>
          {t("codexSessionTraffic.cacheValue", {
            defaultValue: "Cache reads {{total}}",
            total: tokens(cache),
          })}
        </span>
        <span>
          {t("codexSessionTraffic.creationValue", {
            defaultValue: "Cache writes {{total}}",
            total: tokens(creation),
          })}
        </span>
        <span>
          {t("codexSessionTraffic.outputValue", {
            defaultValue: "Output {{total}}",
            total: tokens(output),
          })}
        </span>
      </div>
    </div>
  );
}
function Summary({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/10 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}
