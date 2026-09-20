import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CodexOfficialAuthSection,
  validateCodexOfficialAuthSelection,
} from "./CodexOfficialAuthSection";

describe("CodexOfficialAuthSection", () => {
  it("rejects a missing or reauth-required managed account", () => {
    const accounts = [
      { id: "a", login: "a@example.com", is_default: true, requires_reauth: true },
    ] as any;
    expect(
      validateCodexOfficialAuthSelection(
        { mode: "managed_oauth", accountId: "a" },
        accounts,
      ),
    ).toBeTruthy();
  });

  it("renders the shared authentication choices", () => {
    render(
      <CodexOfficialAuthSection
        value={{ mode: "desktop_current_login" }}
        accounts={[]}
        onChange={vi.fn()}
        onOpenAuthCenter={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Authentication mode" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open authentication center" }),
    ).toBeInTheDocument();
  });
});
