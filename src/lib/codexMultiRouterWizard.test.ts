import { describe, expect, it } from "vitest";
import type { Provider } from "@/types";
import {
  buildCodexMultiRouterWizardPlan,
  initialWizardCatalogModelOrder,
  initialWizardSelectedSourceIds,
  initialWizardSpawnAgentModels,
  isCodexMultiRouterPlan,
  mergeFetchedModelsIntoWizardProvider,
} from "./codexMultiRouterWizard";
import { isRoutingPlan } from "@/components/codex/CodexRouterWorkspacePage";

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

describe("wizard Sub-Agent selection authority", () => {
  it.each([{ models: [] }, { models: [{ model: "deepseek-v4-pro" }] }])(
    "does not resurrect legacy candidates when the canonical catalog has models %j",
    ({ models }) => {
      const plan: Provider = {
        id: "plan",
        name: "Plan",
        settingsConfig: {
          modelCatalog: { models },
          model_catalog: {
            models: [{ model: "deepseek-v4-pro" }],
            spawnAgentModels: ["deepseek-v4-pro"],
          },
        },
      };
      expect(initialWizardSpawnAgentModels(plan)).toEqual([]);
      expect(
        buildCodexMultiRouterWizardPlan(
          [deepseekSource, plan],
          [deepseekSource],
          plan,
        ).plan.settingsConfig.codexRouting.spawnAgentModels,
      ).toEqual([]);
    },
  );

  it("restores legacy candidates only when the canonical catalog is malformed", () => {
    expect(
      initialWizardSpawnAgentModels({
        id: "plan",
        name: "Plan",
        settingsConfig: {
          modelCatalog: { models: null },
          model_catalog: {
            models: [{ model: "deepseek-v4-pro" }],
            spawn_agent_models: ["deepseek-v4-pro"],
          },
        },
      }),
    ).toEqual(["deepseek-v4-pro"]);
  });

  it.each([
    { spawnAgentModels: undefined, expected: [] },
    { spawnAgentModels: [], expected: [] },
    { spawnAgentModels: "not-an-array", expected: [] },
    {
      spawnAgentModels: [null, 1, "deepseek-v4-pro"],
      expected: ["deepseek-v4-pro"],
    },
  ])(
    "takes v2 candidates from routing, not catalog snapshots: %j",
    ({ spawnAgentModels, expected }) => {
      expect(
        initialWizardSpawnAgentModels({
          id: "plan",
          name: "Plan",
          settingsConfig: {
            codexRouting: { schemaVersion: 2, spawnAgentModels },
            modelCatalog: {
              models: [{ model: "snapshot-model" }],
              spawnAgentModels: ["snapshot-model"],
            },
          },
        }),
      ).toEqual(expected);
    },
  );
});

describe("buildCodexMultiRouterWizardPlan subagent version", () => {
  it("keeps canonical official auth entirely out of the Router route", () => {
    const official: Provider = {
      id: "codex-official",
      name: "OpenAI Official",
      category: "official",
      settingsConfig: { modelCatalog: { models: [{ model: "gpt-5.6" }] } },
      meta: {
        codexOfficialAuth: { mode: "account_pool" },
      },
    };

    const { plan } = buildCodexMultiRouterWizardPlan(
      [official],
      [official],
      null,
    );
    expect(
      plan.settingsConfig.codexRouting.routes[0].authPolicy,
    ).toBeUndefined();
    expect(plan.settingsConfig.codexRouting).not.toHaveProperty("officialAuth");
  });

  it("restores model selection without collision aliases from unselected sources", () => {
    const unused = { ...deepseekSource, id: "unused-source", name: "Unused" };
    const plan: Provider = {
      id: "plan",
      name: "Plan",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            {
              id: "selected-route",
              targetProviderId: deepseekSource.id,
              modelSelection: { mode: "include", models: ["deepseek-v4-pro"] },
              authPolicy: { source: "provider_config" },
            },
          ],
        },
      },
    };
    expect(
      initialWizardCatalogModelOrder(plan, [deepseekSource, unused]),
    ).toEqual(["deepseek-v4-pro"]);
    plan.settingsConfig.codexRouting.routes.push({
      id: "disabled-route",
      targetProviderId: unused.id,
      enabled: false,
      modelSelection: { mode: "all" },
      authPolicy: { source: "provider_config" },
    });
    expect(
      initialWizardSelectedSourceIds(plan, [deepseekSource, unused]),
    ).toEqual([deepseekSource.id, unused.id]);
    expect(
      initialWizardCatalogModelOrder(plan, [deepseekSource, unused]),
    ).toEqual(["deepseek-v4-pro-deepseek"]);
  });
  it("does not classify protocol facade routing as a user MultiRouter", () => {
    const facade: Provider = {
      id: "any-source",
      name: "Not name based",
      settingsConfig: {
        codexProtocolSet: {
          version: 1,
          role: "facade",
          responsesProviderId: "r",
          chatProviderId: "c",
          sourceModelCatalog: { models: [{ model: "one" }] },
        },
        codexRouting: { enabled: true, routes: [{ id: "internal" }] },
      },
    };
    expect(isRoutingPlan(facade)).toBe(false);
    expect(isCodexMultiRouterPlan(facade)).toBe(false);
    const router = {
      ...facade,
      settingsConfig: { codexRouting: facade.settingsConfig.codexRouting },
    };
    expect(isRoutingPlan(router)).toBe(true);
    expect(isCodexMultiRouterPlan(router)).toBe(true);
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

  it("follows the current provider catalog after a model is removed", () => {
    const currentSource: Provider = {
      ...deepseekSource,
      settingsConfig: {
        ...deepseekSource.settingsConfig,
        modelCatalog: {
          models: [{ model: "deepseek-v4-flash" }],
        },
      },
    };
    const existingPlan: Provider = {
      id: "router-v2",
      name: "Router V2",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            { model: "deepseek-v4-flash" },
            { model: "removed-from-source" },
          ],
        },
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            {
              id: "deepseek",
              targetProviderId: currentSource.id,
              modelSelection: {
                mode: "include",
                models: ["deepseek-v4-flash", "removed-from-source"],
              },
              aliases: { removed: "removed-from-source" },
              authPolicy: { source: "provider_config" },
            },
          ],
        },
      },
    };

    const { plan, sourceProviders } = buildCodexMultiRouterWizardPlan(
      [currentSource, existingPlan],
      [currentSource],
      existingPlan,
      // `undefined` is the automatic-follow mode used by the wizard when its
      // state is `null`; it must not become a stale explicit allowlist.
      { catalogModelOrder: undefined },
    );

    expect(sourceProviders[0].settingsConfig.modelCatalog.models).toEqual([
      { model: "deepseek-v4-flash" },
    ]);
    expect(plan.settingsConfig.codexRouting.routes).toMatchObject([
      {
        targetProviderId: currentSource.id,
        modelSelection: { mode: "all" },
        aliases: {},
      },
    ]);
  });

  it("keeps a fixed catalog selection as an explicit route allowlist", () => {
    const source: Provider = {
      ...deepseekSource,
      settingsConfig: {
        ...deepseekSource.settingsConfig,
        modelCatalog: {
          models: [
            { model: "deepseek-v4-flash" },
            { model: "deepseek-v4-pro" },
          ],
        },
      },
    };

    const { plan, sourceProviders } = buildCodexMultiRouterWizardPlan(
      [source],
      [source],
      null,
      { catalogModelOrder: ["deepseek-v4-flash"] },
    );

    expect(sourceProviders[0].settingsConfig.modelCatalog.models).toEqual([
      { model: "deepseek-v4-flash" },
    ]);
    expect(plan.settingsConfig.codexRouting.routes[0].modelSelection).toEqual({
      mode: "include",
      models: ["deepseek-v4-flash"],
    });
  });

  it("disables models omitted by a successful refresh and drops them from spawn candidates", () => {
    const source: Provider = {
      ...deepseekSource,
      settingsConfig: {
        ...deepseekSource.settingsConfig,
        modelCatalog: {
          models: [
            { model: "deepseek-v4-flash" },
            { model: "deepseek-v4-pro" },
          ],
          spawnAgentModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
        },
      },
    };

    const refreshed = mergeFetchedModelsIntoWizardProvider(
      source,
      [{ id: "deepseek-v4-flash", ownedBy: null }],
      { preserveExistingSelection: true },
    );
    expect(refreshed.settingsConfig?.modelCatalog?.models).toEqual([
      expect.objectContaining({ model: "deepseek-v4-flash" }),
      expect.objectContaining({ model: "deepseek-v4-pro", enabled: false }),
    ]);
    expect(refreshed.settingsConfig?.modelCatalog?.spawnAgentModels).toEqual([
      "deepseek-v4-flash",
    ]);
  });

  it("keeps models from independent key groups during a single-key refresh", () => {
    const source: Provider = {
      ...deepseekSource,
      settingsConfig: {
        ...deepseekSource.settingsConfig,
        codexApiKeyGroups: [
          {
            id: "pro-key",
            apiKeys: ["other-key"],
            models: ["deepseek-v4-pro"],
          },
        ],
      },
    };
    const refreshed = mergeFetchedModelsIntoWizardProvider(source, [
      { id: "deepseek-v4-flash", ownedBy: null },
    ]);

    expect(refreshed.settingsConfig.modelCatalog.models).toEqual([
      { model: "deepseek-v4-flash" },
      { model: "deepseek-v4-pro" },
    ]);
  });

  it("writes only the canonical catalog while preserving fetched provider metadata", () => {
    const source: Provider = {
      ...deepseekSource,
      settingsConfig: {
        ...deepseekSource.settingsConfig,
        modelCatalog: undefined,
        model_catalog: {
          models: [
            {
              model: "public-model",
              upstreamModel: "wire-model",
              displayName: "My Model",
            },
          ],
        },
      },
    };

    const refreshed = mergeFetchedModelsIntoWizardProvider(source, [
      {
        id: "provider-model",
        ownedBy: null,
        upstreamModel: "wire-model",
        displayName: "Provider Model",
        canonicalSlug: "provider-family",
        aliases: { "previous-model": "provider-model" },
      },
    ]);

    expect(refreshed.settingsConfig).not.toHaveProperty("model_catalog");
    expect(refreshed.settingsConfig.modelCatalog.models).toEqual([
      expect.objectContaining({
        model: "public-model",
        upstreamModel: "wire-model",
        displayName: "My Model",
        canonicalSlug: "provider-family",
        aliases: { "previous-model": "provider-model" },
      }),
    ]);
    expect(source.settingsConfig).toHaveProperty("model_catalog");
  });

  it("restores mixed route selections only from current included source catalogs", () => {
    const source = {
      ...deepseekSource,
      settingsConfig: {
        modelCatalog: {
          models: [
            { model: "deepseek-v4-flash" },
            { model: "deepseek-v4-pro", enabled: false },
          ],
        },
      },
    };
    const otherSource: Provider = {
      id: "other-source",
      name: "Other",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "kept" }, { model: "not-selected" }],
        },
      },
    };
    const plan: Provider = {
      id: "plan",
      name: "Plan",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "removed-model" }, { model: "deepseek-v4-pro" }],
        },
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          modelOrder: ["removed-model", "deepseek-v4-pro"],
          routes: [
            {
              id: "follow",
              targetProviderId: source.id,
              modelSelection: { mode: "all" },
              match: { models: ["removed-model", "deepseek-v4-pro"] },
            },
            {
              id: "selected",
              targetProviderId: otherSource.id,
              modelSelection: {
                mode: "include",
                models: ["kept", "removed-model"],
              },
              match: { models: ["not-selected"] },
            },
          ],
        },
      },
    };

    expect(initialWizardCatalogModelOrder(plan, [source, otherSource])).toEqual(
      ["deepseek-v4-flash", "kept"],
    );
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
