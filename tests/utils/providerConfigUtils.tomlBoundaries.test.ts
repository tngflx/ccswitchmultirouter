import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  extractCodexBaseUrl,
  extractCodexExperimentalBearerToken,
  extractCodexModelName,
  extractCodexTopLevelInt,
  extractCodexWireApi,
  setCodexBaseUrl,
  setCodexModelName,
  setCodexRemoteCompaction,
  setCodexTopLevelInt,
  setCodexWireApi,
  updateCodexExperimentalBearerToken,
} from "@/utils/providerConfigUtils";

describe("Codex source-preserving TOML boundaries", () => {
  it.each([
    '[model_providers."custom"]',
    '[model_providers."custom"] # note with ] and #',
    "[model_providers.'custom']",
    "[ model_providers . custom ]",
    '["model_providers".custom]',
  ])("matches parsed provider paths while retaining header %s", (header) => {
    const input = [
      'model_provider = "custom"',
      "",
      header,
      'name = "Custom"',
      'wire_api = "responses"',
      "",
      '[model_providers."custom.archive"]',
      'base_url = "https://archive.invalid/v1"',
      "",
    ].join("\n");

    const output = setCodexBaseUrl(input, "https://relay.example/v1");
    expect(parseToml(output)).toMatchObject({
      model_providers: {
        custom: { base_url: "https://relay.example/v1" },
        "custom.archive": { base_url: "https://archive.invalid/v1" },
      },
    });
    expect(output).toContain(header);
    expect(extractCodexBaseUrl(setCodexBaseUrl(output, ""))).toBeUndefined();
  });

  it("quotes escaped and dotted provider ids without touching other tables", () => {
    const providerId = 'relay.#]"quoted';
    const providerKey = JSON.stringify(providerId);
    const input = [
      `model_provider = ${providerKey}`,
      "",
      `[model_providers.${providerKey}]`,
      'name = "Selected"',
      'experimental_bearer_token = "redacted-old-token"',
      "",
      '[model_providers."relay"] # note with ]',
      'base_url = "https://other.invalid/v1"',
      "",
    ].join("\n");

    const output = updateCodexExperimentalBearerToken(
      setCodexBaseUrl(input, "https://selected.example/v1"),
      "redacted-new-token",
    );
    expect(parseToml(output)).toMatchObject({
      model_providers: {
        [providerId]: {
          name: "Selected",
          base_url: "https://selected.example/v1",
          experimental_bearer_token: "redacted-new-token",
        },
        relay: { base_url: "https://other.invalid/v1" },
      },
    });
  });

  it("inserts provider assignments before an array-of-table boundary", () => {
    const input = [
      'model_provider = "custom"',
      "",
      "[model_providers.custom]",
      'name = "Custom"',
      "",
      "[[model_providers.custom.models]]",
      'id = "model-1"',
      "",
    ].join("\n");

    const output = setCodexBaseUrl(input, "https://relay.example/v1");
    expect(parseToml(output)).toMatchObject({
      model_providers: {
        custom: {
          base_url: "https://relay.example/v1",
          models: [{ id: "model-1" }],
        },
      },
    });
    expect(
      output.indexOf('base_url = "https://relay.example/v1"'),
    ).toBeLessThan(output.indexOf("[[model_providers.custom.models]]"));
  });

  it("never recovers provider fields from an array-of-tables row", () => {
    const input = [
      'model_provider = "custom"',
      "",
      "[model_providers.custom]",
      "",
      "[[model_providers.custom.models]]",
      'id = "model-1"',
      'name = "Array Name"',
      'base_url = "https://array.invalid/v1"',
      'wire_api = "responses"',
      'experimental_bearer_token = "redacted-array-token"',
      "",
    ].join("\n");

    const withBaseUrl = setCodexBaseUrl(input, "https://relay.example/v1");
    const withWireApi = setCodexWireApi(input, "chat");
    const withToken = updateCodexExperimentalBearerToken(input, "redacted-new");
    const withName = setCodexRemoteCompaction(input, true);
    const modelRow = {
      id: "model-1",
      name: "Array Name",
      base_url: "https://array.invalid/v1",
      wire_api: "responses",
      experimental_bearer_token: "redacted-array-token",
    };

    expect(parseToml(withBaseUrl)).toMatchObject({
      model_providers: {
        custom: { base_url: "https://relay.example/v1", models: [modelRow] },
      },
    });
    expect(parseToml(withWireApi)).toMatchObject({
      model_providers: { custom: { wire_api: "chat", models: [modelRow] } },
    });
    expect(withToken).toBe(input);
    expect(parseToml(withName)).toMatchObject({
      model_providers: { custom: { name: "OpenAI", models: [modelRow] } },
    });
    expect(extractCodexBaseUrl(input)).toBeUndefined();
    expect(extractCodexExperimentalBearerToken(input)).toBeUndefined();
    expect(extractCodexWireApi(input)).toBeUndefined();
  });

  it.each(['"""', "'''"])(
    "ignores apparent provider headers and assignments inside %s strings",
    (delimiter) => {
      const instructions = [
        `developer_instructions = ${delimiter}`,
        "[model_providers.custom]",
        'base_url = "https://instructions.invalid/v1"',
        'wire_api = "instructions"',
        'experimental_bearer_token = "redacted-instructions"',
        delimiter,
      ].join("\n");
      const input = [
        'model_provider = "custom"',
        instructions,
        "",
        "[model_providers.custom]",
        'base_url = "https://old.example/v1"',
        'wire_api = "responses"',
        'experimental_bearer_token = "redacted-old"',
        "",
      ].join("\n");

      const output = updateCodexExperimentalBearerToken(
        setCodexWireApi(
          setCodexBaseUrl(input, "https://relay.example/v1"),
          "chat",
        ),
        "redacted-new",
      );
      expect(output).toContain(instructions);
      expect(parseToml(output)).toMatchObject({
        model_providers: {
          custom: {
            base_url: "https://relay.example/v1",
            wire_api: "chat",
            experimental_bearer_token: "redacted-new",
          },
        },
      });
    },
  );

  it("keeps table-looking multiline text from ending the top-level range", () => {
    const instructions =
      'developer_instructions = """\n[profiles.fake]\nmodel = "instruction"\n"""';
    const input = `${instructions}\nmodel = "old"\n[profiles.real]\nmodel = "nested"\n`;
    expect(extractCodexModelName(input)).toBe("old");
    const output = setCodexModelName(input, "new");
    expect(output).toContain(instructions);
    expect(extractCodexModelName(output)).toBe("new");
    expect(parseToml(output)).toMatchObject({
      model: "new",
      profiles: { real: { model: "nested" } },
    });
  });

  it("reads and writes top-level integers without editing multiline instructions", () => {
    const instructions =
      'developer_instructions = """\nmodel_context_window = 7\n[profiles.fake]\n"""';
    const input = `${instructions}\nmodel_context_window = 128000\n[profiles.real]\nmodel_context_window = 64000\n`;
    expect(extractCodexTopLevelInt(input, "model_context_window")).toBe(128000);
    const output = setCodexTopLevelInt(input, "model_context_window", 256000);
    expect(output).toContain(instructions);
    expect(extractCodexTopLevelInt(output, "model_context_window")).toBe(
      256000,
    );
    expect(parseToml(output)).toMatchObject({
      model_context_window: 256000,
      profiles: { real: { model_context_window: 64000 } },
    });
  });

  it("preserves blank lines inside multiline instructions while normalizing section spacing", () => {
    const instructions = 'developer_instructions = """\nfirst\n\n\nlast\n"""';
    const input = `model_provider = "custom"\n${instructions}\n\n\n[model_providers.custom]\nbase_url = "https://old.example/v1"\n`;
    const output = setCodexBaseUrl(input, "https://relay.example/v1");
    expect(output).toContain(instructions);
    expect(parseToml(output).developer_instructions).toBe(
      parseToml(input).developer_instructions,
    );
    expect(output).toContain('"""\n\n[model_providers.custom]');
  });
});
