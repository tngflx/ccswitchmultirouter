import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  providersApi: {
    getAll: vi.fn(),
    getCurrent: vi.fn(),
    getCodexEditorProviders: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({
  providersApi: mocks.providersApi,
  settingsApi: {},
  usageApi: {},
  sessionsApi: {},
}));

import { fetchProvidersQueryData } from "@/lib/query/queries";

function provider(id = "relay") {
  return {
    id,
    name: id,
    settingsConfig: {},
  };
}

describe("fetchProvidersQueryData", () => {
  it("rejects inventory failures instead of returning an empty provider map", async () => {
    mocks.providersApi.getAll.mockRejectedValueOnce(
      new Error("projection unavailable"),
    );

    await expect(fetchProvidersQueryData("codex")).rejects.toThrow(
      "projection unavailable",
    );
  });

  it("keeps provider inventory when only current-provider lookup fails", async () => {
    mocks.providersApi.getAll.mockResolvedValueOnce({ relay: provider() });
    mocks.providersApi.getCurrent.mockRejectedValueOnce(
      new Error("current provider unavailable"),
    );

    await expect(fetchProvidersQueryData("codex")).resolves.toMatchObject({
      providers: { relay: provider() },
      currentProviderId: "",
      currentProviderError: "current provider unavailable",
    });
  });
});
