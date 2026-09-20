import { describe, expect, it } from "vitest";
import {
  cacheHitRatePercent,
  createUsageTrendTokenTickFormatter,
  formatUsageTrendTokenTickLabel,
} from "@/components/usage/UsageTrendChart";

describe("UsageTrendChart cache hit rate", () => {
  it("calculates cache read tokens as a percentage of cacheable input", () => {
    expect(cacheHitRatePercent(250, 500, 0)).toBe(33.33);
  });

  it("returns zero when no cacheable input exists", () => {
    expect(cacheHitRatePercent(0, 0, 0)).toBe(0);
  });

  it("formats large token ticks compactly for the active locale", () => {
    const formatter = createUsageTrendTokenTickFormatter("en-US");
    expect(formatUsageTrendTokenTickLabel(12500, formatter)).toBe("12.5K");
    expect(formatUsageTrendTokenTickLabel("invalid", formatter)).toBe("--");
  });
});
