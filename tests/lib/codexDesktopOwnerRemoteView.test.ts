import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
const publicIdentityHelpers = resource("model_picker_diagnostics.js").split(
  "const codexPickerModelSnapshot",
)[0];
const viewSource = resource("owner_remote_view.js");

type View = {
  kind: "snapshot" | "unavailable";
  reason?: string;
  observedAtMs?: number;
  threadId?: string;
  model?: string | null;
  latestTurnId?: string | null;
  status?: string;
  currentDisplay?: string;
  historyMode?: string;
  olderContentAvailable?: boolean;
  truncated?: boolean;
  viewReference?: string | null;
  continueBlocker?: string | null;
  turns?: Array<{
    id: string | null;
    status: string;
    items: Array<{
      id: string | null;
      type: string;
      text?: string;
      status?: string;
    }>;
    truncated: boolean;
  }>;
};
type Binding = {
  threadId: string;
  latestTurnId: string;
  expectedModel: string;
  expectedModelProvider: string;
  runtimeGeneration: number;
  observedAtMs: number;
  expiresAtMs: number;
  client: object;
  request: Function;
};
type State = {
  runtimeGeneration: number;
  payload: object;
  appServerClients: object[];
  reactAppServerClientOwners: Map<object, Array<() => boolean>>;
  readCodexOwnerRemoteView: (threadId: unknown) => Promise<View>;
  listCodexOwnerRemoteConversations: () => Promise<{
    kind: "conversations" | "unavailable";
    reason?: string;
    currentDisplay?: string;
    conversations?: Array<{ threadId: string; title: string | null }>;
    truncated?: boolean;
  }>;
  inspectCodexOwnerRemoteViewReference: (id: unknown) => {
    threadId: string;
    baseTurnId: string;
    expectedModel: string;
    expectedModelProvider: string;
    runtimeGeneration: number;
    observedAtMs: number;
  } | null;
  confirmCodexOwnerContinuation: (operation: string) => { started: boolean };
  startCodexOwnerContinuation: (
    reference: unknown,
    operationId: string,
  ) => { started: boolean; jobId?: string };
  commitCodexContinuation: (operationId: string) => { started: boolean };
  readCodexContinuationJob: (operationId: string) => {
    status: string;
    submitted?: boolean;
    mutationAttempted?: boolean;
    intent?: string;
  };
};
const completedThread = (): Record<string, unknown> => ({
  id: "exact-thread",
  model: "request-model",
  modelProvider: "local-provider",
  status: { type: "idle" },
  turns: [
    {
      id: "base-turn",
      status: "completed",
      items: [
        {
          id: "user-1",
          type: "userMessage",
          content: [{ type: "text", text: "hello" }],
        },
        { id: "assistant-1", type: "agentMessage", text: "Current answer" },
      ],
    },
  ],
});
const createHarness = (
  thread = completedThread(),
  options: { host?: string; pauseRead?: boolean; noCrypto?: boolean } = {},
) => {
  const state = {
    runtimeGeneration: 1,
    payload: { modelProvider: "local-provider" },
    reactAppServerClientOwners: new Map<object, Array<() => boolean>>(),
  } as State;
  let installationCurrent = true;
  let ownerCurrent = true;
  const releaseReads: Array<() => void> = [];
  let readsReleased = false;
  let response: unknown = { thread };
  let responseOverridden = false;
  const pageResponses = new Map<string, unknown>();
  const pageTurns = new Map<unknown, object>();
  const own = (value: unknown, key: string) =>
    value && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, key)?.value
      : undefined;
  const tail = (values: unknown[], limit: number) => {
    const page: unknown[] = [];
    for (let index = 0; index < Math.min(values.length, limit); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(
        values,
        String(values.length - index - 1),
      );
      if (descriptor) Object.defineProperty(page, String(index), descriptor);
    }
    return page;
  };
  const calls = vi.fn(async (method: string, params: unknown) => {
    if (method === "turn/start")
      return { threadId: "exact-thread", turn: { id: "continued-turn" } };
    if (options.pauseRead && !readsReleased)
      await new Promise<void>((resolve) => {
        releaseReads.push(resolve);
      });
    if (pageResponses.has(method)) {
      const value = pageResponses.get(method);
      return typeof value === "function" ? value(params) : value;
    }
    if (method === "thread/list") return { data: [thread], nextCursor: null };
    if (method === "thread/turns/list") {
      const turns = own(thread, "turns");
      if (!Array.isArray(turns)) return { data: [], nextCursor: null };
      const limit = own(params, "limit") as number;
      const source = tail(turns, limit);
      const page: object[] = [];
      for (let index = 0; index < source.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          source,
          String(index),
        );
        const turn = own(source, String(index));
        if (turn && typeof turn === "object") {
          pageTurns.set(own(turn, "id"), turn);
          const metadata = { itemsView: "notLoaded", items: [] };
          for (const key of ["id", "status", "model"]) {
            const field = Object.getOwnPropertyDescriptor(turn, key);
            if (field) Object.defineProperty(metadata, key, field);
          }
          page.push(metadata);
        } else if (descriptor)
          Object.defineProperty(page, String(index), descriptor);
      }
      return {
        data: page,
        nextCursor: turns.length > limit ? "older-turns" : null,
      };
    }
    if (method === "thread/items/list") {
      const turnId = own(params, "turnId");
      const items = own(pageTurns.get(turnId), "items");
      const limit = own(params, "limit") as number;
      const page = Array.isArray(items) ? tail(items, limit) : [];
      const data: object[] = [];
      for (let index = 0; index < page.length; index += 1) {
        const entry = { turnId };
        const descriptor = Object.getOwnPropertyDescriptor(page, String(index));
        if (descriptor) Object.defineProperty(entry, "item", descriptor);
        data.push(entry);
      }
      return {
        data,
        nextCursor:
          Array.isArray(items) && items.length > limit ? "older-items" : null,
      };
    }
    if (
      method === "thread/read" &&
      own(params, "includeTurns") === false &&
      !responseOverridden
    ) {
      const metadata: Record<string, unknown> = { turns: [] };
      for (const [key, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(thread),
      )) {
        if (key !== "turns") Object.defineProperty(metadata, key, descriptor);
      }
      return { thread: metadata };
    }
    return response;
  });
  const client = {
    hostId: options.host ?? "local",
    getCompatibleThreadSortKey() {},
    supportsPaginatedThreadHistory() {},
    sendRequest: calls,
  };
  const original = client.sendRequest.bind(client);
  const storage = new Map<string, string>();
  let randomIndex = 0;
  const crypto = options.noCrypto
    ? undefined
    : {
        getRandomValues: (bytes: Uint8Array) => {
          bytes.fill(++randomIndex);
          return bytes;
        },
      };
  const api = new Function(
    "state",
    "localStorage",
    "installAppServerPatch",
    "recordFailure",
    "installationIsCurrent",
    "crypto",
    `${discovery}\n${continuation}\n${publicIdentityHelpers}\n${viewSource}\nreturn { resolveCodexOwnerRemoteViewReference, codexOwnerRemoteViewReferenceIsCurrent, rememberCodexUserTurnAction };`,
  )(
    state,
    {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    async () => {},
    () => {},
    () => installationCurrent,
    crypto,
  ) as {
    resolveCodexOwnerRemoteViewReference: (id: unknown) => Binding | null;
    codexOwnerRemoteViewReferenceIsCurrent: (
      id: unknown,
      binding: unknown,
    ) => boolean;
    rememberCodexUserTurnAction: (method: string, params: unknown) => void;
  };
  const wrapper = async (method: string, params: unknown) => {
    api.rememberCodexUserTurnAction(method, params);
    return original(method, params);
  };
  Object.defineProperty(wrapper, "__ccSwitchRequestHook", {
    value: Object.freeze({ client, original, version: "standalone" }),
  });
  Object.assign(client, {
    __ccSwitchOriginalSendRequest: original,
    sendRequest: wrapper,
    __ccSwitchModelRequestPatch: "standalone",
  });
  state.appServerClients = [client];
  state.reactAppServerClientOwners.set(client, [() => ownerCurrent]);
  return {
    state,
    api,
    thread,
    client,
    calls,
    read: (id: unknown = "exact-thread") => state.readCodexOwnerRemoteView(id),
    releaseRead: () => {
      readsReleased = true;
      for (const release of releaseReads.splice(0)) release();
    },
    setPageResponse: (method: string, value: unknown) => {
      pageResponses.set(method, value);
    },
    replaceRoot: () => {
      ownerCurrent = false;
    },
    replaceRuntime: () => {
      installationCurrent = false;
      state.runtimeGeneration += 1;
    },
    replaceHook: () => {
      client.sendRequest = original;
    },
    setResponse: (value: unknown) => {
      response = value;
      responseOverridden = true;
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Codex owner remote read-only view foundation", () => {
  it("reads the explicitly selected exact local thread without resuming or mutating it", async () => {
    const harness = createHarness();
    const before = JSON.stringify(harness.thread);
    const view = await harness.read();
    expect(view).toMatchObject({
      kind: "snapshot",
      threadId: "exact-thread",
      model: "request-model",
      latestTurnId: "base-turn",
      status: "idle",
      currentDisplay: "unavailable",
      historyMode: "bounded_recent_snapshot",
      olderContentAvailable: false,
      continueBlocker: null,
      turns: [
        {
          id: "base-turn",
          status: "completed",
          items: [
            { id: "user-1", type: "user", text: "hello" },
            { id: "assistant-1", type: "assistant", text: "Current answer" },
          ],
        },
      ],
    });
    expect(view.viewReference).toMatch(/^view-[a-f0-9]{32}$/);
    expect(harness.calls.mock.calls).toEqual([
      ["thread/read", { threadId: "exact-thread", includeTurns: false }],
      [
        "thread/turns/list",
        {
          threadId: "exact-thread",
          cursor: null,
          limit: 20,
          sortDirection: "desc",
          itemsView: "notLoaded",
        },
      ],
      [
        "thread/items/list",
        {
          threadId: "exact-thread",
          turnId: "base-turn",
          cursor: null,
          limit: 40,
          sortDirection: "desc",
          deferOutput: {},
        },
      ],
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
    expect(JSON.stringify(harness.thread)).toBe(before);
    expect(
      harness.api.resolveCodexOwnerRemoteViewReference(view.viewReference),
    ).toMatchObject({
      threadId: "exact-thread",
      latestTurnId: "base-turn",
      expectedModel: "request-model",
      expectedModelProvider: "local-provider",
      runtimeGeneration: 1,
    });
    expect(JSON.stringify(view)).not.toContain("local-provider");
  });

  it("prepares a real view reference through the common executor and commits only one literal continue", async () => {
    const harness = createHarness();
    const view = await harness.read();
    const first = harness.state.startCodexOwnerContinuation(
      view.viewReference,
      "owner-operation-1",
    );
    const second = harness.state.startCodexOwnerContinuation(
      view.viewReference,
      "owner-operation-2",
    );
    expect(first.started).toBe(true);
    expect(second.started).toBe(true);
    for (let index = 0; index < 40; index += 1) await Promise.resolve();
    expect(
      harness.state.readCodexContinuationJob("owner-operation-1").status,
    ).toBe("prepared");
    expect(
      harness.state.readCodexContinuationJob("owner-operation-2").status,
    ).toBe("prepared");
    expect(
      harness.calls.mock.calls.every(([method]) =>
        ["thread/read", "thread/turns/list", "thread/items/list"].includes(
          method,
        ),
      ),
    ).toBe(true);
    expect(
      harness.state.confirmCodexOwnerContinuation("owner-operation-1").started,
    ).toBe(true);
    expect(
      harness.state.confirmCodexOwnerContinuation("owner-operation-2").started,
    ).toBe(true);
    for (let index = 0; index < 40; index += 1) await Promise.resolve();
    expect(
      harness.state.readCodexContinuationJob("owner-operation-1").status,
    ).toBe("confirmed");
    expect(
      harness.state.readCodexContinuationJob("owner-operation-2").status,
    ).toBe("confirmed");
    expect(
      harness.state.commitCodexContinuation("owner-operation-1").started,
    ).toBe(true);
    expect(
      harness.state.commitCodexContinuation("owner-operation-2").started,
    ).toBe(true);
    for (let index = 0; index < 40; index += 1) await Promise.resolve();
    expect(
      harness.calls.mock.calls.filter(([method]) => method === "turn/start"),
    ).toEqual([
      [
        "turn/start",
        {
          threadId: "exact-thread",
          input: [{ type: "text", text: "continue" }],
        },
      ],
    ]);
    expect(
      harness.state.readCodexContinuationJob("owner-operation-1"),
    ).toMatchObject({
      status: "completed",
      submitted: true,
      intent: "OwnerContinue",
    });
    expect(
      harness.state.readCodexContinuationJob("owner-operation-2"),
    ).toMatchObject({
      status: "completed",
      submitted: false,
      mutationAttempted: true,
    });
  });

  it.each([undefined, null, {}, "", " ", "x".repeat(257)])(
    "rejects an invalid selection before any read: %j",
    async (id) => {
      const harness = createHarness();
      const view = await harness.state.readCodexOwnerRemoteView(id);
      expect(view).toEqual({ kind: "unavailable", reason: "invalid_thread" });
      expect(harness.calls).not.toHaveBeenCalled();
    },
  );

  it("does not use a remote host or a retained client with no current owner", async () => {
    for (const mode of ["remote", "stale-root"] as const) {
      const harness = createHarness(undefined, {
        host: mode === "remote" ? "remote" : "local",
      });
      if (mode === "stale-root") harness.replaceRoot();
      expect(await harness.read()).toEqual({
        kind: "unavailable",
        reason: "runtime_unavailable",
      });
      expect(harness.calls).not.toHaveBeenCalled();
    }
  });

  it("rejects the wrong returned thread without publishing its content", async () => {
    const harness = createHarness({
      ...completedThread(),
      id: "foreign-thread",
      private: "fixture-sensitive-content",
    });
    expect(await harness.read()).toEqual({
      kind: "unavailable",
      reason: "thread_unavailable",
    });
    expect(harness.calls).toHaveBeenCalledTimes(1);
  });

  it.each(["root", "runtime", "hook", "payload"] as const)(
    "rechecks %s ownership after the awaited read",
    async (change) => {
      const harness = createHarness(undefined, { pauseRead: true });
      const promise = harness.read();
      await Promise.resolve();
      if (change === "root") harness.replaceRoot();
      if (change === "runtime") harness.replaceRuntime();
      if (change === "hook") harness.replaceHook();
      if (change === "payload")
        harness.state.payload = { modelProvider: "other-provider" };
      harness.releaseRead();
      expect(await promise).toEqual({
        kind: "unavailable",
        reason: "ownership_changed",
      });
    },
  );

  it.each(["failed", "interrupted"])(
    "retains error display and binds a loaded systemError with terminal %s",
    async (turnStatus) => {
      const thread = completedThread();
      thread.status = { type: "systemError", activeFlags: [] };
      thread.turns = [{ id: "base-turn", status: turnStatus, items: [] }];
      const harness = createHarness(thread);
      const view = await harness.read();
      expect(view).toMatchObject({
        kind: "snapshot",
        status: "error",
        latestTurnId: "base-turn",
        continueBlocker: null,
      });
      expect(view.viewReference).toEqual(expect.any(String));
      expect(
        harness.api.resolveCodexOwnerRemoteViewReference(view.viewReference),
      ).toMatchObject({
        threadId: "exact-thread",
        latestTurnId: "base-turn",
        expectedModel: "request-model",
        expectedModelProvider: "local-provider",
      });
      expect(
        harness.calls.mock.calls.some(([method]) => method === "turn/start"),
      ).toBe(false);
    },
  );

  it.each(["completed", "inProgress", "unknown"])(
    "keeps loaded systemError read-only without a failed/interrupted latest turn: %s",
    async (turnStatus) => {
      const thread = completedThread();
      thread.status = { type: "systemError", activeFlags: [] };
      thread.turns = [{ id: "base-turn", status: turnStatus, items: [] }];
      const view = await createHarness(thread).read();
      expect(view).toMatchObject({
        kind: "snapshot",
        status: "error",
        viewReference: null,
      });
      expect(view.continueBlocker).not.toBeNull();
    },
  );

  it.each(
    ["failed", "interrupted"].flatMap((turnStatus) =>
      [
        { pendingApprovals: ["pending"] },
        { pendingOperations: ["pending"] },
        { pendingRequests: ["pending"] },
        { pendingApproval: true },
        { pendingOperation: true },
        { waitingOnApproval: true },
        { waitingOnUserInput: true },
        { pendingApprovals: null },
        { status: { type: "systemError", activeFlags: ["waitingOnApproval"] } },
        { status: { type: "systemError", activeFlags: null } },
      ].map((pending) => ({ turnStatus, pending })),
    ),
  )(
    "keeps loaded systemError read-only with conflicting/unreadable pending evidence: %j",
    async ({ turnStatus, pending }) => {
      const thread = completedThread();
      thread.status = { type: "systemError", activeFlags: [] };
      thread.turns = [{ id: "base-turn", status: turnStatus, items: [] }];
      Object.assign(thread, pending);
      const view = await createHarness(thread).read();
      expect(view.kind).toBe("snapshot");
      expect(view.viewReference).toBeNull();
      expect(view.continueBlocker).not.toBeNull();
    },
  );

  it("does not infer idle from missing or noncanonical thread status", async () => {
    for (const status of [
      undefined,
      "idle",
      { type: "notLoaded" },
      { type: "unrecognized" },
    ]) {
      const harness = createHarness({ ...completedThread(), status });
      expect(await harness.read()).toMatchObject({
        kind: "snapshot",
        status: "unknown",
        viewReference: null,
        continueBlocker: "thread_not_idle",
      });
    }
  });

  it.each([
    { status: { type: "active", activeFlags: [] }, expected: "active" },
    {
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
      expected: "waiting",
    },
    {
      status: { type: "active", activeFlags: ["waitingOnUserInput"] },
      expected: "waiting",
    },
    { status: { type: "systemError" }, expected: "error" },
    {
      status: { type: "idle", activeFlags: ["waitingOnApproval"] },
      expected: "waiting",
    },
  ])(
    "projects finite canonical state without authorizing Continue: %j",
    async ({ status, expected }) => {
      expect(
        await createHarness({ ...completedThread(), status }).read(),
      ).toMatchObject({
        kind: "snapshot",
        status: expected,
        viewReference: null,
        continueBlocker: "thread_not_idle",
      });
    },
  );

  it.each([
    "pendingApproval",
    "pendingApprovals",
    "pendingOperation",
    "pendingOperations",
    "waitingOnApproval",
    "waitingOnUserInput",
  ])("does not authorize a conflicting %s", async (field) => {
    const harness = createHarness({ ...completedThread(), [field]: true });
    expect(await harness.read()).toMatchObject({
      viewReference: null,
      status: "waiting",
      continueBlocker: "thread_not_idle",
    });
  });

  it("does not authorize an active or unknown latest turn, absent provider, or model conflict", async () => {
    for (const partial of [
      { turns: [{ id: "base-turn", status: "inProgress", items: [] }] },
      { turns: [{ id: "base-turn", status: "unknown", items: [] }] },
      { modelProvider: undefined },
      { model: undefined },
      {
        turns: [
          {
            id: "base-turn",
            status: "completed",
            model: "other-model",
            items: [],
          },
        ],
      },
      { turns: [] },
    ]) {
      const view = await createHarness({
        ...completedThread(),
        ...partial,
      }).read();
      expect(view.kind).toBe("snapshot");
      expect(view.viewReference).toBeNull();
      expect(view.continueBlocker).not.toBeNull();
    }
  });

  it("projects only allowlisted messages, public summaries, and tool status/output", async () => {
    const thread = completedThread();
    thread.turns = [
      {
        id: "base-turn",
        status: "completed",
        items: [
          {
            id: "r-1",
            type: "reasoning",
            summary: ["Public summary"],
            content: ["hidden-reasoning-marker"],
            text: "hidden-text-marker",
          },
          {
            id: "c-1",
            type: "commandExecution",
            status: "completed",
            aggregatedOutput: "Tool output",
            command: "credential-command-marker",
            cwd: "private-host-path-marker",
            apiKey: "raw-tool-auth-marker",
          },
          {
            id: "m-1",
            type: "mcpToolCall",
            status: "inProgress",
            arguments: { secret: "tool-argument-marker" },
            result: { token: "tool-result-marker" },
          },
          { id: "unknown-1", type: "unknown", auth: "unknown-raw-marker" },
        ],
      },
    ];
    thread.auth = { token: "thread-auth-marker" };
    thread.config = { secret: "thread-config-marker" };
    thread.error = { message: "raw-error-marker" };
    const view = await createHarness(thread).read();
    expect(view.turns?.[0].items).toEqual([
      { id: "r-1", type: "reasoning_summary", text: "Public summary" },
      { id: "c-1", type: "command", status: "completed", text: "Tool output" },
      { id: "m-1", type: "tool", status: "active" },
      { id: "unknown-1", type: "unsupported", status: "unknown" },
    ]);
    expect(JSON.stringify(view)).not.toMatch(
      /hidden-|credential-command|private-host|raw-tool|tool-argument|tool-result|unknown-raw|thread-auth|thread-config|raw-error/,
    );
  });

  it("never invokes getter-backed transcript fields", async () => {
    const getter = vi.fn(() => "fixture-sensitive-content");
    const item = { id: "assistant-1", type: "agentMessage" };
    Object.defineProperty(item, "text", { get: getter });
    const thread = completedThread();
    thread.turns = [{ id: "base-turn", status: "completed", items: [item] }];
    expect(await createHarness(thread).read()).toEqual({
      kind: "unavailable",
      reason: "snapshot_unreadable",
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not invoke response or exact-thread identity accessors", async () => {
    for (const field of ["response", "id"] as const) {
      const getter = vi.fn(() => "fixture-sensitive-content");
      const harness = createHarness();
      if (field === "response") {
        const response = {};
        Object.defineProperty(response, "thread", { get: getter });
        harness.setResponse(response);
      } else Object.defineProperty(harness.thread, "id", { get: getter });
      const view = await harness.read();
      expect(view).toEqual({
        kind: "unavailable",
        reason: "thread_unavailable",
      });
      expect(getter).not.toHaveBeenCalled();
      expect(JSON.stringify(view)).not.toContain("fixture-sensitive-content");
    }
  });

  it("does not call unknown or malformed pending metadata idle", async () => {
    for (const partial of [
      { pendingApprovals: null },
      { pendingOperations: false },
      { pendingRequests: {} },
      { pendingApproval: [] },
      { waitingOnUserInput: null },
      { status: { type: "idle", activeFlags: null } },
    ]) {
      const view = await createHarness({
        ...completedThread(),
        ...partial,
      }).read();
      expect(view.kind).toBe("snapshot");
      expect(view.status).not.toBe("idle");
      expect(view.viewReference).toBeNull();
    }
  });

  it("does not authorize an accessor-backed optional latest-turn model", async () => {
    const getter = vi.fn(() => "other-model");
    const thread = completedThread();
    const turn = (thread.turns as Array<object>)[0];
    Object.defineProperty(turn, "model", { get: getter });
    const view = await createHarness(thread).read();
    expect(view.kind).toBe("snapshot");
    expect(view.viewReference).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it("never reads unrelated secret getters or invokes object coercion", async () => {
    const getter = vi.fn(() => "fixture-sensitive-content");
    const thread = completedThread();
    Object.defineProperty(thread, "auth", { get: getter });
    const coercion = vi.fn(() => "sensitive-coercion-marker");
    const turns = thread.turns as Array<Record<string, unknown>>;
    const items = turns[0].items as Array<Record<string, unknown>>;
    items.push({
      id: "bad-text",
      type: "agentMessage",
      text: { toString: coercion },
    });
    const view = await createHarness(thread).read();
    expect(view.kind).toBe("snapshot");
    expect(getter).not.toHaveBeenCalled();
    expect(coercion).not.toHaveBeenCalled();
    expect(JSON.stringify(view)).not.toContain("sensitive");
  });

  it("does not invoke getters in array entries or in canonical idle proof", async () => {
    for (const field of ["array", "status", "pending"] as const) {
      const getter = vi.fn(() => "idle");
      const thread = completedThread();
      if (field === "array")
        Object.defineProperty(thread.turns as object[], "0", { get: getter });
      if (field === "status")
        Object.defineProperty(thread.status as object, "type", { get: getter });
      if (field === "pending")
        Object.defineProperty(thread, "pendingApproval", { get: getter });
      const view = await createHarness(thread).read();
      expect(getter).not.toHaveBeenCalled();
      expect(view.viewReference ?? null).toBeNull();
    }
  });

  it("bounds source pages and recent turns/items/text without crawling earlier pages", async () => {
    const earlyGetter = vi.fn(() => {
      throw new Error("must not inspect old turn");
    });
    const turns = Array.from({ length: 5000 }, (_, index) => ({
      id: `turn-${index}`,
      status: "completed",
      items:
        index < 4980
          ? []
          : Array.from({ length: 50 }, (_, item) => ({
              id: `item-${index}-${item}`,
              type: "agentMessage",
              text: "x".repeat(10000),
            })),
    }));
    Object.defineProperty(turns, "0", { get: earlyGetter });
    const view = await createHarness({ ...completedThread(), turns }).read();
    expect(view.kind).toBe("snapshot");
    expect(view.truncated).toBe(true);
    expect(view.turns!.length).toBeLessThanOrEqual(20);
    expect(
      view.turns!.reduce((count, turn) => count + turn.items.length, 0),
    ).toBeLessThanOrEqual(120);
    expect(
      view
        .turns!.flatMap((turn) => turn.items)
        .reduce((count, item) => count + (item.text?.length ?? 0), 0),
    ).toBeLessThanOrEqual(32768);
    expect(earlyGetter).not.toHaveBeenCalled();
    expect(view.olderContentAvailable).toBe(false);
    expect(view.latestTurnId).toBe("turn-4999");
  });

  it("coalesces concurrent exact-thread reads into one snapshot and reference", async () => {
    const harness = createHarness(undefined, { pauseRead: true });
    const first = harness.read();
    const second = harness.read();
    await Promise.resolve();
    expect(harness.calls).toHaveBeenCalledTimes(1);
    harness.releaseRead();
    expect(await first).toEqual(await second);
  });

  it("caps distinct in-flight reads and bounds a stuck reader with the shared deadline", async () => {
    const harness = createHarness(undefined, { pauseRead: true });
    const reads = Array.from({ length: 4 }, (_, index) =>
      harness.read(`thread-${index}`),
    );
    expect(await harness.read("fifth-thread")).toEqual({
      kind: "unavailable",
      reason: "read_busy",
    });
    expect(harness.calls).toHaveBeenCalledTimes(4);
    harness.releaseRead();
    await Promise.all(reads);

    vi.useFakeTimers();
    const stuck = createHarness(undefined, { pauseRead: true });
    const pending = stuck.read();
    await vi.advanceTimersByTimeAsync(2500);
    expect(await pending).toEqual({
      kind: "unavailable",
      reason: "thread_unavailable",
    });
    expect(stuck.calls).toHaveBeenCalledTimes(1);
    stuck.releaseRead();
  });

  it("keeps references private, bounded, expiring, and bound to the current runtime/client", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
    const harness = createHarness();
    const first = await harness.read();
    const binding = harness.api.resolveCodexOwnerRemoteViewReference(
      first.viewReference,
    );
    expect(binding).not.toBeNull();
    expect(Object.isFrozen(binding)).toBe(true);
    expect(
      harness.api.codexOwnerRemoteViewReferenceIsCurrent(first.viewReference, {
        ...binding,
      }),
    ).toBe(false);
    expect(
      harness.api.codexOwnerRemoteViewReferenceIsCurrent(
        first.viewReference,
        binding,
      ),
    ).toBe(true);
    expect(
      harness.api.resolveCodexOwnerRemoteViewReference("invented-reference"),
    ).toBeNull();
    for (let index = 0; index < 33; index += 1) await harness.read();
    expect(
      harness.api.resolveCodexOwnerRemoteViewReference(first.viewReference),
    ).toBeNull();
    const latest = await harness.read();
    vi.advanceTimersByTime(30001);
    expect(
      harness.api.resolveCodexOwnerRemoteViewReference(latest.viewReference),
    ).toBeNull();
  });

  it.each(["root", "runtime", "hook", "payload", "newer-user-action"] as const)(
    "invalidates a reference after %s changes",
    async (change) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
      const harness = createHarness();
      const view = await harness.read();
      const binding = harness.api.resolveCodexOwnerRemoteViewReference(
        view.viewReference,
      );
      if (change === "root") harness.replaceRoot();
      if (change === "runtime") harness.replaceRuntime();
      if (change === "hook") harness.replaceHook();
      if (change === "payload") harness.state.payload = {};
      if (change === "newer-user-action") {
        vi.advanceTimersByTime(1);
        harness.api.rememberCodexUserTurnAction("turn/start", {
          threadId: "exact-thread",
        });
      }
      expect(
        harness.api.codexOwnerRemoteViewReferenceIsCurrent(
          view.viewReference,
          binding,
        ),
      ).toBe(false);
      expect(
        harness.api.resolveCodexOwnerRemoteViewReference(view.viewReference),
      ).toBeNull();
    },
  );

  it("invalidates an owner view for a user interrupt in the same clock millisecond", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
    const harness = createHarness();
    const view = await harness.read();
    expect(view.viewReference).not.toBeNull();
    harness.api.rememberCodexUserTurnAction("turn/interrupt", {
      threadId: "exact-thread",
    });
    expect(
      harness.api.resolveCodexOwnerRemoteViewReference(view.viewReference),
    ).toBeNull();
    expect(
      harness.state.startCodexOwnerContinuation(
        view.viewReference,
        "stale-operation",
      ),
    ).toMatchObject({ started: false });
    expect(
      harness.calls.mock.calls.every(([method]) =>
        ["thread/read", "thread/turns/list", "thread/items/list"].includes(
          method,
        ),
      ),
    ).toBe(true);
    const freshView = await harness.read();
    expect(freshView.kind).toBe("snapshot");
    expect(freshView.viewReference).not.toBeNull();
    expect(freshView.continueBlocker).toBeNull();
  });

  it("allows a fresh frozen-clock view after a prior action but rejects a later same-tick action", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
    const harness = createHarness();
    harness.api.rememberCodexUserTurnAction("turn/interrupt", {
      threadId: "exact-thread",
    });
    const view = await harness.read();
    expect(view.viewReference).not.toBeNull();
    expect(view.continueBlocker).toBeNull();
    expect(
      harness.api.resolveCodexOwnerRemoteViewReference(view.viewReference),
    ).not.toBeNull();
    harness.api.rememberCodexUserTurnAction("turn/interrupt", {
      threadId: "exact-thread",
    });
    expect(
      harness.api.resolveCodexOwnerRemoteViewReference(view.viewReference),
    ).toBeNull();
    expect(
      harness.state.startCodexOwnerContinuation(
        view.viewReference,
        "same-tick-operation",
      ),
    ).toMatchObject({ started: false });
    expect(
      harness.calls.mock.calls.every(([method]) =>
        ["thread/read", "thread/turns/list", "thread/items/list"].includes(
          method,
        ),
      ),
    ).toBe(true);
  });

  it("rejects a later action despite clock rollback and catch-up without sending", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-11-15T12:00:00Z");
    vi.setSystemTime(now);
    const harness = createHarness();
    const view = await harness.read();
    expect(view.viewReference).not.toBeNull();
    vi.setSystemTime(new Date(now.getTime() - 1000));
    harness.api.rememberCodexUserTurnAction("turn/interrupt", {
      threadId: "exact-thread",
    });
    vi.setSystemTime(now);
    expect(
      harness.api.resolveCodexOwnerRemoteViewReference(view.viewReference),
    ).toBeNull();
    expect(
      harness.state.startCodexOwnerContinuation(
        view.viewReference,
        "rollback-operation",
      ),
    ).toMatchObject({ started: false });
    expect(
      harness.calls.mock.calls.every(([method]) =>
        ["thread/read", "thread/turns/list", "thread/items/list"].includes(
          method,
        ),
      ),
    ).toBe(true);
  });

  it("does not mint a reference for a user action racing the read or without secure randomness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
    const harness = createHarness(undefined, { pauseRead: true });
    const pending = harness.read();
    await Promise.resolve();
    vi.advanceTimersByTime(1);
    harness.api.rememberCodexUserTurnAction("turn/start", {
      threadId: "exact-thread",
    });
    harness.releaseRead();
    expect(await pending).toMatchObject({
      kind: "snapshot",
      viewReference: null,
      continueBlocker: "user_action_changed",
    });
    expect(
      await createHarness(undefined, { noCrypto: true }).read(),
    ).toMatchObject({
      kind: "snapshot",
      viewReference: null,
      continueBlocker: "user_action_unavailable",
    });
  });

  it("does not publish credential-shaped model identities or arbitrary rejection details", async () => {
    for (const model of [
      "https://user:password@example.test/v1",
      "sk-fixture-sensitive",
      "model?token=fixture-sensitive",
    ]) {
      const view = await createHarness({ ...completedThread(), model }).read();
      expect(view.model).toBeNull();
      expect(view.viewReference).toBeNull();
      expect(JSON.stringify(view)).not.toContain("fixture-sensitive");
    }
  });
});

describe("owner bounded history source and native reference inspection", () => {
  it("inspects only finite current binding metadata for the internal native adapter", async () => {
    const harness = createHarness();
    const view = await harness.read();
    expect(
      harness.state.inspectCodexOwnerRemoteViewReference(view.viewReference),
    ).toEqual({
      threadId: "exact-thread",
      baseTurnId: "base-turn",
      expectedModel: "request-model",
      expectedModelProvider: "local-provider",
      runtimeGeneration: 1,
      observedAtMs: view.observedAtMs,
    });
    expect(JSON.stringify(view)).not.toContain("local-provider");
    harness.api.rememberCodexUserTurnAction("turn/interrupt", {
      threadId: "exact-thread",
    });
    expect(
      harness.state.inspectCodexOwnerRemoteViewReference(view.viewReference),
    ).toBeNull();
    expect(harness.state.inspectCodexOwnerRemoteViewReference({})).toBeNull();
  });

  it("refuses metadata responses which materialize turns despite includeTurns:false", async () => {
    const harness = createHarness();
    harness.setResponse({ thread: completedThread() });
    expect(await harness.read()).toEqual({
      kind: "unavailable",
      reason: "thread_unavailable",
    });
    expect(harness.calls).toHaveBeenCalledTimes(1);
  });

  it.each([
    { id: "base-turn", status: "completed", items: [], itemsView: "full" },
    {
      id: "base-turn",
      status: "completed",
      items: [{ type: "agentMessage", text: "raw-history-marker" }],
      itemsView: "notLoaded",
    },
    { id: "base-turn", status: "completed", items: [] },
  ])(
    "refuses a turn page which did not honor metadata-only source bounds",
    async (turn) => {
      const harness = createHarness();
      harness.setPageResponse("thread/turns/list", {
        data: [turn],
        nextCursor: null,
      });
      const view = await harness.read();
      expect(view).toEqual({
        kind: "unavailable",
        reason: "thread_unavailable",
      });
      expect(harness.calls).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(view)).not.toContain("raw-history-marker");
    },
  );

  it.each(["thread/turns/list", "thread/items/list"])(
    "refuses unsupported bounded %s without a full-history fallback",
    async (method) => {
      const harness = createHarness();
      harness.setPageResponse(method, { thread: completedThread() });
      expect(await harness.read()).toEqual({
        kind: "unavailable",
        reason: "thread_unavailable",
      });
      expect(
        harness.calls.mock.calls.every(
          ([name, params]) =>
            name !== "thread/read" ||
            (params as { includeTurns: boolean }).includeTurns === false,
        ),
      ).toBe(true);
      expect(
        harness.calls.mock.calls.some(
          ([name]) => name === "thread/resume" || name === "turn/start",
        ),
      ).toBe(false);
    },
  );

  it.each(["thread/turns/list", "thread/items/list"])(
    "rejects a %s response which ignores the requested page size",
    async (method) => {
      const harness = createHarness();
      harness.setPageResponse(method, {
        data: Array.from(
          { length: method === "thread/turns/list" ? 21 : 41 },
          () => ({ id: "unbounded-source" }),
        ),
        nextCursor: null,
      });
      expect(await harness.read()).toEqual({
        kind: "unavailable",
        reason: "thread_unavailable",
      });
    },
  );

  it.each([undefined, "", {}, "x".repeat(4097)])(
    "requires a bounded canonical page cursor: %j",
    async (nextCursor) => {
      const harness = createHarness();
      harness.setPageResponse("thread/turns/list", { data: [], nextCursor });
      expect(await harness.read()).toEqual({
        kind: "unavailable",
        reason: "thread_unavailable",
      });
    },
  );

  it("refuses duplicate turn IDs and item entries attributed to another turn", async () => {
    const duplicated = createHarness();
    duplicated.setPageResponse("thread/turns/list", {
      data: [0, 1].map(() => ({
        id: "same-turn",
        status: "completed",
        itemsView: "notLoaded",
        items: [],
      })),
      nextCursor: null,
    });
    expect((await duplicated.read()).kind).toBe("unavailable");
    const foreign = createHarness();
    foreign.setPageResponse("thread/items/list", {
      data: [
        {
          turnId: "other-turn",
          item: { type: "agentMessage", text: "foreign-source-marker" },
        },
      ],
      nextCursor: null,
    });
    const view = await foreign.read();
    expect(view).toEqual({ kind: "unavailable", reason: "thread_unavailable" });
    expect(JSON.stringify(view)).not.toContain("foreign-source-marker");
  });

  it.each(["cursor", "page-entry", "item"] as const)(
    "does not invoke getter-backed bounded page fields: %s",
    async (field) => {
      const harness = createHarness();
      const getter = vi.fn(() => "sensitive-source-marker");
      if (field === "cursor") {
        const page = { data: [] };
        Object.defineProperty(page, "nextCursor", { get: getter });
        harness.setPageResponse("thread/turns/list", page);
      } else if (field === "page-entry") {
        const data: unknown[] = [];
        Object.defineProperty(data, "0", { get: getter });
        harness.setPageResponse("thread/turns/list", {
          data,
          nextCursor: null,
        });
      } else {
        const entry = { turnId: "base-turn" };
        Object.defineProperty(entry, "item", { get: getter });
        harness.setPageResponse("thread/items/list", {
          data: [entry],
          nextCursor: null,
        });
      }
      expect((await harness.read()).kind).toBe("unavailable");
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it("rechecks metadata and latest-turn identity after reading the bounded items", async () => {
    const metadata = createHarness();
    let reads = 0;
    metadata.setPageResponse("thread/read", () => ({
      thread: {
        ...completedThread(),
        modelProvider: ++reads === 1 ? "local-provider" : "new-provider",
      },
    }));
    expect((await metadata.read()).kind).toBe("unavailable");
    const latest = createHarness();
    let pages = 0;
    latest.setPageResponse("thread/turns/list", () => ({
      data: [
        { id: ++pages === 1 ? "base-turn" : "newer-turn", status: "completed" },
      ],
      nextCursor: null,
    }));
    expect((await latest.read()).kind).toBe("unavailable");
  });

  it("rechecks ownership after an awaited item page", async () => {
    const harness = createHarness();
    harness.setPageResponse("thread/items/list", () => {
      harness.replaceRuntime();
      return { data: [], nextCursor: null };
    });
    expect(await harness.read()).toEqual({
      kind: "unavailable",
      reason: "ownership_changed",
    });
  });

  it("bounds the whole multi-page read and stops scheduling source work after expiry", async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      ...completedThread(),
      turns: Array.from({ length: 20 }, (_, index) => ({
        id: `turn-${index}`,
        status: "completed",
        items: [],
      })),
    });
    harness.setPageResponse("thread/items/list", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return { data: [], nextCursor: null };
    });
    const pending = harness.read();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({
      kind: "unavailable",
      reason: "thread_unavailable",
    });
    const callsAtExpiry = harness.calls.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(harness.calls).toHaveBeenCalledTimes(callsAtExpiry);
  });
});

describe("owner bounded explicit conversation choices", () => {
  it("lists only bounded IDs/titles without exposing previews, paths or current-window claims", async () => {
    const harness = createHarness({
      ...completedThread(),
      name: "Chosen conversation",
      preview: "raw-preview-marker",
      cwd: "private-path-marker",
    });
    expect(await harness.state.listCodexOwnerRemoteConversations()).toEqual({
      kind: "conversations",
      currentDisplay: "unavailable",
      conversations: [
        { threadId: "exact-thread", title: "Chosen conversation" },
      ],
      truncated: false,
    });
    expect(harness.calls.mock.calls).toEqual([
      [
        "thread/list",
        {
          cursor: null,
          limit: 20,
          sortKey: "updated_at",
          sortDirection: "desc",
          archived: false,
          sourceKinds: ["appServer"],
        },
      ],
    ]);
  });

  it("bounds and normalizes title text without invoking coercion", async () => {
    const harness = createHarness();
    harness.setPageResponse("thread/list", {
      data: [
        { id: "a", name: "line\n" + "x".repeat(300) },
        { id: "b", name: null },
        { id: "c" },
      ],
      nextCursor: "more",
    });
    const choices = await harness.state.listCodexOwnerRemoteConversations();
    expect(choices.truncated).toBe(true);
    expect(choices.conversations).toEqual([
      { threadId: "a", title: "line " + "x".repeat(155) },
      { threadId: "b", title: null },
      { threadId: "c", title: null },
    ]);
  });

  it.each(["name", "id", "preview"] as const)(
    "never reads nonallowlisted or accessor-backed conversation metadata: %s",
    async (field) => {
      const getter = vi.fn(() => "raw-metadata-marker");
      const entry = { id: "exact-thread", name: "Safe title" };
      Object.defineProperty(entry, field, { get: getter });
      const harness = createHarness();
      harness.setPageResponse("thread/list", {
        data: [entry],
        nextCursor: null,
      });
      const result = await harness.state.listCodexOwnerRemoteConversations();
      expect(result.kind).toBe(
        field === "preview" ? "conversations" : "unavailable",
      );
      expect(getter).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("raw-metadata-marker");
    },
  );

  it.each(
    [
      [],
      Array.from({ length: 21 }, () => ({ id: "overflow", title: null })),
      [{ id: "duplicate" }, { id: "duplicate" }],
      [{ id: "id with whitespace" }],
      [{ id: "object-title", name: {} }],
    ].map((data) => ({ data })),
  )(
    "rejects malformed/unsupported/unbounded conversation pages without fallback",
    async ({ data }) => {
      const harness = createHarness();
      harness.setPageResponse(
        "thread/list",
        data.length ? { data, nextCursor: null } : { threads: [] },
      );
      expect(await harness.state.listCodexOwnerRemoteConversations()).toEqual({
        kind: "unavailable",
        reason: "conversations_unavailable",
      });
      expect(harness.calls).toHaveBeenCalledTimes(1);
    },
  );

  it("coalesces choices and shares the source-read concurrency budget with views", async () => {
    const harness = createHarness(undefined, { pauseRead: true });
    const first = harness.state.listCodexOwnerRemoteConversations();
    const second = harness.state.listCodexOwnerRemoteConversations();
    const reads = [
      harness.read("one"),
      harness.read("two"),
      harness.read("three"),
    ];
    expect(await harness.read("four")).toEqual({
      kind: "unavailable",
      reason: "read_busy",
    });
    expect(harness.calls).toHaveBeenCalledTimes(4);
    harness.releaseRead();
    expect(await first).toEqual(await second);
    await Promise.all(reads);
  });

  it("rechecks runtime ownership after a choices read and keeps failures finite", async () => {
    const harness = createHarness();
    harness.setPageResponse("thread/list", () => {
      harness.replaceRuntime();
      return { data: [], nextCursor: null };
    });
    expect(await harness.state.listCodexOwnerRemoteConversations()).toEqual({
      kind: "unavailable",
      reason: "ownership_changed",
    });
  });
});
