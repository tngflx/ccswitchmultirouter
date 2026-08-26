import { describe, expect, it } from "vitest";

import {
  normalizeCodexTrafficPolicy,
  resolveCodexTrafficPolicy,
} from "@/components/providers/forms/codexTrafficPolicy";

describe("Codex traffic policy resolution", () => {
  it("shows the maintained OpenCode Zen recommendation", () => {
    expect(
      resolveCodexTrafficPolicy("https://opencode.ai/zen/go/v1"),
    ).toMatchObject({
      source: "recommended",
      admissionEnabled: true,
      maxInFlight: 4,
      maxQueueWaitMs: 30_000,
      rateLimitMaxRetries: 5,
      rejectionRetryMode: "opencode_endpoint_unavailable",
      rejectionMaxRetries: 2,
      rejectionInitialDelayMs: 750,
      rejectionMaxDelayMs: 5_000,
    });
  });

  it("does not claim capacity or replay 503 for unknown providers", () => {
    expect(
      resolveCodexTrafficPolicy("https://unknown.example/v1"),
    ).toMatchObject({
      source: "safe_default",
      admissionEnabled: false,
      rateLimitMaxRetries: 5,
      rejectionRetryMode: "disabled",
      rejectionMaxRetries: 0,
    });
  });

  it("normalizes invalid and out-of-range form values to backend bounds", () => {
    expect(
      normalizeCodexTrafficPolicy({
        admissionEnabled: true,
        maxInFlight: Number.NaN,
        maxQueueWaitMs: 999_999,
        rateLimitMaxRetries: 99,
        rejectionRetryMode: "opencode_endpoint_unavailable",
        rejectionMaxRetries: -4,
        rejectionInitialDelayMs: 1,
        rejectionMaxDelayMs: 100_000,
      }),
    ).toEqual({
      admissionEnabled: true,
      maxInFlight: 8,
      maxQueueWaitMs: 300_000,
      rateLimitMaxRetries: 5,
      rejectionRetryMode: "opencode_endpoint_unavailable",
      rejectionMaxRetries: 0,
      rejectionInitialDelayMs: 100,
      rejectionMaxDelayMs: 60_000,
    });
  });

  it("forces recognized rejection retries to zero when their mode is disabled", () => {
    expect(
      normalizeCodexTrafficPolicy({
        rejectionRetryMode: "disabled",
        rejectionMaxRetries: 5,
      }).rejectionMaxRetries,
    ).toBe(0);
  });
});
