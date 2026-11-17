import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
import { providersApi } from "@/lib/api/providers";

const provider: Provider = {
  id: "source",
  name: "Source",
  settingsConfig: { modelCatalog: { models: [{ model: "kept-model" }] } },
};

describe("provider background-refresh ownership", () => {
  beforeEach(() => invokeMock.mockReset());

  it("patches only Sub-Agent policy fields and returns projection warnings", async () => {
    const result = {
      ...provider,
      projection: {
        status: "pending_retry",
        warning: {
          code: "codex_live_projection_pending_retry",
          message: "Saved; retry required",
        },
      },
    };
    invokeMock.mockResolvedValueOnce(result);
    await expect(
      providersApi.updateCodexSubagentPolicy("source", {
        subagentVersion: "v2",
        spawnAgentModels: [],
      }),
    ).resolves.toBe(result);
    expect(invokeMock).toHaveBeenCalledWith("update_codex_subagent_policy", {
      providerId: "source",
      patch: { subagentVersion: "v2", spawnAgentModels: [] },
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it.each(["profile", "high", "max"] as const)(
    "patches only the all-Sub-Agent reasoning choice %s",
    async (effort) => {
      invokeMock.mockResolvedValueOnce(provider);
      await expect(
        providersApi.updateCodexSubagentPolicy("source", {
          subagentReasoningEffort: effort,
        }),
      ).resolves.toBe(provider);
      expect(invokeMock).toHaveBeenCalledWith("update_codex_subagent_policy", {
        providerId: "source",
        patch: { subagentReasoningEffort: effort },
      });
      expect(invokeMock).toHaveBeenCalledTimes(1);
    },
  );

  it("never falls back to whole-provider writes on an older Sub-Agent backend", async () => {
    invokeMock.mockRejectedValueOnce(
      "Command update_codex_subagent_policy not found",
    );
    await expect(
      providersApi.updateCodexSubagentPolicy("source", {
        subagentVersion: "v1",
      }),
    ).rejects.toBe("Command update_codex_subagent_policy not found");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("passes the current snapshot only when a background refresh requests compare-and-set", async () => {
    invokeMock.mockResolvedValueOnce(true);
    const next = { ...provider, name: "Refreshed source" };
    await providersApi.update(next, "codex", undefined, provider);
    expect(invokeMock).toHaveBeenCalledWith("update_provider_if_unchanged", {
      provider: next,
      app: "codex",
      originalId: undefined,
      expectedProvider: provider,
    });
  });

  it("leaves the ordinary manual update IPC contract unchanged", async () => {
    invokeMock.mockResolvedValueOnce(true);
    await providersApi.update(provider, "codex");
    expect(invokeMock).toHaveBeenCalledWith("update_provider", {
      provider,
      app: "codex",
      originalId: undefined,
    });
  });

  it("fails closed when an older native build lacks the conditional command", async () => {
    invokeMock.mockRejectedValueOnce(
      "Command update_provider_if_unchanged not found",
    );
    await expect(
      providersApi.update(provider, "codex", undefined, provider),
    ).rejects.toThrow("provider_refresh_backend_update_required");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe("update_provider_if_unchanged");
  });

  it("maps Error-shaped missing guarded-command failures to the same safe sentinel", async () => {
    invokeMock.mockRejectedValueOnce(
      new Error("Command update_provider_if_unchanged not found"),
    );
    await expect(
      providersApi.update(provider, "codex", undefined, provider),
    ).rejects.toThrow("provider_refresh_backend_update_required");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("does not relabel an unrelated missing-command error", async () => {
    invokeMock.mockRejectedValueOnce("Command unrelated_command not found");
    await expect(
      providersApi.update(provider, "codex", undefined, provider),
    ).rejects.toBe("Command unrelated_command not found");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a rejected ownership conflict", async () => {
    invokeMock.mockRejectedValueOnce("provider_update_conflict");
    await expect(
      providersApi.update(provider, "codex", undefined, provider),
    ).rejects.toBe("provider_update_conflict");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
