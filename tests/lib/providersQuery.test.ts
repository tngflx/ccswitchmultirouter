import { afterEach, describe, expect, it, vi } from "vitest";

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

import {
  fetchCurrentProviderId,
  fetchProvidersQueryData,
  PROVIDER_QUERY_TIMEOUT_MS,
} from "@/lib/query/queries";

function provider(id = "relay") {
  return {
    id,
    name: id,
    settingsConfig: {},
  };
}

describe("fetchProvidersQueryData", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("rejects inventory failures instead of returning an empty provider map", async () => {
    mocks.providersApi.getAll.mockRejectedValueOnce(
      new Error("projection unavailable"),
    );

    await expect(fetchProvidersQueryData("codex")).rejects.toThrow(
      "projection unavailable",
    );
  });

  it("loads provider inventory without looking up the current provider", async () => {
    mocks.providersApi.getAll.mockResolvedValueOnce({ relay: provider() });

    await expect(fetchProvidersQueryData("codex")).resolves.toEqual({
      providers: { relay: provider() },
    });
    expect(mocks.providersApi.getCurrent).not.toHaveBeenCalled();
  });

  it("rejects a provider inventory request that stalls past the timeout", async () => {
    vi.useFakeTimers();
    mocks.providersApi.getAll.mockReturnValueOnce(new Promise(() => {}));

    const result = fetchProvidersQueryData("codex");
    const expectation = expect(result).rejects.toThrow(
      `Loading codex providers timed out after ${PROVIDER_QUERY_TIMEOUT_MS}ms`,
    );
    await vi.advanceTimersByTimeAsync(PROVIDER_QUERY_TIMEOUT_MS);

    await expectation;
  });

  it("reports current-provider lookup failures as errors", async () => {
    mocks.providersApi.getCurrent.mockRejectedValueOnce(
      new Error("current provider unavailable"),
    );

    await expect(fetchCurrentProviderId("codex")).rejects.toThrow(
      "current provider unavailable",
    );
  });

  it("rejects a current-provider request that stalls past the timeout", async () => {
    vi.useFakeTimers();
    mocks.providersApi.getCurrent.mockReturnValueOnce(new Promise(() => {}));

    const result = fetchCurrentProviderId("codex");
    const expectation = expect(result).rejects.toThrow(
      `Loading codex current provider timed out after ${PROVIDER_QUERY_TIMEOUT_MS}ms`,
    );
    await vi.advanceTimersByTimeAsync(PROVIDER_QUERY_TIMEOUT_MS);

    await expectation;
  });
});
