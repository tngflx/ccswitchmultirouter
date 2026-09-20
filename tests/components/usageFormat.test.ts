import { describe, expect, it } from "vitest";
import {
  formatOutputTokensPerSecond,
  getOutputTokensPerSecond,
} from "@/components/usage/format";

describe("usage output throughput format", () => {
  it("uses generation time after first token", () => {
    expect(
      getOutputTokensPerSecond({
        outputTokens: 120,
        latencyMs: 10_000,
        firstTokenMs: 4_000,
      }),
    ).toBe(20);
  });

  it("prefers explicit duration", () => {
    expect(
      getOutputTokensPerSecond({
        outputTokens: 120,
        latencyMs: 10_000,
        firstTokenMs: 4_000,
        durationMs: 3_000,
      }),
    ).toBe(40);
  });

  it("returns null without positive output or duration", () => {
    expect(formatOutputTokensPerSecond({ outputTokens: 0, latencyMs: 10_000 })).toBeNull();
    expect(
      formatOutputTokensPerSecond({
        outputTokens: 120,
        latencyMs: 4_000,
        firstTokenMs: 4_000,
      }),
    ).toBeNull();
  });
});
