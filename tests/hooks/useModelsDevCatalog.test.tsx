import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";
import { useModelsDevCatalog } from "@/hooks/useModelsDevCatalog";
import { createTestQueryClient } from "../utils/testQueryClient";

const { fetchPricing } = vi.hoisted(() => ({ fetchPricing: vi.fn() }));
vi.mock("@/lib/modelsDevPricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modelsDevPricing")>()),
  fetchModelsDevPricing: fetchPricing,
}));

beforeEach(() => {
  fetchPricing.mockReset();
  fetchPricing.mockResolvedValue({
    z: {
      name: "Zulu",
      models: {
        "chat-one": { name: "One", cost: { input: 1 } },
        "chat-two": { name: "Two", cost: { input: 2 } },
      },
    },
    a: {
      name: "Alpha",
      models: { "chat-three": { name: "Three", cost: { input: 3 } } },
    },
  });
});

it("shares cached data, preserves complete filtering, and applies caller row limits", async () => {
  const client = createTestQueryClient();
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, rerender, unmount } = renderHook(
    ({ search, provider }) => ({
      manual: useModelsDevCatalog(search, provider, 1, 2),
      auto: useModelsDevCatalog(search, provider, 2, 3),
    }),
    { wrapper, initialProps: { search: "", provider: "all" } },
  );
  await waitFor(() => expect(result.current.manual.isLoading).toBe(false));
  expect(fetchPricing).toHaveBeenCalledOnce();
  expect(
    result.current.manual.providers.map((provider) => provider.name),
  ).toEqual(["Alpha", "Zulu"]);
  expect(result.current.manual.visible).toHaveLength(1);
  expect(result.current.auto.visible).toHaveLength(2);
  rerender({ search: " CHAT ", provider: "all" });
  expect(result.current.manual.filtered).toHaveLength(3);
  expect(result.current.manual.visible).toHaveLength(2);
  expect(result.current.auto.visible).toHaveLength(3);
  rerender({ search: "THREE", provider: "a" });
  expect(result.current.manual.visible.map((entry) => entry.modelId)).toEqual([
    "chat-three",
  ]);
  rerender({ search: "THREE", provider: "z" });
  expect(result.current.manual.visible).toEqual([]);
  unmount();
  client.clear();
});

it("does not fetch while the picker is closed", () => {
  const client = createTestQueryClient();
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { unmount } = renderHook(
    () => useModelsDevCatalog("", "all", 50, 200, false),
    { wrapper },
  );
  expect(fetchPricing).not.toHaveBeenCalled();
  unmount();
  client.clear();
});
