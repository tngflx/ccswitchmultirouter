import { describe, expect, it } from "vitest";
import {
  catalogHasRoleModel,
  deepSeekRoleForModel,
  deepSeekRoleModelsMatch,
} from "./deepseekRoleModels";

describe("DeepSeek role model aliases", () => {
  it("maps current and canonical slugs to the same roles", () => {
    expect(deepSeekRoleForModel("deepseek-flash")).toBe("flash");
    expect(deepSeekRoleForModel("deepseek-v4-flash-202605")).toBe("flash");
    expect(deepSeekRoleForModel("deepseek-pro")).toBe("pro");
    expect(deepSeekRoleForModel("deepseek-v4-pro")).toBe("pro");
  });

  it("excludes vision models", () => {
    expect(deepSeekRoleForModel("deepseek-v4-flash-vision-exp")).toBeNull();
    expect(deepSeekRoleForModel("deepseek-flash-vision")).toBeNull();
  });

  it("matches aliases in catalogs without crossing roles", () => {
    expect(deepSeekRoleModelsMatch("deepseek-flash", "deepseek-v4-flash")).toBe(
      true,
    );
    expect(deepSeekRoleModelsMatch("deepseek-flash", "deepseek-v4-pro")).toBe(
      false,
    );
    expect(
      catalogHasRoleModel([{ model: "deepseek-pro" }], "deepseek-v4-pro"),
    ).toBe(true);
  });
});
