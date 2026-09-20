import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const template = readFileSync(
  resolve("src-tauri/src/resources/codex_app_compat_template.js"),
  "utf8",
);
const warningCore = template.slice(
  template.indexOf("  const requestHealthWarningStorageKey ="),
  template.indexOf("  const installModelPickerSpacingFix ="),
);

function warningController() {
  const state: Record<string, unknown> = {};
  new Function("state", warningCore)(state);
  return state as {
    syncRequestHealthWarnings: (warnings: Array<Record<string, unknown>>) => {
      active: number;
    };
  };
}

describe("Codex Request Health advisory warning", () => {
  it("renders one non-interactive warning per backend token and removes it centrally", () => {
    const state = warningController();
    const warning = {
      token: "review-token",
      title: "Request paused for approval",
      detail: "Model: gpt-test · request exceeds the configured threshold",
      instruction:
        "Choose Continue, Block, or Summarize + new session in the Windows notification.",
      expiresAtMs: Date.now() + 60_000,
    };

    expect(state.syncRequestHealthWarnings([warning])).toEqual({ active: 1 });
    expect(state.syncRequestHealthWarnings([warning])).toEqual({ active: 1 });

    const container = document.getElementById(
      "ccswitch-request-health-warning-container",
    );
    expect(container).toHaveAttribute("role", "status");
    expect(container).toHaveTextContent("Request paused for approval");
    expect(container).toHaveTextContent("Windows notification");
    expect(container?.querySelectorAll("article")).toHaveLength(1);
    expect(container?.querySelector("button")).toBeNull();

    expect(state.syncRequestHealthWarnings([])).toEqual({ active: 0 });
    expect(
      document.getElementById("ccswitch-request-health-warning-container"),
    ).toBeNull();
  });

  it("does not restore expired warnings from renderer storage", () => {
    localStorage.setItem(
      "ccswitch-request-health-warnings-v1",
      JSON.stringify([
        {
          token: "expired",
          title: "Expired warning",
          detail: "old",
          instruction: "old",
          expiresAtMs: Date.now() - 1,
        },
      ]),
    );

    warningController();

    expect(
      document.getElementById("ccswitch-request-health-warning-container"),
    ).toBeNull();
    expect(
      localStorage.getItem("ccswitch-request-health-warnings-v1"),
    ).toBeNull();
  });
});
