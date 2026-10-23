import { describe, expect, it } from "vitest";

import en from "./locales/en.json";
import ja from "./locales/ja.json";
import zh from "./locales/zh.json";
import zhTW from "./locales/zh-TW.json";

const locales = { en, ja, zh, "zh-TW": zhTW } as const;
const visibleKinds = [
  "activePreviousInstance",
  "confirmedCrash",
  "uncleanExit",
  "livePreservedProviderRepaired",
  "providerOnlyRestored",
  "unrecoverableUserTables",
  "portOwnedByUnknownOwner",
  "startupTakeoverFailed",
] as const;
const nextSteps = [
  "closeOtherInstanceOrInspectProcess",
  "reviewRecoveryResults",
  "openLogsOrRestoreUserBackup",
  "changeProxyPortOrInspectOwner",
  "openLogsOrRetryTakeover",
  "retryingTakeoverRestore",
] as const;
const uncleanExitTitles = {
  en: "The previous run ended without a clean shutdown record",
  ja: "前回の実行には正常終了の記録がありません",
  zh: "上次运行结束时未留下正常退出记录",
  "zh-TW": "上次執行結束時未留下正常退出紀錄",
} as const;

describe("recovery outcome translations", () => {
  it.each(Object.entries(locales))(
    "%s reports the missing clean-shutdown record without implying configuration recovery failed",
    (locale, messages) => {
      expect(messages.notifications.recovery.kind.uncleanExit).toBe(
        uncleanExitTitles[locale as keyof typeof uncleanExitTitles],
      );
    },
  );

  it.each(Object.entries(locales))(
    "%s covers every user-visible outcome and action",
    (_locale, messages) => {
      for (const kind of visibleKinds) {
        expect(messages.notifications.recovery.kind[kind].trim()).not.toBe("");
      }
      for (const nextStep of nextSteps) {
        expect(
          messages.notifications.recovery.nextStep[nextStep].trim(),
        ).not.toBe("");
      }
    },
  );
});
