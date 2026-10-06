import { describe, expect, it } from "vitest";

import { listenerRecoveryButtonState } from "./ProxyPanel";

describe("listenerRecoveryButtonState", () => {
  it("keeps the recovery control visible but only enables it for an active takeover", () => {
    expect(listenerRecoveryButtonState(undefined)).toEqual({
      enabled: false,
      detail:
        "Enable takeover for at least one app before restoring the listener.",
    });

    expect(
      listenerRecoveryButtonState({
        claude: false,
        codex: true,
        gemini: false,
        grokbuild: false,
        opencode: false,
        openclaw: false,
        hermes: false,
      }),
    ).toEqual({
      enabled: true,
      detail:
        "Continuously guard the configured listener port; only release a verified stale CCSM instance.",
    });
  });
});
