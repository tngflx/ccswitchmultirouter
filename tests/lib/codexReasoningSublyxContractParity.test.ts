import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CodexModelReasoningCapability } from "@/types";
import { normalizeCodexReasoningCapabilityForProvider } from "@/lib/codexReasoningProviderIdentity";

const rustSource = readFileSync(
  path.resolve(
    process.cwd(),
    "src-tauri/src/proxy/providers/codex_reasoning.rs",
  ),
  "utf8",
);
const tsSource = readFileSync(
  path.resolve(process.cwd(), "src/lib/codexReasoningProviderIdentity.ts"),
  "utf8",
);
const rustContract = rustSource.slice(
  rustSource.indexOf("pub fn sublyx_reasoning_capability_for_model("),
  rustSource.indexOf("pub fn normalize_sublyx_reasoning_capability_for_model("),
);
function quotedValues(source: string, pattern: RegExp): string[] {
  const match = source.match(pattern);
  expect(
    match,
    "contract declaration must remain identifiable by this parity guard",
  ).not.toBeNull();
  return [...match![1].matchAll(/"([^"]+)"/g)].map((value) => value[1]);
}
const rustMaxFamilies = quotedValues(
  rustContract,
  /let supports_native_max = \[([\s\S]*?)\]/,
);
const tsMaxFamilies = quotedValues(
  tsSource,
  /const knownNativeMaxModels = \[([\s\S]*?)\]/,
);
const nativeBaseEfforts = quotedValues(
  rustContract,
  /let mut supported_efforts = vec!\[([\s\S]*?)\]/,
);
const rustDefault = rustContract.match(
  /default_effort: Some\("([^"]+)"\.to_string\(\)\)/,
)?.[1];
const rustUltraTarget = rustContract.match(
  /provider_effort: Some\("([^"]+)"\.to_string\(\)\)/,
)?.[1];
const legacyCapability: CodexModelReasoningCapability = {
  // Maintained legacy provenance, not an explicit user-owned subset.
  source: "sublyx",
  supported: true,
  supportedEfforts: ["low", "medium", "high"],
  disableAllowed: false,
  upstream: {
    format: "string",
    parameter: "reasoning_effort",
    effortMap: { low: "low", medium: "medium", high: "high" },
  },
};
const identity = {
  providerName: "Sublyx",
  baseUrl: "https://api.sublyx.org/v1",
};

describe("Sublyx maintained reasoning TS/Rust contract parity", () => {
  it("keeps the exact native Max family allowlist synchronized", () => {
    expect([...tsMaxFamilies].sort()).toEqual([...rustMaxFamilies].sort());
    expect(rustContract).toContain(
      'upstream == *known || upstream.starts_with(&format!("{known}-"))',
    );
    expect(nativeBaseEfforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(rustDefault).toBe("medium");
    expect(rustUltraTarget).toBe("xhigh");
  });

  it.each(
    rustMaxFamilies.flatMap((model) => [
      model,
      `${model}-sublyx`,
      `${model}-preview-sublyx`,
      model.toUpperCase(),
    ]),
  )(
    "preserves native Max independently from synthetic Ultra for %s",
    (model) => {
      const capability = normalizeCodexReasoningCapabilityForProvider(
        model,
        legacyCapability,
        identity,
      );
      expect(capability.supportedEfforts).toEqual([
        ...nativeBaseEfforts,
        "max",
      ]);
      expect(capability.upstream.effortMap).toEqual(
        Object.fromEntries(
          [...nativeBaseEfforts, "max"].map((effort) => [effort, effort]),
        ),
      );
      expect(capability.defaultEffort).toBe(rustDefault);
      expect(capability.upstream.format).toBe("reasoning_object");
      expect(capability.upstream.parameter).toBe("reasoning.effort");
      expect(capability.codexUltraOrchestration).toEqual({
        enabled: true,
        providerEffort: rustUltraTarget,
      });
      expect(capability.supportedEfforts).not.toContain("ultra");
      expect(capability.upstream.effortMap).not.toHaveProperty("ultra");
    },
  );

  it("does not broaden unknown GPT models or cross provider ownership", () => {
    const unknown = normalizeCodexReasoningCapabilityForProvider(
      "gpt-unknown-sublyx",
      legacyCapability,
      identity,
    );
    expect(unknown.supportedEfforts).toEqual(nativeBaseEfforts);
    expect(unknown.supportedEfforts).not.toContain("max");
    const otherProvider = {
      providerName: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
    };
    expect(
      normalizeCodexReasoningCapabilityForProvider(
        "gpt-6-sol-sublyx",
        legacyCapability,
        otherProvider,
      ),
    ).toBe(legacyCapability);
  });
});
