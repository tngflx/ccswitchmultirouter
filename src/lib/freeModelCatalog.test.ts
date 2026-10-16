import { describe, expect, it } from "vitest";

import {
  confirmedFreeModelIdentities,
  enableOnlyConfirmedFreeCatalogModels,
} from "@/lib/freeModelCatalog";

describe("free model catalog selection", () => {
  it("uses explicit metadata and preserves paid and unknown inventory rows", () => {
    const rows = [
      { model: "vendor/confirmed", enabled: false },
      { model: "vendor/paid:free", enabled: true },
      { model: "vendor/unknown:free", enabled: true },
      {
        model: "friendly-name",
        upstreamModel: "vendor/confirmed",
        enabled: false,
      },
    ];

    const next = enableOnlyConfirmedFreeCatalogModels(rows, [
      { id: "vendor/confirmed", isFree: true },
      { id: "vendor/paid:free", isFree: false },
      { id: "vendor/unknown:free" },
    ]);

    expect(next).toEqual([
      { model: "vendor/confirmed", enabled: true },
      { model: "vendor/paid:free", enabled: false },
      { model: "vendor/unknown:free", enabled: false },
      {
        model: "friendly-name",
        upstreamModel: "vendor/confirmed",
        enabled: true,
      },
    ]);
    expect(rows[0].enabled).toBe(false);
  });

  it("does not infer free status from an id suffix", () => {
    expect(
      confirmedFreeModelIdentities([
        { id: "vendor/unknown:free" },
        { id: "vendor/paid:free", isFree: false },
      ]),
    ).toEqual(new Set());
  });
});
