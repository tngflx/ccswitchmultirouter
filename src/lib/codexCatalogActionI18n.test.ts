import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import zh from "@/i18n/locales/zh.json";
import zhTW from "@/i18n/locales/zh-TW.json";
import ja from "@/i18n/locales/ja.json";

const actionKeys = [
  "catalogBrowser.enableOnlyFreeModels",
  "catalogBrowser.enableOnlyFreeModelsHint",
  "catalogBrowser.enableOnlyReasoningModels",
  "catalogBrowser.enableOnlyReasoningModelsHint",
  "codexConfig.noReasoningEffortModels",
  "codexConfig.reasoningEffortModelsOnlyApplied",
] as const;

const locales = [
  {
    language: "en",
    translation: en,
    removedAction: "Enable only synced models",
    toolbar: "fixed catalog action bar",
  },
  {
    language: "zh",
    translation: zh,
    removedAction: "仅启用本次同步的模型",
    toolbar: "固定的模型目录操作栏",
  },
  {
    language: "zh-TW",
    translation: zhTW,
    removedAction: "僅啟用本次同步的模型",
    toolbar: "固定的模型目錄操作列",
  },
  {
    language: "ja",
    translation: ja,
    removedAction: "今回同期したモデルだけを有効化",
    toolbar: "固定カタログ操作バー",
  },
];

describe.each(locales)(
  "Codex catalog action translations: $language",
  ({ language, translation, removedAction, toolbar }) => {
    async function translator() {
      const i18n = createInstance();
      await i18n.init({
        lng: language,
        fallbackLng: false,
        resources: { [language]: { translation } },
        interpolation: { escapeValue: false },
      });
      return i18n;
    }

    it("provides every toolbar action and result without an English fallback", async () => {
      const i18n = await translator();
      for (const key of actionKeys) {
        expect(i18n.exists(key), key).toBe(true);
        expect(i18n.t(key), key).not.toBe(key);
        expect(i18n.t(key).trim().length, key).toBeGreaterThan(0);
      }
    });

    it("describes the fixed catalog actions rather than a removed sync-only button", async () => {
      const i18n = await translator();
      const hint = i18n.t("codexConfig.modelMappingInventoryHint");
      expect(hint).not.toContain(removedAction);
      expect(hint).toContain(toolbar);
    });

    it("preserves the reasoning-action count interpolation", async () => {
      const i18n = await translator();
      const key = "codexConfig.reasoningEffortModelsOnlyApplied";
      const raw = i18n.getResource(language, "translation", key);
      expect(raw).toContain("{{count}}");
      expect(i18n.t(key, { count: 7 })).toContain("7");
      expect(i18n.t(key, { count: 7 })).not.toContain("{{count}}");
    });
  },
);

it("keeps English catalog action resources aligned with renderer fallbacks", () => {
  expect(en.catalogBrowser).toMatchObject({
    enableOnlyFreeModels: "Use free models only",
    enableOnlyFreeModelsHint:
      "Enable only models that the provider explicitly identifies as free; excluded rows remain available for editing.",
    enableOnlyReasoningModels: "Enable only models with reasoning effort",
    enableOnlyReasoningModelsHint:
      "Enable only catalog models that advertise a selectable reasoning effort; excluded rows remain available for editing.",
  });
  expect(en.codexConfig).toMatchObject({
    noReasoningEffortModels: "No catalog models advertise a reasoning effort.",
    reasoningEffortModelsOnlyApplied:
      "Enabled {{count}} model(s) with reasoning effort.",
    modelMappingInventoryHint:
      "All includes retained excluded inventory for editing. Only Included models enter routes and model pickers; use the fixed catalog action bar for bulk inclusion filters while keeping older rows available to edit.",
  });
});
