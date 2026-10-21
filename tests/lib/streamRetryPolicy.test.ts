import { describe, expect, it } from "vitest";
import {
  clampStreamRetryMaxAttempts,
  resolveStreamRetryMode,
  streamRetryModePatch,
} from "@/lib/streamRetryPolicy";

describe("stream retry policy projections", () => {
  it("keeps legacy disabled settings off without hiding explicit modes", () => {
    expect(resolveStreamRetryMode(undefined, false)).toBe("off");
    expect(resolveStreamRetryMode("safe", false)).toBe("off");
    expect(resolveStreamRetryMode("aggressive", false)).toBe("aggressive");
    expect(resolveStreamRetryMode(undefined, true)).toBe("safe");
  });

  it.each([
    [undefined, 3],
    [0, 1],
    [1, 1],
    [2, 2],
    [99, 3],
  ])("clamps %s attempts to %s", (input, expected) => {
    expect(clampStreamRetryMaxAttempts(input)).toBe(expected);
  });

  it("derives the compatibility flag from the selected mode", () => {
    expect(streamRetryModePatch("off")).toEqual({
      streamRetryMode: "off",
      enableStreamRetry: false,
    });
    expect(streamRetryModePatch("safe")).toEqual({
      streamRetryMode: "safe",
      enableStreamRetry: true,
    });
  });
});
