import { describe, expect, it } from "vitest";
import {
  isCompleteCodexCatalogFetch,
  pruneMissingRemoteCodexCatalogRows,
  reconcileFetchedCodexCatalogRows,
} from "./codexCatalogReconciliation";
import type { CodexCatalogRowLike } from "./codexCatalogReconciliation";
import type { CodexModelReasoningCapability } from "@/types";

const createRow = (seed: Record<string, unknown>): CodexCatalogRowLike =>
  ({
    model: String(seed.model ?? ""),
    displayName: String(seed.displayName ?? seed.model ?? ""),
    enabled: seed.enabled !== false,
    ...seed,
  }) as CodexCatalogRowLike;

describe("reconcileFetchedCodexCatalogRows", () => {
  it("matches aliases and preserves an explicit disabled choice", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [
        createRow({
          model: "visible",
          upstreamModel: "upstream",
          enabled: false,
        }),
      ],
      [{ id: "upstream", aliases: ["visible-alias"], supportsImage: true }],
      {},
      { appendNew: true, createRow },
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].enabled).toBe(false);
    expect(result.rows[0].supportsImage).toBe(true);
  });

  it("does not bind a manually maintained row when its visible name is fetched", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [createRow({ model: "manual-model" })],
      [{ id: "manual-model", supportsImage: false }],
      {},
      { appendNew: true, createRow },
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].upstreamModel).toBeUndefined();
  });

  it("appends newly discovered inventory as disabled", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [],
      [{ id: "new-model", inputModalities: ["text", "image"] }],
      {},
      { appendNew: true, createRow },
    );
    expect(result.added).toBe(1);
    expect(result.rows[0]).toMatchObject({
      model: "new-model",
      enabled: false,
      supportsImage: true,
    });
  });

  it("keeps provider identity metadata and an explicit wire binding on discovered models", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [],
      [
        {
          id: "provider-model",
          upstreamModel: "wire-model",
          displayName: "Provider Model",
          canonicalSlug: "canonical-family",
          slug: "catalog-slug",
          name: "provider-record",
          aliases: { "previous-model": "provider-model" },
        },
      ],
      {},
      { appendNew: true, createRow },
    );

    expect(result.rows).toEqual([
      expect.objectContaining({
        model: "provider-model",
        upstreamModel: "wire-model",
        displayName: "Provider Model",
        canonicalSlug: "canonical-family",
        slug: "catalog-slug",
        name: "provider-record",
        aliases: { "previous-model": "provider-model" },
        enabled: false,
      }),
    ]);
  });

  it("preserves an explicit false parallel-tool declaration through catalog refresh", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [createRow({ model: "wire-model", supportsParallelToolCalls: true })],
      [{ id: "wire-model", supportsParallelToolCalls: false }],
      {},
      { appendNew: true, createRow, existingMetadataMode: "refresh" },
    );
    expect(result.rows[0].supportsParallelToolCalls).toBe(true);

    const missing = reconcileFetchedCodexCatalogRows(
      [createRow({ model: "wire-model" })],
      [{ id: "wire-model", supportsParallelToolCalls: false }],
      {},
      { appendNew: true, createRow, existingMetadataMode: "refresh" },
    );
    expect(missing.rows[0].supportsParallelToolCalls).toBe(false);
    expect(missing.rows[0].supports_parallel_tool_calls).toBe(false);
  });

  it.each([
    { inputModalities: ["text"], supportsImage: false },
    { input_modalities: ["text"], supports_image: false },
    { inputModalities: ["text"] },
    { input_modalities: ["text"] },
    { supportsImage: false },
    { supports_image: false },
    { vision: false },
    { textOnly: true },
    { text_only: true },
  ])(
    "preserves explicit text-only capabilities when filling missing fields: %o",
    (seed) => {
      const row = createRow({ model: "wire-model", ...seed });
      const result = reconcileFetchedCodexCatalogRows(
        [row],
        [
          {
            id: "wire-model",
            inputModalities: ["text", "image"],
            supportsImage: true,
          },
        ],
        {},
        { appendNew: true, createRow, existingMetadataMode: "fill-missing" },
      );

      expect(result.rows[0]).toMatchObject(seed);
      expect(
        result.rows[0].inputModalities ?? result.rows[0].input_modalities ?? [],
      ).not.toContain("image");
      expect(
        result.rows[0].supportsImage ??
          result.rows[0].supports_image ??
          result.rows[0].vision,
      ).not.toBe(true);
    },
  );

  it("continues refreshing explicit modality capabilities in authoritative metadata mode", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [
        createRow({
          model: "wire-model",
          input_modalities: ["text"],
          supports_image: false,
        }),
      ],
      [
        {
          id: "wire-model",
          inputModalities: ["text", "image"],
          supportsImage: true,
        },
      ],
      {},
      { appendNew: true, createRow, existingMetadataMode: "refresh" },
    );

    expect(result.rows[0]).toMatchObject({
      inputModalities: ["text", "image"],
      input_modalities: ["text", "image"],
      supportsImage: true,
      supports_image: true,
    });
  });

  it.each([true, false])(
    "refreshes every existing image capability alias to %s together",
    (supportsImage) => {
      const result = reconcileFetchedCodexCatalogRows(
        [
          createRow({
            model: "wire-model",
            inputModalities: supportsImage ? ["text"] : ["text", "image"],
            input_modalities: supportsImage ? ["text"] : ["text", "image"],
            supportsImage: !supportsImage,
            supports_image: !supportsImage,
            vision: !supportsImage,
            textOnly: supportsImage,
            text_only: supportsImage,
          }),
        ],
        [
          {
            id: "wire-model",
            inputModalities: supportsImage ? ["text", "image"] : ["text"],
            supportsImage,
          },
        ],
        {},
        { appendNew: true, createRow, existingMetadataMode: "refresh" },
      );

      expect(result.rows[0]).toMatchObject({
        inputModalities: supportsImage ? ["text", "image"] : ["text"],
        input_modalities: supportsImage ? ["text", "image"] : ["text"],
        supportsImage,
        supports_image: supportsImage,
        vision: supportsImage,
        textOnly: !supportsImage,
        text_only: !supportsImage,
      });
    },
  );

  it.each([true, false])(
    "reconciles retained input modalities when only image support refreshes to %s",
    (supportsImage) => {
      const result = reconcileFetchedCodexCatalogRows(
        [
          createRow({
            model: "wire-model",
            input_modalities: supportsImage
              ? ["text", "audio"]
              : ["text", "image", "audio"],
            supports_image: !supportsImage,
            text_only: supportsImage,
          }),
        ],
        [{ id: "wire-model", supportsImage }],
        {},
        { appendNew: true, createRow, existingMetadataMode: "refresh" },
      );

      const modalities = supportsImage
        ? ["text", "audio", "image"]
        : ["text", "audio"];
      expect(result.rows[0]).toMatchObject({
        inputModalities: modalities,
        input_modalities: modalities,
        supportsImage,
        supports_image: supportsImage,
        text_only: !supportsImage,
      });
    },
  );

  it("hydrates an absent provider label while keeping a custom label and enabled choice", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [
        createRow({
          model: "public-model",
          upstreamModel: "wire-model",
          displayName: "",
        }),
        createRow({
          model: "custom-model",
          upstreamModel: "other-wire-model",
          displayName: "My Custom Label",
          enabled: false,
        }),
      ],
      [
        { id: "wire-model", displayName: "Provider Model" },
        { id: "other-wire-model", displayName: "Other Provider Model" },
      ],
      {},
      { appendNew: true, createRow, existingMetadataMode: "refresh" },
    );

    expect(result.rows).toEqual([
      expect.objectContaining({
        model: "public-model",
        upstreamModel: "wire-model",
        displayName: "Provider Model",
      }),
      expect.objectContaining({
        model: "custom-model",
        upstreamModel: "other-wire-model",
        displayName: "My Custom Label",
        enabled: false,
      }),
    ]);
  });

  it("does not replace persisted aliases that may represent user intent during refresh", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [
        createRow({
          model: "visible-model",
          upstreamModel: "wire-model",
          aliases: { "my-alias": "wire-model" },
        }),
      ],
      [
        {
          id: "wire-model",
          aliases: { "provider-alias": "wire-model" },
        },
      ],
      {},
      { appendNew: true, createRow, existingMetadataMode: "refresh" },
    );

    expect(result.rows[0].aliases).toEqual({ "my-alias": "wire-model" });
  });

  it("refreshes a renamed upstream binding only when the provider advertises the old identity", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [
        createRow({
          model: "my-public-alias",
          upstreamModel: "previous-wire-model",
          displayName: "My Model",
        }),
      ],
      [
        {
          id: "current-wire-model",
          canonicalSlug: "catalog-family-only",
          aliases: ["previous-wire-model"],
        },
      ],
      {},
      { appendNew: true, createRow, existingMetadataMode: "refresh" },
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      model: "my-public-alias",
      upstreamModel: "current-wire-model",
      displayName: "My Model",
      canonicalSlug: "catalog-family-only",
    });
  });

  it("refreshes every visible alias bound to the same upstream model", () => {
    const capability = {
      schemaVersion: 1 as const,
      source: "provider_api" as const,
      baseUrl: "https://relay.example/v1",
      upstreamModel: "wire",
      supportedEndpoints: ["openai_responses" as const],
    };
    const reasoning: CodexModelReasoningCapability = {
      schemaVersion: 2,
      supportStatus: "confirmed_supported",
      controlKind: "graded",
      supportedEfforts: ["high", "xhigh", "max"],
      disableAllowed: false,
      upstream: { format: "reasoning_object", parameter: "reasoning.effort" },
      source: "detection",
    };
    const result = reconcileFetchedCodexCatalogRows(
      [
        createRow({
          model: "alias-one",
          upstreamModel: "wire",
          protocolCapability: { ...capability, supportedEndpoints: [] },
        }),
        createRow({
          model: "alias-two",
          upstreamModel: "wire",
          displayName: "My second alias",
          enabled: false,
          protocolCapability: { ...capability, supportedEndpoints: [] },
        }),
      ],
      [
        {
          id: "wire",
          contextWindow: 128000,
          reasoning,
          protocolCapability: capability,
        },
      ],
      { baseUrl: capability.baseUrl },
      {
        appendNew: true,
        createRow,
        existingMetadataMode: "refresh",
        removeMissingRemote: true,
      },
    );

    expect(result.added).toBe(0);
    expect(result.hydrated).toBe(2);
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row).toMatchObject({
        upstreamModel: "wire",
        contextWindow: "128000",
        reasoning,
        protocolCapability: capability,
      });
    }
    expect(result.rows[1]).toMatchObject({
      model: "alias-two",
      displayName: "My second alias",
      enabled: false,
    });
  });

  it.each([false, true])(
    "keeps an exact upstream ID authoritative over another model's alias (reverse=%s)",
    (reverse) => {
      const fetched = [
        { id: "old", contextWindow: 128000 },
        { id: "new", aliases: ["old"], contextWindow: 256000 },
      ];
      const result = reconcileFetchedCodexCatalogRows(
        [createRow({ model: "favorite", upstreamModel: "old" })],
        reverse ? [...fetched].reverse() : fetched,
        {},
        { appendNew: true, createRow, existingMetadataMode: "refresh" },
      );

      expect(result.rows).toEqual([
        expect.objectContaining({
          model: "favorite",
          upstreamModel: "old",
          contextWindow: "128000",
        }),
        expect.objectContaining({
          model: "new",
          upstreamModel: "new",
          contextWindow: "256000",
          enabled: false,
        }),
      ]);
      expect(result.added).toBe(1);
    },
  );

  it.each([false, true])(
    "does not retarget a binding claimed by multiple provider aliases (reverse=%s)",
    (reverse) => {
      const fetched = [
        { id: "new-one", aliases: ["old"], contextWindow: 128000 },
        { id: "new-two", aliases: ["old"], contextWindow: 256000 },
      ];
      const result = reconcileFetchedCodexCatalogRows(
        [
          createRow({
            model: "favorite",
            upstreamModel: "old",
            contextWindow: "64000",
          }),
        ],
        reverse ? [...fetched].reverse() : fetched,
        {},
        { appendNew: true, createRow, existingMetadataMode: "refresh" },
      );

      expect(result.rows[0]).toMatchObject({
        model: "favorite",
        upstreamModel: "old",
        contextWindow: "64000",
      });
      expect(result.rows.map((row) => row.model).sort()).toEqual([
        "favorite",
        "new-one",
        "new-two",
      ]);
      expect(result.added).toBe(2);
      expect(result.hydrated).toBe(0);
    },
  );

  it("never rewrites a wire binding to a canonical catalog slug", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [createRow({ model: "my-public-alias", upstreamModel: "wire-model" })],
      [{ id: "wire-model", canonicalSlug: "catalog-family-only" }],
      {},
      { appendNew: true, createRow, existingMetadataMode: "refresh" },
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].upstreamModel).toBe("wire-model");
  });

  it("infers known context and refreshes provider-owned metadata without replacing user fields", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [
        createRow({
          model: "deepseek-chat",
          displayName: "My DeepSeek",
          contextWindow: "64000",
          reasoning: { source: "user", supportStatus: "unknown" },
        }),
      ],
      [
        {
          id: "deepseek-chat",
          inputModalities: ["text", "image"],
          supportsImage: true,
          reasoning: {
            schemaVersion: 2,
            supportStatus: "confirmed_supported",
            controlKind: "graded",
            supportedEfforts: ["low"],
            disableAllowed: false,
            upstream: {
              format: "reasoning_object",
              parameter: "reasoning.effort",
            },
            source: "protocol",
          },
        },
      ],
      {},
      { appendNew: true, createRow, existingMetadataMode: "refresh" },
    );
    expect(result.rows[0]).toMatchObject({
      model: "deepseek-chat",
      displayName: "My DeepSeek",
      contextWindow: "64000",
      supportsImage: true,
    });
    expect(result.rows[0].reasoning?.source).toBe("user");
  });

  it("refreshes automatic reasoning metadata while preserving an explicit user declaration", () => {
    const fetchedReasoning: CodexModelReasoningCapability = {
      schemaVersion: 2,
      supportStatus: "confirmed_supported",
      controlKind: "graded",
      supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"],
      disableAllowed: true,
      upstream: {
        format: "reasoning_object",
        parameter: "reasoning.effort",
      },
      source: "detection",
    };
    const automatic = reconcileFetchedCodexCatalogRows(
      [
        createRow({
          model: "xiaomi/mimo-v2.6-pro",
          reasoning: {
            schemaVersion: 2,
            supportStatus: "confirmed_supported",
            controlKind: "none",
            supportedEfforts: [],
            disableAllowed: true,
            upstream: {
              format: "reasoning_object",
              parameter: "reasoning.effort",
            },
            source: "library",
          },
        }),
      ],
      [{ id: "xiaomi/mimo-v2.6-pro", reasoning: fetchedReasoning }],
      {},
      { appendNew: true, createRow },
    );
    expect(automatic.rows[0].reasoning).toEqual(fetchedReasoning);

    const user = reconcileFetchedCodexCatalogRows(
      [
        createRow({
          model: "xiaomi/mimo-v2.6-pro",
          reasoning: { ...fetchedReasoning, source: "user" },
        }),
      ],
      [
        {
          id: "xiaomi/mimo-v2.6-pro",
          reasoning: { ...fetchedReasoning, supportedEfforts: ["high"] },
        },
      ],
      {},
      { appendNew: true, createRow },
    );
    expect(user.rows[0].reasoning?.supportedEfforts).toEqual(
      fetchedReasoning.supportedEfforts,
    );
    expect(user.rows[0].reasoning?.source).toBe("user");
  });

  it("persists API protocol declarations on both existing and newly discovered rows", () => {
    const capability = {
      schemaVersion: 1 as const,
      source: "provider_api" as const,
      baseUrl: "https://relay.example/v1",
      upstreamModel: "wire-model",
      supportedEndpoints: ["openai_chat" as const],
    };
    const result = reconcileFetchedCodexCatalogRows(
      [createRow({ model: "public-model", upstreamModel: "wire-model" })],
      [
        { id: "wire-model", protocolCapability: capability },
        {
          id: "new-model",
          protocolCapability: { ...capability, upstreamModel: "new-model" },
        },
      ],
      { baseUrl: capability.baseUrl },
      { appendNew: true, createRow },
    );

    expect(result.rows[0].protocolCapability).toEqual(capability);
    expect(result.rows[1].protocolCapability).toEqual({
      ...capability,
      upstreamModel: "new-model",
    });
    expect(result.rows[1].enabled).toBe(false);
  });

  it("invalidates stale API declarations only after a complete successful refresh", () => {
    const row = createRow({
      model: "wire-model",
      protocolCapability: {
        schemaVersion: 1,
        source: "provider_api",
        baseUrl: "https://relay.example/v1",
        upstreamModel: "wire-model",
        supportedEndpoints: ["openai_chat"],
      },
    });
    const options = { appendNew: false, createRow };
    const partial = reconcileFetchedCodexCatalogRows(
      [row],
      [{ id: "wire-model" }],
      {},
      options,
    );
    expect(partial.rows[0].protocolCapability).toEqual(row.protocolCapability);

    const complete = reconcileFetchedCodexCatalogRows(
      [row],
      [{ id: "wire-model" }],
      {},
      { ...options, removeMissingRemote: true },
    );
    expect(complete.rows[0]).not.toHaveProperty("protocolCapability");
    expect(row).toHaveProperty("protocolCapability");
  });

  it("removes stale protocol declarations from absent rows retained for editing", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [
        createRow({
          model: "removed-wire-model",
          protocolCapability: {
            schemaVersion: 1,
            source: "provider_api",
            baseUrl: "https://relay.example/v1",
            upstreamModel: "removed-wire-model",
            supportedEndpoints: ["openai_chat"],
          },
        }),
      ],
      [],
      {},
      {
        appendNew: false,
        createRow,
        removeMissingRemote: true,
        includeUnboundRemoteRows: true,
        markMissingRemoteDisabled: true,
      },
    );

    expect(result.rows[0]).toMatchObject({
      model: "removed-wire-model",
      enabled: false,
    });
    expect(result.rows[0]).not.toHaveProperty("protocolCapability");
  });

  it("removes only explicitly remote-bound rows and suppresses suspicious mass deletion", () => {
    const rows = [
      createRow({ model: "remote-one", upstreamModel: "remote-one" }),
      createRow({ model: "manual-one" }),
    ];
    const removed = reconcileFetchedCodexCatalogRows(
      rows,
      [],
      {},
      {
        appendNew: false,
        createRow,
        removeMissingRemote: true,
      },
    );
    expect(removed.removed).toBe(1);
    expect(removed.rows.map((row) => row.model)).toEqual(["manual-one"]);

    const suppressed = reconcileFetchedCodexCatalogRows(
      rows,
      [],
      {},
      {
        appendNew: false,
        createRow,
        removeMissingRemote: true,
        maxRemovalRatio: 0.5,
      },
    );
    expect(suppressed.removed).toBe(0);
    expect(suppressed.removalSuppressed).toBe(true);
    expect(suppressed.rows).toHaveLength(2);
    expect(suppressed.removedModels).toEqual(["remote-one"]);
  });

  it("can demote omitted unbound rows without touching explicitly hidden rows", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [
        createRow({ model: "kept-model" }),
        createRow({ model: "removed-model" }),
        createRow({ model: "hidden-model", enabled: false }),
      ],
      [{ id: "kept-model" }],
      {},
      {
        appendNew: false,
        createRow,
        removeMissingRemote: true,
        includeUnboundRemoteRows: true,
        markMissingRemoteDisabled: true,
      },
    );

    expect(result.rows).toEqual([
      expect.objectContaining({ model: "kept-model", enabled: true }),
      expect.objectContaining({ model: "removed-model", enabled: false }),
      expect.objectContaining({ model: "hidden-model", enabled: false }),
    ]);
    expect(result.removed).toBe(0);
    expect(result.removedModels).toEqual(["removed-model"]);
  });

  it("does not append a duplicate when a fetched alias matches an existing binding", () => {
    const result = reconcileFetchedCodexCatalogRows(
      [createRow({ model: "visible-name", upstreamModel: "upstream-name" })],
      [{ id: "upstream-name", aliases: ["visible-name"] }],
      {},
      { appendNew: true, createRow },
    );
    expect(result.added).toBe(0);
    expect(result.rows).toHaveLength(1);
  });

  it("uses stable binding identities for unbound rows during authoritative pruning", () => {
    const kept = createRow({
      model: "visible-model",
      canonicalSlug: "wire-model",
    });
    const removed = createRow({
      model: "wire-model",
      upstreamModel: "removed-wire-model",
    });
    const result = pruneMissingRemoteCodexCatalogRows(
      [kept, removed],
      [{ id: "wire-model" }],
      { includeUnboundRows: true, markMissingDisabled: true },
    );

    expect(result.rows[0]).toBe(kept);
    expect(result.rows[1]).toMatchObject({
      model: "wire-model",
      upstreamModel: "removed-wire-model",
      enabled: false,
    });
  });

  it("still deletes absent hidden remote rows when physical removal is requested", () => {
    const result = pruneMissingRemoteCodexCatalogRows(
      [createRow({ model: "hidden", upstreamModel: "wire", enabled: false })],
      [],
    );

    expect(result.rows).toEqual([]);
    expect(result.removed).toBe(1);
    expect(result.removedModels).toEqual(["hidden"]);
  });

  it("applies mass-removal protection to unbound enabled inventory too", () => {
    const rows = [
      createRow({ model: "kept" }),
      createRow({ model: "removed" }),
      createRow({ model: "hidden", enabled: false }),
    ];
    const result = pruneMissingRemoteCodexCatalogRows(rows, [{ id: "kept" }], {
      includeUnboundRows: true,
      markMissingDisabled: true,
      maxRemovalRatio: 0.25,
    });

    expect(result.removalSuppressed).toBe(true);
    expect(result.rows).toBe(rows);
    expect(result.removedModels).toEqual(["removed"]);
  });

  it("does not treat a single-key fetch as complete when independent key groups exist", () => {
    expect(isCompleteCodexCatalogFetch(undefined)).toBe(true);
    expect(isCompleteCodexCatalogFetch([])).toBe(true);
    expect(isCompleteCodexCatalogFetch([{ apiKeys: [" "] }])).toBe(true);
    expect(isCompleteCodexCatalogFetch([{ apiKeys: ["group-key"] }])).toBe(
      false,
    );
  });
});
