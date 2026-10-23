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
  threadId?: string;
  expectedModel?: string;
  observedAtMs?: number;
  submitted?: boolean;
  mutationAttempted?: boolean;
  reason?: string;
};
type ContinuationState = {
  appServerClients: object[];
  codexContinuationJobs: Record<string, Job>;
  scopedAppServerDiscoveryPromise?: Promise<void>;
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

const createHarness = (
  pauseSecondRead = false,
  terminalError?: unknown,
  turnStatus = "failed",
  discoveryOptions: {
    pauseDiscovery?: boolean;
    pauseInstallation?: boolean;
    retainClient?: boolean;
  } = {},
) => {
  const state = {} as ContinuationState;
  const storage = new Map<string, string>();
  let reads = 0;
  let releaseRead!: () => void;
  let releaseDiscovery!: () => void;
  let releaseInstallation!: () => void;
  let currentInstallation = true;
  const startTurn = vi.fn((_params?: unknown) => ({
    turn: { id: "continued-turn" },
  }));
  const failedThread = {
    id: "exact-thread",
    model: "request-model",
    turns: [
      {
        id: "failed-turn",
        status: turnStatus,
        error: terminalError ?? {
          message:
            "Our servers are currently overloaded. Please try again later.",
        },
      },
    ],
  };
  const client = {
    hostId: "local",
    getCompatibleThreadSortKey() {},
    supportsPaginatedThreadHistory() {},
    async sendRequest(method: string, params: unknown) {
      if (method === "turn/start") return startTurn(params);
      reads += 1;
      if (pauseSecondRead && reads === 2)
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
      return { thread: failedThread };
    },
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
    async () => {
      if (discoveryOptions.pauseInstallation) {
        await new Promise<void>((resolve) => {
          releaseInstallation = resolve;
        });
        state.appServerClients = [client];
      }
      if (discoveryOptions.pauseDiscovery)
        state.scopedAppServerDiscoveryPromise = new Promise<void>((resolve) => {
          releaseDiscovery = () => {
            state.appServerClients = [client];
            resolve();
          };
        });
    },
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
  state.appServerClients =
    (discoveryOptions.pauseDiscovery || discoveryOptions.pauseInstallation) &&
    !discoveryOptions.retainClient
      ? []
      : [client];
  return {
    state,
    api,
    startTurn,
    readCount: () => reads,
    releaseRead: () => releaseRead(),
    releaseDiscovery: () => releaseDiscovery(),
    releaseInstallation: () => releaseInstallation(),
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
  it("bounds hanging installation and ignores its late result after timeout", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness(false, undefined, "failed", {
        pauseInstallation: true,
      });
      harness.start();
      await flushJobs();
      expect(harness.job().status).toBe("pending");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.job()).toMatchObject({
        status: "completed",
        submitted: false,
        mutationAttempted: false,
      });
      harness.releaseInstallation();
      await flushJobs();
      harness.state.commitCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.job().status).toBe("completed");
      expect(harness.readCount()).toBe(0);
      expect(harness.startTurn).not.toHaveBeenCalled();
      expect(harness.api.readCodexContinuationMarkers()).toEqual({});
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a verified client while a new installation would hang", async () => {
    const harness = createHarness(false, undefined, "failed", {
      pauseInstallation: true,
      retainClient: true,
    });
    harness.start();
    await flushJobs();
    expect(harness.job().status).toBe("prepared");
    expect(harness.readCount()).toBe(2);
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it("cancels a pending discovery and never resurrects its commit closure", async () => {
    const harness = createHarness(false, undefined, "failed", {
      pauseDiscovery: true,
    });
    expect(harness.state.cancelCodexContinuation("missing-recovery")).toEqual({
      cancelled: true,
      notFound: true,
      mutationAttempted: false,
    });
    harness.start();
    await flushJobs();
    expect(harness.state.cancelCodexContinuation("recovery-id")).toEqual({
      cancelled: true,
      mutationAttempted: false,
    });
    harness.releaseDiscovery();
    await flushJobs();
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: false,
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
  });

  it("reports a noncancellable submission and preserves its confirmed outcome", async () => {
    const harness = createHarness();
    harness.start();
    await flushJobs();
    harness.state.commitCodexContinuation("recovery-id");
    expect(harness.state.cancelCodexContinuation("recovery-id")).toEqual({
      cancelled: false,
      submitted: false,
      mutationAttempted: true,
    });
    await flushJobs();
    expect(harness.state.cancelCodexContinuation("recovery-id")).toEqual({
      cancelled: false,
      submitted: true,
      mutationAttempted: true,
    });
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: true,
    });
    expect(harness.startTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps malformed completed job evidence uncertain until an explicit refusal proves no mutation", () => {
    const harness = createHarness();
    const retained: Job = {
      status: "completed",
      submitted: false,
      threadId: "exact-thread",
      expectedModel: "request-model",
      observedAtMs: 1_000,
    };
    harness.state.codexContinuationJobs["projection-case"] = retained;
    expect(
      harness.state.readCodexContinuationJob("projection-case")
        .mutationAttempted,
    ).toBe(true);
    expect(
      harness.state.startCodexContinuation(
        "exact-thread",
        "projection-case",
        "request-model",
        1_000,
      ),
    ).toMatchObject({ started: true });
    harness.state.startCodexContinuation(
      "exact-thread",
      "projection-case",
      "request-model",
      1_000,
    );
    expect(harness.readCount()).toBe(0);
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.state.codexContinuationJobs["projection-case"]).toBe(
      retained,
    );
    expect(harness.state.cancelCodexContinuation("projection-case")).toEqual({
      cancelled: false,
      submitted: false,
      mutationAttempted: true,
    });
    expect(harness.state.codexContinuationJobs["projection-case"]).toBe(
      retained,
    );
    expect(retained.mutationAttempted).toBeUndefined();
    harness.state.commitCodexContinuation("projection-case");
    expect(
      harness.state.readCodexContinuationJob("projection-case")
        .mutationAttempted,
    ).toBe(true);
    harness.state.codexContinuationJobs["projection-case"] = {
      status: "completed",
      submitted: false,
      mutationAttempted: false,
    };
    expect(
      harness.state.readCodexContinuationJob("projection-case")
        .mutationAttempted,
    ).toBe(false);
    harness.state.codexContinuationJobs["projection-case"] = {
      status: "completed",
      submitted: true,
      mutationAttempted: false,
    };
    expect(
      harness.state.readCodexContinuationJob("projection-case")
        .mutationAttempted,
    ).toBe(true);
  });

  it("waits for pending local-client discovery before preparing an exact continue", async () => {
    const harness = createHarness(false, undefined, "failed", {
      pauseDiscovery: true,
    });
    harness.start();
    await flushJobs();
    expect(harness.job().status).toBe("pending");
    expect(harness.readCount()).toBe(0);
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});

    harness.releaseDiscovery();
    await flushJobs();
    expect(harness.job().status).toBe("prepared");
    expect(harness.readCount()).toBe(2);
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    expect(harness.startTurn).toHaveBeenCalledWith({
      threadId: "exact-thread",
      input: [{ type: "text", text: "continue" }],
    });
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: true,
      mutationAttempted: true,
    });
  });

  it("respects a user stop while local-client discovery is pending", async () => {
    const harness = createHarness(false, undefined, "failed", {
      pauseDiscovery: true,
    });
    harness.start();
    await flushJobs();
    harness.api.rememberCodexUserTurnAction("turn/interrupt", {
      threadId: "exact-thread",
    });
    harness.releaseDiscovery();
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: false,
      reason:
        "The user changed or stopped the Codex thread after this request started",
    });
    expect(harness.readCount()).toBe(0);
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
    expect(harness.job().mutationAttempted).toBe(false);
  });

  it("uses an existing local client without waiting for another discovery pass", async () => {
    const harness = createHarness(false, undefined, "failed", {
      pauseDiscovery: true,
      retainClient: true,
    });
    harness.start();
    await flushJobs();
    expect(harness.job().status).toBe("prepared");
    expect(harness.readCount()).toBe(2);
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it("bounds a discovery that never settles without writing a mutation marker", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness(false, undefined, "failed", {
        pauseDiscovery: true,
      });
      harness.start();
      await flushJobs();
      expect(harness.job().status).toBe("pending");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.job()).toMatchObject({
        status: "completed",
        submitted: false,
        mutationAttempted: false,
        reason:
          "Codex Desktop request client was not found after discovery timed out",
      });
      harness.releaseDiscovery();
      await flushJobs();
      harness.state.commitCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.job().status).toBe("completed");
      expect(harness.readCount()).toBe(0);
      expect(harness.startTurn).not.toHaveBeenCalled();
      expect(harness.api.readCodexContinuationMarkers()).toEqual({});
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a proven readiness failure when there is no local client or discovery", async () => {
    const harness = createHarness();
    harness.state.appServerClients = [];
    harness.start();
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
      reason: "Codex Desktop request client was not found",
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
  });

  it.each([
    { code: "network_error", message: "The network request failed" },
    { code: "ECONNRESET", message: "The peer reset the socket" },
    { code: "socket_closed", message: "The remote socket closed" },
    { code: "fetch_error", message: "fetch failed" },
    { code: "ECONNREFUSED", message: "The local endpoint refused the peer" },
    { code: "ENOTFOUND", message: "The upstream host could not be resolved" },
    { code: "EAI_AGAIN", message: "Temporary DNS resolution failure" },
    { code: "ENETUNREACH", message: "The remote endpoint is unreachable" },
    { code: "EHOSTUNREACH", message: "The remote host is unreachable" },
    { httpStatusCode: 408 },
    { httpStatusCode: 425 },
    { httpStatusCode: 429 },
    { httpStatusCode: 501 },
    { httpStatusCode: 505 },
    { httpStatusCode: 508 },
    { httpStatusCode: 599 },
    { status: 408 },
    { code: "425" },
    { message: "HTTP501" },
    { message: "HTTP 503." },
  ])(
    "continues an authorized interrupted connection failure: $code",
    async (error) => {
      const harness = createHarness(false, error, "interrupted");
      harness.start();
      await flushJobs();
      expect(harness.job().status).toBe("prepared");
      expect(harness.startTurn).not.toHaveBeenCalled();

      harness.state.commitCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.startTurn).toHaveBeenCalledTimes(1);
      expect(harness.job()).toMatchObject({
        status: "completed",
        submitted: true,
        mutationAttempted: true,
      });
    },
  );

  it.each([
    {},
    { message: "The user interrupted the turn" },
    { code: "daily_limit", message: "Network request exceeded daily quota" },
    { httpStatusCode: 503, message: "The daily quota was exhausted" },
    { httpStatusCode: 503, message: "The user cancelled the turn" },
  ])(
    "does not continue interrupted user actions or quota errors: %j",
    async (error) => {
      const harness = createHarness(false, error, "interrupted");
      harness.start();
      await flushJobs();
      expect(harness.job().status).toBe("completed");
      harness.state.commitCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.startTurn).not.toHaveBeenCalled();
      expect(harness.api.readCodexContinuationMarkers()).toEqual({});
    },
  );

  it.each(["1408", "1425", "1429", "1503", "5000", "1.503", "503.2"])(
    "does not treat a numeric identifier as an HTTP failure: %s",
    async (identifier) => {
      const harness = createHarness(
        false,
        { message: `Operation identifier ${identifier}` },
        "interrupted",
      );
      harness.start();
      await flushJobs();
      expect(harness.job().status).toBe("completed");
      harness.state.commitCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.startTurn).not.toHaveBeenCalled();
      expect(harness.api.readCodexContinuationMarkers()).toEqual({});
    },
  );

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
