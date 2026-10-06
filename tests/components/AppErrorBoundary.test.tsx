import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import i18n from "@/i18n";
import { testLocaleResources } from "../utils/localizedTestI18n";

/** 用于验证根错误边界会接住子树渲染异常的测试组件。 */
function ThrowDuringRender(): never {
  throw new Error("测试渲染异常");
}

describe("AppErrorBoundary", () => {
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("将子组件渲染异常转换为可见的恢复界面", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <AppErrorBoundary>
        <ThrowDuringRender />
      </AppErrorBoundary>,
    );

    expect(
      screen.getByRole("heading", {
        name: "The application interface failed to load",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("测试渲染异常")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reload interface" }),
    ).toBeEnabled();
    expect(screen.getByText(/ThrowDuringRender/)).toBeInTheDocument();
    expect(localStorage.getItem("ccswitchmulti.lastRenderError.v1")).toContain(
      "测试渲染异常",
    );
  });

  it.each(["zh", "zh-TW", "ja"])(
    "renders recovery actions in %s without changing the diagnostic",
    async (language) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await i18n.changeLanguage(language);
      render(
        <AppErrorBoundary>
          <ThrowDuringRender />
        </AppErrorBoundary>,
      );
      expect(
        screen.getByRole("heading", { name: i18n.t("errors.appRenderTitle") }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: i18n.t("errors.reloadInterface") }),
      ).toBeEnabled();
      expect(screen.getByText("测试渲染异常")).toBeInTheDocument();
      expect(
        localStorage.getItem("ccswitchmulti.lastRenderError.v1"),
      ).toContain("测试渲染异常");
    },
  );
});
