import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { CodexHistoryVisibilityRepairOutcome } from "@/types/proxy";
import { RepairResultPanel } from "./CodexHistoryRepairPanel";

describe("CodexHistoryRepairPanel 分页历史说明", () => {
  it("把分页 rollout 的 Provider 原文保留显示为兼容行为而不是整体失败", () => {
    const result = {
      dryRun: true,
      targetProvider: "codex_model_router_v2",
      sourceFilter: "all",
      providerRowsToUpdate: 1,
      rolloutFirstLinesToUpdate: 0,
      paginatedRolloutProviderUpdatesSkipped: 1,
      userEventRowsToUpdate: 0,
      sessionIndexMissingToAppend: 0,
      prefixDuplicateRowsToRemove: 0,
      internalTranscriptRowsToRemove: 0,
      focusSelectedCount: 0,
      balancedRecentWindowRows: 0,
      rolloutMtimesToTouch: 0,
      stateDbPath: "C:\\tmp\\state_5.sqlite",
      liveConfigModelProvider: "codex_model_router_v2",
      backupDir: null,
    } as CodexHistoryVisibilityRepairOutcome;

    render(
      <RepairResultPanel
        result={result}
        error={null}
        sourceCounts={[]}
        providerCounts={[]}
      />,
    );

    expect(
      screen.getByText("Paginated provider payload preserved"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Paginated history does not rewrite rollout provider bytes/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /the current live provider compatibility layer takes over on restore/,
      ),
    ).toBeInTheDocument();
  });
});
