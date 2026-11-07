import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiFormFields } from "@/components/providers/forms/GeminiFormFields";
import { OpenClawFormFields } from "@/components/providers/forms/OpenClawFormFields";
import { Form } from "@/components/ui/form";
import {
  fetchModelsForConfig,
  showFetchModelsError,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import { toast } from "sonner";

vi.mock("@/lib/api/model-fetch", () => ({
  fetchModelsForConfig: vi.fn(),
  showFetchModelsError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), success: vi.fn() },
}));

function FormShell({ children }: PropsWithChildren) {
  const form = useForm();
  return <Form {...form}>{children}</Form>;
}

type ProviderKind = "Gemini" | "OpenClaw";
const configured = {
  baseUrl: "https://models.example.invalid/v1",
  apiKey: "redacted-test-credential",
};

function renderProvider(
  kind: ProviderKind,
  overrides: Partial<typeof configured> = {},
) {
  const common = {
    ...configured,
    onBaseUrlChange: vi.fn(),
    onApiKeyChange: vi.fn(),
    shouldShowApiKeyLink: false,
    websiteUrl: "",
    ...overrides,
  };
  const content = (inputs: Partial<typeof configured> = {}) => (
    <FormShell>
      {kind === "Gemini" ? (
        <GeminiFormFields
          {...common}
          {...inputs}
          shouldShowApiKey={true}
          shouldShowSpeedTest={false}
          isEndpointModalOpen={false}
          onEndpointModalToggle={vi.fn()}
          onCustomEndpointsChange={vi.fn()}
          autoSelect={false}
          onAutoSelectChange={vi.fn()}
          shouldShowModelField={true}
          model=""
          onModelChange={vi.fn()}
          speedTestEndpoints={[]}
        />
      ) : (
        <OpenClawFormFields
          {...common}
          {...inputs}
          api="openai-completions"
          onApiChange={vi.fn()}
          models={[]}
          onModelsChange={vi.fn()}
          userAgent={false}
          onUserAgentChange={vi.fn()}
        />
      )}
    </FormShell>
  );
  const view = render(content());
  return {
    ...view,
    rerenderProvider: (inputs: Partial<typeof configured>) =>
      view.rerender(content(inputs)),
  };
}

function fetchButton() {
  return screen.getByRole("button", { name: "providerForm.fetchModels" });
}

describe.each<ProviderKind>(["Gemini", "OpenClaw"])(
  "%s ordinary model discovery parity",
  (kind) => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each([
      [{ baseUrl: "", apiKey: "" }, false, false],
      [{ apiKey: "" }, false, true],
      [{ baseUrl: "" }, true, false],
    ] as const)(
      "preserves the shared missing-configuration notification for %j",
      (overrides, hasApiKey, hasBaseUrl) => {
        renderProvider(kind, overrides);
        fireEvent.click(fetchButton());
        expect(fetchModelsForConfig).not.toHaveBeenCalled();
        expect(showFetchModelsError).toHaveBeenCalledWith(
          null,
          expect.any(Function),
          { hasApiKey, hasBaseUrl },
        );
        expect(fetchButton()).toBeEnabled();
        expect(toast.info).not.toHaveBeenCalled();
        expect(toast.success).not.toHaveBeenCalled();
      },
    );

    it("preserves request arguments, pending state and success count", async () => {
      let resolve!: (models: FetchedModel[]) => void;
      vi.mocked(fetchModelsForConfig).mockReturnValue(
        new Promise<FetchedModel[]>((done) => {
          resolve = done;
        }),
      );
      renderProvider(kind);
      fireEvent.click(fetchButton());
      expect(fetchModelsForConfig).toHaveBeenCalledWith(
        configured.baseUrl,
        configured.apiKey,
      );
      expect(fetchModelsForConfig).toHaveBeenCalledTimes(1);
      expect(fetchButton()).toBeDisabled();
      const models: FetchedModel[] = [
        { id: "public-model-a", ownedBy: null },
        { id: "public-model-b", ownedBy: "fixture-owner" },
      ];
      await act(async () => resolve(models));
      await waitFor(() => expect(fetchButton()).toBeEnabled());
      expect(toast.success).toHaveBeenCalledWith(
        "providerForm.fetchModelsSuccess",
      );
      expect(toast.success).toHaveBeenCalledTimes(1);
      expect(toast.info).not.toHaveBeenCalled();
      expect(showFetchModelsError).not.toHaveBeenCalled();
    });

    it.each([
      { baseUrl: "https://next-models.example.invalid/v1" },
      { apiKey: "redacted-next-credential" },
    ])(
      "invalidates a previous provider request when inputs change: %j",
      async (inputs) => {
        let resolvePrevious!: (models: FetchedModel[]) => void;
        let resolveCurrent!: (models: FetchedModel[]) => void;
        vi.mocked(fetchModelsForConfig)
          .mockReturnValueOnce(
            new Promise((done) => {
              resolvePrevious = done;
            }),
          )
          .mockReturnValueOnce(
            new Promise((done) => {
              resolveCurrent = done;
            }),
          );
        const view = renderProvider(kind);
        fireEvent.click(fetchButton());
        expect(fetchButton()).toBeDisabled();

        view.rerenderProvider(inputs);

        expect(fetchButton()).toBeEnabled();
        fireEvent.click(fetchButton());
        expect(fetchButton()).toBeDisabled();
        await act(async () => resolvePrevious([]));
        expect(fetchButton()).toBeDisabled();
        expect(toast.info).not.toHaveBeenCalled();
        expect(toast.success).not.toHaveBeenCalled();
        await act(async () =>
          resolveCurrent([{ id: "current-model", ownedBy: null }]),
        );
        expect(fetchButton()).toBeEnabled();
        expect(toast.success).toHaveBeenCalledTimes(1);
        expect(fetchModelsForConfig).toHaveBeenNthCalledWith(
          2,
          inputs.baseUrl ?? configured.baseUrl,
          inputs.apiKey ?? configured.apiKey,
        );
      },
    );

    it("preserves the empty-directory notification", async () => {
      vi.mocked(fetchModelsForConfig).mockResolvedValue([]);
      renderProvider(kind);
      fireEvent.click(fetchButton());
      await waitFor(() =>
        expect(toast.info).toHaveBeenCalledWith(
          "providerForm.fetchModelsEmpty",
        ),
      );
      expect(fetchButton()).toBeEnabled();
      expect(toast.info).toHaveBeenCalledTimes(1);
      expect(toast.success).not.toHaveBeenCalled();
      expect(showFetchModelsError).not.toHaveBeenCalled();
    });

    it("preserves error handling and restores the pending button", async () => {
      const error = new Error("redacted model-discovery failure");
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      vi.mocked(fetchModelsForConfig).mockRejectedValue(error);
      renderProvider(kind);
      fireEvent.click(fetchButton());
      await waitFor(() =>
        expect(showFetchModelsError).toHaveBeenCalledWith(
          error,
          expect.any(Function),
        ),
      );
      expect(fetchButton()).toBeEnabled();
      expect(showFetchModelsError).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("[ModelFetch] Failed");
      expect(toast.info).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });
  },
);
