import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import zh from "./locales/zh.json";
import zhTW from "./locales/zh-TW.json";

function flattenMessages(
  value: Record<string, unknown>,
  prefix = "",
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, message]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof message === "string"
        ? [[path, message]]
        : Object.entries(
            flattenMessages(message as Record<string, unknown>, path),
          );
    }),
  );
}

const english = flattenMessages(en);

describe("four-locale source-of-truth contract", () => {
  it.each(Object.entries({ zh, "zh-TW": zhTW, ja }))(
    "%s defines every English source key",
    (_language, messages) => {
      const translated = flattenMessages(messages);
      expect(
        Object.keys(english).filter(
          (key) => !Object.prototype.hasOwnProperty.call(translated, key),
        ),
      ).toEqual([]);
    },
  );

  it("keeps native-language names only in the language selector", () => {
    expect(
      Object.entries(english)
        .filter(([, message]) => /\p{Script=Han}/u.test(message))
        .map(([key]) => key),
    ).toEqual([
      "settings.languageOptionChinese",
      "settings.languageOptionTraditionalChinese",
      "settings.languageOptionJapanese",
    ]);
  });

  it.each(Object.entries({ zh, "zh-TW": zhTW, ja }))(
    "%s preserves audited presentation interpolation parameters",
    (_language, messages) => {
      const translated = flattenMessages(messages);
      const parameters = (message: string) =>
        [...message.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)]
          .map((match) => match[1])
          .sort();
      for (const [key, message] of Object.entries(english)) {
        if (
          ![
            "codexRouterWorkspace.",
            "codexCompatibilitySummary.",
            "codexProtocolProbe.",
            "codexSessionTraffic.",
          ].some((prefix) => key.startsWith(prefix))
        )
          continue;
        expect(parameters(translated[key]), key).toEqual(parameters(message));
        expect(translated[key], key).not.toMatch(/\$\{expr\d+\}/);
        expect(
          [...translated[key].matchAll(/<\/?code>/g)].map((match) => match[0]),
          key,
        ).toEqual([...message.matchAll(/<\/?code>/g)].map((match) => match[0]));
      }
    },
  );
});
