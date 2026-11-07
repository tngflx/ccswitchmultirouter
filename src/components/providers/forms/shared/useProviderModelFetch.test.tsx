import { act, renderHook, waitFor } from "@testing-library/react";
import type { TFunction } from "i18next";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  fetchModelsForConfig,
  showFetchModelsError,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import { useProviderModelFetch } from "./useProviderModelFetch";

vi.mock("@/lib/api/model-fetch", () => ({
  fetchModelsForConfig: vi.fn(),
  showFetchModelsError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

const baseUrl = "https://models.example.invalid/v1";
const apiKey = "redacted-test-credential";
const models: FetchedModel[] = [
  { id: "public-model-a", ownedBy: "fixture-owner", contextWindow: 32768 },
  { id: "public-model-b", ownedBy: null, inputModalities: ["text", "image"] },
];
const translate = vi.fn((key: string, options?: { count?: number }) =>
  options?.count === undefined ? key : `${key}:${options.count}`,
);
const t = translate as unknown as TFunction;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const nextIdentity = {
  endpoint: "https://next-models.example.invalid/v1",
  credential: "redacted-next-credential",
};

function renderDiscovery() {
  return renderHook(
    ({ endpoint, credential }) =>
      useProviderModelFetch(endpoint, credential, t),
    { initialProps: { endpoint: baseUrl, credential: apiKey } },
  );
}

describe("useProviderModelFetch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    translate.mockImplementation((key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("preserves the complete fetched model payload and translated success count", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue(models);
    const { result } = renderHook(() =>
      useProviderModelFetch(baseUrl, apiKey, t),
    );
    act(() => result.current.handleFetchModels());
    expect(result.current.isFetchingModels).toBe(true);
    await waitFor(() => expect(result.current.isFetchingModels).toBe(false));
    expect(result.current.fetchedModels).toBe(models);
    expect(translate).toHaveBeenCalledWith("providerForm.fetchModelsSuccess", {
      count: 2,
    });
    expect(toast.success).toHaveBeenCalledWith(
      "providerForm.fetchModelsSuccess:2",
    );
  });

  it("retains the last fetched list when a later request rejects", async () => {
    const error = new Error("redacted discovery error");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(fetchModelsForConfig)
      .mockResolvedValueOnce(models)
      .mockRejectedValueOnce(error);
    const { result } = renderHook(() =>
      useProviderModelFetch(baseUrl, apiKey, t),
    );
    act(() => result.current.handleFetchModels());
    await waitFor(() => expect(result.current.isFetchingModels).toBe(false));
    act(() => result.current.handleFetchModels());
    await waitFor(() => expect(result.current.isFetchingModels).toBe(false));
    expect(result.current.fetchedModels).toBe(models);
    expect(showFetchModelsError).toHaveBeenCalledWith(error, t);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[ModelFetch] Failed");
  });

  it("replaces the previous directory after a successful empty refresh", async () => {
    vi.mocked(fetchModelsForConfig)
      .mockResolvedValueOnce(models)
      .mockResolvedValueOnce([]);
    const { result } = renderHook(() =>
      useProviderModelFetch(baseUrl, apiKey, t),
    );
    act(() => result.current.handleFetchModels());
    await waitFor(() => expect(result.current.fetchedModels).toBe(models));
    act(() => result.current.handleFetchModels());
    await waitFor(() => expect(result.current.isFetchingModels).toBe(false));
    expect(result.current.fetchedModels).toEqual([]);
    expect(toast.info).toHaveBeenCalledWith("providerForm.fetchModelsEmpty");
  });

  it("uses current endpoint and credential inputs without triggering automatic discovery", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue([]);
    const { result, rerender } = renderHook(
      ({ endpoint, credential }) =>
        useProviderModelFetch(endpoint, credential, t),
      { initialProps: { endpoint: baseUrl, credential: apiKey } },
    );
    const next = {
      endpoint: "https://next-models.example.invalid/v1",
      credential: "redacted-next-credential",
    };
    rerender(next);
    expect(fetchModelsForConfig).not.toHaveBeenCalled();
    act(() => result.current.handleFetchModels());
    await waitFor(() => expect(result.current.isFetchingModels).toBe(false));
    expect(fetchModelsForConfig).toHaveBeenCalledWith(
      next.endpoint,
      next.credential,
    );
  });

  it.each([
    { endpoint: nextIdentity.endpoint, credential: apiKey },
    { endpoint: baseUrl, credential: nextIdentity.credential },
    { endpoint: "", credential: apiKey },
    { endpoint: baseUrl, credential: "" },
  ])(
    "never exposes the previous directory on a changed identity: %j",
    async (identity) => {
      vi.mocked(fetchModelsForConfig).mockResolvedValue(models);
      const renders: FetchedModel[][] = [];
      const { result, rerender } = renderHook(
        ({ endpoint, credential }) => {
          const discovery = useProviderModelFetch(endpoint, credential, t);
          renders.push(discovery.fetchedModels);
          return discovery;
        },
        { initialProps: { endpoint: baseUrl, credential: apiKey } },
      );
      act(() => result.current.handleFetchModels());
      await waitFor(() => expect(result.current.fetchedModels).toBe(models));
      renders.length = 0;

      rerender(identity);

      expect(renders.length).toBeGreaterThan(0);
      expect(renders.every((directory) => directory.length === 0)).toBe(true);
      expect(result.current.fetchedModels).toEqual([]);
      expect(result.current.isFetchingModels).toBe(false);
      expect(fetchModelsForConfig).toHaveBeenCalledTimes(1);
    },
  );

  it("does not restore an old directory when inputs change A to B to A", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue(models);
    const { result, rerender } = renderDiscovery();
    act(() => result.current.handleFetchModels());
    await waitFor(() => expect(result.current.fetchedModels).toBe(models));

    rerender(nextIdentity);
    rerender({ endpoint: baseUrl, credential: apiKey });

    expect(result.current.fetchedModels).toEqual([]);
    expect(result.current.isFetchingModels).toBe(false);
    expect(fetchModelsForConfig).toHaveBeenCalledTimes(1);
  });

  it("ignores an obsolete success after the new identity has completed", async () => {
    const previous = deferred<FetchedModel[]>();
    const current = deferred<FetchedModel[]>();
    const currentModels = [{ id: "current-model", ownedBy: null }];
    vi.mocked(fetchModelsForConfig)
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise);
    const { result, rerender } = renderDiscovery();
    act(() => result.current.handleFetchModels());
    rerender(nextIdentity);
    expect(result.current.isFetchingModels).toBe(false);
    act(() => result.current.handleFetchModels());
    await act(async () => current.resolve(currentModels));
    expect(result.current.fetchedModels).toBe(currentModels);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(
      "providerForm.fetchModelsSuccess:1",
    );

    await act(async () => previous.resolve(models));

    expect(result.current.fetchedModels).toBe(currentModels);
    expect(result.current.isFetchingModels).toBe(false);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it.each(["same identity", "new identity", "A to B to A"] as const)(
    "does not let an older finally clear a newer request: %s",
    async (transition) => {
      const previous = deferred<FetchedModel[]>();
      const current = deferred<FetchedModel[]>();
      vi.mocked(fetchModelsForConfig)
        .mockReturnValueOnce(previous.promise)
        .mockReturnValueOnce(current.promise);
      const { result, rerender } = renderDiscovery();
      act(() => result.current.handleFetchModels());
      if (transition !== "same identity") rerender(nextIdentity);
      if (transition === "A to B to A")
        rerender({ endpoint: baseUrl, credential: apiKey });
      act(() => result.current.handleFetchModels());
      expect(result.current.isFetchingModels).toBe(true);

      await act(async () => previous.resolve([]));

      expect(result.current.isFetchingModels).toBe(true);
      expect(result.current.fetchedModels).toEqual([]);
      expect(toast.info).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      await act(async () => current.resolve(models));
      expect(result.current.fetchedModels).toBe(models);
      expect(result.current.isFetchingModels).toBe(false);
      expect(toast.success).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["same identity", "new identity"] as const)(
    "suppresses obsolete errors and their finally: %s",
    async (transition) => {
      const previous = deferred<FetchedModel[]>();
      const current = deferred<FetchedModel[]>();
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      vi.mocked(fetchModelsForConfig)
        .mockReturnValueOnce(previous.promise)
        .mockReturnValueOnce(current.promise);
      const { result, rerender } = renderDiscovery();
      act(() => result.current.handleFetchModels());
      if (transition === "new identity") rerender(nextIdentity);
      act(() => result.current.handleFetchModels());

      await act(async () =>
        previous.reject(new Error("redacted obsolete failure")),
      );

      expect(result.current.isFetchingModels).toBe(true);
      expect(showFetchModelsError).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      await act(async () => current.resolve(models));
      expect(result.current.fetchedModels).toBe(models);
    },
  );

  it.each(["success", "failure"] as const)(
    "suppresses %s notifications and late callbacks after unmount",
    async (outcome) => {
      const pending = deferred<FetchedModel[]>();
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      vi.mocked(fetchModelsForConfig).mockReturnValue(pending.promise);
      const { result, unmount } = renderDiscovery();
      const lateFetch = result.current.handleFetchModels;
      act(() => result.current.handleFetchModels());
      unmount();

      await act(async () => {
        if (outcome === "success") pending.resolve(models);
        else pending.reject(new Error("redacted unmounted failure"));
      });
      act(() => lateFetch());

      expect(fetchModelsForConfig).toHaveBeenCalledTimes(1);
      expect(toast.info).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(showFetchModelsError).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("rejects a stale callback instead of fetching with an old identity", () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue([]);
    const { result, rerender } = renderDiscovery();
    const previousFetch = result.current.handleFetchModels;
    rerender(nextIdentity);

    act(() => previousFetch());

    expect(fetchModelsForConfig).not.toHaveBeenCalled();
    expect(showFetchModelsError).not.toHaveBeenCalled();
  });

  it("logs a fixed error marker without credentials or endpoint while preserving safe error classification", async () => {
    const actual = await vi.importActual<
      typeof import("@/lib/api/model-fetch")
    >("@/lib/api/model-fetch");
    const error = new Error(
      `HTTP 401 discovery denied ${baseUrl}?api_key=${apiKey}`,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(showFetchModelsError).mockImplementationOnce(
      actual.showFetchModelsError,
    );
    vi.mocked(fetchModelsForConfig).mockRejectedValue(error);
    const { result } = renderDiscovery();

    act(() => result.current.handleFetchModels());
    await waitFor(() => expect(result.current.isFetchingModels).toBe(false));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[ModelFetch] Failed");
    expect(showFetchModelsError).toHaveBeenCalledWith(error, t);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "providerForm.fetchModelsAuthFailed",
    );
    for (const call of [
      ...warn.mock.calls,
      ...vi.mocked(toast.error).mock.calls,
    ]) {
      expect(String(call)).not.toContain(apiKey);
      expect(String(call)).not.toContain(baseUrl);
    }
  });

  it("remains mounted and usable after StrictMode layout-effect replay", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue(models);
    const { result } = renderHook(
      () => useProviderModelFetch(baseUrl, apiKey, t),
      { wrapper: StrictMode },
    );

    act(() => result.current.handleFetchModels());
    await waitFor(() => expect(result.current.fetchedModels).toBe(models));

    expect(result.current.isFetchingModels).toBe(false);
    expect(fetchModelsForConfig).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("keeps request ownership on translation-only changes and uses the latest callback for the next fetch", async () => {
    const pending = deferred<FetchedModel[]>();
    const nextTranslate = vi.fn(
      (key: string) => `next:${key}`,
    ) as unknown as TFunction;
    vi.mocked(fetchModelsForConfig)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce([]);
    const { result, rerender } = renderHook(
      ({ translate }) => useProviderModelFetch(baseUrl, apiKey, translate),
      { initialProps: { translate: t } },
    );
    act(() => result.current.handleFetchModels());

    rerender({ translate: nextTranslate });
    expect(result.current.isFetchingModels).toBe(true);
    await act(async () => pending.resolve(models));
    expect(result.current.fetchedModels).toBe(models);
    act(() => result.current.handleFetchModels());
    await waitFor(() => expect(result.current.isFetchingModels).toBe(false));

    expect(result.current.fetchedModels).toEqual([]);
    expect(toast.info).toHaveBeenCalledWith(
      "next:providerForm.fetchModelsEmpty",
    );
    expect(fetchModelsForConfig).toHaveBeenCalledTimes(2);
    expect(fetchModelsForConfig).toHaveBeenNthCalledWith(2, baseUrl, apiKey);
  });
});
