import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const resource = (name: string) =>
  readFileSync(resolve("src-tauri/src/resources/codex_desktop", name), "utf8");
const continuation = resource("continuation.js").replace(
  "__CCSWITCH_TERMINAL_ERROR_POLICY__",
  readFileSync(
    "src-tauri/src/proxy/providers/terminal_error_policy.json",
    "utf8",
  ),
);
const observer = new Function(
  "state",
  "localStorage",
  "installationIsCurrent",
  "crypto",
  `${resource("client_discovery.js")}
   ${resource("app_server_model_list_scope.js")}
   ${continuation}
   ${resource("owner_remote_view.js")}
   ${resource("native_usage_limit_observer.js")}
   return {
     rememberAction: rememberCodexUserTurnAction,
     captureTurnStart: (...args) => captureCodexNativeUsageLimitTurnStart(...args),
   };`,
);

const usageLimit = {
  codexErrorInfo: "usageLimitExceeded",
  message: "You've hit your usage limit. Try again later.",
};
const planUsageLimit = {
  ...usageLimit,
  message:
    "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 7:45 PM.",
};

const session = (id: string, status = "active", turnStatus = "inProgress") => ({
  thread: {
    id,
    status: {
      type: status,
      ...(status === "active" ? { activeFlags: [] } : {}),
    },
    model: "request-model",
    modelProvider: "openai",
    turns: [],
  },
  turn: {
    id: `${id}-turn`,
    status: turnStatus,
    items: [],
    itemsView: "notLoaded",
    error: null as Record<string, unknown> | null,
  },
});

type Session = ReturnType<typeof session>;
type Candidate = {
  threadId: string;
  turnId: string;
  model: string | null;
  modelProvider: string;
  observedAtMs: number;
};

type ProxyTurn = Pick<Candidate, "threadId" | "turnId" | "observedAtMs">;

type Scan = {
  candidates: Candidate[];
  complete: boolean;
  staleProxyTurns?: ProxyTurn[];
};

const incompleteScan = (candidates: unknown[] = []) => ({
  candidates,
  complete: false,
});

const expectCompleteScan = (scan: Scan | null) => {
  expect(scan?.complete).toBe(true);
  return expect(scan?.candidates);
};

const continuationMarkerKey = "ccswitch-codex-continuations-v1";

const fail = (target: Session, error = usageLimit, status = "failed") => {
  target.thread.status.type = "systemError";
  target.turn.status = status;
  target.turn.error = { ...error, additionalDetails: "private fixture" };
};

const harness = (...sessions: Session[]) => {
  const storage = new Map<string, string>();
  const readContinuationMarkers = vi.fn(
    () => storage.get(continuationMarkerKey) ?? null,
  );
  let active = true;
  let randomIndex = 0;
  const state = {
    runtimeGeneration: 1,
    appServerClients: [] as object[],
  } as {
    runtimeGeneration: number;
    appServerClients: object[];
    collectCodexNativeUsageLimitCandidates: (
      proxyTurns?: ProxyTurn[],
    ) => Promise<Scan | null>;
    getCodexNativeUsageLimitCandidate: (
      threadId: string,
      turnId: string,
      client?: object,
    ) => Candidate | null;
    startCodexUsageLimitContinuation: (
      threadId: string,
      operationId: string,
      model: string | null,
      observedAtMs: number,
      turnId: string,
      requireNativeObservation: boolean,
    ) => { started: boolean; jobId: string };
    confirmCodexContinuation: (jobId: string) => { started: boolean };
    commitCodexContinuation: (jobId: string) => { started: boolean };
    readCodexContinuationJob: (jobId: string) => unknown;
  };
  const { rememberAction, captureTurnStart } = observer(
    state,
    {
      getItem: (key: string) =>
        key === continuationMarkerKey
          ? readContinuationMarkers()
          : (storage.get(key) ?? null),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    () => active,
    { getRandomValues: (bytes: Uint8Array) => bytes.fill(++randomIndex) },
  ) as {
    rememberAction: (method: string, params: object) => void;
    captureTurnStart: (
      client: object,
      method: string,
      params: object,
    ) => ((result: unknown) => void) | undefined;
  };
  const startTurn = vi.fn<
    (params: Record<string, unknown>) => Promise<unknown>
  >(async () => {
    throw new Error("Unexpected test turn start");
  });
  const request = vi.fn(
    async (method: string, params: Record<string, unknown>) => {
      if (method === "turn/start") return startTurn(params);
      if (method === "thread/loaded/list") {
        const start = Number(params.cursor ?? 0);
        const end = start + Number(params.limit);
        return {
          data: sessions.slice(start, end).map(({ thread }) => thread.id),
          nextCursor: end < sessions.length ? String(end) : null,
        };
      }
      const target = sessions.find(
        ({ thread }) => thread.id === params.threadId,
      );
      if (method === "thread/read" && params.includeTurns === false)
        return { thread: structuredClone(target?.thread) };
      if (method === "thread/read" && params.includeTurns === true && target)
        return {
          thread: structuredClone({ ...target.thread, turns: [target.turn] }),
        };
      if (method === "thread/turns/list" && params.limit === 1)
        return { data: [structuredClone(target?.turn)], nextCursor: null };
      throw new Error("Unexpected test RPC");
    },
  );
  const makeClient = (hostId = "local", original = request) => {
    const client = {
      hostId,
      getCompatibleThreadSortKey() {},
      supportsPaginatedThreadHistory() {},
      sendRequest: original,
    };
    const wrapper = vi.fn(original);
    Object.defineProperty(wrapper, "__ccSwitchRequestHook", {
      value: Object.freeze({
        client,
        original,
        version: "standalone",
      }),
    });
    return Object.assign(client, {
      __ccSwitchOriginalSendRequest: original,
      sendRequest: wrapper,
      __ccSwitchModelRequestPatch: "standalone",
    });
  };
  state.appServerClients = [makeClient()];
  return {
    state,
    request,
    startTurn,
    rememberAction,
    captureTurnStart,
    makeClient,
    storage,
    readContinuationMarkers,
    retire: () => {
      active = false;
    },
  };
};

describe("native Codex usage-limit observation", () => {
  it.each([
    { status: "active", turnStatus: "inProgress" },
    { status: "idle", turnStatus: "completed" },
  ])(
    "reports only the displaced proxy turn when the newer turn is $turnStatus",
    async ({ status, turnStatus }) => {
      const replacement = session("replacement", status, turnStatus);
      const unrelated = Array.from({ length: 64 }, (_, index) =>
        session(`idle-${index}`, "idle"),
      );
      const missing = session("unlisted", "idle");
      const { state, request } = harness(...unrelated, replacement);
      const old = {
        threadId: replacement.thread.id,
        turnId: "displaced-turn",
        observedAtMs: Date.now(),
      };
      const same = { ...old, turnId: replacement.turn.id };
      const omitted = { ...old, threadId: missing.thread.id };
      const proxyTurns = [old, same, omitted];
      for (let poll = 0; poll < 2; poll++) {
        request.mockClear();
        expect(
          await state.collectCodexNativeUsageLimitCandidates(proxyTurns),
        ).toEqual({
          candidates: [],
          complete: true,
          staleProxyTurns: [old],
        });
        expect(
          request.mock.calls.filter(
            ([method]) => method === "thread/turns/list",
          ),
        ).toEqual([
          [
            "thread/turns/list",
            {
              threadId: replacement.thread.id,
              cursor: null,
              limit: 1,
              sortDirection: "desc",
              itemsView: "notLoaded",
            },
          ],
        ]);
      }
    },
  );

  it("requires a strictly newer recorded owner action to displace the same proxy turn", async () => {
    vi.useFakeTimers();
    try {
      const stopped = session("stopped", "idle", "failed");
      fail(stopped);
      const { state, rememberAction } = harness(stopped);
      const proxy = {
        threadId: stopped.thread.id,
        turnId: stopped.turn.id,
        observedAtMs: Date.now(),
      };
      rememberAction("turn/interrupt", { threadId: proxy.threadId });
      expect(
        await state.collectCodexNativeUsageLimitCandidates([proxy]),
      ).toEqual({ candidates: [], complete: true });
      await vi.advanceTimersByTimeAsync(1);
      rememberAction("turn/interrupt", { threadId: proxy.threadId });
      expect(
        await state.collectCodexNativeUsageLimitCandidates([proxy]),
      ).toEqual({ candidates: [], complete: true, staleProxyTurns: [proxy] });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["active", "notLoaded"])(
    "waits for consistent loaded metadata before replacing proxy evidence when status is %s",
    async (status) => {
      const replacement = session("replacement", status, "completed");
      const { state, request } = harness(replacement);
      const old = {
        threadId: replacement.thread.id,
        turnId: "displaced-turn",
        observedAtMs: Date.now(),
      };
      expect(await state.collectCodexNativeUsageLimitCandidates([old])).toEqual(
        { candidates: [], complete: true },
      );
      if (status === "notLoaded")
        expect(
          request.mock.calls.filter(
            ([method]) => method === "thread/turns/list",
          ),
        ).toHaveLength(0);
      replacement.thread.status = { type: "idle" };
      expect(await state.collectCodexNativeUsageLimitCandidates([old])).toEqual(
        { candidates: [], complete: true, staleProxyTurns: [old] },
      );
    },
  );

  it("defers proxy-only latest reads when the scan outlasts the bridge wait", async () => {
    vi.useFakeTimers();
    try {
      const stalled = Array.from({ length: 16 }, (_, index) =>
        session(`stalled-${index}`, "idle", "completed"),
      );
      const replacement = session("replacement", "idle", "completed");
      const { state, request } = harness(...stalled, replacement);
      const original = request.getMockImplementation()!;
      request.mockImplementation(async (method, params) => {
        if (
          method === "thread/read" &&
          params.threadId !== replacement.thread.id
        )
          return new Promise(() => {});
        return original(method, params);
      });
      const old = {
        threadId: replacement.thread.id,
        turnId: "displaced-turn",
        observedAtMs: Date.now(),
      };
      const scan = state.collectCodexNativeUsageLimitCandidates([old]);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await scan).toEqual(incompleteScan());
      const pending = state.collectCodexNativeUsageLimitCandidates([old]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await pending).toEqual(incompleteScan());
      expect(
        request.mock.calls.filter(
          ([method]) => method === "thread/loaded/list",
        ),
      ).toHaveLength(1);
      expect(
        request.mock.calls.filter(([method]) => method === "thread/turns/list"),
      ).toHaveLength(0);
      request.mockImplementation(original);
      expect(await state.collectCodexNativeUsageLimitCandidates([old])).toEqual(
        { candidates: [], complete: true, staleProxyTurns: [old] },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["turn ID", "request timestamp"])(
    "rechecks a proxy candidate whose %s changes during a pending scan",
    async (changedField) => {
      vi.useFakeTimers();
      try {
        const head = session("head", "idle", "completed");
        const stalled = Array.from({ length: 16 }, (_, index) =>
          session(`stalled-${index}`, "idle", "completed"),
        );
        const { state, request } = harness(head, ...stalled);
        const original = request.getMockImplementation()!;
        request.mockImplementation(async (method, params) => {
          if (method === "thread/read" && params.threadId !== head.thread.id)
            return new Promise(() => {});
          return original(method, params);
        });
        const observedAtMs = Date.now() - 100;
        const initial = {
          threadId: head.thread.id,
          turnId: "displaced-turn",
          observedAtMs,
        };
        const updated =
          changedField === "turn ID"
            ? { ...initial, turnId: "replacement-turn" }
            : { ...initial, observedAtMs: observedAtMs + 1 };
        const initialScan = state.collectCodexNativeUsageLimitCandidates([
          initial,
        ]);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(await initialScan).toEqual({
          candidates: [],
          complete: false,
          staleProxyTurns: [initial],
        });

        // The error was registered after the head read, but its proxy request
        // began before that read. The timestamp alone cannot fence the scan.
        head.turn.id = updated.turnId;
        fail(head);
        const joinedScan = state.collectCodexNativeUsageLimitCandidates([
          updated,
        ]);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await joinedScan).toEqual(incompleteScan());
        expect(
          request.mock.calls.filter(
            ([method]) => method === "thread/turns/list",
          ),
        ).toHaveLength(1);

        request.mockImplementation(original);
        expect(
          await state.collectCodexNativeUsageLimitCandidates([updated]),
        ).toEqual({ candidates: [], complete: true });
        expect(
          request.mock.calls.filter(
            ([method]) => method === "thread/turns/list",
          ),
        ).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["differing heads", "unreadable head", "unreadable enumeration"])(
    "withholds stale proxy evidence when local clients have %s",
    async (ambiguity) => {
      const replacement = session("shared", "idle", "completed");
      const { state, makeClient, request } = harness(replacement);
      const peerRequest = vi.fn(async (method, params) => {
        if (
          (ambiguity === "unreadable enumeration" &&
            method === "thread/loaded/list") ||
          (ambiguity === "unreadable head" && method === "thread/turns/list")
        )
          throw new Error("Fixture peer unavailable");
        if (method === "thread/turns/list")
          return {
            data: [{ ...replacement.turn, id: "other-head" }],
            nextCursor: null,
          };
        return request.getMockImplementation()!(method, params);
      });
      state.appServerClients.push(makeClient("local", peerRequest));
      const scan = await state.collectCodexNativeUsageLimitCandidates([
        {
          threadId: replacement.thread.id,
          turnId: "displaced-turn",
          observedAtMs: Date.now(),
        },
      ]);
      expect(scan).toEqual({
        candidates: [],
        complete: ambiguity === "differing heads",
      });
    },
  );

  it.each([
    {
      name: "an in-progress acknowledgement",
      acknowledgedStatus: "inProgress",
      interrupted: false,
      eligible: true,
      model: "request-model",
    },
    {
      name: "an in-progress acknowledgement without a model",
      acknowledgedStatus: "inProgress",
      interrupted: false,
      eligible: true,
      model: null,
    },
    {
      name: "a terminal acknowledgement",
      acknowledgedStatus: "failed",
      interrupted: false,
      eligible: false,
      model: "request-model",
    },
    {
      name: "an acknowledgement after a newer stop",
      acknowledgedStatus: "inProgress",
      interrupted: true,
      eligible: false,
      model: "request-model",
    },
  ])(
    "uses $name only with current activity evidence",
    async ({ acknowledgedStatus, interrupted, eligible, model }) => {
      const target = session("repeat");
      Object.assign(target.thread, { model });
      const { state, startTurn, rememberAction } = harness(target);
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([]);
      fail(target);
      const [first] =
        (await state.collectCodexNativeUsageLimitCandidates())?.candidates ??
        [];
      expect(first.turnId).toBe("repeat-turn");
      expect(first.model).toBe(model);

      startTurn.mockImplementationOnce(async () => {
        target.turn.id = "continued-turn";
        const acknowledgement = {
          threadId: target.thread.id,
          turn: { id: target.turn.id, status: acknowledgedStatus },
        };
        if (interrupted)
          rememberAction("turn/interrupt", { threadId: target.thread.id });
        fail(target);
        return acknowledgement;
      });
      const { started, jobId } = state.startCodexUsageLimitContinuation(
        first.threadId,
        "resume-first-turn",
        first.model,
        first.observedAtMs,
        first.turnId,
        true,
      );
      expect(started).toBe(true);
      await vi.waitFor(() =>
        expect(state.readCodexContinuationJob(jobId)).toMatchObject({
          status: "prepared",
        }),
      );
      expect(state.confirmCodexContinuation(jobId).started).toBe(true);
      await vi.waitFor(() =>
        expect(state.readCodexContinuationJob(jobId)).toMatchObject({
          status: "confirmed",
        }),
      );
      expect(state.commitCodexContinuation(jobId).started).toBe(true);
      await vi.waitFor(() =>
        expect(state.readCodexContinuationJob(jobId)).toMatchObject({
          status: "completed",
          submitted: true,
          turnId: "continued-turn",
        }),
      );
      expect(startTurn).toHaveBeenCalledTimes(1);
      expect(startTurn).toHaveBeenCalledWith({
        threadId: first.threadId,
        input: [{ type: "text", text: "continue" }],
      });
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual(
        eligible
          ? [
              {
                ...first,
                turnId: "continued-turn",
                observedAtMs: expect.any(Number),
              },
            ]
          : [],
      );
    },
  );

  it("uses exact verified start acknowledgements for turns that end between scans", async () => {
    const first = session("first");
    const second = session("second");
    const { state, rememberAction, captureTurnStart, request } = harness(
      first,
      second,
    );
    for (const target of [first, second]) {
      const params = { threadId: target.thread.id, model: target.thread.model };
      rememberAction("turn/start", params);
      const observe = captureTurnStart(
        state.appServerClients[0],
        "turn/start",
        params,
      );
      expect(observe).toBeTypeOf("function");
      observe?.({ turn: structuredClone(target.turn) });
      fail(target);
    }
    expect(request).not.toHaveBeenCalled();
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual(
      [first, second].map(({ thread, turn }) => ({
        threadId: thread.id,
        turnId: turn.id,
        model: thread.model,
        modelProvider: thread.modelProvider,
        observedAtMs: expect.any(Number),
      })),
    );
  });

  it.each([false, true])(
    "binds secondary-client activity through commit (client replaced: %s)",
    async (replaceClient) => {
      const target = session("secondary");
      const {
        state,
        request,
        startTurn,
        rememberAction,
        captureTurnStart,
        makeClient,
      } = harness(target);
      const secondaryRequest = vi.fn(request.getMockImplementation()!);
      const secondary = makeClient("local", secondaryRequest);
      const primary = state.appServerClients[0];
      state.appServerClients = [primary, secondary];
      request.mockImplementation(async () => ({ data: [], nextCursor: null }));

      const params = { threadId: target.thread.id, model: target.thread.model };
      rememberAction("turn/start", params);
      const observe = captureTurnStart(secondary, "turn/start", params);
      expect(observe).toBeTypeOf("function");
      observe?.({ turn: structuredClone(target.turn) });
      fail(target);

      const scan = await state.collectCodexNativeUsageLimitCandidates();
      expectCompleteScan(scan).toEqual([
        expect.objectContaining({
          threadId: target.thread.id,
          turnId: target.turn.id,
        }),
      ]);
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "thread/loaded/list",
      ]);
      expect(
        secondaryRequest.mock.calls.map(([method, args]) => [
          method,
          args.threadId,
        ]),
      ).toEqual([
        ["thread/loaded/list", undefined],
        ["thread/read", target.thread.id],
        ["thread/turns/list", target.thread.id],
      ]);

      const [candidate] = scan?.candidates ?? [];
      const { started, jobId } = state.startCodexUsageLimitContinuation(
        candidate.threadId,
        "continue-secondary",
        candidate.model,
        candidate.observedAtMs,
        candidate.turnId,
        true,
      );
      expect(started).toBe(true);
      await vi.waitFor(() =>
        expect(state.readCodexContinuationJob(jobId)).toMatchObject({
          status: "prepared",
        }),
      );
      expect(state.confirmCodexContinuation(jobId).started).toBe(true);
      await vi.waitFor(() =>
        expect(state.readCodexContinuationJob(jobId)).toMatchObject({
          status: "confirmed",
        }),
      );

      if (replaceClient) {
        state.appServerClients = [
          primary,
          makeClient("local", secondaryRequest),
        ];
        expect(
          state.getCodexNativeUsageLimitCandidate(
            candidate.threadId,
            candidate.turnId,
          ),
        ).toBeNull();
      }
      startTurn.mockResolvedValue({
        turn: { id: "continued", status: "inProgress" },
      });
      expect(state.commitCodexContinuation(jobId).started).toBe(true);
      await vi.waitFor(() =>
        expect(state.readCodexContinuationJob(jobId)).toMatchObject({
          status: "completed",
          submitted: !replaceClient,
          mutationAttempted: !replaceClient,
        }),
      );
      expect(startTurn).toHaveBeenCalledTimes(replaceClient ? 0 : 1);
      if (!replaceClient)
        expect(startTurn).toHaveBeenCalledWith({
          threadId: target.thread.id,
          input: [{ type: "text", text: "continue" }],
        });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([1, 64])(
    "discovers active turns on both clients with %i overlapping thread IDs",
    async (sharedCount) => {
      const primary = session("primary");
      const secondary = session("secondary");
      const shared = Array.from({ length: sharedCount }, (_, index) =>
        session(`shared-${index}`, index === 0 ? "active" : "idle"),
      );
      const { state, request, makeClient } = harness(
        primary,
        secondary,
        ...shared,
      );
      const original = request.getMockImplementation()!;
      let secondaryLoaded = true;
      const listThreads = (
        sessions: Session[],
        params: Record<string, unknown>,
      ) => {
        const start = Number(params.cursor ?? 0);
        const end = start + Number(params.limit);
        return {
          data: sessions.slice(start, end).map(({ thread }) => thread.id),
          nextCursor: end < sessions.length ? String(end) : null,
        };
      };
      request.mockImplementation(async (method, params) => {
        if (method === "thread/loaded/list")
          return listThreads([primary, ...shared], params);
        if (method === "thread/read" && params.threadId === shared[0].thread.id)
          return { thread: { ...shared[0].thread, status: { type: "idle" } } };
        return original(method, params);
      });
      const secondaryRequest = vi.fn(
        async (method: string, params: Record<string, unknown>) =>
          method === "thread/loaded/list"
            ? listThreads(
                secondaryLoaded
                  ? [primary, secondary, ...shared]
                  : [primary, ...shared],
                params,
              )
            : original(method, params),
      );
      state.appServerClients.push(makeClient("local", secondaryRequest));

      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([]);
      fail(primary);
      fail(secondary);
      fail(shared[0]);
      for (const loaded of [true, true, false]) {
        secondaryLoaded = loaded;
        request.mockClear();
        secondaryRequest.mockClear();
        const candidates = loaded
          ? [primary, shared[0], secondary]
          : [primary, shared[0]];
        expectCompleteScan(
          await state.collectCodexNativeUsageLimitCandidates(),
        ).toEqual(
          candidates.map(({ thread, turn }) =>
            expect.objectContaining({ threadId: thread.id, turnId: turn.id }),
          ),
        );
        const expectReads = (
          calls: typeof request.mock.calls,
          method: string,
          sessions: Session[],
        ) => {
          const reads = calls.filter(([name]) => name === method);
          expect(reads.map(([, params]) => params.threadId).sort()).toEqual(
            sessions.map(({ thread }) => thread.id).sort(),
          );
          expect(
            reads.every(([, params]) =>
              method === "thread/read"
                ? params.includeTurns === false
                : params.limit === 1 && params.itemsView === "notLoaded",
            ),
          ).toBe(true);
        };
        const secondaryOnly = loaded ? [secondary] : [];
        expectReads(request.mock.calls, "thread/read", [primary, ...shared]);
        expectReads(secondaryRequest.mock.calls, "thread/read", [
          primary,
          ...shared,
          ...secondaryOnly,
        ]);
        expectReads(request.mock.calls, "thread/turns/list", [
          primary,
          shared[0],
        ]);
        expectReads(secondaryRequest.mock.calls, "thread/turns/list", [
          primary,
          shared[0],
          ...secondaryOnly,
        ]);
        expect(
          state.getCodexNativeUsageLimitCandidate(
            shared[0].thread.id,
            shared[0].turn.id,
            state.appServerClients[0],
          ),
        ).toBeNull();
        expect(
          state.getCodexNativeUsageLimitCandidate(
            shared[0].thread.id,
            shared[0].turn.id,
            state.appServerClients[1],
          ),
        ).toEqual(expect.objectContaining({ threadId: shared[0].thread.id }));
      }
    },
  );

  it("withholds a shared thread with a conflicting latest turn on another client", async () => {
    const primary = session("shared");
    const secondary = session("shared");
    secondary.turn.id = "other-turn";
    const { state, request, makeClient } = harness(primary);
    state.appServerClients.push(
      makeClient(
        "local",
        vi.fn(async (method, params) => {
          if (method === "thread/read") return { thread: secondary.thread };
          if (method === "thread/turns/list")
            return { data: [secondary.turn], nextCursor: null };
          return request(method, params);
        }),
      ),
    );
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([]);

    fail(primary);
    expect(await state.collectCodexNativeUsageLimitCandidates()).toEqual({
      complete: true,
      candidates: [],
      conflictingThreadIds: [primary.thread.id],
    });
    fail(secondary);
    expect(await state.collectCodexNativeUsageLimitCandidates()).toEqual({
      complete: true,
      candidates: [],
      conflictingThreadIds: [primary.thread.id],
    });
    expect(
      state.getCodexNativeUsageLimitCandidate(
        primary.thread.id,
        primary.turn.id,
      ),
    ).toBeNull();

    state.appServerClients.pop();
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([expect.objectContaining({ turnId: primary.turn.id })]);
  });

  it.each(["active", "idle"])(
    "reports a verified replacement in a partial scan when the overlapping client was %s",
    async (initialStatus) => {
      const shared = session("shared");
      const peer = session("peer");
      const unreadable = session("unreadable");
      const { state, request, makeClient } = harness(shared, peer, unreadable);
      const alternate = session("shared", initialStatus);
      const alternateRequest = vi.fn(async (method: string) => {
        if (method === "thread/loaded/list")
          return { data: [shared.thread.id], nextCursor: null };
        if (method === "thread/read") return { thread: alternate.thread };
        return { data: [alternate.turn], nextCursor: null };
      });
      state.appServerClients.push(makeClient("local", alternateRequest));
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([]);
      fail(shared);
      fail(alternate);
      if (initialStatus === "idle") alternate.thread.status.type = "idle";
      fail(peer);
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([
        expect.objectContaining({ threadId: shared.thread.id }),
        expect.objectContaining({ threadId: peer.thread.id }),
      ]);

      alternate.turn.id = "already-completed";
      alternate.turn.status = "completed";
      alternate.turn.error = null;
      alternate.thread.status = { type: "idle" };
      const original = request.getMockImplementation()!;
      request.mockImplementation(async (method, params) => {
        if (params.threadId === unreadable.thread.id)
          throw new Error("Unrelated unreadable session");
        return original(method, params);
      });
      for (let poll = 0; poll < 2; poll++) {
        expect(await state.collectCodexNativeUsageLimitCandidates()).toEqual({
          complete: false,
          candidates: [expect.objectContaining({ threadId: peer.thread.id })],
          conflictingThreadIds: [shared.thread.id],
        });
        expect(
          state.getCodexNativeUsageLimitCandidate(
            shared.thread.id,
            shared.turn.id,
          ),
        ).toBeNull();
      }
    },
  );

  it.each(["the previous turn", "idle thread metadata"])(
    "keeps start acknowledgements when the first scan sees %s",
    async (snapshot) => {
      const target = session("thread");
      const { state, rememberAction, captureTurnStart } = harness(target);
      const params = { threadId: target.thread.id, model: target.thread.model };
      rememberAction("turn/start", params);
      const observe = captureTurnStart(
        state.appServerClients[0],
        "turn/start",
        params,
      );
      expect(observe).toBeTypeOf("function");
      observe?.({ turn: structuredClone(target.turn) });
      const acknowledgedTurnId = target.turn.id;

      if (snapshot === "the previous turn") {
        target.turn.id = "previous-turn";
        fail(target);
      } else {
        target.thread.status.type = "idle";
      }
      expect(await state.collectCodexNativeUsageLimitCandidates()).toEqual(
        snapshot === "the previous turn"
          ? incompleteScan()
          : { candidates: [], complete: true },
      );

      target.turn.id = acknowledgedTurnId;
      fail(target);
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([
        expect.objectContaining({
          threadId: target.thread.id,
          turnId: acknowledgedTurnId,
        }),
      ]);
    },
  );

  it("bounds latest-turn reads for an acknowledgement that never becomes visible", async () => {
    vi.useFakeTimers();
    try {
      const target = session("thread");
      const { state, request, rememberAction, captureTurnStart } =
        harness(target);
      const params = { threadId: target.thread.id, model: target.thread.model };
      rememberAction("turn/start", params);
      captureTurnStart(
        state.appServerClients[0],
        "turn/start",
        params,
      )?.({
        turn: structuredClone(target.turn),
      });
      target.turn.id = "previous-turn";
      fail(target);

      for (let poll = 0; poll < 6; poll++) {
        expect(await state.collectCodexNativeUsageLimitCandidates()).toEqual({
          candidates: [],
          complete: poll >= 4,
        });
        await vi.advanceTimersByTimeAsync(9_000);
      }
      expect(
        request.mock.calls.filter(([method]) => method === "thread/turns/list"),
      ).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards start acknowledgements after a newer action or inconsistent binding", async () => {
    const stopped = session("stopped");
    const wrongModel = session("wrong-model");
    const mismatched = session("mismatched");
    const failed = session("failed");
    const { state, rememberAction, captureTurnStart, request } = harness(
      stopped,
      wrongModel,
      mismatched,
      failed,
    );
    for (const target of [stopped, wrongModel, mismatched, failed]) {
      const params = {
        threadId: target.thread.id,
        model: target === wrongModel ? "another-model" : target.thread.model,
      };
      const wrapped = {
        hostId: "local",
        method: "turn/start",
        params,
      };
      rememberAction("send-cli-request-for-host", wrapped);
      const observe = captureTurnStart(
        state.appServerClients[0],
        "send-cli-request-for-host",
        wrapped,
      );
      expect(observe).toBeTypeOf("function");
      if (target === stopped) rememberAction("turn/interrupt", params);
      if (target === failed) fail(target);
      observe?.({
        threadId: target === mismatched ? "different-thread" : params.threadId,
        turn: structuredClone(target.turn),
      });
      fail(target);
    }
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([]);
    request.mockClear();
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([]);
    expect(
      request.mock.calls.some(([method]) => method === "thread/turns/list"),
    ).toBe(false);
  });

  it("keeps a local wrapped acknowledgement received during an in-flight scan", async () => {
    const local = session("local-thread");
    const remote = session("remote-thread");
    const { state, rememberAction, captureTurnStart, request } = harness(
      local,
      remote,
    );
    let settleLoaded: () => void = () => {};
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleLoaded = () => resolve({ data: [], nextCursor: null });
        }),
    );
    const scan = state.collectCodexNativeUsageLimitCandidates();

    const method = "send-cli-request-for-host";
    for (const [target, hostId] of [
      [local, "local"],
      [remote, "remote"],
    ] as const) {
      const envelope = {
        method: "turn/start",
        params: { threadId: target.thread.id, hostId },
      };
      rememberAction(method, envelope);
      const observe = captureTurnStart(
        state.appServerClients[0],
        method,
        envelope,
      );
      if (hostId === "local") {
        expect(observe).toBeTypeOf("function");
        observe?.({ turn: structuredClone(target.turn) });
      } else {
        expect(observe).toBeUndefined();
      }
      fail(target);
    }
    settleLoaded();
    expect(await scan).toEqual(incompleteScan());
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([
      expect.objectContaining({
        threadId: local.thread.id,
        turnId: local.turn.id,
      }),
    ]);
  });

  it("returns only the exact previously running turns that hit the usage limit", async () => {
    const first = session("first");
    const second = session("second");
    const historical = session("historical", "idle", "completed");
    fail(historical);
    const stillRunning = session("still-running");
    const { state, request } = harness(first, second, historical, stillRunning);

    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([]);
    expect(request).not.toHaveBeenCalledWith(
      "thread/turns/list",
      expect.objectContaining({ threadId: "historical" }),
    );
    fail(first);
    fail(second, planUsageLimit, "interrupted");
    const scan = await state.collectCodexNativeUsageLimitCandidates();
    expect(scan?.complete).toBe(true);
    const candidates = scan?.candidates;
    expect(candidates).toEqual(
      [first, second].map(({ thread, turn }) => ({
        threadId: thread.id,
        turnId: turn.id,
        model: "request-model",
        modelProvider: "openai",
        observedAtMs: expect.any(Number),
      })),
    );
    const snapshot = state.getCodexNativeUsageLimitCandidate(
      first.thread.id,
      first.turn.id,
    );
    expect(snapshot).toEqual(candidates?.[0]);
    expect(snapshot).not.toBe(candidates?.[0]);
    expect(
      state.getCodexNativeUsageLimitCandidate(first.thread.id, second.turn.id),
    ).toBeNull();
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual(candidates);
    expect(
      request.mock.calls.every(([method]) => method.startsWith("thread/")),
    ).toBe(true);
  });

  it("detects a usage-limit terminal turn on the first scan", async () => {
    const initial = session("first-scan");
    const target = {
      ...initial,
      turn: { ...initial.turn, startedAt: Math.floor(Date.now() / 1_000) },
    };
    const { state, rememberAction, request, captureTurnStart } =
      harness(target);
    const params = {
      threadId: target.thread.id,
      model: target.thread.model,
    };
    rememberAction("turn/start", params);
    const acknowledge = captureTurnStart(
      state.appServerClients[0],
      "turn/start",
      params,
    );
    expect(acknowledge).toBeTypeOf("function");
    acknowledge?.({ turn: structuredClone(target.turn) });
    fail(target);
    expect(request).not.toHaveBeenCalled();

    const scan = await state.collectCodexNativeUsageLimitCandidates();

    expectCompleteScan(scan).toEqual([
      {
        threadId: target.thread.id,
        turnId: target.turn.id,
        model: target.thread.model,
        modelProvider: target.thread.modelProvider,
        observedAtMs: expect.any(Number),
      },
    ]);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/loaded/list",
      "thread/read",
      "thread/turns/list",
    ]);
  });

  it("accepts a terminal usage-limit turn that predates the first active scan", async () => {
    const initial = session("late");
    const late = {
      ...initial,
      turn: { ...initial.turn, startedAt: Math.floor(Date.now() / 1_000) },
    };
    const { state, rememberAction, captureTurnStart, request } = harness(late);
    const params = {
      threadId: late.thread.id,
      model: late.thread.model,
    };
    rememberAction("turn/start", params);
    const acknowledge = captureTurnStart(
      state.appServerClients[0],
      "turn/start",
      params,
    );
    expect(acknowledge).toBeTypeOf("function");
    acknowledge?.({ turn: structuredClone(late.turn) });
    fail(late);
    expect(request).not.toHaveBeenCalled();

    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([
      expect.objectContaining({
        threadId: late.thread.id,
        turnId: late.turn.id,
        model: "request-model",
        modelProvider: "openai",
        observedAtMs: expect.any(Number),
      }),
    ]);
  });

  it.each(["start intent", "terminal acknowledgement"])(
    "does not turn %s and a seconds timestamp into exact running-turn proof",
    async (proof) => {
      const initial = session("unproved-terminal");
      const target = {
        ...initial,
        turn: { ...initial.turn, startedAt: Math.floor(Date.now() / 1_000) },
      };
      const { state, rememberAction, captureTurnStart } = harness(target);
      const params = {
        threadId: target.thread.id,
        model: target.thread.model,
      };
      rememberAction("turn/start", params);
      const acknowledge = captureTurnStart(
        state.appServerClients[0],
        "turn/start",
        params,
      );
      expect(acknowledge).toBeTypeOf("function");
      fail(target);
      if (proof === "terminal acknowledgement")
        acknowledge?.({ turn: structuredClone(target.turn) });
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([]);
      // Separate metadata reads can lag behind the already-terminal turn.
      // That mismatch must not manufacture an earlier running observation.
      target.thread.status.type = "active";
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([]);
      target.thread.status.type = "systemError";
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([]);
      target.turn.id = "another-unproved-terminal";
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([]);
    },
  );

  it("rejects successful completions, cancellations, retry denials, and changed turn IDs", async () => {
    const completed = session("completed");
    const cancelled = session("cancelled");
    const denied = session("denied");
    const newer = session("newer");
    const { state } = harness(completed, cancelled, denied, newer);
    await state.collectCodexNativeUsageLimitCandidates();

    fail(completed, usageLimit, "completed");
    fail(
      cancelled,
      { ...usageLimit, message: "Turn cancelled by user" },
      "interrupted",
    );
    fail(denied, {
      ...usageLimit,
      message: "Usage limit reached. Do not retry.",
    });
    fail(newer);
    newer.turn.id = "unobserved-turn";
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([]);
  });

  it("retains running proof but waits for a usage-limited chat to load before counting it", async () => {
    const target = session("unloaded-after-failure");
    const { state } = harness(target);
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([]);

    fail(target);
    target.thread.status.type = "notLoaded";
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([]);

    target.thread.status.type = "systemError";
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([
      expect.objectContaining({
        threadId: target.thread.id,
        turnId: target.turn.id,
      }),
    ]);
  });

  it.each([
    { transition: "the same turn returns", expected: true },
    { transition: "a later stop", expected: false },
    { transition: "a different turn", expected: false },
    { transition: "the omission window expires", expected: false },
  ])(
    "rechecks a briefly unlisted chat when $transition",
    async ({ transition, expected }) => {
      vi.useFakeTimers();
      try {
        const target = session("briefly-unlisted");
        const { state, request, rememberAction } = harness(target);
        const original = request.getMockImplementation()!;
        let listed = true;
        request.mockImplementation(async (method, params) => {
          if (method === "thread/loaded/list" && !listed)
            return { data: [], nextCursor: null };
          return original(method, params);
        });

        expectCompleteScan(
          await state.collectCodexNativeUsageLimitCandidates(),
        ).toEqual([]);

        const originalTurnId = target.turn.id;
        listed = false;
        fail(target);
        for (let poll = 0; poll < 2; poll++) {
          request.mockClear();
          expectCompleteScan(
            await state.collectCodexNativeUsageLimitCandidates(),
          ).toEqual([]);
          expect(request.mock.calls.map(([method]) => method)).toEqual([
            "thread/loaded/list",
          ]);
          expect(
            state.getCodexNativeUsageLimitCandidate(
              target.thread.id,
              originalTurnId,
            ),
          ).toBeNull();
          await vi.advanceTimersByTimeAsync(1_000);
        }

        if (transition === "a later stop")
          rememberAction("turn/interrupt", { threadId: target.thread.id });
        if (transition === "a different turn") target.turn.id = "replacement";
        if (transition === "the omission window expires")
          await vi.advanceTimersByTimeAsync(30_000);

        listed = true;
        expectCompleteScan(
          await state.collectCodexNativeUsageLimitCandidates(),
        ).toEqual(
          expected
            ? [
                expect.objectContaining({
                  threadId: target.thread.id,
                  turnId: originalTurnId,
                }),
              ]
            : [],
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("excludes sub-agents and turns only observed waiting on approval", async () => {
    const child = session("child");
    Object.assign(child.thread, { source: { subAgent: "review" } });
    const waiting = session("waiting");
    Object.assign(waiting.thread.status, {
      activeFlags: ["waitingOnApproval"],
    });
    const { state } = harness(child, waiting);
    await state.collectCodexNativeUsageLimitCandidates();

    fail(child);
    fail(waiting);
    waiting.thread.status = { type: "systemError" };
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([]);
  });

  it("invalidates prior evidence immediately on user action or a durable attempt", async () => {
    const stopped = session("stopped");
    const submitted = session("submitted");
    const { state, rememberAction, storage } = harness(stopped, submitted);
    await state.collectCodexNativeUsageLimitCandidates();
    fail(stopped);
    fail(submitted);
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toHaveLength(2);

    rememberAction("turn/interrupt", { threadId: "stopped" });
    storage.set(
      "ccswitch-codex-continuations-v1",
      JSON.stringify({ "submitted:submitted-turn": { status: "attempted" } }),
    );
    expect(
      state.getCodexNativeUsageLimitCandidate("stopped", "stopped-turn"),
    ).toBeNull();
    expect(
      state.getCodexNativeUsageLimitCandidate("submitted", "submitted-turn"),
    ).toBeNull();
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([]);
  });

  it.each([
    { threadCount: 2, markerCount: 4 },
    { threadCount: 12, markerCount: 2_048 },
  ])(
    "reads $markerCount continuation markers once per collection for $threadCount eligible threads",
    async ({ threadCount, markerCount }) => {
      const sessions = Array.from({ length: threadCount }, (_, index) =>
        session(`candidate-${index}`),
      );
      const { state, storage, readContinuationMarkers } = harness(...sessions);
      const markers = Object.fromEntries(
        Array.from({ length: markerCount }, (_, index) => [
          `previous-${index}:previous-${index}-turn`,
          { status: "attempted" },
        ]),
      );
      storage.set(continuationMarkerKey, JSON.stringify(markers));

      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([]);
      expect(readContinuationMarkers).not.toHaveBeenCalled();

      for (const target of sessions) fail(target);
      for (let poll = 0; poll < 2; poll++) {
        readContinuationMarkers.mockClear();
        expectCompleteScan(
          await state.collectCodexNativeUsageLimitCandidates(),
        ).toHaveLength(threadCount);
        expect(readContinuationMarkers).toHaveBeenCalledTimes(1);
      }

      const [marked] = sessions;
      markers[`${marked.thread.id}:${marked.turn.id}`] = {
        status: "attempted",
      };
      storage.set(continuationMarkerKey, JSON.stringify(markers));
      expect(
        state.getCodexNativeUsageLimitCandidate(
          marked.thread.id,
          marked.turn.id,
        ),
      ).toBeNull();
      readContinuationMarkers.mockClear();
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual(
        sessions
          .slice(1)
          .map(({ thread }) =>
            expect.objectContaining({ threadId: thread.id }),
          ),
      );
      expect(readContinuationMarkers).toHaveBeenCalledTimes(1);

      storage.set(continuationMarkerKey, "[]");
      readContinuationMarkers.mockClear();
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([]);
      expect(readContinuationMarkers).toHaveBeenCalledTimes(1);
    },
  );

  it("does not recertify a stopped turn that is still running while the stop settles", async () => {
    const stopped = session("stopped");
    const { state, rememberAction } = harness(stopped);
    await state.collectCodexNativeUsageLimitCandidates();

    rememberAction("turn/interrupt", { threadId: stopped.thread.id });
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([]);
    rememberAction("turn/start", { threadId: stopped.thread.id });
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([]);
    fail(stopped);
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([]);

    stopped.thread.status.type = "active";
    stopped.turn.id = "new-user-turn";
    stopped.turn.status = "inProgress";
    stopped.turn.error = null;
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([]);
    fail(stopped);
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([
      expect.objectContaining({
        threadId: stopped.thread.id,
        turnId: "new-user-turn",
      }),
    ]);
  });

  it("observes a different turn that started after a recorded stop", async () => {
    vi.useFakeTimers();
    try {
      const stopAtSeconds = 1_800_000_000;
      vi.setSystemTime(stopAtSeconds * 1_000);
      const replaced = session("replaced");
      const older = session("older");
      const targets = [replaced, older];
      const { state, rememberAction } = harness(...targets);
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([]);
      for (const target of targets) {
        rememberAction("turn/interrupt", { threadId: target.thread.id });
        target.turn.id = `${target.thread.id}-latest`;
        Object.assign(target.turn, {
          startedAt: stopAtSeconds + (target === replaced ? 1 : 0),
        });
      }

      vi.setSystemTime((stopAtSeconds + 2) * 1_000);
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([]);
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([]);
      for (const target of targets) fail(target);
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([
        expect.objectContaining({
          threadId: replaced.thread.id,
          turnId: replaced.turn.id,
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps exact running proof across a failed read and a temporary pending approval", async () => {
    const tracked = session("tracked");
    const acknowledged = session("acknowledged");
    const { state, request, rememberAction, captureTurnStart } = harness(
      tracked,
      acknowledged,
    );
    await state.collectCodexNativeUsageLimitCandidates();

    const params = {
      threadId: acknowledged.thread.id,
      model: acknowledged.thread.model,
    };
    rememberAction("turn/start", params);
    const observe = captureTurnStart(
      state.appServerClients[0],
      "turn/start",
      params,
    );
    expect(observe).toBeTypeOf("function");
    observe?.({ turn: structuredClone(acknowledged.turn) });
    fail(tracked);
    fail(acknowledged);
    Object.assign(acknowledged.thread, { pendingApproval: true });

    const original = request.getMockImplementation();
    request.mockImplementation(async (method, params) => {
      if (method === "thread/read" && params.threadId === tracked.thread.id)
        throw new Error("Temporary fixture read failure");
      return original?.(method, params);
    });
    expect(await state.collectCodexNativeUsageLimitCandidates()).toEqual(
      incompleteScan(),
    );
    for (const { thread, turn } of [tracked, acknowledged])
      expect(
        state.getCodexNativeUsageLimitCandidate(thread.id, turn.id),
      ).toBeNull();

    Object.assign(acknowledged.thread, { pendingApproval: false });
    request.mockImplementation(original!);
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual(
      [tracked, acknowledged].map(({ thread, turn }) =>
        expect.objectContaining({ threadId: thread.id, turnId: turn.id }),
      ),
    );
  });

  it("scopes active evidence to the current verified local source and renderer", async () => {
    const tracked = session("tracked");
    const { state, request, makeClient, retire } = harness(tracked);
    await state.collectCodexNativeUsageLimitCandidates();
    fail(tracked);

    state.appServerClients = [makeClient("remote")];
    request.mockClear();
    expect(await state.collectCodexNativeUsageLimitCandidates()).toBeNull();
    expect(request).not.toHaveBeenCalled();

    state.appServerClients = [makeClient()];
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([]);
    tracked.thread.status.type = "active";
    tracked.turn.status = "inProgress";
    await state.collectCodexNativeUsageLimitCandidates();
    fail(tracked);
    retire();
    expect(await state.collectCodexNativeUsageLimitCandidates()).toBeNull();
  });

  it("distinguishes a failed loaded-session read from a verified empty snapshot", async () => {
    const { state, request } = harness();
    request.mockRejectedValueOnce(
      new Error("Fixture session list unavailable"),
    );
    expect(await state.collectCodexNativeUsageLimitCandidates()).toEqual(
      incompleteScan(),
    );
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([]);
    expect(request.mock.calls).toEqual([
      ["thread/loaded/list", { cursor: null, limit: 32 }],
      ["thread/loaded/list", { cursor: null, limit: 32 }],
    ]);
  });

  it("publishes only independently verified candidates when another latest-turn read fails", async () => {
    const unreadable = session("unreadable");
    const verified = session("verified");
    const { state, request } = harness(unreadable, verified);
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([]);
    fail(unreadable);
    fail(verified);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => {
      if (
        method === "thread/turns/list" &&
        params.threadId === unreadable.thread.id
      )
        throw new Error("Fixture latest turn unavailable");
      return original(method, params);
    });
    expect(await state.collectCodexNativeUsageLimitCandidates()).toEqual(
      incompleteScan([
        expect.objectContaining({ threadId: verified.thread.id }),
      ]),
    );
    verified.turn.status = "completed";
    expect(await state.collectCodexNativeUsageLimitCandidates()).toEqual({
      candidates: [],
      complete: false,
      conflictingThreadIds: [verified.thread.id],
    });
    request.mockImplementation(original);
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([expect.objectContaining({ threadId: unreadable.thread.id })]);
  });

  it.each(["thread/read", "thread/turns/list"])(
    "publishes verified peers across stalled %s batches without overlapping scans",
    async (stalledMethod) => {
      vi.useFakeTimers();
      try {
        const verified = session("verified");
        const stalled = Array.from({ length: 16 }, (_, index) =>
          session(`stalled-${index}`),
        );
        const targets = [...stalled.slice(0, 8), verified, ...stalled.slice(8)];
        const { state, request } = harness(...targets);
        await state.collectCodexNativeUsageLimitCandidates();
        for (const target of targets) fail(target);
        const original = request.getMockImplementation()!;
        request.mockClear();
        request.mockImplementation(async (method, params) => {
          if (
            method === stalledMethod &&
            params.threadId !== verified.thread.id
          )
            return new Promise(() => {});
          return original(method, params);
        });

        const firstPoll = state.collectCodexNativeUsageLimitCandidates();
        const secondPoll = state.collectCodexNativeUsageLimitCandidates();
        const calls = (method: string) =>
          request.mock.calls.filter(([name]) => name === method);
        await vi.advanceTimersByTimeAsync(2_499);
        expect(calls(stalledMethod)).toHaveLength(8);
        await vi.advanceTimersByTimeAsync(501);
        const partial = {
          candidates: [
            expect.objectContaining({ threadId: verified.thread.id }),
          ],
          complete: false,
        };
        expect(await firstPoll).toEqual(partial);
        expect(await secondPoll).toEqual(partial);
        expect(calls("thread/loaded/list")).toHaveLength(1);
        expect(calls(stalledMethod)).toHaveLength(targets.length);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(await state.collectCodexNativeUsageLimitCandidates()).toEqual(
          partial,
        );
        request.mockImplementation(original);
        expect(await state.collectCodexNativeUsageLimitCandidates()).toEqual({
          candidates: targets.map(({ thread }) =>
            expect.objectContaining({ threadId: thread.id }),
          ),
          complete: true,
        });
        expect(calls("thread/loaded/list")).toHaveLength(2);
        expect(calls(stalledMethod)).toHaveLength(targets.length * 2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { idleCount: 1, cursors: [null] },
    { idleCount: 64, cursors: [null, "32", "64"] },
  ])(
    "bounds history requests on repeated polls with $idleCount idle sessions",
    async ({ idleCount, cursors }) => {
      const running = session("running");
      const idle = Array.from({ length: idleCount }, (_, index) =>
        session(`idle-${index}`, "idle"),
      );
      const sessions = [...idle, running];
      const { state, request } = harness(...sessions);
      const pages = cursors.map((cursor) => [
        "thread/loaded/list",
        { cursor, limit: 32 },
      ]);
      const metadata = sessions.map(({ thread }) => [
        "thread/read",
        { threadId: thread.id, includeTurns: false },
      ]);
      const latest = [
        "thread/turns/list",
        {
          threadId: running.thread.id,
          cursor: null,
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        },
      ];

      for (const stopped of [false, false, true, true]) {
        if (stopped) fail(running);
        request.mockClear();
        expectCompleteScan(
          await state.collectCodexNativeUsageLimitCandidates(),
        ).toEqual(
          stopped
            ? [expect.objectContaining({ threadId: running.thread.id })]
            : [],
        );
        expect(
          request.mock.calls.filter(
            ([method]) => method === "thread/loaded/list",
          ),
        ).toEqual(pages);
        expect(
          request.mock.calls.filter(([method]) => method === "thread/read"),
        ).toEqual(metadata);
        expect(
          request.mock.calls.filter(
            ([method]) => method === "thread/turns/list",
          ),
        ).toEqual([latest]);
        expect(request).toHaveBeenCalledTimes(
          pages.length + metadata.length + 1,
        );
      }
    },
  );

  it("retains more than 64 exact start acknowledgements until their turns can be read", async () => {
    const running = Array.from({ length: 65 }, (_, index) =>
      session(`running-${index}`),
    );
    const { state, rememberAction, captureTurnStart } = harness(...running);
    for (const target of running) {
      const params = { threadId: target.thread.id, model: target.thread.model };
      rememberAction("turn/start", params);
      const observe = captureTurnStart(
        state.appServerClients[0],
        "turn/start",
        params,
      );
      expect(observe).toBeTypeOf("function");
      observe?.({ turn: structuredClone(target.turn) });
      fail(target);
    }
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual(
      running.map(({ thread, turn }) =>
        expect.objectContaining({ threadId: thread.id, turnId: turn.id }),
      ),
    );
  });

  it("rejects a nonconsecutive loaded-session cursor cycle", async () => {
    const { state, request } = harness();
    request
      .mockResolvedValueOnce({ data: [], nextCursor: "second" })
      .mockResolvedValueOnce({ data: [], nextCursor: "third" })
      .mockResolvedValueOnce({ data: [], nextCursor: "second" });
    expect(await state.collectCodexNativeUsageLimitCandidates()).toEqual(
      incompleteScan(),
    );
    expect(request.mock.calls).toEqual([
      ["thread/loaded/list", { cursor: null, limit: 32 }],
      ["thread/loaded/list", { cursor: "second", limit: 32 }],
      ["thread/loaded/list", { cursor: "third", limit: 32 }],
    ]);
  });

  it("uses the exact latest turn model when thread metadata omits it", async () => {
    const sampled = session("sampled");
    const acknowledged = session("acknowledged");
    const changed = session("changed");
    const conflicting = session("conflicting");
    const running = [sampled, acknowledged, changed, conflicting];
    for (const target of running) {
      Object.assign(target.turn, { model: target.thread.model });
      if (target !== conflicting)
        Object.assign(target.thread, { model: undefined });
    }
    Object.assign(conflicting.turn, { model: "another-model" });
    acknowledged.thread.status.type = "idle";
    const { state, rememberAction, captureTurnStart } = harness(...running);
    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual([]);
    const params = { threadId: acknowledged.thread.id, model: "request-model" };
    rememberAction("turn/start", params);
    const observe = captureTurnStart(
      state.appServerClients[0],
      "turn/start",
      params,
    );
    expect(observe).toBeTypeOf("function");
    observe?.({ turn: structuredClone(acknowledged.turn) });
    for (const target of running) fail(target);
    Object.assign(changed.turn, { model: "another-model" });

    expectCompleteScan(
      await state.collectCodexNativeUsageLimitCandidates(),
    ).toEqual(
      [sampled, acknowledged].map(({ thread, turn }) =>
        expect.objectContaining({
          threadId: thread.id,
          turnId: turn.id,
          model: "request-model",
          modelProvider: "openai",
        }),
      ),
    );
  });

  it("observes exact turns when the app server omits model metadata", async () => {
    const sampled = session("sampled");
    const retained = session("retained");
    const acknowledged = session("acknowledged");
    const modelFromStart = session("model-from-start");
    const unmatched = session("unmatched");
    const unknown = session("unknown");
    const malformed = session("malformed");
    const targets = [
      sampled,
      retained,
      acknowledged,
      modelFromStart,
      unmatched,
      unknown,
      malformed,
    ];
    for (const target of targets) {
      if (target !== retained) Object.assign(target.thread, { model: null });
    }
    for (const target of [acknowledged, modelFromStart, unmatched])
      target.thread.status.type = "idle";
    Object.assign(unknown.turn, { model: "unknown" });
    Object.assign(malformed.turn, { model: { id: "request-model" } });
    const { state, rememberAction, captureTurnStart } = harness(...targets);
    expect(await state.collectCodexNativeUsageLimitCandidates()).toEqual(
      incompleteScan(),
    );

    for (const target of [acknowledged, modelFromStart, unmatched]) {
      const params = {
        threadId: target.thread.id,
        ...(target === acknowledged ? {} : { model: "request-model" }),
      };
      rememberAction("turn/start", params);
      const observe = captureTurnStart(
        state.appServerClients[0],
        "turn/start",
        params,
      );
      expect(observe).toBeTypeOf("function");
      observe?.({ turn: structuredClone(target.turn) });
    }
    unmatched.turn.id = "different-turn";
    Object.assign(retained.thread, { model: null });
    for (const target of targets) fail(target);
    expect(await state.collectCodexNativeUsageLimitCandidates()).toEqual(
      incompleteScan(
        [sampled, retained, acknowledged, modelFromStart].map((target) =>
          expect.objectContaining({
            threadId: target.thread.id,
            turnId: target.turn.id,
            model:
              target === retained || target === modelFromStart
                ? "request-model"
                : null,
          }),
        ),
      ),
    );
  });

  it("keeps verified candidates during a delayed scan while action and marker evidence match", async () => {
    vi.useFakeTimers();
    try {
      const running = session("running");
      const stopped = session("stopped");
      const submitted = session("submitted");
      const unreadable = session("unreadable");
      const targets = [running, stopped, submitted, unreadable];
      const { state, request, rememberAction, storage } = harness(...targets);
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([]);
      for (const target of targets) fail(target);
      const scan = await state.collectCodexNativeUsageLimitCandidates();
      expect(scan?.complete).toBe(true);
      const candidates = scan?.candidates;
      expect(candidates?.map(({ threadId }) => threadId)).toEqual(
        targets.map(({ thread }) => thread.id),
      );

      const original = request.getMockImplementation();
      request.mockImplementation(async (method, params) => {
        if (
          method === "thread/read" &&
          params.threadId === unreadable.thread.id
        )
          throw new Error("Temporary fixture read failure");
        if (method === "thread/read" || method === "thread/turns/list")
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        return original?.(method, params);
      });
      const delayed = state.collectCodexNativeUsageLimitCandidates();
      await vi.advanceTimersByTimeAsync(2_000);
      rememberAction("turn/interrupt", { threadId: stopped.thread.id });
      storage.set(
        "ccswitch-codex-continuations-v1",
        JSON.stringify({ [`${submitted.thread.id}:${submitted.turn.id}`]: {} }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await delayed).toEqual(incompleteScan([candidates?.[0]]));
      expect(
        state.getCodexNativeUsageLimitCandidate(
          unreadable.thread.id,
          unreadable.turn.id,
        ),
      ).toBeNull();

      running.turn.error = null;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await state.collectCodexNativeUsageLimitCandidates()).toEqual({
        candidates: [],
        complete: false,
        conflictingThreadIds: [running.thread.id],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires previously verified candidates during an unusually long enumeration", async () => {
    vi.useFakeTimers();
    try {
      const running = session("running");
      const { state, request } = harness(running);
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([]);
      fail(running);
      const scan = await state.collectCodexNativeUsageLimitCandidates();
      expect(scan?.complete).toBe(true);
      const candidates = scan?.candidates;
      expect(candidates).toHaveLength(1);

      request.mockImplementation(async (_method, { cursor }) => {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const next = Number(cursor ?? 0) + 1;
        return { data: [], nextCursor: next < 17 ? String(next) : null };
      });
      const firstPoll = state.collectCodexNativeUsageLimitCandidates();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await firstPoll).toEqual(incompleteScan(candidates));
      await vi.advanceTimersByTimeAsync(25_000);
      const overduePoll = state.collectCodexNativeUsageLimitCandidates();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await overduePoll).toEqual(incompleteScan());
      await vi.advanceTimersByTimeAsync(3_000);
      expectCompleteScan(
        await state.collectCodexNativeUsageLimitCandidates(),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["current", "new action", "new generation"])(
    "rechecks a delayed scan at harvest with %s",
    async (change) => {
      vi.useFakeTimers();
      try {
        const running = session("running");
        const { state, request, rememberAction } = harness(running);
        expectCompleteScan(
          await state.collectCodexNativeUsageLimitCandidates(),
        ).toEqual([]);
        fail(running);
        request.mockClear();
        const original = request.getMockImplementation();
        request.mockImplementation(async (method, params) => {
          if (method === "thread/read" || method === "thread/turns/list")
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          return original?.(method, params);
        });
        const firstPoll = state.collectCodexNativeUsageLimitCandidates();
        const overlappingPoll = state.collectCodexNativeUsageLimitCandidates();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(await firstPoll).toEqual(incompleteScan());
        expect(await overlappingPoll).toEqual(incompleteScan());
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "thread/loaded/list",
          "thread/read",
          "thread/turns/list",
        ]);
        await vi.advanceTimersByTimeAsync(1_000);
        if (change === "new action")
          rememberAction("turn/interrupt", { threadId: running.thread.id });
        if (change === "new generation") state.runtimeGeneration++;
        request.mockImplementation(original!);
        expect(await state.collectCodexNativeUsageLimitCandidates()).toEqual(
          change === "current"
            ? {
                candidates: [
                  expect.objectContaining({ threadId: running.thread.id }),
                ],
                complete: true,
              }
            : change === "new generation"
              ? null
              : { candidates: [], complete: true },
        );
        expect(
          request.mock.calls.filter(
            ([method]) => method === "thread/loaded/list",
          ),
        ).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
