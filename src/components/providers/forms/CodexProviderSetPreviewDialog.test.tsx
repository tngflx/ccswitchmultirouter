import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CodexProviderSetPreview } from "@/lib/api/protocol-compatibility";
import { CodexProviderSetPreviewDialog } from "./CodexProviderSetPreviewDialog";

const splitPreview: CodexProviderSetPreview = {
  digest: "split-digest",
  sourceProviderId: "provider-source",
  responsesModels: ["qwen3.8", "glm-5"],
  chatModels: ["deepseek-v4"],
  plan: {
    kind: "split",
    responses_provider_id: "provider-source--ccsm-responses",
    chat_provider_id: "provider-source--ccsm-chat",
  },
};

describe("CodexProviderSetPreviewDialog", () => {
  it("shows the backend split groups without asking the user to choose protocols", () => {
    const onConfirmSplit = vi.fn();
    const onBack = vi.fn();

    render(
      <CodexProviderSetPreviewDialog
        open
        preview={splitPreview}
        pending={false}
        onBack={onBack}
        onConfirmSplit={onConfirmSplit}
        onRetry={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Split by protocol" });
    expect(within(dialog).getByText("qwen3.8")).toBeInTheDocument();
    expect(within(dialog).getByText("glm-5")).toBeInTheDocument();
    expect(within(dialog).getByText("deepseek-v4")).toBeInTheDocument();
    expect(within(dialog).getByText("Responses models")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Chat Completions models"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).queryByRole("combobox")).toBeNull();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Confirm split" }),
    );
    expect(onConfirmSplit).toHaveBeenCalledOnce();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("blocks saving when any model lacks a verified unique selection", () => {
    const onRetry = vi.fn();
    const blocked: CodexProviderSetPreview = {
      digest: "blocked-digest",
      sourceProviderId: "provider-source",
      responsesModels: [],
      chatModels: [],
      plan: {
        kind: "blocked",
        models: [
          {
            model: "qwen3.8",
            upstreamModel: "Qwen/Qwen3.8",
            reason: "probe_not_verified",
            stage: "continuation",
            failureKind: "http_status",
            statusCode: 422,
          },
        ],
      },
    };

    render(
      <CodexProviderSetPreviewDialog
        open
        preview={blocked}
        pending={false}
        onBack={vi.fn()}
        onConfirmSplit={vi.fn()}
        onRetry={onRetry}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Cannot save yet" });
    expect(within(dialog).getByText("qwen3.8")).toBeInTheDocument();
    expect(within(dialog).getByText("Qwen/Qwen3.8")).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Probe results have not passed full verification",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Failed stage: Tool continuation"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Failure type: HTTP status (422)"),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Confirm split" }),
    ).toBeNull();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Probe again" }),
    );
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
