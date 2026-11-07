import { describe, expect, it } from "vitest";
import identityFixture from "../../tests/fixtures/codexApiKeyGroupIdentity.json";
import {
  CODEX_API_KEY_GROUP_ALIAS_MARKER,
  isGeneratedCodexApiKeyGroupModel,
} from "./codexApiKeyGroup";

describe("generated Codex API key group models", () => {
  it.each(identityFixture.cases)(
    "classifies $name without changing the row",
    ({ row, generated }) => {
      const model = { ...identityFixture.baseModel, ...row };
      const before = structuredClone(model);

      expect(isGeneratedCodexApiKeyGroupModel(model)).toBe(generated);
      expect(model).toEqual(before);
    },
  );

  it("uses the reserved marker for generated picker ids", () => {
    expect(CODEX_API_KEY_GROUP_ALIAS_MARKER).toBe("--ccg-");
    expect(
      isGeneratedCodexApiKeyGroupModel({
        model: `base${CODEX_API_KEY_GROUP_ALIAS_MARKER}group`,
      }),
    ).toBe(true);
  });
});
