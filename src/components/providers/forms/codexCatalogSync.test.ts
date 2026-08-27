import { describe, expect, it } from "vitest";

import {
  reconcileFetchedCodexCatalogRows,
  type CodexCatalogRowLike,
} from "./codexCatalogSync";

const source = { providerName: "Sublyx", baseUrl: "https://api.example.com" };

function createRow(seed: CodexCatalogRowLike): CodexCatalogRowLike {
  return { ...seed };
}

const remoteModels = [
  { id: "keep-me", contextWindow: 128000, inputModalities: ["text"] },
  { id: "blocked-model", contextWindow: 64000 },
  { id: "new-model" },
];

describe("reconcileFetchedCodexCatalogRows", () => {
  it("keeps disabled rows excluded and does not re-add their identities", () => {
    const initial: CodexCatalogRowLike[] = [
      { model: "Keep Me", upstreamModel: "keep-me", contextWindow: "" },
      { model: "blocked-model", enabled: false },
    ];

    const result = reconcileFetchedCodexCatalogRows(
      initial,
      remoteModels,
      source,
      { appendNew: true, createRow },
    );

    expect(result.rows.map((row) => row.model)).toEqual([
      "Keep Me",
      "blocked-model",
      "new-model",
    ]);
    expect(result.added).toBe(1);
    expect(result.rows[0].enabled).toBeUndefined();
    expect(result.rows[1].enabled).toBe(false);
    expect(result.rows[0].contextWindow).toBe("128000");
  });

  it("fills only empty fields and never appends during refill", () => {
    const initial: CodexCatalogRowLike[] = [
      {
        model: "manual-alias",
        upstreamModel: "",
        contextWindow: "200000",
        supportsImage: false,
      },
      { model: "", contextWindow: "" },
    ];

    const result = reconcileFetchedCodexCatalogRows(
      initial,
      [
        {
          id: "manual-alias",
          contextWindow: 999,
          inputModalities: ["text", "image"],
          supportsImage: true,
        },
        { id: "should-not-append" },
      ],
      source,
      { appendNew: false, createRow },
    );

    expect(result.rows).toHaveLength(2);
    expect(result.added).toBe(0);
    expect(result.hydrated).toBe(1);
    expect(result.rows[0]).toMatchObject({
      model: "manual-alias",
      upstreamModel: "manual-alias",
      contextWindow: "200000",
      inputModalities: ["text", "image"],
      supportsImage: false,
      textOnly: false,
    });
  });

  it("preserves catalog order and existing row state when syncing", () => {
    const initial: CodexCatalogRowLike[] = [
      { model: "z-existing", displayName: "Custom", enabled: true },
      { model: "hidden", enabled: false },
    ];

    const result = reconcileFetchedCodexCatalogRows(
      initial,
      [{ id: "a-new" }, { id: "z-existing" }],
      source,
      { appendNew: true, createRow },
    );

    expect(result.rows.map((row) => row.model)).toEqual([
      "z-existing",
      "hidden",
      "a-new",
    ]);
    expect(result.rows[0].displayName).toBe("Custom");
    expect(result.rows[0].enabled).toBe(true);
    expect(result.rows[1].enabled).toBe(false);
  });

  it("refreshes stale provider metadata without changing user-owned catalog fields", () => {
    const initial: CodexCatalogRowLike[] = [
      {
        model: "friendly-gpt",
        upstreamModel: "gpt-5.5",
        displayName: "My GPT",
        contextWindow: "128000",
        inputModalities: ["text"],
        supportsImage: false,
        textOnly: true,
        enabled: false,
        sortIndex: 7,
        reasoning: {
          schemaVersion: 2,
          supportStatus: "unknown",
          controlKind: "none",
          supportedEfforts: [],
          disableAllowed: true,
          upstream: { format: "none", parameter: "none" },
          source: "user",
        },
      },
    ];

    const result = reconcileFetchedCodexCatalogRows(
      initial,
      [
        {
          id: "gpt-5.5",
          contextWindow: 272000,
          inputModalities: ["text", "image"],
          supportsImage: true,
        },
      ],
      source,
      { appendNew: false, createRow, existingMetadataMode: "refresh" },
    );

    expect(result.hydrated).toBe(1);
    expect(result.rows[0]).toMatchObject({
      model: "friendly-gpt",
      upstreamModel: "gpt-5.5",
      displayName: "My GPT",
      contextWindow: "272000",
      inputModalities: ["text", "image"],
      supportsImage: true,
      textOnly: false,
      enabled: false,
      sortIndex: 7,
    });
    expect(result.rows[0].reasoning?.source).toBe("user");
  });
});
