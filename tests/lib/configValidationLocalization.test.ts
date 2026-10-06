import { beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import {
  updateCommonConfigSnippet,
  validateJsonConfig,
} from "@/utils/providerConfigUtils";
import { testLocaleResources } from "../utils/localizedTestI18n";

describe("localized configuration validation preserves fail-closed boundaries", () => {
  beforeEach(async () => {
    for (const [language, resource] of Object.entries(testLocaleResources)) {
      i18n.addResourceBundle(
        language,
        "translation",
        resource.translation,
        true,
        true,
      );
    }
    await i18n.changeLanguage("en");
  });

  it.each(["en", "zh", "zh-TW", "ja"])(
    "localizes errors in %s without allowing invalid configuration writes",
    async (language) => {
      await i18n.changeLanguage(language);
      for (const invalid of ["null", "[]", "false", "123"]) {
        expect(validateJsonConfig(invalid)).toBe(
          i18n.t("configValidation.mustBeObject", {
            field: i18n.t("configValidation.config"),
          }),
        );
      }
      expect(validateJsonConfig("{")).toBe(
        i18n.t("configValidation.invalidJson", {
          field: i18n.t("configValidation.config"),
        }),
      );
      const rawConfig = "{not valid JSON";
      expect(
        updateCommonConfigSnippet(rawConfig, '{"env":{"A":"1"}}', true),
      ).toEqual({
        updatedConfig: rawConfig,
        error: i18n.t("configValidation.applyFailed"),
      });
      const unchanged = { env: { LOCAL: "keep" } };
      const rejected = updateCommonConfigSnippet(
        JSON.stringify(unchanged),
        "[]",
        true,
      );
      expect(JSON.parse(rejected.updatedConfig)).toEqual(unchanged);
      expect(rejected.error).toBe(
        i18n.t("configValidation.mustBeObject", {
          field: i18n.t("configValidation.commonSnippet"),
        }),
      );
      expect(validateJsonConfig('{"valid":true}')).toBe("");
      expect(validateJsonConfig("")).toBe("");
      expect(
        JSON.parse(
          updateCommonConfigSnippet(
            JSON.stringify(unchanged),
            '{"env":{"A":"1"}}',
            true,
          ).updatedConfig,
        ),
      ).toEqual({ env: { LOCAL: "keep", A: "1" } });
    },
  );

  it("keeps caller field identifiers unchanged in English validation diagnostics", () => {
    expect(validateJsonConfig("[]", "custom-field-42")).toBe(
      "custom-field-42 must be a JSON object",
    );
    expect(validateJsonConfig("{", "custom-field-42")).toBe(
      "custom-field-42 has invalid JSON syntax",
    );
  });
});
