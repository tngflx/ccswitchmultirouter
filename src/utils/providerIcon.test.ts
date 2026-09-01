import { describe, expect, it } from "vitest";
import { resolveProviderIcon } from "./providerIcon";
import { providerFaviconUrl } from "./providerIcon";

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

  it("derives a favicon URL from an API origin", () => {
    expect(
      providerFaviconUrl("https://api.example.com/v1/chat/completions"),
    ).toBe(
      "https://www.google.com/s2/favicons?domain_url=https%3A%2F%2Fapi.example.com&sz=64",
    );
  });

  it("ignores non-web API endpoints", () => {
    expect(providerFaviconUrl("not-a-url")).toBeUndefined();
    expect(providerFaviconUrl("file:///tmp/provider")).toBeUndefined();
  });
});
