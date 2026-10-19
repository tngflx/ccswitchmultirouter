import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, PropsWithChildren } from "react";
import { useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeFormFields } from "@/components/providers/forms/OpenCodeFormFields";
import { Form } from "@/components/ui/form";
import { fetchModelsForConfig, type FetchedModel } from "@/lib/api/model-fetch";

vi.mock("@/lib/api/model-fetch", () => ({
  fetchModelsForConfig: vi.fn(),
  showFetchModelsError: vi.fn(),
}));

type OpenCodeFormFieldsProps = ComponentProps<typeof OpenCodeFormFields>;

const FormShell = ({ children }: PropsWithChildren) => {
  const form = useForm();

  return <Form {...form}>{children}</Form>;
};

const renderOpenCodeForm = (
  overrides: Partial<OpenCodeFormFieldsProps> = {},
) => {
  const props: OpenCodeFormFieldsProps = {
    npm: "@ai-sdk/openai-compatible",
    onNpmChange: vi.fn(),
    apiKey: "sk-test",
    onApiKeyChange: vi.fn(),
    category: "custom",
    shouldShowApiKeyLink: false,
    websiteUrl: "",
    baseUrl: "https://api.example.com/v1",
    onBaseUrlChange: vi.fn(),
    headers: {},
    onHeadersChange: vi.fn(),
    models: {
      "kimi-k2": {
        name: "Kimi K2",
        limit: { context: 1048576, output: 131072 },
      },
    },
    onModelsChange: vi.fn(),
    extraOptions: {},
    onExtraOptionsChange: vi.fn(),
    ...overrides,
  };

  return {
    props,
    ...render(
      <FormShell>
        <OpenCodeFormFields {...props} />
      </FormShell>,
    ),
  };
};

const expandFirstModel = () => {
  fireEvent.click(screen.getByRole("button", { name: "Toggle model details" }));
};

describe("OpenCodeFormFields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const chooseFetchedModel = async (id: string) => {
    fireEvent.click(
      screen.getByRole("button", { name: /fetch.*model|get.*model/i }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Select model" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: id }));
  };

  it("applies fetched model facts without carrying the previous model's capabilities", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue([
      {
        id: "new-model",
        ownedBy: "example",
        displayName: "New Model",
        contextWindow: 64000,
        inputModalities: ["text", "image", "audio"],
        supportsImage: true,
        supportsParallelToolCalls: false,
        reasoning: {
          schemaVersion: 2,
          supportStatus: "confirmed_supported",
          controlKind: "graded",
          supportedEfforts: ["low", "max", "ultra"],
          defaultEffort: "max",
          disableAllowed: false,
          upstream: {
            format: "string",
            parameter: "reasoning_effort",
            effortMap: { low: "low", max: "max", ultra: "max" },
          },
        },
      },
    ]);
    const onModelsChange = vi.fn();
    renderOpenCodeForm({
      models: {
        "old-model": {
          name: "Old Model",
          limit: { context: 1000000, output: 200000 },
          modalities: { input: ["text", "video"], output: ["audio"] },
          reasoning: false,
          variants: { high: { reasoningEffort: "high" } },
          provider: { npm: "@ai-sdk/anthropic" },
          cost: { input: 1, output: 2 },
          aliases: ["my-local-alias"],
          headers: { "X-Region": "test" },
          options: {
            timeout: 12345,
            user: "operator",
            thinking: { type: "enabled" },
            reasoningEffort: "high",
          },
        },
      },
      onModelsChange,
    });

    await chooseFetchedModel("new-model");

    expect(onModelsChange).toHaveBeenLastCalledWith({
      "new-model": {
        name: "New Model",
        limit: { context: 64000 },
        modalities: { input: ["text", "image", "audio"] },
        reasoning: true,
        variants: {
          low: { reasoningEffort: "low" },
          max: { reasoningEffort: "max" },
          ultra: { reasoningEffort: "max" },
        },
        aliases: ["my-local-alias"],
        headers: { "X-Region": "test" },
        options: {
          timeout: 12345,
          user: "operator",
          reasoningEffort: "max",
          parallel_tool_calls: false,
        },
      },
    });
  });

  it("keeps an ID-only fetched model unknown instead of borrowing the old model's limits and variants", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue([
      { id: "unknown-model", ownedBy: null },
    ]);
    const onModelsChange = vi.fn();
    renderOpenCodeForm({
      models: {
        "old-model": {
          name: "Old Model",
          limit: { context: 1000000, output: 200000 },
          reasoning: true,
          tool_call: true,
          attachment: true,
          modalities: { input: ["text", "image"] },
          variants: { max: { reasoningEffort: "max" } },
          options: {
            timeout: 12345,
            reasoningEffort: "max",
            parallel_tool_calls: false,
          },
        },
      },
      onModelsChange,
    });

    await chooseFetchedModel("unknown-model");

    expect(onModelsChange).toHaveBeenLastCalledWith({
      "unknown-model": {
        name: "unknown-model",
        options: { timeout: 12345 },
      },
    });
  });

  it.each([
    ["@ai-sdk/anthropic", "anthropic"],
    ["@ai-sdk/openai", "openai_responses"],
    ["@ai-sdk/openai-compatible", "openai_chat"],
    ["@ai-sdk/google", "gemini_native"],
    ["@ai-sdk/amazon-bedrock", undefined],
    ["@ai-sdk/google-vertex", undefined],
  ])(
    "uses only the known native fetch protocol for %s",
    async (npm, apiFormat) => {
      vi.mocked(fetchModelsForConfig).mockResolvedValue([]);
      renderOpenCodeForm({
        npm: npm!,
        headers: { "X-Region": "test", "draft-header:123": "" },
      });

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: /fetch.*model|get.*model/i }),
        );
      });

      expect(fetchModelsForConfig).toHaveBeenCalledWith(
        "https://api.example.com/v1",
        "sk-test",
        false,
        undefined,
        undefined,
        {
          apiFormat,
          requestHeaders: { "X-Region": "test" },
        },
      );
    },
  );

  it.each([
    { baseUrl: "https://other.example.com/v1" },
    { apiKey: "different-key" },
    { npm: "@ai-sdk/anthropic" },
    { headers: { "X-Region": "other" } },
  ])(
    "discards an in-flight model list after its source changes: %o",
    async (changes) => {
      let resolve!: (models: FetchedModel[]) => void;
      vi.mocked(fetchModelsForConfig).mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const { props, rerender } = renderOpenCodeForm();
      fireEvent.click(
        screen.getByRole("button", { name: /fetch.*model|get.*model/i }),
      );
      rerender(
        <FormShell>
          <OpenCodeFormFields {...props} {...changes} />
        </FormShell>,
      );

      await act(async () => {
        resolve([{ id: "old-endpoint-model", ownedBy: null }]);
      });

      expect(
        screen.queryByRole("button", { name: "Select model" }),
      ).not.toBeInTheDocument();
    },
  );

  it("refreshes fetched facts when the selected model ID is unchanged", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue([
      {
        id: "kimi-k2",
        ownedBy: null,
        displayName: "Kimi K2 Updated",
        contextWindow: 2000000,
      },
    ]);
    const onModelsChange = vi.fn();
    renderOpenCodeForm({ onModelsChange });

    await chooseFetchedModel("kimi-k2");

    expect(onModelsChange).toHaveBeenLastCalledWith({
      "kimi-k2": {
        name: "Kimi K2 Updated",
        limit: { context: 2000000, output: 131072 },
      },
    });
  });

  it("does not overwrite another configured model when selecting its fetched ID", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue([
      { id: "existing-model", ownedBy: null },
    ]);
    const onModelsChange = vi.fn();
    renderOpenCodeForm({
      models: {
        "old-model": { name: "Old Model" },
        "existing-model": { name: "My Existing Model", reasoning: false },
      },
      onModelsChange,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /fetch.*model|get.*model/i }),
    );
    const buttons = await screen.findAllByRole("button", {
      name: "Select model",
    });
    fireEvent.click(buttons[0]);
    fireEvent.click(
      await screen.findByRole("option", { name: "existing-model" }),
    );

    expect(onModelsChange).not.toHaveBeenCalled();
  });

  it("retains model facts during a deliberate manual alias rename", () => {
    const onModelsChange = vi.fn();
    renderOpenCodeForm({ onModelsChange });
    const id = screen.getByDisplayValue("kimi-k2");

    fireEvent.change(id, { target: { value: "my-kimi-alias" } });
    fireEvent.blur(id);

    expect(onModelsChange).toHaveBeenLastCalledWith({
      "my-kimi-alias": {
        name: "Kimi K2",
        limit: { context: 1048576, output: 131072 },
      },
    });
  });

  it("restores the model ID input when a manual rename collides with an existing model", () => {
    const onModelsChange = vi.fn();
    renderOpenCodeForm({
      models: {
        "old-model": { name: "Old Model" },
        "existing-model": { name: "Existing Model" },
      },
      onModelsChange,
    });
    const id = screen.getByDisplayValue("old-model");

    fireEvent.change(id, { target: { value: "existing-model" } });
    fireEvent.blur(id);

    expect(onModelsChange).not.toHaveBeenCalled();
    expect(id).toHaveValue("old-model");
  });

  it("warns when an OpenCode Zen provider contains a free-tier model", () => {
    renderOpenCodeForm({
      baseUrl: "https://opencode.ai/zen/v1",
      models: {
        "space-bunny-free": { name: "Space Bunny" },
        "gpt-6.1-sol": { name: "GPT-6.1 Sol" },
      },
    });

    expect(
      screen.getByText("OpenCode Zen free models are OpenCode-only"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Changing User-Agent or session headers cannot grant access/,
      ),
    ).toBeInTheDocument();
  });

  it("does not show the Zen free-tier warning for ordinary providers", () => {
    renderOpenCodeForm({
      baseUrl: "https://api.example.com/v1",
      models: { "example-free": { name: "Example Free" } },
    });

    expect(
      screen.queryByText("OpenCode Zen free models are OpenCode-only"),
    ).not.toBeInTheDocument();
  });

  it("surfaces existing provider headers", () => {
    renderOpenCodeForm({
      headers: {
        "HTTP-Referer": "https://cc-switch.app",
        "X-Title": "CC Switch",
      },
    });

    expect(screen.getByDisplayValue("HTTP-Referer")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("https://cc-switch.app"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("X-Title")).toBeInTheDocument();
    expect(screen.getByDisplayValue("CC Switch")).toBeInTheDocument();
  });

  it("updates provider headers", () => {
    const onHeadersChange = vi.fn();
    renderOpenCodeForm({
      headers: { "X-Title": "CC Switch" },
      onHeadersChange,
    });

    fireEvent.change(screen.getByDisplayValue("CC Switch"), {
      target: { value: "OpenCode" },
    });

    expect(onHeadersChange).toHaveBeenCalledWith({
      "X-Title": "OpenCode",
    });
  });

  it("shows a blank header name for newly added headers", () => {
    const onHeadersChange = vi.fn();
    const { rerender, props } = renderOpenCodeForm({ onHeadersChange });

    fireEvent.click(screen.getByRole("button", { name: "Add header" }));

    const nextHeaders = onHeadersChange.mock.calls[0][0];
    const headerKey = Object.keys(nextHeaders)[0];
    expect(headerKey).toMatch(/^draft-header:/);

    rerender(
      <FormShell>
        <OpenCodeFormFields {...props} headers={nextHeaders} />
      </FormShell>,
    );

    expect(screen.getByPlaceholderText("X-Title")).toHaveValue("");
  });

  it("removes provider headers", () => {
    const onHeadersChange = vi.fn();
    renderOpenCodeForm({
      headers: { "X-Title": "CC Switch" },
      onHeadersChange,
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove header" }));

    expect(onHeadersChange).toHaveBeenCalledWith({});
  });

  it("rejects case-insensitive duplicate header names and restores the input", () => {
    const onHeadersChange = vi.fn();
    renderOpenCodeForm({
      headers: { "X-A": "A", "X-B": "B" },
      onHeadersChange,
    });

    const keyInput = screen.getByDisplayValue("X-B");
    fireEvent.change(keyInput, { target: { value: "x-a" } });
    fireEvent.blur(keyInput);

    expect(onHeadersChange).not.toHaveBeenCalled();
    expect(keyInput).toHaveValue("X-B");
  });

  it("surfaces provider options whose names start with option-", () => {
    renderOpenCodeForm({
      extraOptions: { "option-mode": "legacy" },
    });

    expect(screen.getByDisplayValue("option-mode")).toBeInTheDocument();
    expect(screen.getByDisplayValue("legacy")).toBeInTheDocument();
  });

  it("surfaces existing model token limits", () => {
    renderOpenCodeForm();

    expandFirstModel();

    expect(screen.getByLabelText("Context")).toHaveValue(1048576);
    expect(screen.getByLabelText("Output")).toHaveValue(131072);
  });

  it("updates model token limits as structured numbers", () => {
    const onModelsChange = vi.fn();
    renderOpenCodeForm({ onModelsChange });

    expandFirstModel();
    fireEvent.change(screen.getByLabelText("Context"), {
      target: { value: "2000000" },
    });

    expect(onModelsChange).toHaveBeenCalledWith({
      "kimi-k2": {
        name: "Kimi K2",
        limit: { context: 2000000, output: 131072 },
      },
    });
  });

  it("removes model limit when both fields are cleared", () => {
    const onModelsChange = vi.fn();
    const { rerender, props } = renderOpenCodeForm({ onModelsChange });

    expandFirstModel();
    fireEvent.change(screen.getByLabelText("Context"), {
      target: { value: "" },
    });

    const withoutContext = {
      "kimi-k2": {
        name: "Kimi K2",
        limit: { output: 131072 },
      },
    };
    expect(onModelsChange).toHaveBeenLastCalledWith(withoutContext);

    rerender(
      <FormShell>
        <OpenCodeFormFields {...props} models={withoutContext} />
      </FormShell>,
    );
    fireEvent.change(screen.getByLabelText("Output"), {
      target: { value: "" },
    });

    expect(onModelsChange).toHaveBeenLastCalledWith({
      "kimi-k2": {
        name: "Kimi K2",
      },
    });
  });
});
