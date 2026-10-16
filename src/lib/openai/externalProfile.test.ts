import { describe, expect, it } from "vitest";
import {
  buildClineConfig,
  buildCurlSnippet,
  buildKiloSnippet,
  buildReachableBaseUrl,
} from "./externalProfile";

describe("external OpenAI client setup", () => {
  it("builds explicit Cline-compatible configuration without hosted URLs", () => {
    const config = JSON.parse(
      buildClineConfig("http://127.0.0.1:15722/v1", "ccsw_test", "model-a"),
    );

    expect(config).toEqual({
      provider: "OpenAI Compatible",
      baseUrl: "http://127.0.0.1:15722/v1",
      apiKey: "ccsw_test",
      modelId: "model-a",
    });
    expect(JSON.stringify(config)).not.toContain("cline.bot");
  });

  it("labels Kilo setup as local CCSwitch and exposes model checks", () => {
    const kilo = buildKiloSnippet(
      "http://192.168.1.20:15722/v1",
      "ccsw_test",
      "model-a",
    );
    const curl = buildCurlSnippet(
      "http://192.168.1.20:15722/v1",
      "ccsw_test",
      "model-a",
    );

    expect(kilo).toContain("not https://ai-gateway.kilo.ai/api/v1");
    expect(kilo).toContain('OPENAI_MODEL="model-a"');
    expect(curl).toContain("/models");
    expect(curl).toContain("/chat/completions");
  });

  it("uses a reachable placeholder for wildcard bindings", () => {
    expect(buildReachableBaseUrl("0.0.0.0", 15722)).toBe(
      "http://<your-ip-or-domain>:15722/v1",
    );
  });
});
