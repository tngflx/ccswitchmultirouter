import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CodexFormSaveFeedback } from "./CodexFormFields";

describe("CodexFormSaveFeedback", () => {
  it("keeps catalog validation visible and explicitly says the whole draft was not saved", () => {
    render(
      <CodexFormSaveFeedback
        catalogValidationError={{
          model: "deepseek",
          message:
            "deepseek: Ultra is unlocked but no provider reasoning effort is selected",
        }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Ultra is unlocked but no provider reasoning effort is selected",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "API Key, endpoint, and other edits remain in the current draft, but none of these changes were saved.",
    );
  });

  it("shows a generic pre-submit error without rendering the secret draft value", () => {
    render(
      <CodexFormSaveFeedback saveError="Codex 设置校验或解析失败；本次尚未提交，草稿仍保留。" />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("本次尚未提交");
    expect(screen.getByRole("alert")).not.toHaveTextContent("synthetic-secret");
  });

  it("does not claim a rejected backend save was not written", () => {
    render(
      <CodexFormSaveFeedback saveError="Save result was not confirmed. The backend may have written the data, but follow-up synchronization failed. Refresh to verify the state and avoid changing the API Key again until then. The current draft is preserved." />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Save result was not confirmed",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The backend may have written the data",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Refresh to verify the state",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "avoid changing the API Key again",
    );
  });
});
