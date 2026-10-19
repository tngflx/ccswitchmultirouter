import { describe, expect, it } from "vitest";
import { normalizeTakeoverListenAddress } from "@/lib/takeoverListenerAddress";

import en from "@/i18n/locales/en.json";
import zh from "@/i18n/locales/zh.json";
import zhTW from "@/i18n/locales/zh-TW.json";
import ja from "@/i18n/locales/ja.json";

describe("takeover listener address", () => {
  it.each([
    [" localhost ", "127.0.0.1"],
    ["127.0.0.1", "127.0.0.1"],
    ["127.255.255.255", "127.255.255.255"],
    ["::1", "::1"],
    ["[::1]", "::1"],
    ["0:0:0:0:0:0:0:1", "::1"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeTakeoverListenAddress(input)).toBe(expected);
  });
  it.each([
    "0.0.0.0",
    "::",
    "[::]",
    "192.0.2.1",
    "2001:db8::1",
    "example.test",
    "localhost.example.test",
    "127.1",
    "127.00.0.1",
    "127.0.0.256",
    "2130706433",
    "0x7f000001",
    "::ffff:127.0.0.1",
    "::1%lo",
    "",
    "[127.0.0.1]",
    "::1]/not-an-ip",
  ])("rejects %s", (input) => {
    expect(normalizeTakeoverListenAddress(input)).toBeNull();
  });
});

it("provides the safety and recovery copy in every supported locale", () => {
  for (const locale of [en, zh, zhTW, ja]) {
    for (const key of [
      "loopbackOnly",
      "externalApiForLan",
      "stopBeforeRepair",
      "useLocalhost",
    ] as const) {
      expect(locale.proxy.settings[key]).toBeTruthy();
    }
  }
});
