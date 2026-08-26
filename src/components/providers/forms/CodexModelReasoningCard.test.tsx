import { beforeAll, describe, expect, it } from "vitest";
import type { CodexModelReasoningResolution } from "@/types/codexSubagentV2";
import i18n from "@/i18n";
import zh from "@/i18n/locales/zh.json";

import {
  describeFinalBehavior,
  reasoningCardStatus,
  reasoningControlKind,
} from "./CodexModelReasoningCard";

// 组件与 describeFinalBehavior 都依赖真实翻译资源；
// 全局 setup 用空资源初始化 i18next，这里补挂真实 zh 资源。
beforeAll(async () => {
  // 全局 setup 已注册空 zh bundle，必须强制合并真实资源
  i18n.addResourceBundle("zh", "translation", zh, true, true);
  await i18n.changeLanguage("zh");
});

function resolution(
  supportKind: CodexModelReasoningResolution["resolved"]["supportKind"],
): CodexModelReasoningResolution {
  return {
    model: "qwen3.8",
    capability: null,
    source: "unknown",
    fingerprint: "",
    resolved: {
      supportKind,
      confidence: "unverified",
      codexSelectableEfforts: [],
      providerAcceptedEfforts: [],
      disableAllowed: false,
      effortMap: {},
    },
    hasDetectionCandidate: false,
    detection: null,
  };
}

describe("CodexModelReasoningCard", () => {
  it("keeps unknown distinct from confirmed unsupported", () => {
    expect(reasoningCardStatus(resolution("unknown"))).toBe("unknown");
    expect(reasoningCardStatus(resolution("unsupported"))).toBe("unsupported");
  });

  it("projects graded capability and explains the final behavior", () => {
    const value = resolution("effort_levels");
    value.capability = {
      supportStatus: "confirmed_supported",
      controlKind: "graded",
      supportedEfforts: ["low", "high"],
      defaultEffort: "high",
      disableAllowed: true,
      upstream: { format: "reasoning_object", parameter: "reasoning.effort" },
    };
    value.resolved.codexSelectableEfforts = ["low", "high"];
    value.resolved.providerAcceptedEfforts = ["low", "high"];
    value.resolved.providerDefaultEffort = "high";
    value.resolved.disableAllowed = true;

    expect(reasoningControlKind(value)).toBe("graded");
    expect(describeFinalBehavior(value)).toContain("reasoning effort");
    expect(describeFinalBehavior(value)).toContain("low / high");
  });
});
