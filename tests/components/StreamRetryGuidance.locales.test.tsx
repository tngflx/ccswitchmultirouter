import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import { StreamRetryToggle } from "@/components/proxy/StreamRetryToggle";
import { createLocalizedTestI18n } from "../utils/localizedTestI18n";

const prerequisiteKey =
  "settings.advanced.proxy.streamRetryContinuationPrerequisite";
const guidanceCases = [
  {
    language: "en",
    repair:
      /If a debugging port is already available, first use “Unlock model picker”/,
    restart:
      /Only if the debugging port is missing, save your work and fully exit Codex Desktop/,
    delivery: /only when Codex accepts the new “continue” turn/,
  },
  {
    language: "ja",
    repair:
      /デバッグポートがすでに利用できる場合は、まず「Unlock model picker」/,
    restart: /ポートがない場合に限り、作業を保存して/,
    delivery: /受け付けた場合のみ/,
  },
  {
    language: "zh-TW",
    repair: /如果偵錯連接埠已可用，請先使用「Unlock model picker」/,
    restart: /僅在缺少偵錯連接埠時，先儲存工作並完全退出 Codex Desktop/,
    delivery: /只有 Codex 接受新的「continue」輪次後/,
  },
  {
    language: "zh",
    repair: /如果调试端口已可用，请先使用“Unlock model picker”/,
    restart: /仅在缺少调试端口时，先保存工作并完全退出 Codex Desktop/,
    delivery: /只有 Codex 接受新的“continue”轮次后/,
  },
];

describe("stream retry guidance with production locale resources", () => {
  it.each(guidanceCases)(
    "renders repair-first, conditional restart guidance in $language",
    async ({ language, repair, restart, delivery }) => {
      const locale = await createLocalizedTestI18n(language);
      render(
        <I18nextProvider i18n={locale}>
          <StreamRetryToggle mode="aggressive" onChange={vi.fn()} />
        </I18nextProvider>,
      );

      const guidance = screen.getByText(locale.t(prerequisiteKey));
      expect(guidance).toBeVisible();
      expect(guidance).toHaveTextContent(repair);
      expect(guidance).toHaveTextContent(restart);
      expect(guidance).toHaveTextContent(delivery);
      expect(guidance).not.toHaveTextContent(
        /requires Codex Desktop to be launched from CCSwitchMulti/,
      );
    },
  );

  it("names the actual English repair action in both activity-panel hints", async () => {
    const locale = await createLocalizedTestI18n("en");
    for (const key of ["launchHelp", "repairHelp"]) {
      const guidance = locale.t(`streamRetry.continuation.${key}`);
      expect(guidance).toContain("Unlock model picker");
      expect(guidance).not.toContain("Unlock model menu");
    }
  });
});
