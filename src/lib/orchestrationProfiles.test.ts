import { describe, expect, it } from "vitest";
import type { Provider } from "@/types";
import {
  createOrchestrationDraft,
  firstOrchestrationModelRef,
  toOrchestrationProviderChoices,
  validateOrchestrationDraft,
} from "./orchestrationProfiles";

const provider = (
  id: string,
  settingsConfig: Provider["settingsConfig"],
): Provider => ({ id, name: id, settingsConfig });

describe("orchestration draft and direct-provider boundary", () => {
  it("does not invent a model for an empty authoritative official catalog", () => {
    const claude = toOrchestrationProviderChoices({
      official: provider("claude-official", {
        modelCatalog: { models: [] },
        model_catalog: { models: [{ model: "stale" }] },
        env: { ANTHROPIC_MODEL: "also-stale" },
      }),
    });
    expect(firstOrchestrationModelRef("claude", { claude, codex: [] })).toEqual(
      {
        appType: "claude",
        providerId: "claude-official",
        model: "",
      },
    );
  });

  it("prefers usable inventories over an unavailable official provider", () => {
    const codex = toOrchestrationProviderChoices({
      official: provider("codex-official", { modelCatalog: { models: [] } }),
      usable: provider("usable", {
        modelCatalog: {
          models: [
            { model: "excluded", enabled: false },
            { model: "included" },
          ],
        },
      }),
    });
    expect(firstOrchestrationModelRef("codex", { codex, claude: [] })).toEqual({
      appType: "codex",
      providerId: "usable",
      model: "included",
    });
  });

  it("prefers official inventory over alphabetical order without mutating choices", () => {
    const codex = toOrchestrationProviderChoices({
      custom: provider("aaa-custom", { model: "custom" }),
      official: provider("codex-official", {
        modelCatalog: { models: ["official"] },
      }),
    });
    const snapshot = JSON.stringify(codex);
    expect(
      firstOrchestrationModelRef("codex", { codex, claude: [] }).model,
    ).toBe("official");
    expect(JSON.stringify(codex)).toBe(snapshot);
  });

  it("excludes recursive aliases, disabled routers and all protocol-set providers", () => {
    expect(
      toOrchestrationProviderChoices({
        router: provider("router", {
          codexRouting: { enabled: false, routes: [] },
        }),
        protocol: provider("protocol", { codexProtocolSet: { role: "leaf" } }),
        direct: provider("direct", {
          modelCatalog: { models: ["ccsm-orch/recursive", "ordinary"] },
        }),
      }),
    ).toEqual([
      { id: "direct", name: "direct", models: ["ordinary"], hasCatalog: true },
    ]);
  });

  it("requires explicit enablement and allows incomplete drafts to be saved", () => {
    const choices = { claude: [], codex: [] };
    const draft = createOrchestrationDraft("draft", choices, "Draft", "");
    expect(draft.enabled).toBe(false);
    const settings = { enabled: true, profiles: [draft] };
    expect(validateOrchestrationDraft(settings, choices)).toBeUndefined();
    draft.enabled = true;
    expect(validateOrchestrationDraft(settings, choices)?.key).toBe(
      "orchestration.roleRequired",
    );
  });

  it("validates non-selected profiles and requires a scoped enabled active default", () => {
    const choices = {
      claude: [{ id: "p", name: "P", models: ["m"], hasCatalog: true }],
      codex: [],
    };
    const draft = createOrchestrationDraft("draft", choices, "Draft", "");
    const settings = {
      enabled: true,
      profiles: [draft],
      activeProfileId: "draft",
      defaultModeByApp: { codex: "orchestrated" as const },
    };
    expect(validateOrchestrationDraft(settings, choices)?.key).toBe(
      "orchestration.defaultProfileRequired",
    );
    draft.enabled = true;
    draft.worker = draft.orchestrator;
    draft.scope = "claude";
    expect(validateOrchestrationDraft(settings, choices)?.key).toBe(
      "orchestration.defaultProfileRequired",
    );
    draft.scope = "all";
    expect(validateOrchestrationDraft(settings, choices)).toBeUndefined();
  });
});
