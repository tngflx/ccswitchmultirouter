import { describe, expect, it } from "vitest";
import {
  modelBindingIdentityValues,
  modelIdentityValues,
} from "./modelIdentities";

describe("model identity contract", () => {
  it("normalizes visible, upstream, canonical, and alias identities", () => {
    expect(
      modelIdentityValues({
        model: " gpt-6.1-sol-sublyx ",
        upstreamModel: "gpt-6.1-sol",
        canonicalSlug: "GPT-6.1-SOL",
        aliases: ["gpt-6.1-sol-relay"],
      }),
    ).toEqual(["gpt-6.1-sol-sublyx", "gpt-6.1-sol", "gpt-6.1-sol-relay"]);
  });

  it("does not use a visible alias as a binding when upstream is explicit", () => {
    expect(
      modelBindingIdentityValues({
        model: "gpt-6.1-sol-sublyx",
        upstreamModel: "gpt-6.1-sol",
      }),
    ).toEqual(["gpt-6.1-sol"]);
  });
});
