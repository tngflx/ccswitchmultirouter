import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ProtocolLabCancelled,
  type ProtocolLabAdapter,
  useProtocolLabWorkflow,
} from "./useProtocolLabWorkflow";

type Draft = { id: string; manual?: boolean };
type Preview = { plan: "single" | "split" | "blocked" };

function createAdapter(
  overrides: Partial<
    ProtocolLabAdapter<Draft, string, Preview, string, string, string, string>
  > = {},
): ProtocolLabAdapter<Draft, string, Preview, string, string, string, string> {
  return {
    requiresProbe: (_draft, receiptIds) => receiptIds.length === 0,
    isManual: (draft) => draft.manual === true,
    preflight: vi.fn(async (_draft, onProgress) => {
      onProgress("baseline");
      return {
        outcome: "probe-outcome",
        receiptIds: ["receipt-one"],
        adaptationPreview: "adaptation-one",
      };
    }),
    prepare: vi.fn(async (): Promise<Preview> => ({ plan: "split" })),
    plan: (preview) => preview.plan,
    commit: vi.fn(async () => ({
      outcome: "commit-outcome",
      snapshot: "snapshot-one",
      projectionWarning: false,
    })),
    isDependencyChanged: (error) =>
      error instanceof Error && error.message === "dependency_changed",
    ...overrides,
  };
}

describe("useProtocolLabWorkflow", () => {
  it("commits an automatic Split plan directly with accept_auto", async () => {
    const adapter = createAdapter();
    const { result } = renderHook(() => useProtocolLabWorkflow(adapter));
    let savePromise!: Promise<string>;

    act(() => {
      savePromise = result.current.save({ id: "provider-one" });
    });
    expect(result.current.state.phase).toBe("awaiting_probe_consent");

    await act(async () => {
      await result.current.confirmProbe();
      await savePromise;
    });

    expect(adapter.commit).toHaveBeenCalledWith(
      { id: "provider-one" },
      ["receipt-one"],
      { plan: "split" },
      "accept_auto",
      { probeOutcome: "probe-outcome" },
    );
    expect(result.current.state.phase).toBe("committed");
  });

  it("re-probes once after a dependency change within the same consent", async () => {
    const commit = vi
      .fn()
      .mockRejectedValueOnce(new Error("dependency_changed"))
      .mockResolvedValueOnce({
        outcome: "commit-outcome",
        snapshot: "snapshot-two",
        projectionWarning: false,
      });
    const preflight = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: "initial-chat-evidence",
        receiptIds: ["initial-chat-receipt"],
        adaptationPreview: "chat",
      })
      .mockResolvedValueOnce({
        outcome: "retry-responses-evidence",
        receiptIds: ["retry-responses-receipt"],
        adaptationPreview: "responses",
      });
    const adapter = createAdapter({ commit, preflight });
    const { result } = renderHook(() => useProtocolLabWorkflow(adapter));
    let savePromise!: Promise<string>;

    act(() => {
      savePromise = result.current.save({ id: "provider-one" });
    });
    await act(async () => {
      await result.current.confirmProbe();
      await savePromise;
    });

    expect(adapter.preflight).toHaveBeenCalledTimes(2);
    expect(vi.mocked(adapter.preflight).mock.calls[0][2]).toEqual({
      staleRetry: false,
    });
    expect(vi.mocked(adapter.preflight).mock.calls[1][2]).toEqual({
      staleRetry: true,
    });
    expect(adapter.commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[0][4]).toEqual({
      probeOutcome: "initial-chat-evidence",
    });
    expect(commit.mock.calls[1][4]).toEqual({
      probeOutcome: "retry-responses-evidence",
    });
    expect(result.current.state.staleRetryCount).toBe(1);
    expect(result.current.state.phase).toBe("committed");
  });

  it("does not attach another operation's probe evidence to a direct restored save", async () => {
    const adapter = createAdapter({ requiresProbe: () => false });
    const { result } = renderHook(() => useProtocolLabWorkflow(adapter));
    let validationPromise!: Promise<string>;
    act(() => {
      validationPromise = result.current.validate({ id: "previous-provider" });
    });
    await act(async () => {
      await result.current.confirmProbe();
      await validationPromise;
    });
    expect(result.current.probeOutcome).toBe("probe-outcome");

    await act(async () => {
      await result.current.save({ id: "restored-provider" }, [
        "restored-current-receipt",
      ]);
    });

    expect(adapter.commit).toHaveBeenCalledWith(
      { id: "restored-provider" },
      ["restored-current-receipt"],
      { plan: "split" },
      "accept_auto",
      { probeOutcome: undefined },
    );
  });

  it("keeps projection failure as a committed warning", async () => {
    const adapter = createAdapter({
      requiresProbe: () => false,
      commit: vi.fn(async () => ({
        outcome: "commit-outcome",
        snapshot: "snapshot-warning",
        projectionWarning: true,
        projectionErrorCode: "projection_pending",
      })),
    });
    const { result } = renderHook(() => useProtocolLabWorkflow(adapter));

    await act(async () => {
      await result.current.save({ id: "provider-one" }, ["receipt-one"]);
    });

    expect(result.current.state.phase).toBe("committed_projection_warning");
    expect(result.current.state.errorCode).toBe("projection_pending");
  });

  it("keeps completed probe evidence when manual protocol selection blocks prepare", async () => {
    const adapter = createAdapter({
      prepare: vi.fn(async () => {
        throw new Error("codex_provider_set_manual_intent_required");
      }),
      errorCode: (error) =>
        error instanceof Error &&
        error.message === "codex_provider_set_manual_intent_required"
          ? "manual_intent_required"
          : undefined,
    });
    const { result } = renderHook(() => useProtocolLabWorkflow(adapter));
    let savePromise!: Promise<string>;

    act(() => {
      savePromise = result.current.save({ id: "provider-one" });
      savePromise.catch(() => undefined);
    });
    await act(async () => {
      await result.current.confirmProbe();
    });

    expect(result.current.probeOutcome).toBe("probe-outcome");
    expect(result.current.state.receiptIds).toEqual(["receipt-one"]);
    expect(result.current.state.phase).toBe("action_required");
    expect(result.current.state.errorCode).toBe("manual_intent_required");

    act(() => result.current.cancel());
    await expect(savePromise).rejects.toBeInstanceOf(ProtocolLabCancelled);
  });

  it("resets stale probe output and rejects an active operation", async () => {
    const adapter = createAdapter();
    const { result } = renderHook(() => useProtocolLabWorkflow(adapter));

    let firstValidation!: Promise<string>;
    act(() => {
      firstValidation = result.current.validate({ id: "provider-one" });
    });
    await act(async () => {
      await result.current.confirmProbe();
      await firstValidation;
    });
    expect(result.current.probeOutcome).toBe("probe-outcome");

    let pendingValidation!: Promise<string>;
    act(() => {
      pendingValidation = result.current.validate({ id: "provider-two" });
      pendingValidation.catch(() => undefined);
    });
    act(() => {
      result.current.reset({ id: "provider-three" });
    });

    await expect(pendingValidation).rejects.toBeInstanceOf(
      ProtocolLabCancelled,
    );
    expect(result.current.probeOutcome).toBeNull();
    expect(result.current.state.phase).toBe("idle");
    expect(result.current.state.draft).toEqual({ id: "provider-three" });
  });
});
