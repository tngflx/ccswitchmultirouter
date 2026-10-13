import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CodexProviderEditorSnapshot,
  CodexProviderProtocolPreflightOutcome,
  CodexProviderSetCommitOutcome,
  CodexProviderSetPreview,
} from "@/lib/api/protocol-compatibility";
import type { Provider } from "@/types";

import { useCodexProviderSetSave } from "./useCodexProviderSetSave";

const protocolCompatibilityMocks = vi.hoisted(() => ({
  preflight: vi.fn(),
  prepare: vi.fn(),
  commit: vi.fn(),
  editorSnapshot: vi.fn(),
  restore: vi.fn(),
}));

const providerApiMocks = vi.hoisted(() => ({
  updateTrayMenu: vi.fn(),
}));

vi.mock("@/lib/api/protocol-compatibility", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/api/protocol-compatibility")
  >()),
  preflightCodexProviderProtocolCompatibility:
    protocolCompatibilityMocks.preflight,
  prepareCodexProviderSet: protocolCompatibilityMocks.prepare,
  commitCodexProviderSet: protocolCompatibilityMocks.commit,
  getCodexProviderEditorSnapshot: protocolCompatibilityMocks.editorSnapshot,
  restoreCodexProviderProtocolEvidence: protocolCompatibilityMocks.restore,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    providersApi: {
      ...actual.providersApi,
      updateTrayMenu: providerApiMocks.updateTrayMenu,
    },
  };
});

const provider: Provider = {
  id: "third-party-provider",
  name: "Third-party relay",
  category: "custom",
  settingsConfig: {
    auth: { OPENAI_API_KEY: "sk-test" },
    modelCatalog: { models: [{ model: "model-a" }] },
  },
  meta: { apiFormat: "openai_responses" },
};

const adaptation = {
  persistence: "single" as const,
  status: "ready" as const,
  effectiveTransport: "open_ai_responses" as const,
  models: [],
};

const restoredOutcome: CodexProviderProtocolPreflightOutcome = {
  provider,
  receiptIds: ["restored-receipt"],
  records: [],
  observations: [],
  protocolApplied: false,
  adaptationPreview: adaptation,
};

const preview: CodexProviderSetPreview = {
  digest: "prepared-digest",
  sourceProviderId: provider.id,
  responsesModels: ["model-a"],
  chatModels: [],
  plan: { kind: "single", transport: "open_ai_responses" },
};

const snapshot: CodexProviderEditorSnapshot = {
  logicalProvider: provider,
  adaptation,
};

const commitOutcome: CodexProviderSetCommitOutcome = {
  preview,
  snapshot,
  projections: [],
  status: "committed",
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useCodexProviderSetSave", () => {
  beforeEach(() => {
    protocolCompatibilityMocks.preflight.mockReset();
    protocolCompatibilityMocks.prepare.mockReset();
    protocolCompatibilityMocks.commit.mockReset();
    protocolCompatibilityMocks.editorSnapshot.mockReset();
    protocolCompatibilityMocks.restore.mockReset();
    providerApiMocks.updateTrayMenu.mockReset();
    protocolCompatibilityMocks.prepare.mockResolvedValue(preview);
    protocolCompatibilityMocks.commit.mockResolvedValue(commitOutcome);
    providerApiMocks.updateTrayMenu.mockResolvedValue(undefined);
  });

  it("restores persisted evidence before saving an automatic Provider whose UI receipt is missing", async () => {
    protocolCompatibilityMocks.restore.mockResolvedValue(restoredOutcome);
    const { result } = renderHook(() => useCodexProviderSetSave(), {
      wrapper: createWrapper(),
    });
    let savePromise!: Promise<void>;

    try {
      act(() => {
        savePromise = result.current.persistCodexProviderSet(provider);
        savePromise.catch(() => undefined);
      });

      await waitFor(() =>
        expect(protocolCompatibilityMocks.restore).toHaveBeenCalledWith(
          provider,
        ),
      );
      await act(async () => {
        await savePromise;
      });

      expect(protocolCompatibilityMocks.preflight).not.toHaveBeenCalled();
      expect(protocolCompatibilityMocks.prepare).toHaveBeenCalledWith(
        provider,
        ["restored-receipt"],
      );
      expect(protocolCompatibilityMocks.commit).toHaveBeenCalledWith(
        provider,
        ["restored-receipt"],
        "prepared-digest",
        "accept_auto",
      );
      expect(result.current.workflow.state.phase).toBe("committed");
    } finally {
      act(() => result.current.workflow.cancel());
    }
  });

  it("confirms a per-model Chat selection as manual instead of retrying automatic probing", async () => {
    const manuallySelectedProvider: Provider = {
      ...provider,
      meta: {
        apiFormat: "openai_responses",
        codexProtocolOverrides: { "model-a": "openai_chat" },
      },
    };
    const { result } = renderHook(() => useCodexProviderSetSave(), {
      wrapper: createWrapper(),
    });
    let savePromise!: Promise<void>;

    try {
      act(() => {
        savePromise = result.current.persistCodexProviderSet(
          manuallySelectedProvider,
        );
        savePromise.catch(() => undefined);
      });

      await act(async () => {
        await savePromise;
      });

      expect(protocolCompatibilityMocks.restore).not.toHaveBeenCalled();
      expect(protocolCompatibilityMocks.preflight).not.toHaveBeenCalled();
      expect(protocolCompatibilityMocks.prepare).toHaveBeenCalledWith(
        manuallySelectedProvider,
        [],
      );
      expect(protocolCompatibilityMocks.commit).toHaveBeenCalledWith(
        manuallySelectedProvider,
        [],
        "prepared-digest",
        "confirm_manual",
      );
      expect(result.current.workflow.state.phase).toBe("committed");
    } finally {
      act(() => result.current.workflow.cancel());
    }
  });

  it("saves a new automatic model with the declared protocol when unverified save is allowed", async () => {
    protocolCompatibilityMocks.restore.mockResolvedValue(null);
    const deepseekProvider: Provider = {
      ...provider,
      settingsConfig: {
        ...provider.settingsConfig,
        modelCatalog: { models: [{ model: "deepseek-v4.1-flash" }] },
      },
    };
    const { result } = renderHook(() => useCodexProviderSetSave(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.persistCodexProviderSet(deepseekProvider, [], {
        allowUnverifiedSave: true,
      });
    });

    const expectedDraft = expect.objectContaining({
      id: deepseekProvider.id,
      meta: expect.objectContaining({
        apiFormat: "openai_responses",
        codexProtocolMode: "manual",
      }),
    });
    expect(protocolCompatibilityMocks.restore).toHaveBeenCalledWith(
      deepseekProvider,
    );
    expect(protocolCompatibilityMocks.preflight).not.toHaveBeenCalled();
    expect(protocolCompatibilityMocks.prepare).toHaveBeenCalledWith(
      expectedDraft,
      [],
    );
    expect(protocolCompatibilityMocks.commit).toHaveBeenCalledWith(
      expectedDraft,
      [],
      "prepared-digest",
      "confirm_manual",
    );
    expect(result.current.workflow.state.phase).toBe("committed");
  });

  it("saves an OpenRouter DeepSeek Flash model without forcing a paid probe", async () => {
    protocolCompatibilityMocks.restore.mockResolvedValue(null);
    const openRouterProvider: Provider = {
      ...provider,
      id: "openrouter",
      name: "OpenRouter",
      settingsConfig: {
        auth: { OPENAI_API_KEY: "sk-or-test" },
        config:
          'model_provider = "openrouter"\nmodel = "deepseek/deepseek-v4.1-flash"\n[model_providers.openrouter]\nname = "OpenRouter"\nbase_url = "https://openrouter.ai/api/v1"\nwire_api = "responses"\n',
        modelCatalog: {
          models: [{ model: "deepseek/deepseek-v4.1-flash" }],
        },
      },
    };
    const { result } = renderHook(() => useCodexProviderSetSave(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.persistCodexProviderSet(openRouterProvider, [], {
        allowUnverifiedSave: true,
      });
    });

    expect(protocolCompatibilityMocks.preflight).not.toHaveBeenCalled();
    expect(protocolCompatibilityMocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "openrouter",
        settingsConfig: expect.objectContaining({
          config: expect.stringContaining("https://openrouter.ai/api/v1"),
        }),
        meta: expect.objectContaining({
          apiFormat: "openai_responses",
          codexProtocolMode: "manual",
        }),
      }),
      [],
    );
    expect(protocolCompatibilityMocks.commit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "openrouter" }),
      [],
      "prepared-digest",
      "confirm_manual",
    );
    expect(result.current.workflow.state.phase).toBe("committed");
  });

  it("saves an OpenRouter MiMo model without forcing a paid probe", async () => {
    protocolCompatibilityMocks.restore.mockResolvedValue(null);
    const openRouterProvider: Provider = {
      ...provider,
      id: "openrouter-mimo",
      name: "OpenRouter MiMo",
      settingsConfig: {
        auth: { OPENAI_API_KEY: "sk-or-test" },
        config:
          'model_provider = "openrouter"\nmodel = "xiaomi/mimo-v2.5-pro"\n[model_providers.openrouter]\nname = "OpenRouter"\nbase_url = "https://openrouter.ai/api/v1"\nwire_api = "responses"\n',
        modelCatalog: {
          models: [{ model: "xiaomi/mimo-v2.5-pro" }],
        },
      },
    };
    const { result } = renderHook(() => useCodexProviderSetSave(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.persistCodexProviderSet(openRouterProvider, [], {
        allowUnverifiedSave: true,
      });
    });

    expect(protocolCompatibilityMocks.preflight).not.toHaveBeenCalled();
    expect(protocolCompatibilityMocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "openrouter-mimo",
        meta: expect.objectContaining({
          apiFormat: "openai_responses",
          codexProtocolMode: "manual",
          codexProtocolOverrides: {
            "xiaomi/mimo-v2.5-pro": "openai_responses",
          },
        }),
      }),
      [],
    );
    expect(result.current.workflow.state.phase).toBe("committed");
  });

  it("falls back to an unverified save when evidence restoration cannot compile the draft", async () => {
    protocolCompatibilityMocks.restore.mockRejectedValue(
      new Error("provider-specific catalog entry is invalid"),
    );
    const { result } = renderHook(() => useCodexProviderSetSave(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.persistCodexProviderSet(provider, [], {
        allowUnverifiedSave: true,
      });
    });

    expect(protocolCompatibilityMocks.preflight).not.toHaveBeenCalled();
    expect(protocolCompatibilityMocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          apiFormat: "openai_responses",
          codexProtocolMode: "manual",
        }),
      }),
      [],
    );
    expect(protocolCompatibilityMocks.commit).toHaveBeenCalledWith(
      expect.objectContaining({ id: provider.id }),
      [],
      "prepared-digest",
      "confirm_manual",
    );
  });

  it.each(["modelCatalog", "model_catalog"])(
    "saves a partial %s protocol selection without testing",
    async (catalogKey) => {
      protocolCompatibilityMocks.restore.mockResolvedValue(null);
      const mixedProvider: Provider = {
        ...provider,
        settingsConfig: {
          auth: provider.settingsConfig.auth,
          [catalogKey]: {
            models: [
              { model: "model-a" },
              { model: " MODEL-B " },
              { model: "model-c", api_format: "openai_chat" },
              { id: "model-d", wireApi: "chat" },
              { slug: "model-e", wire_api: "open_ai_chat" },
              { model: "disabled-model", enabled: false },
            ],
          },
        },
        meta: {
          apiFormat: "openai_responses",
          codexProtocolOverrides: { " MODEL-A ": "openai_chat" },
        },
      };
      const { result } = renderHook(() => useCodexProviderSetSave(), {
        wrapper: createWrapper(),
      });
      let savePromise!: Promise<void>;

      try {
        act(() => {
          savePromise = result.current.persistCodexProviderSet(
            mixedProvider,
            [],
            { allowUnverifiedSave: true },
          );
          savePromise.catch(() => undefined);
        });

        await waitFor(() =>
          expect(result.current.workflow.state.phase).toBe("committed"),
        );
        await act(async () => {
          await savePromise;
        });

        expect(protocolCompatibilityMocks.preflight).not.toHaveBeenCalled();
        expect(protocolCompatibilityMocks.commit).toHaveBeenCalledWith(
          expect.objectContaining({
            meta: expect.objectContaining({
              apiFormat: "openai_responses",
              codexProtocolMode: "manual",
              codexProtocolOverrides: {
                "model-a": "openai_chat",
                "model-b": "openai_responses",
                "model-c": "openai_chat",
                "model-d": "openai_chat",
                "model-e": "openai_chat",
              },
            }),
          }),
          [],
          "prepared-digest",
          "confirm_manual",
        );
        expect(mixedProvider.meta).toEqual({
          apiFormat: "openai_responses",
          codexProtocolOverrides: { " MODEL-A ": "openai_chat" },
        });
      } finally {
        act(() => result.current.workflow.cancel());
      }
    },
  );
});
