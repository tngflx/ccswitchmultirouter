import { createInstance } from "i18next";
import en from "@/i18n/locales/en.json";
import zh from "@/i18n/locales/zh.json";
import zhTW from "@/i18n/locales/zh-TW.json";
import ja from "@/i18n/locales/ja.json";

export const testLocaleResources = {
  en: { translation: en },
  zh: { translation: zh },
  "zh-TW": { translation: zhTW },
  ja: { translation: ja },
};

// Use explicit I18nextProvider instances without changing the shared test
// bootstrap: older tests intentionally exercise defaultValue fallbacks.
export async function createLocalizedTestI18n(language = "en") {
  const instance = createInstance();
  await instance.init({
    lng: language,
    fallbackLng: "en",
    resources: testLocaleResources,
    interpolation: { escapeValue: false },
  });
  return instance;
}
