import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AddProviderDialog,
  buildMixedCodexProviderData,
} from "@/components/providers/AddProviderDialog";
import type { Provider } from "@/types";
import type { ProviderFormValues } from "@/components/providers/forms/ProviderForm";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h1>{children}</h1>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

let mockFormValues: ProviderFormValues;

vi.mock("@/components/providers/forms/ProviderForm", () => ({
  ProviderForm: ({
    onSubmit,
  }: {
    onSubmit: (values: ProviderFormValues) => void;
  }) => {
    return (
      <form
        id="provider-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(mockFormValues);
        }}
      />
    );
  },
}));

describe("AddProviderDialog", () => {
  beforeEach(() => {
    mockFormValues = {
      name: "Test Provider",
      websiteUrl: "https://provider.example.com",
      settingsConfig: JSON.stringify({ env: {}, config: {} }),
      meta: {
        custom_endpoints: {
          "https://api.new-endpoint.com": {
            url: "https://api.new-endpoint.com",
            addedAt: 1,
          },
        },
      },
    };
  });

  it("使用 ProviderForm 返回的自定义端点", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);
    const handleOpenChange = vi.fn();

    render(
      <AddProviderDialog
        open
        onOpenChange={handleOpenChange}
        appId="claude"
        onSubmit={handleSubmit}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "common.add",
      }),
    );

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));

    const submitted = handleSubmit.mock.calls[0][0];
    expect(submitted.meta?.custom_endpoints).toEqual(
      mockFormValues.meta?.custom_endpoints,
    );
    expect(handleOpenChange).toHaveBeenCalledWith(false);
  });

  it("在缺少自定义端点时回退到配置中的 baseUrl", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);

    mockFormValues = {
      name: "Base URL Provider",
      websiteUrl: "",
      settingsConfig: JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "https://claude.base" },
        config: {},
      }),
    };

    render(
      <AddProviderDialog
        open
        onOpenChange={vi.fn()}
        appId="claude"
        onSubmit={handleSubmit}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "common.add",
      }),
    );

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));

    const submitted = handleSubmit.mock.calls[0][0];
    expect(submitted.meta?.custom_endpoints).toEqual({
      "https://claude.base": {
        url: "https://claude.base",
        addedAt: expect.any(Number),
        lastUsed: undefined,
      },
    });
  });

  it("keeps mixed Codex protocols under one provider with per-model routing", () => {
    const providerData: Omit<Provider, "id"> = {
      name: "Relay",
      settingsConfig: {
        modelCatalog: {
          models: [
            { model: "gpt-5.5", upstreamModel: "gpt-5.5" },
            { model: "qwen3.6", upstreamModel: "qwen3.6" },
          ],
        },
      },
      meta: { apiFormat: "openai_responses" },
    };

    const mixed = buildMixedCodexProviderData(providerData, {
      providerName: "Relay",
      responsesModels: ["gpt-5.5"],
      chatModels: ["qwen3.6"],
      apiFormatSource: "inferred",
    });

    expect(mixed.name).toBe("Relay");
    expect(mixed.meta).toMatchObject({
      apiFormat: "openai_responses",
      apiFormatSource: "inferred",
    });
    expect(mixed.settingsConfig.modelCatalog).toMatchObject({
      models: [
        {
          model: "gpt-5.5",
          apiFormat: "openai_responses",
          apiFormatSource: "inferred",
        },
        {
          model: "qwen3.6",
          apiFormat: "openai_chat",
          apiFormatSource: "inferred",
        },
      ],
    });
  });

  it("labels the Codex flow as adding a model source rather than creating a router", () => {
    render(
      <AddProviderDialog
        open
        onOpenChange={vi.fn()}
        appId="codex"
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText("Add Codex model source")).toBeInTheDocument();
    expect(screen.queryByText("Create MultiRouter")).not.toBeInTheDocument();
  });

  it("新建 Grok Build 自定义供应商时不补默认 Grok 图标", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);

    mockFormValues = {
      name: "tes 1",
      websiteUrl: "",
      icon: "",
      iconColor: "",
      settingsConfig: JSON.stringify({
        config: `[models]
default = "grok-4.5"

[model."grok-4.5"]
model = "grok-4.5"
base_url = "https://grok.example.com/v1"
name = "tes 1"
api_key = "secret"
api_backend = "responses"
context_window = 500000
`,
      }),
    };

    render(
      <AddProviderDialog
        open
        onOpenChange={vi.fn()}
        appId="grokbuild"
        onSubmit={handleSubmit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "common.add" }));

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));

    const submitted = handleSubmit.mock.calls[0][0];
    expect(submitted.icon).toBeUndefined();
    expect(submitted.iconColor).toBeUndefined();
  });
});
