import { useState, type PropsWithChildren } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { Form } from "@/components/ui/form";
import { OpenClawFormFields } from "@/components/providers/forms/OpenClawFormFields";
import { HermesFormFields } from "@/components/providers/forms/HermesFormFields";

function Shell({ children }: PropsWithChildren) {
  const form = useForm();
  return <Form {...form}>{children}</Form>;
}

function Editor({ kind }: { kind: "openclaw" | "hermes" }) {
  const [models, setModels] = useState(
    Array.from({ length: 431 }, (_, index) => ({
      id: `model-${index}`,
      name: `Model ${index}`,
    })),
  );
  const props = {
    baseUrl: "https://example.com/v1",
    onBaseUrlChange: () => {},
    apiKey: "test",
    onApiKeyChange: () => {},
    shouldShowApiKeyLink: false,
    websiteUrl: "",
    models,
    onModelsChange: setModels,
  };
  return (
    <Shell>
      {kind === "openclaw" ? (
        <OpenClawFormFields
          {...props}
          api="openai-completions"
          onApiChange={() => {}}
          userAgent={false}
          onUserAgentChange={() => {}}
        />
      ) : (
        <HermesFormFields
          {...props}
          onModelsChange={(next) =>
            setModels(
              next.map((model) => ({ ...model, name: model.name ?? "" })),
            )
          }
          apiMode="chat_completions"
          onApiModeChange={() => {}}
          rateLimitDelay={undefined}
          onRateLimitDelayChange={() => {}}
        />
      )}
      <output data-testid="saved-models">{JSON.stringify(models)}</output>
    </Shell>
  );
}

describe.each(["openclaw", "hermes"] as const)(
  "%s large model editor",
  (kind) => {
    it("loads bounded rows and edits the original model after searching", async () => {
      render(<Editor kind={kind} />);
      expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
      expect(await screen.findAllByDisplayValue(/^model-\d+$/)).toHaveLength(
        20,
      );
      fireEvent.change(
        screen.getByRole("textbox", { name: "opencode.searchModels" }),
        { target: { value: "model-430" } },
      );
      fireEvent.change(screen.getByDisplayValue("Model 430"), {
        target: { value: "Edited last model" },
      });
      const models = JSON.parse(
        screen.getByTestId("saved-models").textContent!,
      );
      expect(models).toHaveLength(431);
      expect(models[0].name).toBe("Model 0");
      expect(models[430].name).toBe("Edited last model");
    });
  },
);
