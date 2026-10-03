import { describe, expect, it } from "vitest";
import {
  normalizeCodexTrafficPolicy,
  resolveCodexTrafficPolicy,
} from "./codexTrafficPolicy";

describe("codex traffic policy", () => {
  it("uses the maintained Zen recommendation", () => {
    const policy = resolveCodexTrafficPolicy("https://opencode.ai/zen/go/v1");
    expect(policy.source).toBe("recommended");
    expect(policy.admissionEnabled).toBe(true);
    expect(policy.maxInFlight).toBe(4);
  });

  it("clamps custom values and disables dependent retries", () => {
    const policy = normalizeCodexTrafficPolicy({
      maxInFlight: 999,
      maxQueueWaitMs: 1,
      rejectionRetryMode: "disabled",
      rejectionMaxRetries: 5,
    });
    expect(policy.maxInFlight).toBe(64);
    expect(policy.maxQueueWaitMs).toBe(100);
    expect(policy.rejectionMaxRetries).toBe(0);
  });
});
