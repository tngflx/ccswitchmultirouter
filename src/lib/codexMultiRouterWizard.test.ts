import { describe, expect, it } from "vitest";
import type { CodexModelReasoningCapability, Provider } from "@/types";
import {
  buildCodexMultiRouterWizardPlan,
  buildWizardModelCatalog,
  buildWizardRoutesFromSources,
  canonicalizeWizardProviderModels,
  initialWizardCatalogModelOrder,
  initialWizardSelectedSourceIds,
  mergeFetchedModelsIntoWizardProvider,
  resolveWizardModelNameCollisions,
} from "./codexMultiRouterWizard";

const deepseekSource: Provider = {
  id: "deepseek-source",
  name: "DeepSeek",
  category: "custom",
  settingsConfig: {
    baseUrl: "https://example.invalid/v1",
    auth: { OPENAI_API_KEY: "test-only" },
    modelCatalog: {
      models: [{ model: "deepseek-v4-flash" }, { model: "deepseek-v4-pro" }],
    },
  },
};

describe("mergeFetchedModelsIntoWizardProvider", () => {
  it("deduplicates case/whitespace variants without losing fetched metadata", () => {
    const models = canonicalizeWizardProviderModels([
      { model: " GPT-5 ", upstreamModel: "gpt-5" },
      { model: "gpt-5", upstreamModel: "GPT-5", contextWindow: 128000 },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]?.model).toBe("GPT-5");
    expect(models[0]?.contextWindow).toBe(128000);
  });

  it("persists reasoning capability metadata returned by model discovery", () => {
    const reasoning: CodexModelReasoningCapability = {
      schemaVersion: 2,
      supportStatus: "confirmed_supported",
      controlKind: "graded",
      supportedEfforts: ["low", "high", "max"],
      defaultEffort: "high",
      disableAllowed: false,
      upstream: {
        format: "string",
        parameter: "reasoning_effort",
        effortMap: {},
      },
      source: "provider",
    };

    const merged = mergeFetchedModelsIntoWizardProvider(
      {
        ...deepseekSource,
        settingsConfig: {
          ...deepseekSource.settingsConfig,
          modelCatalog: {
            models: [{ model: "deepseek-v4-flash" }],
          },
        },
      },
      [
        {
          id: "deepseek-v4-flash",
          ownedBy: "provider",
          reasoning,
        },
      ],
      { preserveExistingSelection: true },
    );

    expect(merged.settingsConfig.modelCatalog?.models[0]?.reasoning).toEqual(
      reasoning,
    );
  });

  it("does not duplicate fetched rows when the endpoint repeats an id with different casing", () => {
    const merged = mergeFetchedModelsIntoWizardProvider(
      {
        ...deepseekSource,
        settingsConfig: {
          ...deepseekSource.settingsConfig,
          modelCatalog: { models: [] },
        },
      },
      [
        { id: "DeepSeek-V4-Flash", ownedBy: "provider" },
        { id: "deepseek-v4-flash", ownedBy: "provider" },
      ],
    );
    expect(merged.settingsConfig.modelCatalog?.models).toHaveLength(1);
  });
});

describe("wizard mixed-provider catalog identity", () => {
  it("does not turn unrelated manual rows into remote-bound rows on save", () => {
    const source: Provider = {
      ...deepseekSource,
      settingsConfig: {
        ...deepseekSource.settingsConfig,
        modelCatalog: { models: [{ model: "manual-custom" }] },
      },
    };
    const result = buildCodexMultiRouterWizardPlan([source], [source]);
    expect(
      result.persistedSourceProviders[0].settingsConfig.modelCatalog?.models,
    ).toEqual([{ model: "manual-custom" }]);
  });

  it("repairs a previously saved alias using the route's canonical target", () => {
    const relay: Provider = {
      ...deepseekSource,
      id: "sublyx",
      name: "Sublyx",
      settingsConfig: {
        ...deepseekSource.settingsConfig,
        modelCatalog: { models: [{ model: "gpt-5.6-sol-sublyx" }] },
      },
    };
    const plan: Provider = {
      id: "router",
      name: "Router",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            {
              id: "relay-route",
              targetProviderId: "sublyx",
              modelSelection: { mode: "all" },
              aliases: { "gpt-5.6-sol-sublyx": "gpt-5.6-sol" },
            },
          ],
        },
      },
    };

    const result = buildCodexMultiRouterWizardPlan(
      [relay, plan],
      [relay],
      plan,
    );
    expect(
      result.persistedSourceProviders[0].settingsConfig.modelCatalog?.models[0],
    ).toMatchObject({
      model: "gpt-5.6-sol-sublyx",
      upstreamModel: "gpt-5.6-sol",
    });
  });

  it("persists collision aliases with their upstream ids without dropping excluded rows", () => {
    const left: Provider = {
      ...deepseekSource,
      id: "official",
      name: "Official",
      settingsConfig: {
        ...deepseekSource.settingsConfig,
        modelCatalog: { models: [{ model: "gpt-5.6-sol" }] },
      },
    };
    const relay: Provider = {
      ...deepseekSource,
      id: "sublyx",
      name: "Sublyx",
      settingsConfig: {
        ...deepseekSource.settingsConfig,
        modelCatalog: {
          models: [
            { model: "gpt-5.6-sol" },
            { model: "excluded", enabled: false },
          ],
          spawnAgentModels: ["gpt-5.6-sol"],
        },
      },
    };

    const result = buildCodexMultiRouterWizardPlan(
      [left, relay],
      [left, relay],
      null,
      { catalogModelOrder: ["gpt-5.6-sol", "gpt-5.6-sol-sublyx"] },
    );
    const stored = result.persistedSourceProviders.find(
      (provider) => provider.id === "sublyx",
    );
    expect(stored?.settingsConfig.modelCatalog?.models).toEqual([
      expect.objectContaining({
        model: "gpt-5.6-sol-sublyx",
        upstreamModel: "gpt-5.6-sol",
      }),
      { model: "excluded", enabled: false },
    ]);
    expect(stored?.settingsConfig.modelCatalog?.spawnAgentModels).toEqual([
      "gpt-5.6-sol-sublyx",
    ]);
    expect(
      result.sourceProviders.find((source) => source.id === "sublyx")
        ?.settingsConfig.modelCatalog?.models[0],
    ).toMatchObject({
      model: "gpt-5.6-sol-sublyx",
      upstreamModel: "gpt-5.6-sol",
    });
    expect(
      result.plan.settingsConfig.codexRouting?.routes?.find(
        (route: { targetProviderId?: string }) =>
          route.targetProviderId === "sublyx",
      )?.aliases,
    ).toMatchObject({ "gpt-5.6-sol-sublyx": "gpt-5.6-sol" });
  });

  it("keeps distinct models that collide on visible names and routes aliases to upstream ids", () => {
    const left: Provider = {
      ...deepseekSource,
      id: "left",
      name: "Left",
      settingsConfig: {
        ...deepseekSource.settingsConfig,
        modelCatalog: { models: [{ model: "shared", upstreamModel: "alpha" }] },
      },
    };
    const right: Provider = {
      ...deepseekSource,
      id: "right",
      name: "Right",
      settingsConfig: {
        ...deepseekSource.settingsConfig,
        modelCatalog: { models: [{ model: "shared", upstreamModel: "beta" }] },
      },
    };
    const resolved = resolveWizardModelNameCollisions([left, right]);
    const models = resolved.flatMap(
      (provider) => provider.settingsConfig.modelCatalog?.models ?? [],
    );
    expect(new Set(models.map((model) => model.model.toLowerCase())).size).toBe(
      2,
    );
    const routes = buildWizardRoutesFromSources(resolved);
    const rightRoute = routes.find(
      (route) => route.targetProviderId === "right",
    );
    expect(rightRoute?.aliases).toMatchObject({ "beta-right": "beta" });
    expect(buildWizardModelCatalog(resolved).models).toHaveLength(2);
  });

  it("qualifies a stale explicit alias when it collides across provider routes", () => {
    const left: Provider = {
      ...deepseekSource,
      id: "left",
      name: "Left",
      settingsConfig: {
        ...deepseekSource.settingsConfig,
        modelCatalog: { models: [{ model: "shared", upstreamModel: "alpha" }] },
      },
    };
    const right: Provider = {
      ...deepseekSource,
      id: "right",
      name: "Right",
      settingsConfig: {
        ...deepseekSource.settingsConfig,
        modelCatalog: { models: [{ model: "shared", upstreamModel: "alpha" }] },
      },
    };
    const resolved = resolveWizardModelNameCollisions(
      [left, right],
      [
        {
          id: "left-route",
          targetProviderId: "left",
          modelSelection: { mode: "all" },
          aliases: {},
        },
        {
          id: "right-route",
          targetProviderId: "right",
          modelSelection: { mode: "all" },
          aliases: { shared: "alpha" },
        },
      ],
    );
    const models = resolved.flatMap(
      (provider) => provider.settingsConfig.modelCatalog?.models ?? [],
    );
    expect(new Set(models.map((model) => model.model.toLowerCase())).size).toBe(
      2,
    );
    expect(models.map((model) => model.model.toLowerCase())).toEqual([
      "alpha-left",
      "shared",
    ]);
  });
});

describe("buildCodexMultiRouterWizardPlan subagent version", () => {
  it("persists an explicit wizard model order in the router document", () => {
    const { plan } = buildCodexMultiRouterWizardPlan(
      [deepseekSource],
      [deepseekSource],
      null,
      { catalogModelOrder: ["deepseek-v4-pro", "deepseek-v4-flash"] },
    );

    expect(plan.settingsConfig.codexRouting.modelOrder).toEqual([
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ]);
  });

  it("rehydrates saved order and appends newly available models", () => {
    const source = {
      ...deepseekSource,
      settingsConfig: {
        ...deepseekSource.settingsConfig,
        modelCatalog: {
          models: [
            { model: "deepseek-v4-flash" },
            { model: "deepseek-v4-pro" },
            { model: "deepseek-v4-vision" },
          ],
        },
      },
    };
    const existingPlan: Provider = {
      id: "router-v2",
      name: "Router V2",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          modelOrder: ["deepseek-v4-pro", "removed-model"],
          routes: [],
        },
      },
    };

    expect(initialWizardCatalogModelOrder(existingPlan, [source])).toEqual([
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek-v4-vision",
    ]);
  });

  it("clears a prior custom order when wizard follows provider order", () => {
    const existingPlan: Provider = {
      id: "router-v2",
      name: "Router V2",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          modelOrder: ["deepseek-v4-pro", "deepseek-v4-flash"],
          routes: [],
        },
      },
    };
    const { plan } = buildCodexMultiRouterWizardPlan(
      [deepseekSource, existingPlan],
      [deepseekSource],
      existingPlan,
      { clearModelOrder: true },
    );

    expect(plan.settingsConfig.codexRouting).not.toHaveProperty("modelOrder");
  });

  it("initializes an existing schema-v2 plan from its route Provider ids", () => {
    const unusedSource: Provider = {
      ...deepseekSource,
      id: "unused-source",
      name: "Unused",
    };
    const existingPlan: Provider = {
      id: "router-v2",
      name: "Router V2",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            {
              id: "deepseek",
              enabled: true,
              targetProviderId: deepseekSource.id,
              modelSelection: { mode: "all" },
              authPolicy: { source: "provider_config" },
            },
            {
              id: "missing",
              enabled: true,
              targetProviderId: "missing-source",
              modelSelection: { mode: "all" },
              authPolicy: { source: "provider_config" },
            },
          ],
        },
      },
    };

    expect(
      initialWizardSelectedSourceIds(existingPlan, [
        deepseekSource,
        unusedSource,
      ]),
    ).toEqual([deepseekSource.id]);
  });

  it("selects every available Provider when creating a new plan", () => {
    const secondSource: Provider = {
      ...deepseekSource,
      id: "second-source",
    };

    expect(
      initialWizardSelectedSourceIds(null, [deepseekSource, secondSource]),
    ).toEqual([deepseekSource.id, secondSource.id]);
  });

  it("persists an explicit V1 selection without dropping its direct model overrides", () => {
    const { plan } = buildCodexMultiRouterWizardPlan(
      [deepseekSource],
      [deepseekSource],
      null,
      {
        subagentVersion: "v1",
        spawnAgentModels: ["deepseek-v4-pro"],
      } as never,
    );

    expect(plan.settingsConfig.codexRouting.subagentVersion).toBe("v1");
    expect(plan.settingsConfig.codexRouting.spawnAgentModels).toEqual([
      "deepseek-v4-pro",
    ]);
  });

  it("writes V2 when a legacy plan has no explicit subagent version", () => {
    const legacyPlan: Provider = {
      id: "legacy-router",
      name: "Legacy Router",
      category: "custom",
      settingsConfig: {
        codexRouting: { enabled: true, routes: [] },
        modelCatalog: {
          models: [{ model: "deepseek-v4-pro" }],
          spawnAgentModels: ["deepseek-v4-pro"],
        },
      },
    };

    const { plan } = buildCodexMultiRouterWizardPlan(
      [deepseekSource, legacyPlan],
      [deepseekSource],
      legacyPlan,
    );

    expect(plan.settingsConfig.codexRouting.subagentVersion).toBe("v2");
    expect(plan.settingsConfig.codexRouting.spawnAgentModels).toEqual([
      "deepseek-v4-pro",
    ]);
  });

  it("keeps schema-v2 all-selection in automatic-follow mode instead of freezing Provider facts", () => {
    const source: Provider = {
      ...deepseekSource,
      settingsConfig: {
        ...deepseekSource.settingsConfig,
        modelCatalog: {
          models: [
            { model: "deepseek-v4-flash" },
            { model: "deepseek-v4-pro" },
            { model: "deepseek-v4-vision" },
          ],
        },
      },
    };
    const existingPlan: Provider = {
      id: "router-v2",
      name: "Router V2",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "deepseek-v4-flash" }],
          spawnAgentModels: ["stale-router-candidate"],
        },
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          spawnAgentModels: ["deepseek-v4-pro"],
          routes: [
            {
              id: "deepseek",
              enabled: true,
              targetProviderId: source.id,
              modelSelection: { mode: "all" },
              authPolicy: { source: "provider_config" },
            },
          ],
        },
      },
    };

    const order = initialWizardCatalogModelOrder(existingPlan, [source]);
    expect(order).toBeNull();
    const { plan } = buildCodexMultiRouterWizardPlan(
      [source, existingPlan],
      [source],
      existingPlan,
      { catalogModelOrder: order ?? undefined },
    );

    expect(plan.settingsConfig.codexRouting.routes[0].modelSelection).toEqual({
      mode: "all",
    });
    expect(plan.settingsConfig.codexRouting.spawnAgentModels).toEqual([
      "deepseek-v4-pro",
    ]);
    expect(plan.settingsConfig).not.toHaveProperty("modelCatalog");
    expect(plan.settingsConfig).not.toHaveProperty("model_catalog");
  });
});

describe("buildCodexMultiRouterWizardPlan subagent profile rekey", () => {
  const legacyAlias = "shared-model-old-a";
  const nextAlias = "shared-model-vendor-a";

  function source(id: string, name: string): Provider {
    return {
      id,
      name,
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "shared-model" }] },
      },
    };
  }

  function existingPlanWith(
    profiles: Record<string, Record<string, unknown>>,
    spawnAgentModels: string[] = [legacyAlias],
  ): Provider {
    return {
      id: "router-existing",
      name: "Router Existing",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          subagentVersion: "v2",
          routes: [
            {
              id: "vendor-a",
              enabled: true,
              targetProviderId: "vendor-a",
              modelSelection: { mode: "all" },
              aliases: { [legacyAlias]: "shared-model" },
              authPolicy: { source: "provider_config" },
            },
          ],
          subagentV2: {
            schemaVersion: 2,
            selectionPolicy: "balanced",
            profiles,
          },
          spawnAgentModels,
        },
      },
    };
  }

  it("rekeys a stale profile and spawn candidate to the rebuilt visible alias", () => {
    const legacyProfile = {
      model: legacyAlias,
      enabled: true,
      questionnaire: {
        taskStrengths: ["testing"],
        optimization: "quality",
        writeScope: "complex_changes",
        preference: "preferred",
      },
      reasoning: { policy: "fixed", effort: "high" },
    };
    const result = buildCodexMultiRouterWizardPlan(
      [source("vendor-a", "Vendor A"), source("vendor-b", "Vendor B")],
      [source("vendor-a", "Vendor A"), source("vendor-b", "Vendor B")],
      existingPlanWith({ [legacyAlias]: legacyProfile }),
    );
    const routing = result.plan.settingsConfig.codexRouting as Record<
      string,
      any
    >;

    expect(routing.subagentV2.profiles[nextAlias]).toMatchObject({
      model: nextAlias,
      enabled: true,
      reasoning: { policy: "fixed", effort: "high" },
    });
    expect(routing.subagentV2.profiles[legacyAlias]).toBeUndefined();
    expect(routing.spawnAgentModels).toContain(nextAlias);
  });

  it("preserves both profiles when the rebuilt alias is already occupied", () => {
    const result = buildCodexMultiRouterWizardPlan(
      [source("vendor-a", "Vendor A"), source("vendor-b", "Vendor B")],
      [source("vendor-a", "Vendor A"), source("vendor-b", "Vendor B")],
      existingPlanWith({
        [legacyAlias]: { model: legacyAlias, enabled: true },
        [nextAlias]: { model: nextAlias, enabled: false },
      }),
    );
    const profiles = (
      result.plan.settingsConfig.codexRouting as Record<string, any>
    ).subagentV2.profiles;

    expect(profiles[legacyAlias]).toMatchObject({ enabled: true });
    expect(profiles[nextAlias]).toMatchObject({ enabled: false });
  });

  it("preserves an unrelated profile for later catalog reconciliation", () => {
    const removedProfile = { model: "removed-model", enabled: false };
    const result = buildCodexMultiRouterWizardPlan(
      [source("vendor-a", "Vendor A"), source("vendor-b", "Vendor B")],
      [source("vendor-a", "Vendor A"), source("vendor-b", "Vendor B")],
      existingPlanWith({ "removed-model": removedProfile }),
    );
    const profiles = (
      result.plan.settingsConfig.codexRouting as Record<string, any>
    ).subagentV2.profiles;

    expect(profiles["removed-model"]).toEqual(removedProfile);
  });
});
