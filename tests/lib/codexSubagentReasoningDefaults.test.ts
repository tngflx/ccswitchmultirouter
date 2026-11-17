import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultCodexSubagentV2Config } from "@/types/codexSubagentV2";

const readSource = (file: string) =>
  readFileSync(path.resolve(process.cwd(), file), "utf8");
const expectedPreference = ["high", "max"];

describe("Sub-Agent High/Max default contract", () => {
  it("keeps frontend and backend fixed-profile preference synchronized without implicit Ultra", () => {
    const frontend = readSource("src/lib/codexSubagentReasoningPolicy.ts");
    const frontendPreference = frontend.match(
      /SUBAGENT_FIXED_REASONING_EFFORTS\s*=\s*\[([^\]]+)\]/,
    );
    expect(
      frontendPreference,
      "Sub-Agent effort allowlist declaration",
    ).not.toBeNull();
    expect(
      [...frontendPreference![1].matchAll(/"([^"]+)"/g)].map(
        (value) => value[1],
      ),
    ).toEqual(expectedPreference);
    expect(
      readSource("src/components/codex/CodexSubagentProfileEditor.tsx"),
    ).toContain("SUBAGENT_FIXED_REASONING_EFFORTS");
    expect(
      readSource("src/components/codex/CodexRouterWorkspacePage.tsx"),
    ).toContain("SUBAGENT_FIXED_REASONING_EFFORTS");

    const rust = readSource("src-tauri/src/codex_config.rs");
    const initializer = rust.slice(
      rust.indexOf("fn catalog_profile_draft("),
      rust.indexOf(
        "let default_reasoning =",
        rust.indexOf("fn catalog_profile_draft("),
      ),
    );
    expect(initializer).not.toBe("");
    expect(
      [...initializer.matchAll(/SubagentReasoningEffort::(\w+)/g)].map(
        (value) => value[1].toLowerCase(),
      ),
    ).toEqual(expectedPreference);
  });

  it("defaults fresh templates to High but never shares or rewrites a saved profile choice", () => {
    const first = createDefaultCodexSubagentV2Config();
    const second = createDefaultCodexSubagentV2Config();
    expect(
      Object.values(first.profiles).map((profile) => profile.reasoning),
    ).toEqual(
      Object.values(first.profiles).map(() => ({
        policy: "fixed",
        effort: "high",
      })),
    );
    first.profiles[Object.keys(first.profiles)[0]].reasoning = {
      policy: "fixed",
      effort: "max",
    };
    expect(
      Object.values(second.profiles).every(
        (profile) =>
          profile.reasoning.policy === "fixed" &&
          profile.reasoning.effort === "high",
      ),
    ).toBe(true);
    expect(first.profiles[Object.keys(first.profiles)[0]].reasoning).toEqual({
      policy: "fixed",
      effort: "max",
    });
  });
});
