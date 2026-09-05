import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexKeyGroupModels } from "@/components/providers/forms/CodexKeyGroupModels";
import { fetchModelsForConfig } from "@/lib/api/model-fetch";
import type { CodexApiKeyGroup } from "@/types";

vi.mock("@/lib/api/model-fetch", () => ({
  fetchModelsForConfig: vi.fn(),
  showFetchModelsError: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const group: CodexApiKeyGroup = {
  id: "astra",
  apiKeys: ["astra-key"],
  strategy: "fixed",
  models: [],
};
const props = { baseUrl: "https://example.com/v1", onModelsFetched: vi.fn() };

describe("model-specific credentials", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches and assigns each credential's models independently", async () => {
    vi.mocked(fetchModelsForConfig).mockImplementation(async (_url, key) => [
      {
        id: key === "astra-key" ? "gpt-6-astra" : "gpt-5.6",
        ownedBy: "sublyx",
      },
    ]);
    const changed = vi.fn();
    function Harness() {
      const [groups, setGroups] = useState([
        group,
        { ...group, id: "subscription", apiKeys: ["subscription-key"] },
      ]);
      return (
        <>
          {groups.map((item) => (
            <CodexKeyGroupModels
              key={item.id}
              {...props}
              group={item}
              onChange={(next) =>
                setGroups((previous) => {
                  const result = previous.map((value) =>
                    value.id === next.id ? next : value,
                  );
                  changed(result);
                  return result;
                })
              }
            />
          ))}
        </>
      );
    }
    render(<Harness />);
    for (const button of screen.getAllByRole("button")) fireEvent.click(button);
    await waitFor(() =>
      expect(changed).toHaveBeenLastCalledWith([
        expect.objectContaining({
          apiKeys: ["astra-key"],
          models: ["gpt-6-astra"],
        }),
        expect.objectContaining({
          apiKeys: ["subscription-key"],
          models: ["gpt-5.6"],
        }),
      ]),
    );
    expect(fetchModelsForConfig).toHaveBeenCalledTimes(2);
  });

  it("preserves commas while typing multiple model names", () => {
    const changed = vi.fn();
    function Harness() {
      const [value, setValue] = useState(group);
      return (
        <CodexKeyGroupModels
          {...props}
          group={value}
          onChange={(next) => {
            changed(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByLabelText("codexConfig.apiKeyGroupModels");
    for (const char of "astra, regular") {
      fireEvent.change(input, {
        target: { value: (input as HTMLInputElement).value + char },
      });
    }
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ models: ["astra", "regular"] }),
    );
  });

  it("discards a pending response after the credential changes", async () => {
    let resolve!: (models: { id: string; ownedBy: string }[]) => void;
    vi.mocked(fetchModelsForConfig).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const changed = vi.fn();
    const view = render(
      <CodexKeyGroupModels {...props} group={group} onChange={changed} />,
    );
    fireEvent.click(screen.getByRole("button"));
    view.rerender(
      <CodexKeyGroupModels
        {...props}
        group={{ ...group, apiKeys: ["replacement"] }}
        onChange={changed}
      />,
    );
    await act(async () => resolve([{ id: "stale-model", ownedBy: "sublyx" }]));
    expect(changed).not.toHaveBeenCalled();
    expect(props.onModelsFetched).not.toHaveBeenCalled();
  });
});
