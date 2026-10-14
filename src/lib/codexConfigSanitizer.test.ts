import { describe, expect, it } from "vitest";
import type { CodexCatalogModel, CodexRoutingConfig } from "@/types";
import {
  buildCodexModelReferenceIndex,
  sanitizeCodexApiKeyGroups,
  sanitizeCodexProtocolOverrides,
  sanitizeCodexRoutingConfig,
} from "./codexConfigSanitizer";

const activeCatalog: CodexCatalogModel[] = [
  {
    model: "new-model",
    upstreamModel: "wire-new",
    canonicalSlug: "new-model",
    aliases: ["old-model"],
  },
  {
    model: "disabled-model",
    enabled: false,
  },
];

describe("codex config sanitizer", () => {
  it("migrates aliases and removes stale references across legacy routing", () => {
    const index = buildCodexModelReferenceIndex(activeCatalog);
    const routing = {
      enabled: true,
      modelOrder: ["OLD-MODEL", "removed-model", "new-model"],
      spawnAgentModels: ["removed-model", "old-model"],
      routes: [
        {
          id: "legacy",
          match: { models: ["old-model", "removed-model"] },
          upstream: {
            apiFormat: "openai_responses",
            auth: { source: "provider_config" },
            modelMap: {
              "OLD-MODEL": "old-model",
              "removed-model": "removed-model",
            },
          },
        },
      ],
      subagentV2: {
        schemaVersion: 2,
        selectionPolicy: "balanced",
        profiles: {
          "old-model": { model: "OLD-MODEL", enabled: true },
          "removed-model": { model: "removed-model", enabled: true },
        },
      },
    } as unknown as CodexRoutingConfig;

    const sanitized = sanitizeCodexRoutingConfig(routing, index) as any;
    expect(sanitized.modelOrder).toEqual(["new-model"]);
    expect(sanitized.spawnAgentModels).toEqual(["new-model"]);
    expect(sanitized.routes[0].match.models).toEqual(["new-model"]);
    expect(sanitized.routes[0].upstream.modelMap).toEqual({
      "new-model": "wire-new",
    });
    expect(sanitized.subagentV2.profiles).toEqual({
      "new-model": { model: "new-model", enabled: true },
    });
  });

  it("keeps valid custom legacy aliases while pruning stale targets", () => {
    const index = buildCodexModelReferenceIndex(activeCatalog);
    const routing = {
      routes: [
        {
          id: "legacy-aliases",
          match: { models: ["fast-new", "removed-alias"] },
          upstream: {
            modelMap: {
              "fast-new": "old-model",
              "removed-alias": "removed-model",
            },
          },
        },
      ],
    } as unknown as CodexRoutingConfig;

    const sanitized = sanitizeCodexRoutingConfig(routing, index) as any;
    expect(sanitized.routes[0].match.models).toEqual(["fast-new"]);
    expect(sanitized.routes[0].upstream.modelMap).toEqual({
      "fast-new": "wire-new",
    });
  });

  it("sanitizes schema-v2 selections and alias targets", () => {
    const index = buildCodexModelReferenceIndex(activeCatalog);
    const routing = {
      schemaVersion: 2,
      routes: [
        {
          id: "v2",
          targetProviderId: "provider",
          modelSelection: {
            mode: "include",
            models: ["old-model", "disabled-model"],
          },
          aliases: {
            "fast-new": "OLD-MODEL",
            "fast-removed": "removed-model",
          },
        },
      ],
    } as unknown as CodexRoutingConfig;

    const sanitized = sanitizeCodexRoutingConfig(routing, index) as any;
    expect(sanitized.routes[0].modelSelection.models).toEqual(["new-model"]);
    expect(sanitized.routes[0].aliases).toEqual({ "fast-new": "new-model" });
  });

  it("resolves v2 route references against their target rather than the router catalog", () => {
    const routerIndex = buildCodexModelReferenceIndex([
      { model: "model-provider-a", upstreamModel: "shared-wire" },
      { model: "model-provider-b", upstreamModel: "shared-wire" },
    ]);
    const targetIndexes = new Map([
      [
        "provider-a",
        buildCodexModelReferenceIndex([
          {
            model: "model-a",
            upstreamModel: "shared-wire",
            aliases: ["old-a"],
          },
        ]),
      ],
      ["provider-b", buildCodexModelReferenceIndex([])],
    ]);
    const routing = {
      schemaVersion: 2,
      modelOrder: ["model-provider-a", "model-provider-b", "removed"],
      routes: [
        {
          targetProviderId: "provider-a",
          modelSelection: { mode: "include", models: ["old-a", "removed"] },
          aliases: { "model-provider-a": "shared-wire" },
        },
        {
          targetProviderId: "provider-b",
          modelSelection: { mode: "include", models: ["model-b"] },
          aliases: { "model-provider-b": "shared-wire" },
        },
        {
          targetProviderId: "unloaded",
          modelSelection: { mode: "include", models: ["unknown"] },
        },
      ],
    } as unknown as CodexRoutingConfig;

    const sanitized = sanitizeCodexRoutingConfig(routing, routerIndex, (id) =>
      targetIndexes.get(id),
    ) as any;
    expect(sanitized.modelOrder).toEqual([
      "model-provider-a",
      "model-provider-b",
    ]);
    expect(sanitized.routes[0].modelSelection.models).toEqual(["model-a"]);
    expect(sanitized.routes[0].aliases).toEqual({
      "model-provider-a": "model-a",
    });
    expect(sanitized.routes[1].modelSelection.models).toEqual([]);
    expect(sanitized.routes[1].aliases).toEqual({});
    expect(sanitized.routes[2]).toEqual(routing.routes![2]);
  });

  it("migrates historical route aliases in include selections without reviving excluded targets", () => {
    const routing = {
      schemaVersion: 2,
      routes: [
        {
          enabled: true,
          modelSelection: {
            mode: "include",
            models: ["FAST", "hidden", "stale"],
          },
          aliases: {
            fast: "wire-new",
            hidden: "disabled-model",
            stale: "removed-model",
          },
        },
      ],
    } as unknown as CodexRoutingConfig;
    const sanitized = sanitizeCodexRoutingConfig(
      routing,
      buildCodexModelReferenceIndex(activeCatalog),
      undefined,
      { preserveUpstreamReferences: true },
    ) as any;
    expect(sanitized.routes[0]).toEqual({
      enabled: true,
      modelSelection: { mode: "include", models: ["new-model"] },
      aliases: { fast: "wire-new" },
    });
  });

  it("does not let a route alias override a canonical source model", () => {
    const routing = {
      schemaVersion: 2,
      routes: [
        {
          modelSelection: { mode: "include", models: ["new-model"] },
          aliases: { "new-model": "other-model" },
        },
      ],
    } as unknown as CodexRoutingConfig;
    const sanitized = sanitizeCodexRoutingConfig(
      routing,
      buildCodexModelReferenceIndex([
        ...activeCatalog,
        { model: "other-model" },
      ]),
    ) as any;
    expect(sanitized.routes[0].modelSelection.models).toEqual(["new-model"]);
    expect(sanitized.routes[0].aliases).toEqual({});
  });

  it("preserves valid upstream references for workspace saves while migrating historical aliases", () => {
    const index = buildCodexModelReferenceIndex(activeCatalog);
    const routing = {
      schemaVersion: 2,
      routes: [
        {
          modelSelection: {
            mode: "include",
            models: ["wire-new", "old-model", "removed-model"],
          },
          aliases: {
            fast: "wire-new",
            historical: "old-model",
            stale: "removed-model",
          },
        },
      ],
    } as unknown as CodexRoutingConfig;
    const sanitized = sanitizeCodexRoutingConfig(routing, index, undefined, {
      preserveUpstreamReferences: true,
    }) as any;
    expect(sanitized.routes[0].modelSelection.models).toEqual(["wire-new"]);
    expect(sanitized.routes[0].aliases).toEqual({
      fast: "wire-new",
      historical: "new-model",
    });
    expect(routing.routes![0]).toHaveProperty("aliases.stale", "removed-model");
  });

  it("retains canonical IDs when another catalog row shares their upstream name", () => {
    const index = buildCodexModelReferenceIndex([
      { model: "shared-wire" },
      { model: "relay-model", upstreamModel: "shared-wire" },
    ]);
    expect(index.resolve("shared-wire")).toBe("shared-wire");
    expect(index.resolve("relay-model")).toBe("relay-model");
    expect(index.upstreamFor("relay-model")).toBe("shared-wire");
  });

  it("disables include routes when every selected model becomes unavailable", () => {
    const routing = {
      schemaVersion: 2,
      routes: [
        {
          id: "removed",
          enabled: true,
          modelSelection: { mode: "include", models: ["removed-model"] },
          aliases: { fast: "removed-model" },
        },
        {
          id: "follow",
          enabled: true,
          modelSelection: { mode: "all" },
          aliases: { fast: "removed-model" },
        },
      ],
    } as unknown as CodexRoutingConfig;

    const sanitized = sanitizeCodexRoutingConfig(
      routing,
      buildCodexModelReferenceIndex([]),
    ) as any;
    expect(sanitized.routes[0]).toEqual({
      id: "removed",
      enabled: false,
      modelSelection: { mode: "include", models: [] },
      aliases: {},
    });
    expect(sanitized.routes[1]).toEqual({
      id: "follow",
      enabled: true,
      modelSelection: { mode: "all" },
      aliases: {},
    });
  });

  it("prunes ambiguous aliases without pruning either canonical model", () => {
    const index = buildCodexModelReferenceIndex([
      { model: "model-a", aliases: ["shared"] },
      { model: "model-b", aliases: ["shared"] },
    ]);
    expect(index.resolve("shared")).toBeUndefined();
    expect(index.resolve("model-a")).toBe("model-a");
    expect(index.resolve("model-b")).toBe("model-b");
  });

  it("does not keep aliases to models excluded from an explicit route selection", () => {
    const index = buildCodexModelReferenceIndex([
      { model: "included" },
      { model: "excluded" },
    ]);
    const routing = {
      schemaVersion: 2,
      routes: [
        {
          modelSelection: { mode: "include", models: ["included"] },
          aliases: { fast: "included", slow: "excluded" },
        },
      ],
    } as unknown as CodexRoutingConfig;
    expect(
      (sanitizeCodexRoutingConfig(routing, index) as any).routes[0].aliases,
    ).toEqual({ fast: "included" });
  });

  it("migrates protocol and API-key group references", () => {
    const index = buildCodexModelReferenceIndex(activeCatalog);
    expect(
      sanitizeCodexProtocolOverrides(
        {
          "OLD-MODEL": "openai_chat",
          "removed-model": "openai_responses",
        },
        index,
      ),
    ).toEqual({ "new-model": "openai_chat" });

    expect(
      sanitizeCodexApiKeyGroups(
        [
          {
            id: "group",
            apiKeys: ["key"],
            models: ["old-model", "removed-model"],
            prefixes: ["new-"],
          },
        ],
        index,
      ),
    ).toEqual([
      {
        id: "group",
        apiKeys: ["key"],
        models: ["wire-new"],
        prefixes: ["new-"],
      },
    ]);
  });

  it("keeps base identities resolvable when grouped picker rows inherit metadata", () => {
    const index = buildCodexModelReferenceIndex([
      ...activeCatalog,
      {
        ...activeCatalog[0],
        model: "new-model--ccg-group",
        apiKeyGroupId: "group",
        apiKeyGroupGenerated: true,
      },
    ]);

    expect(index.resolve("new-model")).toBe("new-model");
    expect(index.resolve("old-model")).toBe("new-model");
    expect(index.resolve("new-model--ccg-group")).toBe("new-model--ccg-group");
    expect(index.upstreamFor("new-model--ccg-group")).toBe("wire-new");
  });
});
