import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useForm } from "react-hook-form";
import { OpenCodeFormFields } from "@/components/providers/forms/OpenCodeFormFields";
import { Form } from "@/components/ui/form";
import { invalidateAutoModelRefresh } from "@/hooks/useAutoModelRefresh";

const fetchModelsForConfig = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/model-fetch", () => ({
  fetchModelsForConfig,
  showFetchModelsError: vi.fn(),
}));

function FormShell({ children }: { children: React.ReactNode }) {
  const form = useForm();
  return <Form {...form}>{children}</Form>;
}

describe("OpenCodeFormFields model refresh", () => {
  beforeEach(() => {
    invalidateAutoModelRefresh();
    localStorage.clear();
  });

  it("silently checks a saved model and marks an unavailable model ID red", async () => {
    fetchModelsForConfig.mockResolvedValue([
      { id: "current-model", ownedBy: "provider" },
    ]);
    const onModelsChange = vi.fn();
    render(
      <FormShell>
        <OpenCodeFormFields
          providerId="opencode-provider"
          autoRefreshModels
          npm="@ai-sdk/openai-compatible"
          onNpmChange={vi.fn()}
          apiKey="secret"
          onApiKeyChange={vi.fn()}
          shouldShowApiKeyLink={false}
          websiteUrl=""
          baseUrl="https://provider.example/v1"
          onBaseUrlChange={vi.fn()}
          headers={{}}
          onHeadersChange={vi.fn()}
          models={{ "old-model": { name: "Old model" } }}
          onModelsChange={onModelsChange}
          extraOptions={{}}
          onExtraOptionsChange={vi.fn()}
        />
      </FormShell>,
    );

    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(1));
    const modelInput = await screen.findByDisplayValue("old-model");
    await waitFor(() =>
      expect(modelInput).toHaveAttribute("aria-invalid", "true"),
    );
    expect(modelInput.className).toContain("text-destructive");
    expect(onModelsChange).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "codexConfig.modelListDismiss" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});
