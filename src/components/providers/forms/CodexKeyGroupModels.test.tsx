import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CodexApiKeyGroup } from "@/types";
import type { FetchedModel } from "@/lib/api/model-fetch";
import { fetchModelsForConfig } from "@/lib/api/model-fetch";
import { CodexKeyGroupModels } from "./CodexKeyGroupModels";

vi.mock("@/lib/api/model-fetch", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/model-fetch")>(
    "@/lib/api/model-fetch",
  );
  return {
    ...actual,
    fetchModelsForConfig: vi.fn(),
    showFetchModelsError: vi.fn(),
  };
});

const model = (id: string): FetchedModel => ({
  id,
  ownedBy: "test",
});

const makeGroup = (
  overrides: Partial<CodexApiKeyGroup> = {},
): CodexApiKeyGroup => ({
  id: "group-1",
  label: "Primary",
  apiKeys: ["key-a", "key-b"],
  strategy: "fixed",
  models: [],
  prefixes: [],
  ...overrides,
});

describe("CodexKeyGroupModels", () => {
  beforeEach(() => {
    vi.mocked(fetchModelsForConfig).mockReset();
  });

  it("edits exact model IDs and prefixes", () => {
    const onChange = vi.fn();
    render(
      <CodexKeyGroupModels
        group={makeGroup({ models: ["gpt-5"], prefixes: ["claude-"] })}
        baseUrl="https://provider.test"
        onChange={onChange}
        onModelsFetched={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Exact models, comma separated"), {
      target: { value: "gpt-5, o3" },
    });
    fireEvent.change(screen.getByLabelText("Model prefixes, comma separated"), {
      target: { value: "claude-, qwen-" },
    });

    expect(onChange).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ models: ["gpt-5", "o3"] }),
    );
    expect(onChange).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ prefixes: ["claude-", "qwen-"] }),
    );
  });

  it("fetches only the first key for fixed groups", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue([model("gpt-5")]);
    render(
      <CodexKeyGroupModels
        group={makeGroup({ strategy: "fixed" })}
        baseUrl="https://provider.test"
        isFullUrl
        customUserAgent="agent"
        onChange={vi.fn()}
        onModelsFetched={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(1));
    expect(fetchModelsForConfig).toHaveBeenCalledWith(
      "https://provider.test",
      "key-a",
      true,
      undefined,
      "agent",
    );
  });

  it.each(["round_robin", "random"] as const)(
    "fetches every key for %s groups and deduplicates models",
    async (strategy) => {
      vi.mocked(fetchModelsForConfig)
        .mockResolvedValueOnce([model("shared"), model("first")])
        .mockResolvedValueOnce([model("shared"), model("second")]);
      const onChange = vi.fn();
      const onModelsFetched = vi.fn();
      render(
        <CodexKeyGroupModels
          group={makeGroup({ strategy })}
          baseUrl="https://provider.test"
          onChange={onChange}
          onModelsFetched={onModelsFetched}
        />,
      );

      fireEvent.click(screen.getByRole("button"));
      await waitFor(() =>
        expect(fetchModelsForConfig).toHaveBeenCalledTimes(2),
      );
      await waitFor(() => expect(onModelsFetched).toHaveBeenCalledTimes(1));
      expect(onModelsFetched).toHaveBeenCalledWith([
        model("shared"),
        model("first"),
        model("second"),
      ]);
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ models: ["shared", "first", "second"] }),
      );
    },
  );

  it("ignores a result from a group that changed while fetching", async () => {
    let resolveFetch!: (models: FetchedModel[]) => void;
    vi.mocked(fetchModelsForConfig).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const onChange = vi.fn();
    const { rerender } = render(
      <CodexKeyGroupModels
        group={makeGroup()}
        baseUrl="https://provider.test"
        onChange={onChange}
        onModelsFetched={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    rerender(
      <CodexKeyGroupModels
        group={makeGroup({ apiKeys: ["new-key"] })}
        baseUrl="https://provider.test"
        onChange={onChange}
        onModelsFetched={vi.fn()}
      />,
    );
    resolveFetch([model("stale")]);

    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(1));
    expect(onChange).not.toHaveBeenCalled();
  });
});
