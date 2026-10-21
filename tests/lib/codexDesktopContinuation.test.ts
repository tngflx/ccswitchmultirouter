import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const resource = (name: string) =>
  readFileSync(
    path.resolve(process.cwd(), "src-tauri/src/resources/codex_desktop", name),
    "utf8",
  );
const discovery = resource("client_discovery.js");
const continuation = resource("continuation.js").replace(
  "__CCSWITCH_TERMINAL_ERROR_POLICY__",
  readFileSync(
    path.resolve(
      process.cwd(),
      "src-tauri/src/proxy/providers/terminal_error_policy.json",
    ),
    "utf8",
  ),
);
const terminalErrorCases = JSON.parse(
  readFileSync(
    path.resolve(process.cwd(), "tests/fixtures/terminalErrorPolicy.json"),
    "utf8",
  ),
) as Array<{
  name: string;
  event: string;
  error: unknown;
  expectedCode: string | null;
}>;

type Job = {
  status: string;
  submitted?: boolean;
  mutationAttempted?: boolean;
  reason?: string;
};
type ContinuationState = {
  appServerClients: object[];
  startCodexContinuation: (
    thread: string,
    recovery: string,
    model: string,
    observedAt: number,
  ) => unknown;
  commitCodexContinuation: (recovery: string) => unknown;
  cancelCodexContinuation: (recovery: string) => unknown;
  readCodexContinuationJob: (recovery: string) => Job;
};

const flushJobs = async () => {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
};

const createHarness = (pauseSecondRead = false, terminalError?: unknown) => {
  const state = {} as ContinuationState;
  const storage = new Map<string, string>();
  let reads = 0;
  let releaseRead!: () => void;
  let currentInstallation = true;
  const startTurn = vi.fn(() => ({ turn: { id: "continued-turn" } }));
  const failedThread = {
    id: "exact-thread",
    model: "request-model",
    turns: [
      {
        id: "failed-turn",
        status: "failed",
        error: terminalError ?? {
          message:
            "Our servers are currently overloaded. Please try again later.",
        },
      },
    ],
  };
  const api = new Function(
    "state",
    "localStorage",
    "installAppServerPatch",
    "recordFailure",
    "installationIsCurrent",
    `${discovery}\n${continuation}\nreturn { rememberCodexUserTurnAction, readCodexContinuationMarkers, codexContinuationTerminalErrorCode };`,
  )(
    state,
    {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    async () => {},
    () => {},
    () => currentInstallation,
  ) as {
    rememberCodexUserTurnAction: (method: string, params: object) => void;
    readCodexContinuationMarkers: () => object;
    codexContinuationTerminalErrorCode: (
      event: string,
      payload: unknown,
    ) => string | null;
  };
  state.appServerClients = [
    {
      hostId: "local",
      getCompatibleThreadSortKey() {},
      supportsPaginatedThreadHistory() {},
      async sendRequest(method: string) {
        if (method === "turn/start") return startTurn();
        reads += 1;
        if (pauseSecondRead && reads === 2)
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
          });
        return { thread: failedThread };
      },
    },
  ];
  return {
    state,
    api,
    startTurn,
    releaseRead: () => releaseRead(),
    replaceInstallation: () => {
      currentInstallation = false;
    },
    start: () =>
      state.startCodexContinuation(
        "exact-thread",
        "recovery-id",
        "request-model",
        Date.now() - 1_000,
      ),
    job: () => state.readCodexContinuationJob("recovery-id"),
  };
};

describe("Codex Desktop continuation authorization", () => {
  it.each(terminalErrorCases)(
    "applies the shared terminal-error contract: $name",
    async ({ event, error, expectedCode }) => {
      const harness = createHarness(false, error);
      expect(
        harness.api.codexContinuationTerminalErrorCode(event, { error }),
      ).toBe(expectedCode);
      harness.start();
      await flushJobs();
      expect(harness.job().status).toBe(
        expectedCode === null ? "prepared" : "completed",
      );
      if (expectedCode !== null) {
        harness.state.commitCodexContinuation("recovery-id");
        await flushJobs();
        expect(harness.startTurn).not.toHaveBeenCalled();
      }
    },
  );

  it("does not continue an upstream operation whose outcome is still pending", async () => {
    const harness = createHarness(false, {
      code: "response_pending",
      message: "The upstream operation may still be running.",
    });
    harness.start();
    await flushJobs();

    expect(harness.job().status).toBe("completed");
    expect(harness.job().reason).toBe(
      "The latest Codex turn needs a user action",
    );
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
  });

  it("blocks every canonical permanent-error marker before continuation", async () => {
    const markers = [
      {
        code: "response.pending",
        message: "The upstream operation is still running",
      },
      {
        code: "content.policy",
        message: "The request was blocked by content policy",
      },
      { code: "policy violation", message: "The request violated policy" },
      { code: "token_expired", message: "The managed token expired" },
      {
        code: "content_filter",
        message: "The provider applied a content filter",
      },
      { code: "daily_limit", message: "The daily usage limit was reached" },
      {
        code: "payment_required",
        message: "Payment is required before retrying",
      },
      {
        code: "insufficient_balance",
        message: "The account has insufficient balance",
      },
      {
        code: "invalid_parameter",
        message: "The request contains an invalid parameter",
      },
      {
        code: "access_denied",
        message: "Access was denied by the provider",
      },
      { code: "aborted", message: "The upstream request was aborted" },
    ];

    for (const terminalError of markers) {
      const harness = createHarness(false, terminalError);
      harness.start();
      await flushJobs();

      expect(harness.job(), terminalError.code).toMatchObject({
        status: "completed",
        reason: "The latest Codex turn needs a user action",
      });
      harness.state.commitCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.startTurn, terminalError.code).not.toHaveBeenCalled();
      expect(
        harness.api.readCodexContinuationMarkers(),
        terminalError.code,
      ).toEqual({});
    }
  });

  it("waits for backend authorization after a pending thread read and can be cancelled without a mutation", async () => {
    const harness = createHarness(true);
    harness.start();
    await flushJobs();
    expect(harness.job().status).toBe("pending");

    // Off/Safe, provider changes, or a reduced budget can revoke authorization
    // in the backend while this renderer request is awaiting its final read.
    harness.releaseRead();
    await flushJobs();
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.job().status).toBe("prepared");
    harness.state.cancelCodexContinuation("recovery-id");
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();

    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
    expect(harness.job().submitted).toBe(false);
  });

  it("submits an authorized prepared continuation exactly once", async () => {
    const harness = createHarness();
    harness.start();
    await flushJobs();
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.job().status).toBe("prepared");

    harness.state.commitCodexContinuation("recovery-id");
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();

    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: true,
      mutationAttempted: true,
    });
  });

  it("checks a new user stop again at commit", async () => {
    const harness = createHarness();
    harness.start();
    await flushJobs();
    harness.api.rememberCodexUserTurnAction("turn/interrupt", {
      threadId: "exact-thread",
    });
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();

    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
  });

  it("does not commit a prepared continuation from a replaced runtime", async () => {
    const harness = createHarness();
    harness.start();
    await flushJobs();
    harness.replaceInstallation();
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();

    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
  });
});
