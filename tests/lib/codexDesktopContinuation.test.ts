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
  expectedModel?: string | null;
  observedAtMs?: number;
  submitted?: boolean;
  mutationAttempted?: boolean;
  usageLimitDeferred?: boolean;
  usageLimitReadUnavailable?: boolean;
  reason?: string;
};
type ContinuationState = {
  appServerClients: object[];
  runtimeGeneration: number;
  codexContinuationJobs: Record<string, Job>;
  scopedAppServerDiscoveryPromise?: Promise<void>;
  startCodexContinuation: (
    thread: string,
    recovery: string,
    model: string,
    observedAt: number,
  ) => unknown;
  startCodexUsageLimitContinuation: (
    thread: string,
    recovery: string,
    model: string | null,
    observedAt: number,
    turn: string,
    requireNativeObservation?: boolean,
  ) => unknown;
  getCodexNativeUsageLimitCandidate?: (
    thread: string,
    turn: string,
  ) => {
    model: string | null;
    modelProvider: string;
    observedAtMs: number;
  } | null;
  startCodexOwnerContinuation: (
    viewReference: string,
    operation: string,
  ) => unknown;
  confirmCodexContinuation: (operation: string) => unknown;
  confirmCodexOwnerContinuation: (operation: string) => unknown;
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
    requestHook?: "verified" | "unverified" | "stale-version";
    pauseCommitRead?: boolean;
    readError?: Error;
    failOnThreadRead?: number;
    boundedHistoryUnavailable?: boolean;
    boundedHistoryPage?: unknown;
    noCrypto?: boolean;
    captureNativeAcknowledgement?: () => (response: unknown) => void;
  } = {},
) => {
  const state = { runtimeGeneration: 1 } as ContinuationState;
  const ownerReferences = new Map<string, Record<string, unknown>>();
  let randomIndex = 0;
  const crypto = discoveryOptions.noCrypto
    ? undefined
    : {
        getRandomValues: (bytes: Uint8Array) => {
          bytes.fill(++randomIndex);
          return bytes;
        },
      };
  const storage = new Map<string, string>();
  let markerWritesUnavailable = false;
  let reads = 0;
  let releaseRead!: () => void;
  let releaseCommitRead!: () => void;
  let releaseDiscovery!: () => void;
  let releaseInstallation!: () => void;
  let currentInstallation = true;
  const startTurn = vi.fn((_params?: unknown) => ({
    turn: { id: "continued-turn" },
  }));
  const failedThread: {
    id: string;
    model: string | null;
    modelProvider?: string;
    status?: unknown;
    turns: Array<{
      id: string;
      status: string;
      error: unknown;
      model?: string;
    }>;
    pendingApprovals?: unknown;
    pendingApproval?: unknown;
    pendingOperation?: unknown;
    waitingOnApproval?: unknown;
    waitingOnUserInput?: unknown;
    pendingOperations?: unknown;
  } = {
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
  const requestCalls: Array<[string, unknown]> = [];
  const client = {
    hostId: "local",
    getCompatibleThreadSortKey() {},
    supportsPaginatedThreadHistory() {},
    async sendRequest(method: string, params: unknown) {
      requestCalls.push([method, params]);
      if (method === "turn/start") return startTurn(params);
      if (discoveryOptions.readError) throw discoveryOptions.readError;
      if (method === "thread/turns/list") {
        if (discoveryOptions.boundedHistoryUnavailable)
          throw new Error("Unsupported bounded history");
        if (
          Object.prototype.hasOwnProperty.call(
            discoveryOptions,
            "boundedHistoryPage",
          )
        )
          return discoveryOptions.boundedHistoryPage;
        const data = failedThread.turns
          .slice(-1)
          .reverse()
          .map((turn) => {
            const metadata = { items: [], itemsView: "notLoaded" };
            for (const key of ["id", "status", "model", "error"]) {
              const descriptor = Object.getOwnPropertyDescriptor(turn, key);
              if (descriptor) Object.defineProperty(metadata, key, descriptor);
            }
            return metadata;
          });
        return { data, nextCursor: null };
      }
      reads += 1;
      if (pauseSecondRead && reads === 2)
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
      if (discoveryOptions.pauseCommitRead && reads === 3)
        await new Promise<void>((resolve) => {
          releaseCommitRead = resolve;
        });
      if (reads === discoveryOptions.failOnThreadRead)
        throw new Error("Codex thread read failed (private response detail)");
      if ((params as { includeTurns?: boolean }).includeTurns === false) {
        const metadata: Record<string, unknown> = { turns: [] };
        for (const [key, descriptor] of Object.entries(
          Object.getOwnPropertyDescriptors(failedThread),
        )) {
          if (key !== "turns") Object.defineProperty(metadata, key, descriptor);
        }
        return { thread: metadata };
      }
      return { thread: failedThread };
    },
  };
  const original = client.sendRequest.bind(client);
  const api = new Function(
    "state",
    "localStorage",
    "installAppServerPatch",
    "recordFailure",
    "installationIsCurrent",
    "resolveCodexOwnerRemoteViewReference",
    "codexOwnerRemoteViewReferenceIsCurrent",
    "crypto",
    "captureCodexNativeUsageLimitAcknowledgement",
    `${discovery}\n${continuation}\nreturn { rememberCodexUserTurnAction, readCodexContinuationMarkers, codexContinuationTerminalErrorCode, classifyCodexContinuationThread, captureCodexOwnerUserActionEvidence, codexOwnerUserActionEvidenceIsCurrent };`,
  )(
    state,
    {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (
          markerWritesUnavailable &&
          key === "ccswitch-codex-continuations-v1"
        )
          throw new Error("Storage unavailable");
        storage.set(key, value);
      },
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
    (reference: string) => ownerReferences.get(reference) ?? null,
    (reference: string, binding: Record<string, unknown>) =>
      currentInstallation &&
      ownerReferences.get(reference) === binding &&
      binding.runtimeGeneration === state.runtimeGeneration &&
      Number(binding.expiresAtMs) > Date.now(),
    crypto,
    discoveryOptions.captureNativeAcknowledgement,
  ) as {
    rememberCodexUserTurnAction: (method: string, params: unknown) => void;
    captureCodexOwnerUserActionEvidence: (thread: string) => object | null;
    codexOwnerUserActionEvidenceIsCurrent: (
      thread: string,
      evidence: object | null,
    ) => boolean;
    readCodexContinuationMarkers: () => object;
    classifyCodexContinuationThread: (
      thread: object,
      threadId: string,
      model: string,
    ) => { ready: boolean; reason?: string };
    codexContinuationTerminalErrorCode: (
      event: string,
      payload: unknown,
    ) => string | null;
  };
  if (discoveryOptions.requestHook !== "unverified") {
    // Model the production wrapper's activity tracking and ownership metadata
    // without installing the unrelated renderer discovery/normalization stack.
    // The real discovery predicate must still verify every retained client.
    const version =
      discoveryOptions.requestHook === "stale-version"
        ? "stale-continuation-fixture"
        : "standalone";
    const wrapper: typeof client.sendRequest = async (method, params) => {
      api.rememberCodexUserTurnAction(method, params);
      return original(method, params);
    };
    Object.defineProperty(wrapper, "__ccSwitchRequestHook", {
      value: Object.freeze({ client, original, version }),
    });
    Object.assign(client, {
      __ccSwitchOriginalSendRequest: original,
      sendRequest: wrapper,
      __ccSwitchModelRequestPatch: version,
    });
  }
  state.appServerClients =
    (discoveryOptions.pauseDiscovery || discoveryOptions.pauseInstallation) &&
    !discoveryOptions.retainClient
      ? []
      : [client];
  return {
    state,
    api,
    storage,
    startTurn,
    failedThread,
    seedMarkers: (markers: object) =>
      storage.set("ccswitch-codex-continuations-v1", JSON.stringify(markers)),
    refuseMarkerWrites: () => {
      markerWritesUnavailable = true;
    },
    ownerView: (reference = "owner-view", observedAtMs = Date.now() - 100) => {
      failedThread.status = { type: "idle" };
      failedThread.modelProvider = "owned-provider";
      const binding = Object.freeze({
        threadId: failedThread.id,
        latestTurnId: failedThread.turns.at(-1)?.id,
        expectedModel: failedThread.model,
        expectedModelProvider: failedThread.modelProvider,
        observedAtMs,
        userActionEvidence: api.captureCodexOwnerUserActionEvidence(
          failedThread.id,
        ),
        runtimeGeneration: state.runtimeGeneration,
        client,
        request: original,
        expiresAtMs: Date.now() + 30_000,
      });
      ownerReferences.set(reference, binding);
      return reference;
    },
    expireOwnerView: (reference = "owner-view") => {
      ownerReferences.delete(reference);
    },
    readCount: () => reads,
    requestCalls,
    releaseRead: () => releaseRead(),
    releaseCommitRead: () => releaseCommitRead(),
    releaseDiscovery: () => releaseDiscovery(),
    releaseInstallation: () => releaseInstallation(),
    replaceInstallation: () => {
      currentInstallation = false;
    },
    replaceHook: () => {
      client.sendRequest = original;
    },
    start: () =>
      state.startCodexContinuation(
        "exact-thread",
        "recovery-id",
        "request-model",
        Date.now() - 1_000,
      ),
    job: () => state.readCodexContinuationJob("recovery-id"),
    changeFailedTurn: (turnId: string) => {
      failedThread.turns[0].id = turnId;
    },
  };
};

describe("Codex Desktop continuation authorization", () => {
  it.each([
    {
      threadModel: undefined,
      turnModel: undefined,
      expectedModel: "request-model",
    },
    {
      threadModel: "request-model",
      turnModel: "other-model",
      expectedModel: "request-model",
    },
    { threadModel: "request-model", turnModel: undefined, expectedModel: "" },
    { threadModel: undefined, turnModel: undefined, expectedModel: "unknown" },
  ])("rejects an unverified model binding: %j", (binding) => {
    const harness = createHarness();
    const thread = {
      id: "exact-thread",
      model: binding.threadModel,
      turns: [
        { id: "failed-turn", status: "failed", model: binding.turnModel },
      ],
    };
    expect(
      harness.api.classifyCodexContinuationThread(
        thread,
        "exact-thread",
        binding.expectedModel,
      ).ready,
    ).toBe(false);
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it.each(["", "unknown", " UNKNOWN "])(
    "refuses starting continuation without an exact request model: %j",
    (model) => {
      const harness = createHarness();
      expect(
        harness.state.startCodexContinuation(
          "exact-thread",
          "invalid-request",
          model,
          Date.now() - 1000,
        ),
      ).toMatchObject({ started: false });
      expect(harness.readCount()).toBe(0);
      expect(harness.startTurn).not.toHaveBeenCalled();
    },
  );

  it("does not commit a prepared closure after its client loses current discovery ownership", async () => {
    const harness = createHarness();
    harness.start();
    await flushJobs();
    expect(harness.job().status).toBe("prepared");
    harness.state.appServerClients = [];
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
    });
  });

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

  it.each(["unverified", "stale-version"] as const)(
    "rejects a %s request client without reading or mutating the thread",
    async (requestHook) => {
      const harness = createHarness(false, undefined, "failed", {
        requestHook,
      });
      harness.start();
      await flushJobs();

      expect(harness.job()).toMatchObject({
        status: "completed",
        submitted: false,
        mutationAttempted: false,
        reason: "Codex Desktop request client was not found",
      });
      expect(harness.readCount()).toBe(0);
      harness.state.commitCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.startTurn).not.toHaveBeenCalled();
      expect(harness.api.readCodexContinuationMarkers()).toEqual({});
    },
  );

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

  it.each([
    { retryable: false, code: "server_error" },
    { error: { retryable: false, code: "server_error" } },
    { response: { error: { retryable: false, code: "server_error" } } },
    { retryable: true, error: { retryable: false, code: "server_error" } },
    { retryable: false, error: { retryable: true, code: "server_error" } },
    { error: "Service temporarily overloaded. Do not retry this request." },
    "Service temporarily overloaded. Do not retry this request.",
  ])(
    "honors explicit retry denial at the known payload boundary: %j",
    (payload) => {
      const harness = createHarness();
      expect(
        harness.api.codexContinuationTerminalErrorCode(
          "response.failed",
          payload,
        ),
      ).toBe("non_retryable_error");
    },
  );

  it.each([
    { error: { retryable: true, code: "server_error" } },
    { error: { retryable: "false", code: "server_error" } },
    {
      error: {
        code: "server_error",
        metadata: {
          request: { retryable: false, prompt: "Do not retry this request" },
        },
      },
    },
    {
      error: { code: "server_error" },
      request: { retryable: false, message: "Do not retry this request" },
    },
  ])(
    "does not infer a retry denial from unrelated request metadata: %j",
    (payload) => {
      const harness = createHarness();
      expect(
        harness.api.codexContinuationTerminalErrorCode(
          "response.failed",
          payload,
        ),
      ).toBeNull();
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

  it.each(["failed", "interrupted"])(
    "prepares and commits the original temporary usage %s exactly once",
    async (status) => {
      const harness = createHarness(
        false,
        {
          type: "usage_limit_reached",
          message: "You've hit your usage limit. Please try again later.",
        },
        status,
      );
      harness.start();
      await flushJobs();
      expect(harness.job()).toMatchObject({ status: "prepared" });
      expect(harness.startTurn).not.toHaveBeenCalled();
      expect(harness.api.readCodexContinuationMarkers()).toEqual({});

      harness.state.commitCodexContinuation("recovery-id");
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
    },
  );

  it("does not continue a temporary usage failure after a newer user stop", async () => {
    const harness = createHarness(false, {
      type: "usage_limit_reached",
      message: "You've hit your usage limit. Please try again later.",
    });
    harness.start();
    await flushJobs();
    expect(harness.job().status).toBe("prepared");
    harness.api.rememberCodexUserTurnAction("turn/interrupt", {
      threadId: "exact-thread",
    });
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
  });

  it.each([
    "Daily usage limit reached; please try again later",
    "Weekly usage limit reached; please try again later",
    "Monthly usage limit reached; please try again later",
    "Usage limit reached because quota is exhausted; retry later",
    "Usage limit reached because billing requires payment; retry later",
    "Usage limit reached because credit is exhausted; retry later",
  ])(
    "does not continue hard usage failures with retry wording: %s",
    async (message) => {
      const harness = createHarness(false, {
        type: "usage_limit_reached",
        message,
      });
      harness.start();
      await flushJobs();
      expect(harness.job()).toMatchObject({
        status: "completed",
        submitted: false,
        mutationAttempted: false,
        reason: "The latest Codex turn needs a user action",
      });
      harness.state.commitCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.startTurn).not.toHaveBeenCalled();
      expect(harness.api.readCodexContinuationMarkers()).toEqual({});
    },
  );

  it("rechecks the exact failed turn immediately before commit", async () => {
    const harness = createHarness();
    harness.start();
    await flushJobs();
    expect(harness.job().status).toBe("prepared");

    harness.changeFailedTurn("new-failed-turn");
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();

    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
    });
  });

  it.each(["user-action", "runtime-replaced", "hook-replaced"] as const)(
    "fails closed when authorization changes during the final thread read: %s",
    async (change) => {
      const harness = createHarness(false, undefined, "failed", {
        pauseCommitRead: true,
      });
      harness.start();
      await flushJobs();
      expect(harness.job().status).toBe("prepared");
      harness.state.commitCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.readCount()).toBe(3);
      if (change === "user-action")
        harness.api.rememberCodexUserTurnAction("turn/interrupt", {
          threadId: "exact-thread",
        });
      else if (change === "runtime-replaced") harness.replaceInstallation();
      else harness.replaceHook();
      harness.releaseCommitRead();
      await flushJobs();
      expect(harness.startTurn).not.toHaveBeenCalled();
      expect(harness.api.readCodexContinuationMarkers()).toEqual({});
      expect(harness.job()).toMatchObject({
        status: "completed",
        submitted: false,
        mutationAttempted: false,
      });
    },
  );

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

describe("explicit owner Codex continuation preparation", () => {
  it("refuses a prepared owner commit until final-read confirmation finishes", async () => {
    const harness = createHarness(false, undefined, "completed");
    harness.state.startCodexOwnerContinuation(
      harness.ownerView(),
      "owner-confirm-contract",
    );
    await flushJobs();
    expect(
      harness.state.commitCodexContinuation("owner-confirm-contract"),
    ).toMatchObject({ started: false });
    expect(
      harness.state.readCodexContinuationJob("owner-confirm-contract"),
    ).toMatchObject({
      status: "prepared",
      submitted: false,
      mutationAttempted: false,
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
    harness.state.confirmCodexOwnerContinuation("owner-confirm-contract");
    await flushJobs();
    expect(
      harness.state.readCodexContinuationJob("owner-confirm-contract"),
    ).toMatchObject({
      status: "confirmed",
      submitted: false,
      mutationAttempted: false,
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
    const reads = harness.readCount();
    harness.state.commitCodexContinuation("owner-confirm-contract");
    // There is no awaited read after native authorization: dispatch happens
    // synchronously in the same call, before flushing an acknowledgement.
    expect(harness.readCount()).toBe(reads);
    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    await flushJobs();
    expect(
      harness.state.readCodexContinuationJob("owner-confirm-contract"),
    ).toMatchObject({
      status: "completed",
      submitted: true,
      mutationAttempted: true,
    });
  });
  it("cancels final-read confirmation without leaving a late owner sender", async () => {
    const harness = createHarness(false, undefined, "completed", {
      pauseCommitRead: true,
    });
    harness.state.startCodexOwnerContinuation(
      harness.ownerView(),
      "owner-confirm-cancel",
    );
    await flushJobs();
    harness.state.confirmCodexOwnerContinuation("owner-confirm-cancel");
    await flushJobs();
    expect(
      harness.state.readCodexContinuationJob("owner-confirm-cancel").status,
    ).toBe("confirming");
    expect(
      harness.state.cancelCodexContinuation("owner-confirm-cancel"),
    ).toMatchObject({ cancelled: true, mutationAttempted: false });
    harness.releaseCommitRead();
    await flushJobs();
    expect(
      harness.state.commitCodexContinuation("owner-confirm-cancel"),
    ).toMatchObject({ started: false });
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
  });
  it.each([
    "turn_getter",
    "id_getter",
    "id_coercion",
    "same_base",
    "thread_getter",
  ])(
    "keeps mutation evidence uncertain for unreadable acknowledgement %s without getters or coercion",
    async (shape) => {
      const harness = createHarness(false, undefined, "completed");
      const effect = vi.fn(() => "continued-turn");
      const response: Record<string, unknown> = {
        turn: { id: "continued-turn" },
      };
      if (shape === "turn_getter")
        Object.defineProperty(response, "turn", {
          get: () => {
            effect();
            return { id: "continued-turn" };
          },
        });
      if (shape === "id_getter")
        Object.defineProperty(response.turn, "id", { get: effect });
      if (shape === "id_coercion") response.turn = { id: { toString: effect } };
      if (shape === "same_base") response.turn = { id: "failed-turn" };
      if (shape === "thread_getter")
        Object.defineProperty(response, "thread", {
          get: () => {
            effect();
            return { id: "exact-thread" };
          },
        });
      harness.startTurn.mockImplementationOnce(
        () => response as ReturnType<typeof harness.startTurn>,
      );
      const reference = harness.ownerView();
      harness.state.startCodexOwnerContinuation(reference, "owner-operation");
      await flushJobs();
      harness.state.confirmCodexOwnerContinuation("owner-operation");
      await flushJobs();
      harness.state.commitCodexContinuation("owner-operation");
      await flushJobs();
      expect(
        harness.state.readCodexContinuationJob("owner-operation"),
      ).toMatchObject({
        status: "completed",
        submitted: false,
        mutationAttempted: true,
      });
      expect(harness.startTurn).toHaveBeenCalledTimes(1);
      expect(effect).not.toHaveBeenCalled();
      expect(Object.values(harness.api.readCodexContinuationMarkers())).toEqual(
        [
          expect.objectContaining({
            status: "attempted",
            intent: "OwnerContinue",
          }),
        ],
      );
    },
  );
  it("projects only inert canonical owner job evidence for native reservation", async () => {
    const harness = createHarness(false, undefined, "completed");
    const reference = harness.ownerView();
    harness.state.startCodexOwnerContinuation(reference, "owner-operation");
    await flushJobs();
    const retained = harness.state.codexContinuationJobs["owner-operation"];
    const getter = vi.fn(() => "must-not-read");
    Object.defineProperty(retained, "privateTransport", {
      enumerable: true,
      get: getter,
    });
    expect(
      harness.state.readCodexContinuationJob("owner-operation"),
    ).toMatchObject({
      status: "prepared",
      intent: "OwnerContinue",
      threadId: "exact-thread",
      expectedBaseTurnId: "failed-turn",
      baseTurnId: "failed-turn",
      runtimeGeneration: 1,
      submitted: false,
      mutationAttempted: false,
    });
    expect(
      harness.state.readCodexContinuationJob("owner-operation"),
    ).not.toHaveProperty("privateTransport");
    expect(
      harness.state.readCodexContinuationJob("owner-operation"),
    ).not.toHaveProperty("ownerViewReference");
    expect(
      harness.state.readCodexContinuationJob("owner-operation"),
    ).not.toHaveProperty("commit");
    expect(getter).not.toHaveBeenCalled();
    harness.state.confirmCodexOwnerContinuation("owner-operation");
    await flushJobs();
    harness.state.commitCodexContinuation("owner-operation");
    await flushJobs();
    expect(
      harness.state.readCodexContinuationJob("owner-operation"),
    ).toMatchObject({
      status: "completed",
      intent: "OwnerContinue",
      baseTurnId: "failed-turn",
      submitted: true,
      mutationAttempted: true,
      turnId: "continued-turn",
    });
  });
  it.each([
    { status: "completed", error: undefined },
    {
      status: "failed",
      error: { message: "Daily quota exhausted", retryable: false },
    },
    {
      status: "interrupted",
      error: { message: "The user cancelled the request" },
    },
  ])(
    "prepares one explicit idle owner action without relaxing auto policy: $status",
    async ({ status, error }) => {
      const harness = createHarness(false, error, status);
      const reference = harness.ownerView();
      expect(
        harness.api.classifyCodexContinuationThread(
          harness.failedThread,
          "exact-thread",
          "request-model",
        ).ready,
      ).toBe(false);
      expect(
        harness.state.startCodexOwnerContinuation(reference, "owner-operation"),
      ).toMatchObject({ started: true });
      await flushJobs();
      expect(
        harness.state.readCodexContinuationJob("owner-operation"),
      ).toMatchObject({
        status: "prepared",
        intent: "OwnerContinue",
        submitted: false,
        mutationAttempted: false,
      });
      expect(harness.startTurn).not.toHaveBeenCalled();
      harness.state.confirmCodexOwnerContinuation("owner-operation");
      await flushJobs();
      harness.state.commitCodexContinuation("owner-operation");
      await flushJobs();
      expect(harness.startTurn).toHaveBeenCalledTimes(1);
      expect(harness.startTurn).toHaveBeenCalledWith({
        threadId: "exact-thread",
        input: [{ type: "text", text: "continue" }],
      });
    },
  );

  it.each(["failed", "interrupted"])(
    "allows one explicit continuation from loaded systemError with terminal %s",
    async (turnStatus) => {
      const harness = createHarness(false, { retryable: false }, turnStatus);
      const reference = harness.ownerView();
      harness.failedThread.status = { type: "systemError", activeFlags: [] };
      expect(
        harness.api.classifyCodexContinuationThread(
          harness.failedThread,
          "exact-thread",
          "request-model",
        ).ready,
      ).toBe(false);
      harness.state.startCodexOwnerContinuation(reference, "owner-operation");
      await flushJobs();
      expect(
        harness.state.readCodexContinuationJob("owner-operation"),
      ).toMatchObject({
        status: "prepared",
        submitted: false,
        mutationAttempted: false,
      });
      harness.state.confirmCodexOwnerContinuation("owner-operation");
      await flushJobs();
      harness.state.commitCodexContinuation("owner-operation");
      await flushJobs();
      expect(harness.startTurn).toHaveBeenCalledTimes(1);
      expect(harness.startTurn).toHaveBeenCalledWith({
        threadId: "exact-thread",
        input: [{ type: "text", text: "continue" }],
      });
    },
  );

  it.each(["completed", "inProgress", "unknown"])(
    "rejects loaded systemError without a failed/interrupted latest turn: %s",
    async (turnStatus) => {
      const harness = createHarness(false, undefined, turnStatus);
      const reference = harness.ownerView();
      harness.failedThread.status = { type: "systemError", activeFlags: [] };
      harness.state.startCodexOwnerContinuation(reference, "owner-operation");
      await flushJobs();
      expect(
        harness.state.readCodexContinuationJob("owner-operation"),
      ).toMatchObject({
        status: "completed",
        submitted: false,
        mutationAttempted: false,
      });
      expect(harness.startTurn).not.toHaveBeenCalled();
    },
  );

  it.each(
    ["failed", "interrupted"].flatMap((turnStatus) =>
      [
        { status: { type: "systemError", activeFlags: ["waitingOnApproval"] } },
        {
          status: { type: "systemError", activeFlags: ["waitingOnUserInput"] },
        },
        { pendingApprovals: ["pending"] },
        { pendingOperations: ["pending"] },
        { pendingRequests: ["pending"] },
        { pendingApproval: true },
        { pendingOperation: true },
        { waitingOnApproval: true },
        { waitingOnUserInput: true },
        { pendingApprovals: null },
        { status: { type: "systemError", activeFlags: null } },
      ].map((pending) => ({ turnStatus, pending })),
    ),
  )(
    "rejects loaded systemError with conflicting or unreadable pending state: %j",
    async ({ turnStatus, pending }) => {
      const harness = createHarness(false, undefined, turnStatus);
      const reference = harness.ownerView();
      harness.failedThread.status = { type: "systemError", activeFlags: [] };
      Object.assign(harness.failedThread, pending);
      harness.state.startCodexOwnerContinuation(reference, "owner-operation");
      await flushJobs();
      expect(
        harness.state.readCodexContinuationJob("owner-operation"),
      ).toMatchObject({
        status: "completed",
        submitted: false,
        mutationAttempted: false,
      });
      expect(harness.startTurn).not.toHaveBeenCalled();
    },
  );

  it.each(["active", "completed"])(
    "rechecks loaded systemError eligibility at final commit: %s",
    async (change) => {
      const harness = createHarness(false, undefined, "failed", {
        pauseCommitRead: true,
      });
      const reference = harness.ownerView();
      harness.failedThread.status = { type: "systemError", activeFlags: [] };
      harness.state.startCodexOwnerContinuation(reference, "owner-operation");
      await flushJobs();
      expect(
        harness.state.readCodexContinuationJob("owner-operation").status,
      ).toBe("prepared");
      harness.state.confirmCodexOwnerContinuation("owner-operation");
      await flushJobs();
      harness.state.commitCodexContinuation("owner-operation");
      await flushJobs();
      if (change === "active")
        harness.failedThread.status = { type: "active", activeFlags: [] };
      else harness.failedThread.turns[0].status = "completed";
      harness.releaseCommitRead();
      await flushJobs();
      expect(harness.startTurn).not.toHaveBeenCalled();
      expect(harness.api.readCodexContinuationMarkers()).toEqual({});
    },
  );

  it.each([
    undefined,
    "idle",
    { type: "active", activeFlags: [] },
    { type: "active", activeFlags: ["waitingOnApproval"] },
    { type: "active", activeFlags: ["waitingOnUserInput"] },
    { type: "notLoaded" },
    { type: "systemError" },
    { type: "idle", activeFlags: ["waitingOnApproval"] },
  ])(
    "refuses unknown/nonquiescent native state including systemError with completed turn: %j",
    async (status) => {
      const harness = createHarness(false, undefined, "completed");
      const reference = harness.ownerView();
      harness.failedThread.status = status;
      harness.state.startCodexOwnerContinuation(reference, "owner-operation");
      await flushJobs();
      expect(
        harness.state.readCodexContinuationJob("owner-operation"),
      ).toMatchObject({
        status: "completed",
        submitted: false,
        mutationAttempted: false,
      });
      expect(harness.startTurn).not.toHaveBeenCalled();
    },
  );

  it.each(["pendingApprovals", "pendingOperations"] as const)(
    "refuses conflicting native pending state: %s",
    async (field) => {
      const harness = createHarness(false, undefined, "completed");
      const reference = harness.ownerView();
      harness.failedThread[field] = ["pending"];
      harness.state.startCodexOwnerContinuation(reference, "owner-operation");
      await flushJobs();
      expect(
        harness.state.readCodexContinuationJob("owner-operation"),
      ).toMatchObject({
        status: "completed",
        submitted: false,
        mutationAttempted: false,
      });
      expect(harness.startTurn).not.toHaveBeenCalled();
    },
  );

  it("rejects an absent or forged view reference without reading a thread", () => {
    const harness = createHarness();
    expect(
      harness.state.startCodexOwnerContinuation(
        "not-issued",
        "owner-operation",
      ),
    ).toMatchObject({ started: false });
    expect(harness.readCount()).toBe(0);
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it("does not invoke arbitrary coercions or accept an arbitrary content object", () => {
    const harness = createHarness();
    const coercion = vi.fn(() => "owner-view");
    expect(
      harness.state.startCodexOwnerContinuation(
        { toString: coercion } as unknown as string,
        "owner-operation",
      ),
    ).toMatchObject({ started: false });
    expect(coercion).not.toHaveBeenCalled();
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it("rejects a stale latest-turn binding before preparation", async () => {
    const harness = createHarness(false, undefined, "completed");
    const reference = harness.ownerView();
    harness.changeFailedTurn("newer-turn");
    harness.state.startCodexOwnerContinuation(reference, "owner-operation");
    await flushJobs();
    expect(
      harness.state.readCodexContinuationJob("owner-operation"),
    ).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
    });
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it.each([
    "turn",
    "provider",
    "view",
    "user-action",
    "runtime",
    "client",
  ] as const)("rechecks owner binding after final read: %s", async (change) => {
    const harness = createHarness(false, undefined, "completed", {
      pauseCommitRead: true,
    });
    const reference = harness.ownerView();
    harness.state.startCodexOwnerContinuation(reference, "owner-operation");
    await flushJobs();
    expect(
      harness.state.readCodexContinuationJob("owner-operation").status,
    ).toBe("prepared");
    harness.state.confirmCodexOwnerContinuation("owner-operation");
    await flushJobs();
    harness.state.commitCodexContinuation("owner-operation");
    await flushJobs();
    if (change === "turn") harness.changeFailedTurn("newer-turn");
    else if (change === "provider")
      harness.failedThread.modelProvider = "another-provider";
    else if (change === "view") harness.expireOwnerView();
    else if (change === "runtime") harness.replaceInstallation();
    else if (change === "client") harness.replaceHook();
    else
      harness.api.rememberCodexUserTurnAction("turn/interrupt", {
        threadId: "exact-thread",
      });
    harness.releaseCommitRead();
    await flushJobs();
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
    expect(
      harness.state.readCodexContinuationJob("owner-operation"),
    ).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
    });
  });

  it("shares the base-turn mutation marker across owner and automatic jobs", async () => {
    const harness = createHarness();
    const reference = harness.ownerView();
    harness.start();
    harness.state.startCodexOwnerContinuation(reference, "owner-operation");
    await flushJobs();
    expect(harness.job().status).toBe("prepared");
    expect(
      harness.state.readCodexContinuationJob("owner-operation").status,
    ).toBe("prepared");
    harness.state.commitCodexContinuation("recovery-id");
    harness.state.confirmCodexOwnerContinuation("owner-operation");
    await flushJobs();
    harness.state.commitCodexContinuation("owner-operation");
    await flushJobs();
    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    expect(harness.api.readCodexContinuationMarkers()).toMatchObject({
      "exact-thread:failed-turn": { status: "submitted" },
    });
  });

  it("does not replay an uncertain owner mutation under a new operation id", async () => {
    const harness = createHarness(false, undefined, "completed");
    const reference = harness.ownerView();
    harness.startTurn.mockImplementation(() => {
      throw new Error("Connection lost after dispatch");
    });
    harness.state.startCodexOwnerContinuation(reference, "owner-operation");
    await flushJobs();
    harness.state.confirmCodexOwnerContinuation("owner-operation");
    await flushJobs();
    harness.state.commitCodexContinuation("owner-operation");
    await flushJobs();
    expect(
      harness.state.readCodexContinuationJob("owner-operation"),
    ).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: true,
    });
    harness.state.startCodexOwnerContinuation(
      reference,
      "second-owner-operation",
    );
    await flushJobs();
    harness.state.confirmCodexOwnerContinuation("second-owner-operation");
    await flushJobs();
    harness.state.commitCodexContinuation("second-owner-operation");
    await flushJobs();
    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    expect(harness.api.readCodexContinuationMarkers()).toMatchObject({
      "exact-thread:failed-turn": { status: "attempted" },
    });
  });

  it("reuses one owner operation but refuses rebinding its id to another snapshot", async () => {
    const harness = createHarness(false, undefined, "completed");
    const reference = harness.ownerView();
    harness.state.startCodexOwnerContinuation(reference, "owner-operation");
    await flushJobs();
    expect(
      harness.state.startCodexOwnerContinuation(reference, "owner-operation"),
    ).toMatchObject({ started: true });
    const otherReference = harness.ownerView("another-owner-view");
    expect(
      harness.state.startCodexOwnerContinuation(
        otherReference,
        "owner-operation",
      ),
    ).toMatchObject({ started: false });
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it("rejects getter-backed native thread identity without evaluating it", async () => {
    const harness = createHarness();
    const idGetter = vi.fn(() => "exact-thread");
    Object.defineProperty(harness.failedThread, "id", { get: idGetter });
    harness.start();
    await flushJobs();
    expect(idGetter).not.toHaveBeenCalled();
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
    });
  });
});

describe("durable shared continuation evidence", () => {
  it.each(["attempted", "submitted"])(
    "does not age out old %s evidence when writing another turn",
    async (status) => {
      const harness = createHarness();
      const oldWrittenAt = Date.now() - 48 * 60 * 60 * 1000;
      harness.seedMarkers({
        "exact-thread:older-base-turn": {
          recoveryId: "older-operation",
          status,
          writtenAt: oldWrittenAt,
        },
      });
      harness.start();
      await flushJobs();
      harness.state.commitCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.startTurn).toHaveBeenCalledTimes(1);
      expect(harness.api.readCodexContinuationMarkers()).toMatchObject({
        "exact-thread:older-base-turn": { status, writtenAt: oldWrittenAt },
      });
      harness.changeFailedTurn("older-base-turn");
      harness.state.startCodexContinuation(
        "exact-thread",
        "another-operation",
        "request-model",
        Date.now() - 1000,
      );
      await flushJobs();
      harness.state.commitCodexContinuation("another-operation");
      await flushJobs();
      expect(harness.startTurn).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses without sending when attempted evidence cannot be persisted", async () => {
    const harness = createHarness(false, undefined, "completed");
    const reference = harness.ownerView();
    harness.state.startCodexOwnerContinuation(reference, "owner-operation");
    await flushJobs();
    harness.refuseMarkerWrites();
    harness.state.confirmCodexOwnerContinuation("owner-operation");
    await flushJobs();
    harness.state.commitCodexContinuation("owner-operation");
    await flushJobs();
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(
      harness.state.readCodexContinuationJob("owner-operation"),
    ).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
    });
  });
});

describe("owner continuation exact-client and inert-input boundaries", () => {
  it("never discovers or falls back to another client for an issued owner view", async () => {
    const harness = createHarness(false, undefined, "completed");
    const reference = harness.ownerView();
    const otherRead = vi.fn();
    harness.state.appServerClients = [
      { hostId: "local", sendRequest: otherRead },
    ];
    harness.state.startCodexOwnerContinuation(reference, "owner-operation");
    await flushJobs();
    expect(harness.readCount()).toBe(0);
    expect(otherRead).not.toHaveBeenCalled();
    expect(
      harness.state.readCodexContinuationJob("owner-operation"),
    ).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it("does not read any client for a revoked view reference", () => {
    const harness = createHarness(false, undefined, "completed");
    const reference = harness.ownerView();
    harness.expireOwnerView();
    expect(
      harness.state.startCodexOwnerContinuation(reference, "owner-operation"),
    ).toMatchObject({ started: false });
    expect(harness.readCount()).toBe(0);
  });

  it("rejects a reference revoked while its first exact read is pending", async () => {
    const harness = createHarness(true, undefined, "completed");
    const reference = harness.ownerView();
    harness.state.startCodexOwnerContinuation(reference, "owner-operation");
    await flushJobs();
    harness.expireOwnerView();
    harness.releaseRead();
    await flushJobs();
    expect(
      harness.state.readCodexContinuationJob("owner-operation"),
    ).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it.each(["status", "pendingApprovals"] as const)(
    "does not invoke getter-backed native owner state: %s",
    async (field) => {
      const harness = createHarness(false, undefined, "completed");
      const reference = harness.ownerView();
      const getter = vi.fn(() => (field === "status" ? { type: "idle" } : []));
      Object.defineProperty(harness.failedThread, field, { get: getter });
      harness.state.startCodexOwnerContinuation(reference, "owner-operation");
      await flushJobs();
      expect(getter).not.toHaveBeenCalled();
      expect(
        harness.state.readCodexContinuationJob("owner-operation"),
      ).toMatchObject({
        status: "completed",
        submitted: false,
        mutationAttempted: false,
      });
      expect(harness.startTurn).not.toHaveBeenCalled();
    },
  );

  it("ignores arbitrary extra prompt/RPC arguments and only prepares literal continue", async () => {
    const harness = createHarness(false, undefined, "completed");
    const reference = harness.ownerView();
    const getter = vi.fn(() => "arbitrary-command");
    const arbitrary = Object.defineProperty({}, "input", { get: getter });
    (
      harness.state.startCodexOwnerContinuation as (
        ...args: unknown[]
      ) => unknown
    )(reference, "owner-operation", arbitrary);
    await flushJobs();
    expect(harness.startTurn).not.toHaveBeenCalled();
    harness.state.confirmCodexOwnerContinuation("owner-operation");
    await flushJobs();
    harness.state.commitCodexContinuation("owner-operation");
    await flushJobs();
    expect(getter).not.toHaveBeenCalled();
    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    expect(harness.startTurn).toHaveBeenCalledWith({
      threadId: "exact-thread",
      input: [{ type: "text", text: "continue" }],
    });
  });

  it("does not reuse one job id across automatic and owner intents", async () => {
    const harness = createHarness();
    const reference = harness.ownerView();
    harness.start();
    await flushJobs();
    expect(
      harness.state.startCodexOwnerContinuation(reference, "recovery-id"),
    ).toMatchObject({ started: false });
    expect(harness.job()).toMatchObject({
      intent: "AutoRecovery",
      status: "prepared",
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
  });
});

describe("owner continuation shared pending-state proof", () => {
  it.each([
    "pendingApproval",
    "pendingOperation",
    "waitingOnApproval",
    "waitingOnUserInput",
  ] as const)(
    "rejects affirmative pending flag %s despite an idle status",
    async (field) => {
      const harness = createHarness(false, undefined, "completed");
      const reference = harness.ownerView();
      harness.failedThread[field] = true;
      harness.state.startCodexOwnerContinuation(reference, "owner-operation");
      await flushJobs();
      expect(
        harness.state.readCodexContinuationJob("owner-operation"),
      ).toMatchObject({
        status: "completed",
        submitted: false,
        mutationAttempted: false,
      });
      expect(harness.startTurn).not.toHaveBeenCalled();
    },
  );
});

describe("malformed continuation evidence fails closed", () => {
  it("does not treat a malformed persisted marker document as an empty history", async () => {
    const harness = createHarness();
    harness.seedMarkers([]);
    harness.start();
    await flushJobs();
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
    });
  });

  it("does not erase an exact-base-turn marker merely because its payload is malformed", async () => {
    const harness = createHarness();
    harness.seedMarkers({ "exact-thread:failed-turn": null });
    harness.start();
    await flushJobs();
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: true,
    });
  });
});

it("refuses an optional latest-turn model accessor instead of treating it as absent", async () => {
  const harness = createHarness(false, undefined, "completed");
  const reference = harness.ownerView();
  const getter = vi.fn(() => "another-model");
  Object.defineProperty(harness.failedThread.turns[0], "model", {
    get: getter,
  });
  harness.state.startCodexOwnerContinuation(reference, "owner-operation");
  await flushJobs();
  expect(getter).not.toHaveBeenCalled();
  expect(
    harness.state.readCodexContinuationJob("owner-operation"),
  ).toMatchObject({
    status: "completed",
    submitted: false,
    mutationAttempted: false,
  });
  expect(harness.startTurn).not.toHaveBeenCalled();
});

describe("owner continuation finite diagnostics", () => {
  it("does not serialize raw exact-read transport errors into owner jobs", async () => {
    const marker = "redacted-provider-error-marker";
    const harness = createHarness(false, undefined, "completed", {
      readError: new Error(marker),
    });
    const reference = harness.ownerView();
    harness.state.startCodexOwnerContinuation(reference, "owner-operation");
    await flushJobs();
    const job = harness.state.readCodexContinuationJob("owner-operation");
    expect(job).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
    });
    expect(JSON.stringify(job)).not.toContain(marker);
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it("reports an uncertain owner send without serializing its raw error", async () => {
    const marker = "redacted-provider-error-marker";
    const harness = createHarness(false, undefined, "completed");
    const reference = harness.ownerView();
    harness.startTurn.mockImplementation(() => {
      throw new Error(marker);
    });
    harness.state.startCodexOwnerContinuation(reference, "owner-operation");
    await flushJobs();
    harness.state.confirmCodexOwnerContinuation("owner-operation");
    await flushJobs();
    harness.state.commitCodexContinuation("owner-operation");
    await flushJobs();
    const job = harness.state.readCodexContinuationJob("owner-operation");
    expect(job).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: true,
    });
    expect(JSON.stringify(job)).not.toContain(marker);
    expect(harness.startTurn).toHaveBeenCalledTimes(1);
  });
});

it("refuses an owner action when a user stop shares the snapshot millisecond", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  try {
    const harness = createHarness(false, undefined, "completed");
    const reference = harness.ownerView("owner-view", Date.now());
    harness.api.rememberCodexUserTurnAction("turn/interrupt", {
      threadId: "exact-thread",
    });
    harness.state.startCodexOwnerContinuation(reference, "owner-operation");
    await flushJobs();
    harness.state.confirmCodexOwnerContinuation("owner-operation");
    await flushJobs();
    harness.state.commitCodexContinuation("owner-operation");
    await flushJobs();
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
  } finally {
    clock.mockRestore();
  }
});

describe("owner canonical user-action evidence", () => {
  it("rejects clock rollback and catch-up without relying on wall-clock ordering", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const harness = createHarness(false, undefined, "completed");
      const reference = harness.ownerView("owner-view", Date.now());
      harness.state.startCodexOwnerContinuation(reference, "owner-operation");
      await flushJobs();
      clock.mockReturnValue(900_000);
      harness.api.rememberCodexUserTurnAction("turn/interrupt", {
        threadId: "exact-thread",
      });
      clock.mockReturnValue(1_000_000);
      harness.state.confirmCodexOwnerContinuation("owner-operation");
      await flushJobs();
      harness.state.commitCodexContinuation("owner-operation");
      await flushJobs();
      expect(harness.startTurn).not.toHaveBeenCalled();
      expect(harness.api.readCodexContinuationMarkers()).toEqual({});
    } finally {
      clock.mockRestore();
    }
  });

  it("allows a fresh owner view captured after a prior action in the same millisecond", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const harness = createHarness(false, undefined, "completed");
      harness.api.rememberCodexUserTurnAction("turn/interrupt", {
        threadId: "exact-thread",
      });
      const reference = harness.ownerView("owner-view", Date.now());
      harness.state.startCodexOwnerContinuation(reference, "owner-operation");
      await flushJobs();
      expect(
        harness.state.readCodexContinuationJob("owner-operation").status,
      ).toBe("prepared");
      harness.state.confirmCodexOwnerContinuation("owner-operation");
      await flushJobs();
      harness.state.commitCodexContinuation("owner-operation");
      await flushJobs();
      expect(harness.startTurn).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("makes owner evidence unavailable without secure randomness but preserves automatic preparation", async () => {
    const harness = createHarness(false, undefined, "failed", {
      noCrypto: true,
    });
    expect(
      harness.api.captureCodexOwnerUserActionEvidence("exact-thread"),
    ).toBeNull();
    harness.start();
    await flushJobs();
    expect(harness.job().status).toBe("prepared");
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.startTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps action evidence stable across reads but changes on every same-tick action", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const harness = createHarness();
      harness.api.rememberCodexUserTurnAction("turn/interrupt", {
        threadId: "exact-thread",
      });
      const first =
        harness.api.captureCodexOwnerUserActionEvidence("exact-thread");
      expect(first).not.toBeNull();
      expect(
        harness.api.codexOwnerUserActionEvidenceIsCurrent(
          "exact-thread",
          first,
        ),
      ).toBe(true);
      harness.api.rememberCodexUserTurnAction("turn/interrupt", {
        threadId: "exact-thread",
      });
      expect(
        harness.api.codexOwnerUserActionEvidenceIsCurrent(
          "exact-thread",
          first,
        ),
      ).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([1, 128])(
    "parses unchanged persisted action evidence once across repeated reads of %i threads",
    (threadCount) => {
      const { api, storage } = createHarness();
      const storageKey = "ccswitch-codex-user-turn-actions-v1";
      const revision = "a".repeat(32);
      const threadIds = Array.from(
        { length: threadCount },
        (_, index) => `thread-${index}`,
      );
      const document = {
        schemaVersion: 2,
        revision,
        actions: Object.fromEntries(
          threadIds.map((id, index) => [
            id,
            {
              method: "turn/start",
              atMs: 1_000_000,
              actionId: (index + 1).toString(16).padStart(32, "0"),
            },
          ]),
        ),
      };
      const unchanged = JSON.stringify(document);
      storage.set(storageKey, unchanged);
      const storageReads = vi.spyOn(storage, "get");
      const parse = vi.spyOn(JSON, "parse");
      try {
        const threadId = threadIds[0];
        const first = api.captureCodexOwnerUserActionEvidence(threadId);
        expect(first).toMatchObject({
          documentRevision: revision,
          persistedMethod: "turn/start",
        });
        for (let poll = 0; poll < 3; poll += 1) {
          for (const id of threadIds) {
            expect(api.captureCodexOwnerUserActionEvidence(id)).toMatchObject({
              documentRevision: revision,
              persistedMethod: "turn/start",
            });
          }
        }
        expect(
          storageReads.mock.calls.filter(([key]) => key === storageKey),
        ).toHaveLength(threadCount * 3 + 1);
        expect(
          parse.mock.calls.filter(([raw]) => raw === unchanged),
        ).toHaveLength(1);

        document.actions[threadId].method = "turn/interrupt";
        const changed = JSON.stringify(document);
        storage.set(storageKey, changed);
        expect(api.codexOwnerUserActionEvidenceIsCurrent(threadId, first)).toBe(
          false,
        );
        expect(api.captureCodexOwnerUserActionEvidence(threadId)).toMatchObject(
          {
            documentRevision: revision,
            persistedMethod: "turn/interrupt",
          },
        );
        expect(
          parse.mock.calls.filter(([raw]) => raw === changed),
        ).toHaveLength(1);

        document.actions[threadId].method = "invalid-method";
        storage.set(storageKey, JSON.stringify(document));
        expect(api.captureCodexOwnerUserActionEvidence(threadId)).toBeNull();
        storage.delete(storageKey);
        expect(api.captureCodexOwnerUserActionEvidence(threadId)).toBeNull();

        storage.set(storageKey, unchanged);
        expect(api.captureCodexOwnerUserActionEvidence(threadId)).toEqual(
          first,
        );
        expect(
          parse.mock.calls.filter(([raw]) => raw === unchanged),
        ).toHaveLength(2);
      } finally {
        parse.mockRestore();
        storageReads.mockRestore();
      }
    },
  );
});

describe("automatic recovery bounded source contract", () => {
  it("uses only metadata and one unloaded latest turn through preparation and commit", async () => {
    const harness = createHarness();
    harness.start();
    await flushJobs();
    expect(harness.job().status).toBe("prepared");
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    const reads = harness.requestCalls.filter(
      ([method]) => method !== "turn/start",
    );
    expect(reads).toHaveLength(6);
    for (const [method, params] of reads) {
      expect(params).toEqual(
        method === "thread/read"
          ? { threadId: "exact-thread", includeTurns: false }
          : {
              threadId: "exact-thread",
              cursor: null,
              limit: 1,
              sortDirection: "desc",
              itemsView: "notLoaded",
            },
      );
    }
  });

  it("refuses unavailable pagination without loading the automatic recovery transcript", async () => {
    const harness = createHarness(false, undefined, "failed", {
      boundedHistoryUnavailable: true,
    });
    harness.start();
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.requestCalls).toEqual([
      ["thread/read", { threadId: "exact-thread", includeTurns: false }],
      [
        "thread/turns/list",
        {
          threadId: "exact-thread",
          cursor: null,
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        },
      ],
    ]);
  });

  it("reprepares the same recovery id after active work reaches a recoverable terminal state", async () => {
    const harness = createHarness(false, undefined, "inProgress");
    const observedAt = Date.now() - 1000;
    const start = () =>
      harness.state.startCodexContinuation(
        "exact-thread",
        "recovery-id",
        "request-model",
        observedAt,
      );
    harness.failedThread.status = { type: "active" };
    start();
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
      reason: "The interrupted Codex thread is still active",
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
    harness.failedThread.status = { type: "idle" };
    harness.failedThread.turns[0].status = "failed";
    start();
    await flushJobs();
    expect(harness.job().status).toBe("prepared");
    expect(harness.readCount()).toBe(3);
    expect(harness.startTurn).not.toHaveBeenCalled();
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    expect(harness.job().submitted).toBe(true);
    expect(
      harness.requestCalls
        .filter(([method]) => method === "thread/read")
        .every(
          ([, params]) =>
            (params as { includeTurns: boolean }).includeTurns === false,
        ),
    ).toBe(true);
  });

  it.each([
    { status: "failed", error: { message: "The user cancelled the turn" } },
    {
      status: "failed",
      error: { code: "authentication_error", message: "Authentication failed" },
    },
    {
      status: "failed",
      error: {
        code: "response_pending",
        message: "The upstream operation is still pending",
      },
    },
    { status: "interrupted", error: {} },
    { status: "completed", error: {} },
    { status: "unknown", error: {} },
  ])(
    "preserves refusal for bounded terminal metadata $status $error",
    async ({ status, error }) => {
      const harness = createHarness(false, error, status);
      harness.start();
      await flushJobs();
      expect(harness.job()).toMatchObject({
        status: "completed",
        submitted: false,
        mutationAttempted: false,
      });
      harness.state.commitCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.startTurn).not.toHaveBeenCalled();
      expect(harness.api.readCodexContinuationMarkers()).toEqual({});
    },
  );

  it("refuses accessor-backed bounded terminal errors without evaluating them", async () => {
    const harness = createHarness();
    const readError = vi.fn(() => ({ message: "untrusted accessor" }));
    Object.defineProperty(harness.failedThread.turns[0], "error", {
      get: readError,
    });
    harness.start();
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
    });
    expect(readError).not.toHaveBeenCalled();
    expect(harness.startTurn).not.toHaveBeenCalled();
  });
});

describe("owner continuation bounded source contract", () => {
  it("uses only metadata and latest-turn pages throughout preparation and commit", async () => {
    const harness = createHarness(false, undefined, "completed");
    const reference = harness.ownerView();
    harness.state.startCodexOwnerContinuation(
      reference,
      "bounded-owner-operation",
    );
    await flushJobs();
    expect(
      harness.state.readCodexContinuationJob("bounded-owner-operation").status,
    ).toBe("prepared");
    harness.state.confirmCodexOwnerContinuation("bounded-owner-operation");
    await flushJobs();
    harness.state.commitCodexContinuation("bounded-owner-operation");
    await flushJobs();
    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    const reads = harness.requestCalls.filter(
      ([method]) => method !== "turn/start",
    );
    expect(reads).toHaveLength(6);
    for (const [method, params] of reads) {
      expect(params).toEqual(
        method === "thread/read"
          ? { threadId: "exact-thread", includeTurns: false }
          : {
              threadId: "exact-thread",
              cursor: null,
              limit: 1,
              sortDirection: "desc",
              itemsView: "notLoaded",
            },
      );
    }
  });

  it("refuses unavailable pagination without falling back to a full owner transcript read", async () => {
    const harness = createHarness(false, undefined, "completed", {
      boundedHistoryUnavailable: true,
    });
    const reference = harness.ownerView();
    harness.state.startCodexOwnerContinuation(
      reference,
      "unsupported-owner-operation",
    );
    await flushJobs();
    expect(
      harness.state.readCodexContinuationJob("unsupported-owner-operation"),
    ).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.requestCalls).toEqual([
      ["thread/read", { threadId: "exact-thread", includeTurns: false }],
      [
        "thread/turns/list",
        {
          threadId: "exact-thread",
          cursor: null,
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        },
      ],
    ]);
  });
});

it.each([
  {
    data: [
      { id: "failed-turn", status: "completed", itemsView: "full", items: [] },
    ],
    nextCursor: null,
  },
  {
    data: [
      {
        id: "failed-turn",
        status: "completed",
        itemsView: "notLoaded",
        items: [{ text: "raw-history-marker" }],
      },
    ],
    nextCursor: null,
  },
  {
    data: Array.from({ length: 2 }, () => ({
      id: "failed-turn",
      status: "completed",
      itemsView: "notLoaded",
      items: [],
    })),
    nextCursor: null,
  },
])(
  "refuses owner turn metadata when the server ignores source bounds",
  async (boundedHistoryPage) => {
    const harness = createHarness(false, undefined, "completed", {
      boundedHistoryPage,
    });
    const reference = harness.ownerView();
    harness.state.startCodexOwnerContinuation(
      reference,
      "unbounded-owner-operation",
    );
    await flushJobs();
    const job = harness.state.readCodexContinuationJob(
      "unbounded-owner-operation",
    );
    expect(job).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
    });
    expect(JSON.stringify(job)).not.toContain("raw-history-marker");
    expect(harness.startTurn).not.toHaveBeenCalled();
  },
);

describe("Codex usage-limit continuation", () => {
  const genericDesktopError = {
    message: "An error occurred.",
    codexErrorInfo: "other",
    additionalDetails: null,
  };
  const usageError = {
    message: "You've hit your usage limit. Try again later.",
    codexErrorInfo: "usageLimitExceeded",
  };
  const planUsageError = {
    message:
      "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 7:45 PM.",
    codexErrorInfo: "usageLimitExceeded",
    additionalDetails: null,
  };
  const dailyUsageMessage =
    "Daily usage limit exceeded. The upstream provider's daily Codex allowance is exhausted.";
  it("submits literal continue when the bounded turn page omits its optional cursor", async () => {
    const harness = createHarness(false, usageError, "failed", {
      boundedHistoryPage: {
        data: [
          {
            id: "failed-turn",
            status: "failed",
            error: usageError,
            itemsView: "notLoaded",
            items: [],
          },
        ],
      },
    });
    harness.failedThread.status = { type: "idle" };
    const observation = nativeObservation();
    harness.failedThread.modelProvider = observation.modelProvider;
    harness.state.getCodexNativeUsageLimitCandidate = () => observation;
    prepareUsageLimit(
      harness,
      true,
      observation.model,
      observation.observedAtMs,
    );
    await flushJobs();
    expect(harness.job().status).toBe("prepared");
    harness.state.confirmCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.job().status).toBe("confirmed");
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: true,
      mutationAttempted: true,
      turnId: "continued-turn",
    });
    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    expect(harness.startTurn).toHaveBeenCalledWith({
      threadId: "exact-thread",
      input: [{ type: "text", text: "continue" }],
    });
  });
  const dailyUsageError = {
    code: "usage_limit_reached",
    type: "usage_limit_reached",
    upstream_reason: "DAILY_LIMIT_EXCEEDED",
    message: dailyUsageMessage,
  };
  const dailyUsageTransportError = {
    codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } },
    message: dailyUsageMessage,
  };
  const dailyUsageNativeWrapper = {
    codexErrorInfo: "other",
    message: `unexpected status 403 Forbidden: ${JSON.stringify({
      error: { type: "upstream_error", message: "daily usage limit exceeded" },
    })}, url: http://localhost/responses`,
  };
  const dailyUsagePlainWrapper = {
    codexErrorInfo: "other",
    message:
      "unexpected status 403 Forbidden: daily usage limit exceeded, url: http://localhost/responses",
  };
  const dailyUsageTypedWrapper = {
    codexErrorInfo: "other",
    message: `unexpected status 429 Too Many Requests: ${JSON.stringify({
      error: dailyUsageError,
    })}, url: http://localhost/responses`,
  };
  const retryLimitTransportError = {
    codexErrorInfo: "other",
    message: "exceeded retry limit, last status: 429 Too Many Requests",
  };
  const prepareUsageLimit = (
    harness: ReturnType<typeof createHarness>,
    requireNativeObservation = false,
    model: string | null = "request-model",
    observedAtMs = Date.now() - 1_000,
  ) =>
    harness.state.startCodexUsageLimitContinuation(
      "exact-thread",
      "recovery-id",
      model,
      observedAtMs,
      "failed-turn",
      requireNativeObservation,
    );
  const nativeObservation = (model: string | null = "request-model") => ({
    model,
    modelProvider: "request-provider",
    observedAtMs: Date.now() - 1_000,
  });

  it.each(["submitted marker write", "native observer callback"])(
    "retains a validated submission when the %s fails",
    async (failure) => {
      const observeStart = vi.fn(() => {
        if (failure === "native observer callback")
          throw new Error("Native observation unavailable");
      });
      const harness = createHarness(false, usageError, "failed", {
        captureNativeAcknowledgement: () => observeStart,
      });
      harness.failedThread.status = { type: "idle" };
      const observation = nativeObservation();
      harness.failedThread.modelProvider = observation.modelProvider;
      harness.state.getCodexNativeUsageLimitCandidate = () => observation;
      const acknowledgement = { turn: { id: "continued-turn" } };
      harness.startTurn.mockImplementationOnce(() => {
        expect(harness.api.readCodexContinuationMarkers()).toMatchObject({
          "exact-thread:failed-turn": { status: "attempted" },
        });
        if (failure === "submitted marker write") harness.refuseMarkerWrites();
        return acknowledgement;
      });

      prepareUsageLimit(
        harness,
        true,
        observation.model,
        observation.observedAtMs,
      );
      await flushJobs();
      harness.state.confirmCodexContinuation("recovery-id");
      await flushJobs();
      harness.state.commitCodexContinuation("recovery-id");
      await flushJobs();

      expect(harness.job()).toMatchObject({
        status: "completed",
        submitted: true,
        mutationAttempted: true,
        turnId: "continued-turn",
      });
      expect(observeStart.mock.calls).toEqual([[acknowledgement]]);
      expect(harness.api.readCodexContinuationMarkers()).toMatchObject({
        "exact-thread:failed-turn":
          failure === "submitted marker write"
            ? { status: "attempted" }
            : { status: "submitted", turnId: "continued-turn" },
      });

      harness.state.startCodexUsageLimitContinuation(
        "exact-thread",
        "duplicate-recovery-id",
        observation.model,
        observation.observedAtMs,
        "failed-turn",
        true,
      );
      await flushJobs();
      harness.state.confirmCodexContinuation("duplicate-recovery-id");
      await flushJobs();
      expect(
        harness.state.commitCodexContinuation("duplicate-recovery-id"),
      ).toMatchObject({ started: true });
      await flushJobs();
      expect(harness.startTurn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    usageError,
    planUsageError,
    dailyUsageError,
    {
      code: "USAGE_LIMIT_EXCEEDED",
      type: "upstream_error",
      message: "Provider returned a usage limit code",
    },
    dailyUsageTransportError,
    dailyUsageNativeWrapper,
    dailyUsagePlainWrapper,
    retryLimitTransportError,
    {
      codexErrorInfo: "other",
      message: `unexpected status 429 Too Many Requests: ${JSON.stringify({
        response: { error: dailyUsageError },
      })}, url: http://localhost/responses`,
    },
    ...["weekly", "monthly"].map((period) => ({
      codexErrorInfo: "usageLimitExceeded",
      message: `The upstream provider's ${period} usage limit was exceeded.`,
    })),
    ...["weekly", "monthly"].map((period) => ({
      codexErrorInfo: "other",
      message: `The upstream provider's ${period} usage limit was exceeded.`,
    })),
  ])(
    "submits literal continue only after confirming the exact usage-limited turn: %j",
    async (error) => {
      const harness = createHarness(false, error);
      harness.failedThread.status = { type: "systemError" };
      prepareUsageLimit(harness);
      await flushJobs();
      expect(harness.job().status).toBe("prepared");
      expect(
        harness.state.commitCodexContinuation("recovery-id"),
      ).toMatchObject({
        started: false,
      });
      harness.state.confirmCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.job().status).toBe("confirmed");
      harness.state.commitCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.startTurn).toHaveBeenCalledTimes(1);
      expect(harness.startTurn).toHaveBeenCalledWith({
        threadId: "exact-thread",
        input: [{ type: "text", text: "continue" }],
      });
    },
  );

  it("does not treat retry-limit transport text as native proof without exact proxy evidence", async () => {
    const harness = createHarness(false, retryLimitTransportError);
    harness.failedThread.status = { type: "systemError" };
    prepareUsageLimit(harness, true);
    await flushJobs();
    expect(harness.job()).toBeNull();
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it("continues an exact proxy-confirmed failed turn with a generic Desktop error", async () => {
    const harness = createHarness(false, genericDesktopError);
    harness.failedThread.status = { type: "systemError" };
    prepareUsageLimit(harness);
    await flushJobs();
    expect(harness.job().status).toBe("prepared");
    harness.state.confirmCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.job().status).toBe("confirmed");
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.startTurn).toHaveBeenCalledOnce();
    expect(harness.startTurn).toHaveBeenCalledWith({
      threadId: "exact-thread",
      input: [{ type: "text", text: "continue" }],
    });
  });

  it.each([
    { turnStatus: "interrupted", error: genericDesktopError },
    { turnStatus: "failed", error: null },
    { turnStatus: "failed", error: { message: "" } },
    {
      turnStatus: "failed",
      error: { ...genericDesktopError, code: "model_not_found" },
    },
    {
      turnStatus: "failed",
      error: { ...genericDesktopError, additionalDetails: "Access denied" },
    },
    {
      turnStatus: "failed",
      error: Object.defineProperty(
        { message: genericDesktopError.message },
        "codexErrorInfo",
        { get: () => "other" },
      ),
    },
  ])(
    "rejects a generic failure with ambiguous or conflicting evidence %#",
    async ({ turnStatus, error }) => {
      const harness = createHarness(false, undefined, turnStatus);
      harness.failedThread.status = { type: "systemError" };
      harness.failedThread.turns[0].error = error;
      prepareUsageLimit(harness);
      await flushJobs();
      expect(harness.job()).toMatchObject({
        status: "completed",
        mutationAttempted: false,
      });
      expect(harness.startTurn).not.toHaveBeenCalled();
    },
  );

  it("requires a current native usage-limit error for a native-only continuation", async () => {
    const harness = createHarness(false, genericDesktopError);
    const observation = nativeObservation();
    Object.assign(harness.failedThread, {
      status: { type: "systemError" },
      modelProvider: observation.modelProvider,
    });
    harness.state.getCodexNativeUsageLimitCandidate = () => observation;
    prepareUsageLimit(
      harness,
      true,
      observation.model,
      observation.observedAtMs,
    );
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "completed",
      mutationAttempted: false,
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it("revalidates the generic Desktop error immediately before submission", async () => {
    const error = { ...genericDesktopError };
    const harness = createHarness(false, error);
    harness.failedThread.status = { type: "systemError" };
    prepareUsageLimit(harness);
    await flushJobs();
    harness.state.confirmCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.job().status).toBe("confirmed");
    error.message = "Access denied";
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "completed",
      mutationAttempted: false,
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it("keeps the automatic continuation policy for plan limits with a credit suggestion", () => {
    const harness = createHarness();
    expect(
      harness.api.codexContinuationTerminalErrorCode("", {
        error: planUsageError,
      }),
    ).toBe("insufficient_quota");
  });

  it.each([
    dailyUsageError,
    dailyUsageTransportError,
    dailyUsageNativeWrapper,
    dailyUsagePlainWrapper,
    dailyUsageTypedWrapper,
  ])(
    "keeps automatic continuation blocked for a recurring allowance error: %j",
    async (error) => {
      const harness = createHarness(false, error);
      harness.start();
      await flushJobs();
      expect(harness.job()).toMatchObject({
        status: "completed",
        mutationAttempted: false,
      });
      expect(harness.startTurn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a different turn", { id: "newer-turn" }],
    ["a completed turn", { status: "completed" }],
    [
      "an unrelated error",
      { error: { message: "Our servers are overloaded" } },
    ],
    [
      "a hard limit",
      {
        error: {
          message: "You've hit your daily usage limit. Please try again later.",
        },
      },
    ],
    [
      "a quota failure with the same Codex error code",
      {
        error: {
          ...usageError,
          message: "Quota exceeded. Check your plan and billing details.",
        },
      },
    ],
    [
      "a limit with no retry wording",
      { error: { ...usageError, message: "You've hit your usage limit." } },
    ],
    [
      "a plan limit with explicit retry denial",
      { error: { ...planUsageError, retryable: false } },
    ],
    [
      "a plan limit reporting hard quota in its details",
      { error: { ...planUsageError, additionalDetails: "Quota exhausted." } },
    ],
    [
      "a period limit with explicit retry denial",
      { error: { ...dailyUsageError, retryable: false } },
    ],
    [
      "a period limit with a permission denial",
      {
        error: {
          ...dailyUsageError,
          additionalDetails: "This request was denied by content policy.",
        },
      },
    ],
    [
      "a period limit with a user cancellation",
      {
        error: {
          ...dailyUsageError,
          additionalDetails: "The user canceled the turn.",
        },
      },
    ],
    [
      "a period limit with a billing failure",
      { error: { ...dailyUsageError, additionalDetails: "Billing failed." } },
    ],
    [
      "an ordinary 403 denial with period wording in the endpoint URL",
      {
        error: {
          ...dailyUsageNativeWrapper,
          message:
            "unexpected status 403 Forbidden: Access denied, url: http://localhost/daily_usage_limit",
        },
      },
    ],
    [
      "a wrapped period limit with explicit retry denial",
      {
        error: {
          ...dailyUsageNativeWrapper,
          message: `unexpected status 403 Forbidden: ${JSON.stringify({ error: { ...dailyUsageError, retryable: false } })}, url: http://localhost/responses`,
        },
      },
    ],
    [
      "a wrapped period limit accompanied by an envelope permission code",
      {
        error: {
          ...dailyUsageNativeWrapper,
          message: `unexpected status 403 Forbidden: ${JSON.stringify({
            code: "access_denied",
            error: dailyUsageError,
          })}, url: http://localhost/responses`,
        },
      },
    ],
    [
      "a wrapped period limit accompanied by an envelope cancellation status",
      {
        error: {
          ...dailyUsageNativeWrapper,
          message: `unexpected status 403 Forbidden: ${JSON.stringify({
            status: "canceled",
            error: dailyUsageError,
          })}, url: http://localhost/responses`,
        },
      },
    ],
    [
      "a wrapped period limit with a retry denial in the nested response",
      {
        error: {
          ...dailyUsageNativeWrapper,
          message: `unexpected status 403 Forbidden: ${JSON.stringify({
            error: dailyUsageError,
            response: { error: { retryable: false } },
          })}, url: http://localhost/responses`,
        },
      },
    ],
    [
      "a wrapped period limit with conflicting permission details",
      {
        error: {
          ...dailyUsageNativeWrapper,
          message:
            "unexpected status 403 Forbidden: daily usage limit exceeded. Access denied, url: http://localhost/responses",
        },
      },
    ],
  ])("skips %s", async (_label, changedTurn) => {
    const harness = createHarness(false, usageError);
    harness.failedThread.status = { type: "idle" };
    Object.assign(harness.failedThread.turns[0], changedTurn);
    prepareUsageLimit(harness);
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "completed",
      mutationAttempted: false,
    });
    expect(harness.job().usageLimitDeferred).not.toBe(true);
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it.each([
    { status: { type: "active" } },
    { status: { type: "idle" }, pendingOperations: ["pending"] },
  ])("defers a thread with active or pending work", async (thread) => {
    const harness = createHarness(false, usageError);
    Object.assign(harness.failedThread, thread);
    prepareUsageLimit(harness);
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "completed",
      mutationAttempted: false,
      usageLimitDeferred: true,
    });
    expect(harness.job()).not.toHaveProperty("usageLimitReadUnavailable");
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "reports an unavailable initial read so another renderer can verify the interruption (native evidence: %s)",
    async (requireNativeObservation) => {
      const harness = createHarness(false, usageError, "failed", {
        readError: new Error("thread not found"),
      });
      const observation = nativeObservation();
      if (requireNativeObservation)
        harness.state.getCodexNativeUsageLimitCandidate = () => observation;
      expect(
        prepareUsageLimit(
          harness,
          requireNativeObservation,
          observation.model,
          observation.observedAtMs,
        ),
      ).toMatchObject({ started: true });
      await flushJobs();
      expect(harness.job()).toMatchObject({
        status: "completed",
        submitted: false,
        mutationAttempted: false,
        usageLimitDeferred: true,
        usageLimitReadUnavailable: true,
      });
      expect(harness.requestCalls).toEqual([
        ["thread/read", { threadId: "exact-thread", includeTurns: false }],
      ]);
      expect(harness.startTurn).not.toHaveBeenCalled();
    },
  );

  it.each([
    { read: 2, native: false, tryAnotherRenderer: true },
    { read: 3, native: false, tryAnotherRenderer: true },
    { read: 2, native: true, tryAnotherRenderer: false },
    { read: 3, native: true, tryAnotherRenderer: false },
  ])(
    "handles an unavailable exact read $read during recovery (native evidence: $native)",
    async ({ read, native, tryAnotherRenderer }) => {
      const harness = createHarness(false, usageError, "failed", {
        failOnThreadRead: read,
      });
      const observation = nativeObservation();
      Object.assign(harness.failedThread, {
        status: { type: "idle" },
        modelProvider: observation.modelProvider,
      });
      if (native)
        harness.state.getCodexNativeUsageLimitCandidate = () => observation;
      expect(
        prepareUsageLimit(
          harness,
          native,
          observation.model,
          observation.observedAtMs,
        ),
      ).toMatchObject({ started: true });
      await flushJobs();
      if (read === 3) {
        expect(harness.job().status).toBe("prepared");
        harness.state.confirmCodexContinuation("recovery-id");
        await flushJobs();
      }
      expect(harness.readCount()).toBe(read);
      expect(harness.job()).toMatchObject({
        status: "completed",
        submitted: false,
        mutationAttempted: false,
        usageLimitDeferred: true,
      });
      expect(harness.job().usageLimitReadUnavailable === true).toBe(
        tryAnotherRenderer,
      );
      expect(harness.job().reason).not.toContain("private response detail");
      expect(harness.startTurn).not.toHaveBeenCalled();
    },
  );

  it("preserves a user stop while an exact confirmation read fails", async () => {
    const harness = createHarness(false, usageError, "failed", {
      failOnThreadRead: 3,
      pauseCommitRead: true,
    });
    harness.failedThread.status = { type: "idle" };
    prepareUsageLimit(harness);
    await flushJobs();
    expect(harness.job().status).toBe("prepared");
    harness.state.confirmCodexContinuation("recovery-id");
    await flushJobs();
    harness.api.rememberCodexUserTurnAction("turn/interrupt", {
      threadId: "exact-thread",
      turnId: "failed-turn",
    });
    harness.releaseCommitRead();
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
      reason:
        "The user changed or stopped the Codex thread before continuation",
    });
    expect(harness.job().usageLimitDeferred).not.toBe(true);
    expect(harness.job()).not.toHaveProperty("usageLimitReadUnavailable");
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it("withholds fallback when an exact confirmation returns a different thread", async () => {
    const harness = createHarness(false, usageError);
    harness.failedThread.status = { type: "idle" };
    prepareUsageLimit(harness);
    await flushJobs();
    expect(harness.job().status).toBe("prepared");
    harness.failedThread.id = "different-thread";
    harness.state.confirmCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
      reason: "Codex returned a different thread",
    });
    expect(harness.job()).not.toHaveProperty("usageLimitReadUnavailable");
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it.each([
    usageError,
    dailyUsageError,
    dailyUsageNativeWrapper,
    genericDesktopError,
  ])(
    "revalidates the usage limit before releasing the confirmed sender: %j",
    async (error) => {
      const harness = createHarness(false, error);
      harness.failedThread.status = { type: "idle" };
      prepareUsageLimit(harness);
      await flushJobs();
      expect(harness.job().status).toBe("prepared");
      harness.failedThread.turns[0].error = { message: "Connection closed" };
      harness.state.confirmCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.job()).toMatchObject({
        status: "completed",
        mutationAttempted: false,
      });
      expect(harness.job().usageLimitDeferred).not.toBe(true);
      expect(harness.startTurn).not.toHaveBeenCalled();
    },
  );

  it.each([dailyUsageError, dailyUsageTypedWrapper])(
    "confirms a native-only period limit for the same observed provider and turn: %j",
    async (error) => {
      const harness = createHarness(false, error);
      const observation = nativeObservation();
      Object.assign(harness.failedThread, {
        status: { type: "idle" },
        modelProvider: observation.modelProvider,
      });
      harness.state.getCodexNativeUsageLimitCandidate = () => observation;
      expect(
        prepareUsageLimit(
          harness,
          true,
          observation.model,
          observation.observedAtMs,
        ),
      ).toMatchObject({ started: true });
      await flushJobs();
      expect(harness.job().status).toBe("prepared");
      harness.state.confirmCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.job().status).toBe("confirmed");
      harness.state.commitCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.startTurn).toHaveBeenCalledOnce();
      expect(harness.startTurn).toHaveBeenCalledWith({
        threadId: "exact-thread",
        input: [{ type: "text", text: "continue" }],
      });
    },
  );

  it.each([false, true])(
    "resumes a verified native thread with no model field only while its provider is current (changed: %s)",
    async (providerChanged) => {
      const harness = createHarness(false, usageError);
      const observation = nativeObservation(null);
      Object.assign(harness.failedThread, {
        status: { type: "idle" },
        model: null,
        modelProvider: observation.modelProvider,
      });
      harness.state.getCodexNativeUsageLimitCandidate = () => observation;
      expect(prepareUsageLimit(harness, false, null)).toMatchObject({
        started: false,
      });
      expect(
        prepareUsageLimit(harness, true, null, observation.observedAtMs),
      ).toMatchObject({ started: true });
      await flushJobs();
      expect(harness.job().status).toBe("prepared");
      if (providerChanged)
        harness.failedThread.modelProvider = "other-provider";
      harness.state.confirmCodexContinuation("recovery-id");
      await flushJobs();
      harness.state.commitCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.job()).toMatchObject({
        status: "completed",
        submitted: !providerChanged,
        mutationAttempted: !providerChanged,
      });
      if (providerChanged) {
        expect(harness.startTurn).not.toHaveBeenCalled();
      } else {
        expect(harness.startTurn).toHaveBeenCalledTimes(1);
        expect(harness.startTurn).toHaveBeenCalledWith({
          threadId: "exact-thread",
          input: [{ type: "text", text: "continue" }],
        });
      }
    },
  );

  it.each([
    {
      evidence: "native and proxy evidence for the same turn",
      requireNative: true,
      freshModel: null,
      submitted: true,
    },
    {
      evidence: "proxy evidence alone",
      requireNative: false,
      freshModel: null,
      submitted: false,
    },
    {
      evidence: "native and proxy evidence with a conflicting model on reread",
      requireNative: true,
      freshModel: "other-model",
      submitted: false,
    },
  ])(
    "checks an omitted model with $evidence",
    async ({ requireNative, freshModel, submitted }) => {
      const harness = createHarness(false, usageError);
      const observation = nativeObservation(null);
      Object.assign(harness.failedThread, {
        status: { type: "idle" },
        model: null,
        modelProvider: observation.modelProvider,
      });
      harness.state.getCodexNativeUsageLimitCandidate = () => observation;
      expect(
        prepareUsageLimit(
          harness,
          requireNative,
          "request-model",
          observation.observedAtMs,
        ),
      ).toMatchObject({ started: true });
      await flushJobs();
      harness.failedThread.model = freshModel;
      harness.state.confirmCodexContinuation("recovery-id");
      await flushJobs();
      harness.state.commitCodexContinuation("recovery-id");
      await flushJobs();
      expect(harness.job()).toMatchObject({
        status: "completed",
        submitted,
        mutationAttempted: submitted,
      });
      expect(harness.startTurn).toHaveBeenCalledTimes(submitted ? 1 : 0);
      if (submitted)
        expect(harness.startTurn).toHaveBeenCalledWith({
          threadId: "exact-thread",
          input: [{ type: "text", text: "continue" }],
        });
    },
  );

  it("does not substitute a fresh native observation for the one selected by the backend", async () => {
    const harness = createHarness(false, usageError);
    const observation = nativeObservation();
    harness.failedThread.status = { type: "idle" };
    harness.failedThread.modelProvider = observation.modelProvider;
    harness.state.getCodexNativeUsageLimitCandidate = () => observation;

    expect(
      prepareUsageLimit(
        harness,
        true,
        "request-model",
        observation.observedAtMs - 1,
      ),
    ).toMatchObject({ started: false });
    await flushJobs();
    expect(harness.readCount()).toBe(0);
    expect(harness.startTurn).not.toHaveBeenCalled();
  });

  it("requires current native evidence on the renderer that observed the interruption", async () => {
    const harness = createHarness(false, usageError);
    harness.failedThread.status = { type: "idle" };
    expect(prepareUsageLimit(harness, true)).toMatchObject({ started: false });
    expect(harness.readCount()).toBe(0);

    let current = true;
    const observation = nativeObservation();
    harness.failedThread.modelProvider = observation.modelProvider;
    const verifyObservation = vi.fn(() => (current ? observation : null));
    harness.state.getCodexNativeUsageLimitCandidate = verifyObservation;
    expect(
      prepareUsageLimit(
        harness,
        true,
        observation.model,
        observation.observedAtMs,
      ),
    ).toMatchObject({ started: true });
    await flushJobs();
    harness.state.confirmCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.job().status).toBe("confirmed");

    current = false;
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();
    expect(verifyObservation).toHaveBeenLastCalledWith(
      "exact-thread",
      "failed-turn",
      harness.state.appServerClients[0],
    );
    expect(harness.job()).toMatchObject({
      status: "completed",
      mutationAttempted: false,
      usageLimitDeferred: true,
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
  });

  it("can resume an exact native interruption after observation recovers during confirmation", async () => {
    const harness = createHarness(false, usageError, "failed", {
      pauseCommitRead: true,
    });
    harness.failedThread.status = { type: "idle" };
    let current = true;
    const observation = nativeObservation();
    harness.failedThread.modelProvider = observation.modelProvider;
    harness.state.getCodexNativeUsageLimitCandidate = () =>
      current ? observation : null;
    expect(
      prepareUsageLimit(
        harness,
        true,
        observation.model,
        observation.observedAtMs,
      ),
    ).toMatchObject({ started: true });
    await flushJobs();
    harness.state.confirmCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.job().status).toBe("confirming");

    current = false;
    harness.releaseCommitRead();
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
      usageLimitDeferred: true,
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});

    current = true;
    expect(
      harness.state.startCodexUsageLimitContinuation(
        "exact-thread",
        "retry-recovery-id",
        "request-model",
        observation.observedAtMs,
        "failed-turn",
        true,
      ),
    ).toMatchObject({ started: true });
    await flushJobs();
    harness.state.confirmCodexContinuation("retry-recovery-id");
    await flushJobs();
    harness.state.commitCodexContinuation("retry-recovery-id");
    await flushJobs();
    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    expect(
      harness.state.readCodexContinuationJob("retry-recovery-id"),
    ).toMatchObject({
      status: "completed",
      submitted: true,
      mutationAttempted: true,
    });
  });
});

describe("explicit automatic Codex continuation confirmation", () => {
  it("finishes the final read before exposing an immediate guarded sender", async () => {
    const harness = createHarness(false, undefined, "failed", {
      pauseCommitRead: true,
    });
    harness.start();
    await flushJobs();
    expect(harness.job().status).toBe("prepared");
    expect(harness.state.confirmCodexContinuation("recovery-id")).toMatchObject(
      { started: true },
    );
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "confirming",
      submitted: false,
      mutationAttempted: false,
    });
    expect(harness.readCount()).toBe(3);
    expect(harness.state.commitCodexContinuation("recovery-id")).toMatchObject({
      started: false,
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
    harness.releaseCommitRead();
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "confirmed",
      submitted: false,
      mutationAttempted: false,
    });
    const reads = harness.readCount();
    harness.state.commitCodexContinuation("recovery-id");
    // Native authorization has now run: the confirmed sender performs no
    // awaited read between the native final check and the original request.
    expect(harness.readCount()).toBe(reads);
    expect(harness.startTurn).toHaveBeenCalledTimes(1);
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: true,
      mutationAttempted: true,
    });
  });

  it("does not revive an automatic sender cancelled during confirmation", async () => {
    const harness = createHarness(false, undefined, "failed", {
      pauseCommitRead: true,
    });
    harness.start();
    await flushJobs();
    harness.state.confirmCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.job().status).toBe("confirming");
    harness.state.cancelCodexContinuation("recovery-id");
    harness.releaseCommitRead();
    await flushJobs();
    expect(harness.state.commitCodexContinuation("recovery-id")).toMatchObject({
      started: false,
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
  });

  it("rechecks automatic user-action evidence synchronously after confirmation", async () => {
    const harness = createHarness();
    harness.start();
    await flushJobs();
    harness.state.confirmCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.job().status).toBe("confirmed");
    harness.api.rememberCodexUserTurnAction("turn/interrupt", {
      threadId: "exact-thread",
    });
    harness.state.commitCodexContinuation("recovery-id");
    await flushJobs();
    expect(harness.job()).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
    });
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.api.readCodexContinuationMarkers()).toEqual({});
  });
});
