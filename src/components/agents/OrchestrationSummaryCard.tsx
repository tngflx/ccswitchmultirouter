import { useQuery } from "@tanstack/react-query";
import { Bot, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { orchestrationApi, providersApi } from "@/lib/api";
import type { OrchestrationProfile } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface OrchestrationSummaryCardProps {
  onOpen: () => void;
}

function roleModel(
  profile: OrchestrationProfile | undefined,
  role: "orchestrator" | "worker",
): string | undefined {
  const model = profile?.[role]?.model?.trim();
  return model || undefined;
}

export function OrchestrationSummaryCard({
  onOpen,
}: OrchestrationSummaryCardProps) {
  const { t } = useTranslation();
  const settings = useQuery({
    queryKey: ["orchestration", "settings"],
    queryFn: orchestrationApi.getSettings,
  });
  const projection = useQuery({
    queryKey: ["orchestration", "projection"],
    queryFn: providersApi.inspectActiveCodexMultiRouterProjection,
    enabled: settings.data?.enabled === true,
  });

  const activeProfile = settings.data?.profiles.find(
    (profile) => profile.id === settings.data?.activeProfileId,
  );
  const enabledProfiles =
    settings.data?.profiles.filter((profile) => profile.enabled) ?? [];
  const state = settings.isLoading
    ? "loading"
    : settings.isError
      ? "error"
      : enabledProfiles.length === 0
        ? "empty"
        : projection.data?.state === "ready"
          ? "ready"
          : projection.data?.state === "pending"
            ? "pending"
            : "notRequired";

  return (
    <Card
      data-testid="orchestration-summary-card"
      className="border-emerald-500/25 bg-gradient-to-r from-emerald-500/5 via-background to-cyan-500/5"
    >
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0 pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 shrink-0 text-emerald-500" />
            <CardTitle className="text-lg">
              {t("orchestration.mainPageTitle")}
            </CardTitle>
            {state === "ready" && (
              <Badge variant="secondary">{t("orchestration.published")}</Badge>
            )}
          </div>
          <CardDescription className="mt-1">
            {t("orchestration.mainPageDescription")}
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={onOpen}>
          <Settings2 className="h-4 w-4" />
          {t("orchestration.configure")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {state === "loading" && (
          <p className="text-sm text-muted-foreground">
            {t("orchestration.loading")}
          </p>
        )}
        {state === "error" && (
          <p
            role="alert"
            className="text-sm text-amber-700 dark:text-amber-300"
          >
            {t("orchestration.mainPageLoadFailed")}
          </p>
        )}
        {state === "empty" && (
          <p className="text-sm text-muted-foreground">
            {t("orchestration.mainPageEmpty")}
          </p>
        )}
        {(state === "ready" ||
          state === "pending" ||
          state === "notRequired") && (
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {t("orchestration.activeProfileLabel")}
              </div>
              <div className="mt-1 truncate text-sm font-medium">
                {activeProfile?.displayName ??
                  enabledProfiles[0]?.displayName ??
                  t("orchestration.noActiveProfile")}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {t("orchestration.plannerLabel")}
              </div>
              <div className="mt-1 truncate text-sm font-medium">
                {roleModel(
                  activeProfile ?? enabledProfiles[0],
                  "orchestrator",
                ) ?? t("orchestration.notConfigured")}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {t("orchestration.workerLabel")}
              </div>
              <div className="mt-1 truncate text-sm font-medium">
                {roleModel(activeProfile ?? enabledProfiles[0], "worker") ??
                  t("orchestration.notConfigured")}
              </div>
            </div>
          </div>
        )}
        {state === "pending" && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {t("orchestration.mainPagePending")}
          </p>
        )}
        {state === "notRequired" && (
          <p className="text-xs text-muted-foreground">
            {t("orchestration.mainPageNotPublished")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
