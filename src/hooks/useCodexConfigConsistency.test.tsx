import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  CodexConfigConsistencyReport,
  CodexRuntimeRefreshPreflight,
  CodexRuntimeRefreshProgress,
  CodexRuntimeRefreshResult,
} from "@/lib/api/codexConfigConsistency";
import { codexConfigConsistencyApi } from "@/lib/api/codexConfigConsistency";
import { proxyApi } from "@/lib/api/proxy";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useCodexConfigConsistency } from "./useCodexConfigConsistency";

vi.mock("@/hooks/useTauriEvent", () => ({ useTauriEvent: vi.fn() }));
vi.mock("@/lib/api/codexConfigConsistency", () => ({
  codexConfigConsistencyApi: {
    inspect: vi.fn(),
    resolve: vi.fn(),
    inspectRuntimeRefresh: vi.fn(),
    refreshRuntimeState: vi.fn(),
  },
}));
vi.mock("@/lib/api/proxy", () => ({
  proxyApi: {
    unlockCodexModelPicker: vi.fn(),
  },
}));

const drift: CodexConfigConsistencyReport = {
  state: "external_drift",
  providerId: "router",
  expectedFingerprint: "expected",
  actualFingerprint: "actual",
  changedKeys: ["model_reasoning_effort"],
  reason: "live_config_changed",
  runtimeActivation: {
    state: "current",
    appServerStartedAt: "2026-09-01T00:00:00+08:00",
    configModifiedAt: "2026-08-31T23:59:00+08:00",
    reason: null,
  },
};

const consistent: CodexConfigConsistencyReport = {
  ...drift,
  state: "consistent",
  changedKeys: [],
  reason: null,
};

const healthyPreflight: CodexRuntimeRefreshPreflight = {
  supported: true,
  canRefresh: true,
  snapshotToken: "healthy-snapshot",
  desktopProcessCount: 1,
  appServerProcessCount: 1,
  processCount: 2,
  launchTarget: null,
  warning: null,
  paginatedHistory: {
    affectedRolloutCount: 0,
    duplicateOrdinalCount: 0,
    affectedBytes: 0,
    blockedRolloutCount: 0,
    blockedReason: null,
  },
};

const repairablePreflight: CodexRuntimeRefreshPreflight = {
  ...healthyPreflight,
  paginatedHistory: {
    ...healthyPreflight.paginatedHistory,
    affectedRolloutCount: 1,
    duplicateOrdinalCount: 1,
  },
};

function enableFakePollTimers() {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
}

describe("useCodexConfigConsistency", () => {
  it("deduplicates the startup event and fallback query by actual fingerprint", async () => {
    vi.mocked(codexConfigConsistencyApi.inspect).mockResolvedValue(drift);
    let onEvent: ((payload: CodexConfigConsistencyReport) => void) | undefined;
    vi.mocked(useTauriEvent).mockImplementation((name, handler) => {
      if (name === "codex-config-consistency") {
        onEvent = handler as (payload: CodexConfigConsistencyReport) => void;
      }
    });

    const { result } = renderHook(() => useCodexConfigConsistency());
    await waitFor(() => expect(result.current.report).toEqual(drift));
    onEvent?.(drift);

    expect(result.current.report).toEqual(drift);
    expect(codexConfigConsistencyApi.inspect).toHaveBeenCalledOnce();
  });

  it("surfaces a runtime-only restart requirement even when disk config is consistent", async () => {
    const runtimeStale: CodexConfigConsistencyReport = {
      ...drift,
      state: "consistent",
      changedKeys: [],
      reason: null,
      runtimeActivation: {
        state: "restart_required",
        appServerStartedAt: "2026-08-31T21:48:34+08:00",
        configModifiedAt: "2026-08-31T22:38:53+08:00",
        reason: "app_server_started_before_managed_config",
      },
    };
    vi.mocked(codexConfigConsistencyApi.inspect).mockResolvedValue(
      runtimeStale,
    );

    const { result } = renderHook(() => useCodexConfigConsistency());

    await waitFor(() => expect(result.current.report).toEqual(runtimeStale));
  });

  it("dismisses immediately when deferring fails to persist acknowledgement", async () => {
    vi.mocked(codexConfigConsistencyApi.inspect).mockResolvedValue(drift);
    vi.mocked(codexConfigConsistencyApi.resolve).mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    const { result } = renderHook(() => useCodexConfigConsistency());
    await waitFor(() => expect(result.current.report).toEqual(drift));

    await act(async () => result.current.resolve("later"));

    expect(codexConfigConsistencyApi.resolve).toHaveBeenCalledWith(
      "actual",
      "later",
    );
    expect(result.current.report).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBe(false);
  });

  it("does not fall through into a second resolve when defer returns stale evidence", async () => {
    vi.mocked(codexConfigConsistencyApi.inspect).mockResolvedValue(drift);
    vi.mocked(codexConfigConsistencyApi.resolve).mockResolvedValueOnce(drift);

    const { result } = renderHook(() => useCodexConfigConsistency());
    await waitFor(() => expect(result.current.report).toEqual(drift));

    await act(async () => result.current.resolve("later"));

    expect(codexConfigConsistencyApi.resolve).toHaveBeenCalledTimes(1);
    expect(result.current.report).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBe(false);
  });

  it("dismisses runtime attention even when no fingerprint is available", async () => {
    const runtimeWithoutFingerprint: CodexConfigConsistencyReport = {
      ...drift,
      state: "consistent",
      actualFingerprint: null,
      changedKeys: [],
      reason: null,
      runtimeActivation: {
        ...drift.runtimeActivation,
        state: "restart_required",
      },
    };
    vi.mocked(codexConfigConsistencyApi.inspect).mockResolvedValue(
      runtimeWithoutFingerprint,
    );

    const { result } = renderHook(() => useCodexConfigConsistency());
    await waitFor(() =>
      expect(result.current.report).toEqual(runtimeWithoutFingerprint),
    );

    await act(async () => result.current.resolve("later"));

    expect(codexConfigConsistencyApi.resolve).not.toHaveBeenCalled();
    expect(result.current.report).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("does not reopen dismissed runtime attention when the same event is replayed", async () => {
    vi.mocked(codexConfigConsistencyApi.inspect).mockResolvedValue(drift);
    let onEvent: ((payload: CodexConfigConsistencyReport) => void) | undefined;
    vi.mocked(useTauriEvent).mockImplementation((name, handler) => {
      if (name === "codex-config-consistency") {
        onEvent = handler as (payload: CodexConfigConsistencyReport) => void;
      }
    });

    const { result } = renderHook(() => useCodexConfigConsistency());
    await waitFor(() => expect(result.current.report).toEqual(drift));
    await act(async () => result.current.resolve("later"));

    onEvent?.(drift);
    expect(result.current.report).toBeNull();
  });

  it("proactively opens the repair status when Codex history projection damage is detected", async () => {
    const consistent: CodexConfigConsistencyReport = {
      ...drift,
      state: "consistent",
      changedKeys: [],
      reason: null,
    };
    vi.mocked(codexConfigConsistencyApi.inspect).mockResolvedValue(consistent);
    vi.mocked(
      codexConfigConsistencyApi.inspectRuntimeRefresh,
    ).mockResolvedValue({
      supported: true,
      canRefresh: true,
      snapshotToken: "history-damage-snapshot",
      desktopProcessCount: 1,
      appServerProcessCount: 1,
      processCount: 2,
      launchTarget: "OpenAI.Codex_2p2nqsd0c76g0!App",
      warning: null,
      paginatedHistory: {
        affectedRolloutCount: 1,
        duplicateOrdinalCount: 0,
        rotatedThreadCount: 1,
        rotatedSegmentCount: 3,
        affectedBytes: 1_400_000_000,
        blockedRolloutCount: 0,
        blockedReason: null,
      },
    });

    const { result } = renderHook(() => useCodexConfigConsistency());

    await waitFor(() => expect(result.current.refresh.phase).toBe("status"));
    expect(result.current.refresh.preflight?.paginatedHistory).toMatchObject({
      rotatedThreadCount: 1,
      rotatedSegmentCount: 3,
    });
  });

  it("keeps the status panel closed for history files that are only kept unchanged", async () => {
    const consistent: CodexConfigConsistencyReport = {
      ...drift,
      state: "consistent",
      changedKeys: [],
      reason: null,
    };
    vi.mocked(codexConfigConsistencyApi.inspect).mockResolvedValue(consistent);
    vi.mocked(
      codexConfigConsistencyApi.inspectRuntimeRefresh,
    ).mockResolvedValue({
      supported: true,
      canRefresh: true,
      snapshotToken: "skipped-history-snapshot",
      desktopProcessCount: 1,
      appServerProcessCount: 1,
      processCount: 2,
      launchTarget: "OpenAI.Codex_2p2nqsd0c76g0!App",
      warning: null,
      paginatedHistory: {
        affectedRolloutCount: 0,
        duplicateOrdinalCount: 0,
        affectedBytes: 0,
        blockedRolloutCount: 38,
        blockedReason:
          "history_base_offset_not_record_boundary: rollout_id=01a00000-0000-7000-8000-000000000002",
      },
    });

    const { result } = renderHook(() => useCodexConfigConsistency());

    await waitFor(() =>
      expect(
        codexConfigConsistencyApi.inspectRuntimeRefresh,
      ).toHaveBeenCalled(),
    );
    expect(result.current.refresh.phase).toBe("idle");
    expect(result.current.report).toBeNull();
  });

  it("keeps checking config every 30 seconds but scans unchanged history only on the fallback", async () => {
    enableFakePollTimers();
    try {
      vi.mocked(codexConfigConsistencyApi.inspect).mockResolvedValue(
        consistent,
      );
      const preflight = vi.mocked(
        codexConfigConsistencyApi.inspectRuntimeRefresh,
      );
      preflight.mockResolvedValue(healthyPreflight);

      const { result } = renderHook(() => useCodexConfigConsistency());
      await act(async () => vi.advanceTimersByTimeAsync(270_000));

      expect(codexConfigConsistencyApi.inspect).toHaveBeenCalledTimes(10);
      expect(preflight).toHaveBeenCalledOnce();
      expect(result.current.refresh.phase).toBe("idle");

      preflight.mockResolvedValue(repairablePreflight);
      await act(async () => vi.advanceTimersByTimeAsync(30_000));

      expect(preflight).toHaveBeenCalledTimes(2);
      expect(result.current.refresh.phase).toBe("status");
      expect(result.current.refresh.preflight).toEqual(repairablePreflight);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the full preflight on the next poll after runtime evidence changes", async () => {
    enableFakePollTimers();
    try {
      const inspect = vi.mocked(codexConfigConsistencyApi.inspect);
      inspect.mockResolvedValue(consistent);
      const preflight = vi.mocked(
        codexConfigConsistencyApi.inspectRuntimeRefresh,
      );
      preflight
        .mockResolvedValueOnce(healthyPreflight)
        .mockResolvedValue(repairablePreflight);

      const { result } = renderHook(() => useCodexConfigConsistency());
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(preflight).toHaveBeenCalledOnce();

      inspect.mockResolvedValue({
        ...consistent,
        runtimeActivation: {
          ...consistent.runtimeActivation,
          appServerStartedAt: "2026-09-01T00:01:00+08:00",
        },
      });
      await act(async () => vi.advanceTimersByTimeAsync(30_000));

      expect(preflight).toHaveBeenCalledTimes(2);
      expect(result.current.refresh.phase).toBe("status");
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks history promptly when attention clears even with the previous healthy evidence", async () => {
    enableFakePollTimers();
    try {
      const inspect = vi.mocked(codexConfigConsistencyApi.inspect);
      inspect.mockResolvedValue(consistent);
      const preflight = vi.mocked(
        codexConfigConsistencyApi.inspectRuntimeRefresh,
      );
      preflight.mockResolvedValue(healthyPreflight);

      const { result } = renderHook(() => useCodexConfigConsistency());
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(preflight).toHaveBeenCalledOnce();

      inspect.mockResolvedValue(drift);
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(result.current.report).toEqual(drift);
      expect(preflight).toHaveBeenCalledOnce();

      inspect.mockResolvedValue(consistent);
      preflight.mockResolvedValue(repairablePreflight);
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(preflight).toHaveBeenCalledTimes(2);
      expect(result.current.refresh.phase).toBe("status");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a failed background scan on every unchanged config poll", async () => {
    enableFakePollTimers();
    try {
      vi.mocked(codexConfigConsistencyApi.inspect).mockResolvedValue(
        consistent,
      );
      const preflight = vi.mocked(
        codexConfigConsistencyApi.inspectRuntimeRefresh,
      );
      preflight
        .mockRejectedValueOnce(new Error("history inspection unavailable"))
        .mockResolvedValue(healthyPreflight);

      const { result } = renderHook(() => useCodexConfigConsistency());
      await act(async () => vi.advanceTimersByTimeAsync(270_000));

      expect(preflight).toHaveBeenCalledOnce();
      expect(result.current.refresh.phase).toBe("idle");

      preflight.mockResolvedValue(repairablePreflight);
      await act(async () => vi.advanceTimersByTimeAsync(30_000));

      expect(preflight).toHaveBeenCalledTimes(2);
      expect(result.current.refresh.phase).toBe("status");
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires a checked preflight before refreshing and preserves progress until completion", async () => {
    const runtimeStale: CodexConfigConsistencyReport = {
      ...drift,
      state: "consistent",
      changedKeys: [],
      reason: null,
      runtimeActivation: {
        state: "restart_required",
        appServerStartedAt: "2026-08-31T21:48:34+08:00",
        configModifiedAt: "2026-08-31T22:38:53+08:00",
        reason: "app_server_started_before_managed_config",
      },
    };
    vi.mocked(codexConfigConsistencyApi.inspect).mockResolvedValue(
      runtimeStale,
    );
    vi.mocked(
      codexConfigConsistencyApi.inspectRuntimeRefresh,
    ).mockResolvedValue({
      supported: true,
      canRefresh: true,
      snapshotToken: "checked-snapshot",
      desktopProcessCount: 1,
      appServerProcessCount: 1,
      processCount: 2,
      launchTarget: "OpenAI.Codex_2p2nqsd0c76g0!App",
      warning: "active_tasks_will_be_interrupted",
      paginatedHistory: {
        affectedRolloutCount: 1,
        duplicateOrdinalCount: 3,
        affectedBytes: 1_100_000_000,
        blockedRolloutCount: 0,
        blockedReason: null,
      },
    });
    vi.mocked(codexConfigConsistencyApi.refreshRuntimeState).mockResolvedValue({
      outcome: "completed_with_warnings",
      configStatus: "ready",
      paginatedHistoryStatus: "ready",
      rendererCompatibilityStatus: "warning",
      rendererCompatibilityMessage: "old renderer path",
      forceTerminated: false,
      closedProcessCount: 2,
      repairedHistoryRolloutCount: 1,
      repairedHistoryDuplicateCount: 3,
    });
    const { result } = renderHook(() => useCodexConfigConsistency());
    await waitFor(() => expect(result.current.report).toEqual(runtimeStale));

    await act(async () => result.current.inspectRuntimeRefresh());
    expect(result.current.refresh.phase).toBe("confirm");

    await act(async () => result.current.confirmRuntimeRefresh());
    expect(codexConfigConsistencyApi.refreshRuntimeState).toHaveBeenCalledWith(
      "checked-snapshot",
    );
    expect(result.current.refresh.phase).toBe("completed");

    vi.mocked(proxyApi.unlockCodexModelPicker).mockResolvedValue({
      attemptedPorts: [9229],
      debugPort: 9229,
      targetId: "renderer",
      targetTitle: "ChatGPT",
      targetUrl: "app://-/index.html",
      modelCount: 1,
      modelNames: ["qwen3.8"],
      injected: true,
      launched: false,
      codexExecutable: "ChatGPT.exe",
      historySyncRequested: true,
      historyCatalogComplete: true,
      historyCatalogCount: 100,
      allProviderHistoryPatched: true,
      historyRefreshRequested: true,
      message: "ready",
    });
    await act(async () => result.current.retryRendererCompatibility());
    expect(result.current.refresh.result?.outcome).toBe("completed");
    expect(result.current.refresh.result?.rendererCompatibilityStatus).toBe(
      "ready",
    );
  });

  it("captures detailed progress logs and keeps heartbeats out of the log list", async () => {
    const runtimeStale: CodexConfigConsistencyReport = {
      ...drift,
      state: "consistent",
      changedKeys: [],
      reason: null,
      runtimeActivation: {
        state: "restart_required",
        appServerStartedAt: "2026-08-31T21:48:34+08:00",
        configModifiedAt: "2026-08-31T22:38:53+08:00",
        reason: "app_server_started_before_managed_config",
      },
    };
    vi.mocked(codexConfigConsistencyApi.inspect).mockResolvedValue(
      runtimeStale,
    );
    vi.mocked(
      codexConfigConsistencyApi.inspectRuntimeRefresh,
    ).mockResolvedValue({
      supported: true,
      canRefresh: true,
      snapshotToken: "progress-snapshot",
      desktopProcessCount: 1,
      appServerProcessCount: 1,
      processCount: 2,
      launchTarget: "OpenAI.Codex_2p2nqsd0c76g0!App",
      warning: null,
      paginatedHistory: {
        affectedRolloutCount: 1,
        duplicateOrdinalCount: 3,
        affectedBytes: 1_100_000_000,
        blockedRolloutCount: 0,
        blockedReason: null,
      },
    });
    vi.mocked(codexConfigConsistencyApi.refreshRuntimeState).mockReturnValue(
      new Promise(() => {}),
    );
    let onProgress:
      ((payload: CodexRuntimeRefreshProgress) => void) | undefined;
    vi.mocked(useTauriEvent).mockImplementation((name, handler) => {
      if (name === "codex-runtime-refresh-progress") {
        onProgress = handler as (payload: CodexRuntimeRefreshProgress) => void;
      }
    });

    const { result } = renderHook(() => useCodexConfigConsistency());
    await waitFor(() => expect(result.current.report).toEqual(runtimeStale));
    await act(async () => result.current.inspectRuntimeRefresh());
    await act(async () => {
      void result.current.confirmRuntimeRefresh();
    });
    expect(result.current.refresh.phase).toBe("refreshing");

    act(() => {
      onProgress?.({
        stage: "repairing_history",
        kind: "log",
        sequence: 1,
        emittedAtMs: 1_700_000_000_000,
        code: "history_file_started",
        message: "正在修复历史文件 1/2：abc",
      });
      onProgress?.({
        stage: "repairing_history",
        kind: "heartbeat",
        sequence: 2,
        emittedAtMs: 1_700_000_000_100,
      });
    });

    expect(result.current.refresh.logs).toHaveLength(1);
    expect(result.current.refresh.logs[0]?.message).toBe(
      "正在修复历史文件 1/2：abc",
    );
    expect(result.current.refresh.lastProgressAt).not.toBeNull();
  });

  it("fails a silent refresh and ignores the late backend result", async () => {
    const runtimeStale: CodexConfigConsistencyReport = {
      ...drift,
      state: "consistent",
      changedKeys: [],
      reason: null,
      runtimeActivation: {
        state: "restart_required",
        appServerStartedAt: "2026-08-31T21:48:34+08:00",
        configModifiedAt: "2026-08-31T22:38:53+08:00",
        reason: "app_server_started_before_managed_config",
      },
    };
    vi.mocked(codexConfigConsistencyApi.inspect).mockResolvedValue(
      runtimeStale,
    );
    vi.mocked(
      codexConfigConsistencyApi.inspectRuntimeRefresh,
    ).mockResolvedValue({
      supported: true,
      canRefresh: true,
      snapshotToken: "stall-snapshot",
      desktopProcessCount: 1,
      appServerProcessCount: 1,
      processCount: 2,
      launchTarget: "OpenAI.Codex_2p2nqsd0c76g0!App",
      warning: null,
      paginatedHistory: {
        affectedRolloutCount: 0,
        duplicateOrdinalCount: 0,
        affectedBytes: 0,
        blockedRolloutCount: 0,
        blockedReason: null,
      },
    });
    let resolveRefresh!: (value: CodexRuntimeRefreshResult) => void;
    vi.mocked(codexConfigConsistencyApi.refreshRuntimeState).mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    const { result } = renderHook(() => useCodexConfigConsistency());
    await waitFor(() => expect(result.current.report).toEqual(runtimeStale));
    await act(async () => result.current.inspectRuntimeRefresh());
    expect(result.current.refresh.phase).toBe("confirm");

    vi.useFakeTimers();
    try {
      await act(async () => {
        void result.current.confirmRuntimeRefresh();
      });
      expect(result.current.refresh.phase).toBe("refreshing");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      expect(result.current.refresh.phase).toBe("failed");
      expect(result.current.refresh.error).toContain("may be stalled");

      await act(async () => {
        resolveRefresh({
          outcome: "completed",
          configStatus: "ready",
          paginatedHistoryStatus: "ready",
          rendererCompatibilityStatus: "ready",
          rendererCompatibilityMessage: null,
          forceTerminated: false,
          closedProcessCount: 2,
          repairedHistoryRolloutCount: 0,
          repairedHistoryDuplicateCount: 0,
        });
        await Promise.resolve();
      });
      expect(result.current.refresh.phase).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a persistent status overview with a fresh snapshot despite the background cooldown", async () => {
    enableFakePollTimers();
    try {
      vi.mocked(codexConfigConsistencyApi.inspect).mockResolvedValue(
        consistent,
      );
      const preflight = vi.mocked(
        codexConfigConsistencyApi.inspectRuntimeRefresh,
      );
      preflight.mockResolvedValue(healthyPreflight);
      const { result } = renderHook(() => useCodexConfigConsistency());
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(preflight).toHaveBeenCalledOnce();

      preflight.mockResolvedValue({
        ...healthyPreflight,
        snapshotToken: "status-snapshot",
      });
      await act(async () => result.current.openStatusPanel());

      expect(preflight).toHaveBeenCalledTimes(2);
      expect(result.current.report).toEqual(consistent);
      expect(result.current.refresh.phase).toBe("status");
      expect(result.current.refresh.preflight?.snapshotToken).toBe(
        "status-snapshot",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
