import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import ja from "./locales/ja.json";
import zh from "./locales/zh.json";
import zhTW from "./locales/zh-TW.json";
import {
  DEFAULT_LANGUAGE,
  parseSupportedLanguage,
  type SupportedLanguage,
} from "./language";

const getInitialLanguage = (): SupportedLanguage => {
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem("language");
      const storedLanguage = parseSupportedLanguage(stored);
      if (storedLanguage) return storedLanguage;
    } catch (error) {
      console.warn("[i18n] Failed to read stored language preference", error);
    }
  }

  // English is the predictable first-run language. Users can opt into a
  // locale from Settings; do not let the host OS silently switch a fresh
  // install into Chinese or another locale before the app is configured.
  return DEFAULT_LANGUAGE;
};

const resources = {
  en: {
    translation: en,
  },
  ja: {
    translation: ja,
  },
  zh: {
    translation: zh,
  },
  "zh-TW": {
    translation: zhTW,
  },
};

i18n.use(initReactI18next).init({
  resources,
  lng: getInitialLanguage(),
  fallbackLng: "en",

  interpolation: {
    escapeValue: false,
  },

  debug: false,
});

export default i18n;
