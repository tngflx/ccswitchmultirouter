import { describe, expect, it } from "vitest";
import {
  inferProviderIcon,
  inferProviderIconFromConfig,
  resolveProviderDisplayIcon,
  resolveProviderIcon,
} from "./providerIcon";
import { getIconMetadata, hasIcon, isUrlIcon } from "@/icons/extracted";

describe("resolveProviderIcon", () => {
  it("clears the legacy automatic Grok Build icon", () => {
    expect(resolveProviderIcon("grokbuild", "grok", "")).toBeUndefined();
    expect(resolveProviderIcon("grokbuild", "grok")).toBeUndefined();
  });

  it("preserves a Grok icon explicitly selected by the user", () => {
    expect(resolveProviderIcon("grokbuild", "grok", "currentColor")).toBe(
      "grok",
    );
  });

  it("does not reinterpret another app's provider icon", () => {
    expect(resolveProviderIcon("codex", "grok", "")).toBe("grok");
  });

  it("normalizes an empty icon to the initials fallback", () => {
    expect(resolveProviderIcon("grokbuild", "  ", "")).toBeUndefined();
  });

  it("leaves unknown providers to the initials fallback", () => {
    expect(
      inferProviderIcon(
        undefined,
        "https://api.example.com/v1/chat/completions",
      ),
    ).toBeUndefined();
    expect(inferProviderIcon(undefined, "not-a-url")).toBeUndefined();
  });

  it("uses the bundled Sublyx vector for Sublyx API origins", () => {
    expect(
      inferProviderIcon(
        undefined,
        "https://api.sublyx.org/v1",
        "https://sublyx.org",
      ),
    ).toBe("sublyx");
  });

  it("registers Sublyx as a bundled vector icon", () => {
    expect(hasIcon("sublyx")).toBe(true);
    expect(isUrlIcon("sublyx")).toBe(true);
    expect(getIconMetadata("sublyx")?.displayName).toBe("Sublyx");
  });

  it("resolves the bundled icon for a legacy ProviderCard record", () => {
    expect(
      resolveProviderDisplayIcon("codex", {
        name: "Sublyx Legacy",
        settingsConfig: {
          config:
            '[model_providers.sublyx]\nbase_url = "https://api.sublyx.org/v1"',
        },
      }),
    ).toBe("sublyx");
  });

  it("upgrades a persisted low-resolution Sublyx favicon", () => {
    expect(inferProviderIcon("https://sublyx.org/favicon.ico")).toBe("sublyx");
  });

  it("resolves known providers to bundled icons before generic favicons", () => {
    expect(inferProviderIcon(undefined, "https://api.openrouter.ai/v1")).toBe(
      "openrouter",
    );
    expect(inferProviderIcon(undefined, "https://api.deepseek.com/v1")).toBe(
      "deepseek",
    );
  });

  it("infers a known icon by provider name when legacy config has no URL", () => {
    expect(
      inferProviderIconFromConfig(undefined, {}, undefined, "Sublyx Primary"),
    ).toBe("sublyx");
  });

  it("extracts and persists an API icon from nested provider config", () => {
    expect(
      inferProviderIconFromConfig(undefined, {
        config:
          '[model_providers.custom]\nbase_url = "https://api.sublyx.org/v1"',
      }),
    ).toBe("sublyx");
  });
});
