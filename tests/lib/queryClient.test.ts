import { describe, expect, it } from "vitest";
import { queryClient } from "@/lib/query/queryClient";

describe("shared query client cache policy", () => {
  it("keeps ordinary reads warm across short remounts", () => {
    const defaults = queryClient.getDefaultOptions().queries;

    expect(defaults).toBeDefined();
    if (!defaults) return;
    expect(defaults.staleTime).toBe(30 * 1000);
    expect(defaults.gcTime).toBe(10 * 60 * 1000);
    expect(defaults.refetchOnWindowFocus).toBe(false);
  });
});
