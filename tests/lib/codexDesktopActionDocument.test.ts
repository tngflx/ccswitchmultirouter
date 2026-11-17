import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const actionKey = "ccswitch-codex-user-turn-actions-v1";
const continuation = readFileSync(
  path.resolve(
    process.cwd(),
    "src-tauri/src/resources/codex_desktop/continuation.js",
  ),
  "utf8",
).replace(
  "__CCSWITCH_TERMINAL_ERROR_POLICY__",
  readFileSync(
    path.resolve(
      process.cwd(),
      "src-tauri/src/proxy/providers/terminal_error_policy.json",
    ),
    "utf8",
  ),
);

type Action = { method: string; atMs: number; actionId?: string | null };
type ActionDocument = {
  schemaVersion: number;
  revision: string;
  actions: Record<string, Action>;
};
type ActionState = {
  runtimeGeneration: number;
  codexUserTurnActions?: Record<string, Action>;
  codexUserTurnActionPersistenceFailed?: boolean;
};
type WriteMode =
  "normal" | "throw-before" | "throw-after" | "partial" | "silent";
let randomCounter = 0;
// Deterministic test-only Web Crypto adapter. Production uses only browser CSPRNG.
const testCrypto = () => ({
  getRandomValues(bytes: Uint8Array) {
    bytes.fill(0);
    const counter = ++randomCounter;
    bytes[0] = (counter >>> 24) & 255;
    bytes[1] = (counter >>> 16) & 255;
    bytes[2] = (counter >>> 8) & 255;
    bytes[3] = counter & 255;
    return bytes;
  },
});
const createStore = (raw: unknown = null) => ({
  raw,
  writes: [] as string[],
  mode: "normal" as WriteMode,
  nextRead: undefined as { value: unknown } | undefined,
  beforeWrite: undefined as ((value: string) => void) | undefined,
  getItem(key: string) {
    if (key !== actionKey) return null;
    if (this.nextRead) {
      const value = this.nextRead.value;
      this.nextRead = undefined;
      return value;
    }
    return this.raw;
  },
  setItem(key: string, value: string) {
    if (key !== actionKey) return;
    this.writes.push(value);
    this.beforeWrite?.(value);
    if (this.mode === "throw-before")
      throw new Error("redacted-fixture-write-failure");
    if (this.mode === "silent") return;
    this.raw = this.mode === "partial" ? value.slice(0, -1) : value;
    if (this.mode === "throw-after")
      throw new Error("redacted-fixture-write-failure");
  },
});
type Store = ReturnType<typeof createStore>;
type API = {
  initialize: () => boolean;
  remember: (method: unknown, params: unknown) => void;
  capture: (threadId: unknown) => Record<string, unknown> | null;
  current: (threadId: unknown, evidence: unknown) => boolean;
  newer: (threadId: string, atMs: number) => boolean;
};
const createHarness = (
  options: {
    raw?: unknown;
    store?: Store;
    state?: ActionState;
    local?: Record<string, Action>;
    noCrypto?: boolean;
  } = {},
) => {
  const store = options.store ?? createStore(options.raw ?? null);
  const state = options.state ?? { runtimeGeneration: 1 };
  if (options.local) state.codexUserTurnActions = options.local;
  const failures = vi.fn();
  const api = new Function(
    "state",
    "localStorage",
    "recordFailure",
    "installationIsCurrent",
    "crypto",
    `${continuation}\nreturn {
      initialize: initializeCodexContinuationActionDocument,
      remember: rememberCodexUserTurnAction,
      capture: captureCodexOwnerUserActionEvidence,
      current: codexOwnerUserActionEvidenceIsCurrent,
      newer: codexContinuationHasNewerUserAction,
    };`,
  )(
    state,
    store,
    failures,
    () => true,
    options.noCrypto ? undefined : testCrypto(),
  ) as API;
  return {
    state,
    store,
    api,
    failures,
    document: () => JSON.parse(store.raw as string) as ActionDocument,
  };
};
const validAction = (atMs = 1000, method = "turn/interrupt"): Action => ({
  method,
  atMs,
});
const revision = "1".repeat(32);
const actionId = "2".repeat(32);
const envelope = (actions: Record<string, Action> = {}) => ({
  schemaVersion: 2,
  revision,
  actions,
});
const oldWriter = (snapshot: string | null, threadId: string, atMs: number) => {
  const actions = JSON.parse(snapshot ?? "{}");
  const cutoff = atMs - 24 * 60 * 60 * 1000;
  for (const [id, existing] of Object.entries(actions)) {
    if (Number((existing as { atMs?: number } | null)?.atMs || 0) < cutoff)
      delete actions[id];
  }
  actions[threadId] = { method: "turn/interrupt", atMs };
  return JSON.stringify(actions);
};

afterEach(() => vi.restoreAllMocks());

describe("canonical Codex user-action document installation upgrade", () => {
  it("migrates strictly valid legacy records once, preserving method/time/existing identities", () => {
    const harness = createHarness({
      raw: JSON.stringify({
        first: validAction(),
        second: { ...validAction(2000, "turn/start"), actionId },
      }),
    });
    const document = harness.document();
    expect(document).toMatchObject({
      schemaVersion: 2,
      actions: {
        first: { method: "turn/interrupt", atMs: 1000 },
        second: { method: "turn/start", atMs: 2000, actionId },
      },
    });
    expect(document.revision).toMatch(/^[a-f0-9]{32}$/);
    expect(document.actions.first.actionId).toMatch(/^[a-f0-9]{32}$/);
    expect(Object.isFrozen(harness.state.codexUserTurnActions)).toBe(true);
    expect(Object.isFrozen(harness.state.codexUserTurnActions?.first)).toBe(
      true,
    );
    expect(harness.state.codexUserTurnActions?.first).toEqual(
      document.actions.first,
    );
    expect(harness.api.capture("first")).not.toBeNull();
    const raw = harness.store.raw;
    expect(harness.api.initialize()).toBe(true);
    expect(harness.api.initialize()).toBe(true);
    expect(harness.store.writes).toHaveLength(1);
    expect(harness.store.raw).toBe(raw);
  });

  it("installs an absent store as a valid empty v2 document before owner evidence exists", () => {
    const harness = createHarness();
    expect(harness.document()).toEqual({
      schemaVersion: 2,
      revision: expect.stringMatching(/^[a-f0-9]{32}$/),
      actions: {},
    });
    expect(harness.api.capture("first")).toMatchObject({
      documentRevision: harness.document().revision,
      runtimeGeneration: 1,
      localRecord: null,
      persistedActionId: null,
    });
  });

  it("accepts an existing strict v2 document without rewriting identities on a second installation", () => {
    const store = createStore(
      JSON.stringify(envelope({ first: { ...validAction(), actionId } })),
    );
    const first = createHarness({ store });
    const original = first.api.capture("first");
    first.state.runtimeGeneration += 1;
    const second = createHarness({ store, state: first.state });
    expect(store.writes).toHaveLength(0);
    expect(second.document()).toEqual(
      envelope({ first: { ...validAction(), actionId } }),
    );
    expect(first.api.current("first", original)).toBe(false);
    expect(second.api.current("first", original)).toBe(false);
    expect(second.api.capture("first")).not.toBeNull();
  });

  it("invalidates pre-upgrade generation evidence before the explicit migration write", () => {
    const first = createHarness();
    const evidence = first.api.capture("first");
    first.store.raw = JSON.stringify({ first: validAction() });
    first.state.runtimeGeneration += 1;
    const duringWrite = vi.fn(() =>
      expect(first.api.current("first", evidence)).toBe(false),
    );
    first.store.beforeWrite = duringWrite;
    const upgraded = createHarness({ store: first.store, state: first.state });
    expect(duringWrite).toHaveBeenCalledTimes(1);
    expect(upgraded.api.current("first", evidence)).toBe(false);
    expect(upgraded.api.capture("first")).not.toBeNull();
  });

  it.each([
    "{",
    "[]",
    "42",
    "null",
    JSON.stringify({ schemaVersion: 3, revision, actions: {} }),
    JSON.stringify({ schemaVersion: 2, revision }),
    JSON.stringify({ schemaVersion: 2, revision: "bad", actions: {} }),
    JSON.stringify({ schemaVersion: 2, revision, actions: {}, extra: true }),
    JSON.stringify({ actions: validAction() }),
    JSON.stringify({ first: null }),
    JSON.stringify({ first: { method: "unknown", atMs: 1000 } }),
    JSON.stringify({ first: { method: "turn/start", atMs: "1000" } }),
    JSON.stringify({ first: { method: "turn/start", atMs: 0 } }),
    JSON.stringify({ first: { method: "turn/start", atMs: 1.5 } }),
    JSON.stringify({
      first: { method: "turn/start", atMs: 1000, actionId: null },
    }),
    JSON.stringify({
      first: { method: "turn/start", atMs: 1000, unknown: "redacted-fixture" },
    }),
    JSON.stringify(envelope({ first: validAction() })),
  ])(
    "never replaces malformed, partial or future persisted evidence during installation",
    (raw) => {
      const harness = createHarness({ raw });
      expect(harness.store.raw).toBe(raw);
      expect(harness.store.writes).toHaveLength(0);
      expect(harness.api.capture("first")).toBeNull();
      expect(harness.api.initialize()).toBe(false);
      expect(harness.store.writes).toHaveLength(0);
      expect(
        harness.failures.mock.calls.map(([error]) => (error as Error).message),
      ).not.toContain("redacted-fixture");
    },
  );

  it.each(["throw-before", "throw-after", "partial", "silent"] as const)(
    "keeps a failed or unconfirmed %s migration owner-disabled without read retries",
    (mode) => {
      const raw = JSON.stringify({ first: validAction() });
      const store = createStore(raw);
      store.mode = mode;
      const harness = createHarness({ store });
      expect(harness.api.capture("first")).toBeNull();
      const after = store.raw;
      store.mode = "normal";
      expect(harness.api.capture("first")).toBeNull();
      expect(harness.api.initialize()).toBe(false);
      expect(store.raw).toBe(after);
      expect(store.writes).toHaveLength(1);
      if (mode === "throw-before" || mode === "silent") {
        harness.state.runtimeGeneration += 1;
        const retry = createHarness({ store, state: harness.state });
        expect(retry.api.capture("first")).not.toBeNull();
        expect(store.writes).toHaveLength(2);
      }
    },
  );

  it("resumes a crash after the migration write from its valid v2 document without reassigning nonces", () => {
    const store = createStore(JSON.stringify({ first: validAction() }));
    store.mode = "throw-after";
    const interrupted = createHarness({ store });
    const committed = interrupted.document();
    expect(interrupted.api.capture("first")).toBeNull();
    store.mode = "normal";
    interrupted.state.runtimeGeneration += 1;
    const recovered = createHarness({ store, state: interrupted.state });
    expect(recovered.document()).toEqual(committed);
    expect(store.writes).toHaveLength(1);
    expect(recovered.api.capture("first")).not.toBeNull();
  });

  it("does not invoke a local projection accessor, write migration data, or ignore it in automatic recovery", () => {
    const getter = vi.fn(() => ({ first: validAction(2000) }));
    const state: ActionState = { runtimeGeneration: 1 };
    Object.defineProperty(state, "codexUserTurnActions", {
      get: getter,
      configurable: true,
    });
    const harness = createHarness({
      state,
      raw: JSON.stringify({ first: validAction() }),
    });
    expect(harness.api.capture("first")).toBeNull();
    expect(harness.store.writes).toHaveLength(0);
    expect(() => harness.api.newer("first", 1500)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not invoke accessor-backed local record proof or coerce a reflected store result", () => {
    const getter = vi.fn(() => "turn/interrupt");
    const local = { first: { atMs: 2000 } as Action };
    Object.defineProperty(local.first, "method", { get: getter });
    const reflected = Object.defineProperty({}, "toString", { get: getter });
    const first = createHarness({
      local,
      raw: JSON.stringify({ first: validAction() }),
    });
    const second = createHarness({ raw: reflected });
    expect(first.store.writes).toHaveLength(0);
    expect(second.store.writes).toHaveLength(0);
    expect(first.api.capture("first")).toBeNull();
    expect(second.api.capture("first")).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("action document revision prevents legacy and current-writer ABA", () => {
  it.each([1000, Date.now()] as const)(
    "rejects an old HEAD writer which prunes or appends envelope fields at %s",
    (now) => {
      const harness = createHarness();
      const evidence = harness.api.capture("first");
      const before = harness.store.raw as string;
      harness.store.raw = oldWriter(before, "other-thread", now);
      expect(harness.api.current("first", evidence)).toBe(false);
      expect(harness.api.capture("first")).toBeNull();
      const raw = harness.store.raw;
      const writes = harness.store.writes.length;
      expect(harness.api.initialize()).toBe(true);
      expect(harness.store.raw).toBe(raw);
      expect(harness.store.writes).toHaveLength(writes);
    },
  );

  it("does not repair a late legacy clobber in an owner read or a new action write", () => {
    const harness = createHarness();
    harness.store.raw = JSON.stringify({ first: validAction() });
    const raw = harness.store.raw;
    const writes = harness.store.writes.length;
    expect(harness.api.capture("first")).toBeNull();
    expect(() => harness.api.newer("first", 999)).toThrow();
    harness.api.remember("turn/interrupt", { threadId: "first" });
    expect(harness.store.raw).toBe(raw);
    expect(harness.store.writes).toHaveLength(writes);
    expect(harness.state.codexUserTurnActionPersistenceFailed).toBe(true);
    expect(() => harness.api.newer("first", Date.now())).toThrow();
  });

  it("keeps an old read-before-migration/write-after-action ABA from restoring a reference", () => {
    const oldSnapshot = JSON.stringify({});
    const harness = createHarness({ raw: oldSnapshot });
    const evidence = harness.api.capture("first");
    harness.api.remember("turn/interrupt", { threadId: "first" });
    expect(harness.api.current("first", evidence)).toBe(false);
    harness.store.raw = oldWriter(oldSnapshot, "other-thread", Date.now());
    expect(harness.api.current("first", evidence)).toBe(false);
    expect(harness.api.capture("first")).toBeNull();
  });

  it("generates a new revision at a stale current writer's write rather than restoring its read revision", () => {
    const first = createHarness();
    const staleSnapshot = first.store.raw;
    const evidence = first.api.capture("first");
    const originalRevision = first.document().revision;
    const sibling = createHarness({ store: first.store });
    sibling.api.remember("turn/interrupt", { threadId: "first" });
    const actionRevision = sibling.document().revision;
    expect(first.api.current("first", evidence)).toBe(false);
    first.store.nextRead = { value: staleSnapshot };
    first.api.remember("turn/interrupt", { threadId: "other-thread" });
    const restored = first.document();
    expect(restored.actions.first).toBeUndefined();
    expect(restored.revision).not.toBe(originalRevision);
    expect(restored.revision).not.toBe(actionRevision);
    expect(first.api.current("first", evidence)).toBe(false);
    expect(first.api.capture("first")).not.toBeNull();
  });

  it("changes the revision even for a same-tick action on an unrelated thread", () => {
    vi.spyOn(Date, "now").mockReturnValue(100_000);
    const harness = createHarness();
    const evidence = harness.api.capture("first");
    const revisionBefore = harness.document().revision;
    harness.api.remember("turn/interrupt", { threadId: "other-thread" });
    expect(harness.document().revision).not.toBe(revisionBefore);
    expect(harness.api.current("first", evidence)).toBe(false);
  });

  it("keeps old-generation references invalid across same-state reinstall and current-writer actions", () => {
    const first = createHarness();
    const evidence = first.api.capture("first");
    first.state.runtimeGeneration += 1;
    const next = createHarness({ store: first.store, state: first.state });
    expect(first.api.current("first", evidence)).toBe(false);
    expect(next.api.current("first", evidence)).toBe(false);
    first.api.remember("turn/interrupt", { threadId: "other-thread" });
    expect(next.document().actions["other-thread"].actionId).toMatch(
      /^[a-f0-9]{32}$/,
    );
    expect(next.api.capture("first")).not.toBeNull();
  });
});

describe("automatic compatibility and honest action persistence uncertainty", () => {
  it.each([false, true])(
    "retains the exact automatic timestamp > cutoff policy when never-v2 legacy compatibility is %s",
    (noCrypto) => {
      const harness = createHarness({
        raw: JSON.stringify({ first: validAction(2000) }),
        noCrypto,
      });
      expect(harness.api.newer("first", 1999)).toBe(true);
      expect(harness.api.newer("first", 2000)).toBe(false);
      expect(harness.api.newer("first", 2001)).toBe(false);
      if (noCrypto) {
        expect(harness.store.writes).toHaveLength(0);
        harness.store.raw = JSON.stringify({ first: validAction(3000) });
        expect(harness.api.capture("first")).toBeNull();
        expect(harness.api.newer("first", 2999)).toBe(true);
        expect(harness.api.newer("first", 3000)).toBe(false);
      } else {
        expect(harness.document().schemaVersion).toBe(2);
      }
    },
  );

  it.each([null, "{}", JSON.stringify({ other: validAction(3000) })])(
    "refuses automatic legacy fallback after a positively established v2 document is clobbered to %s",
    (clobbered) => {
      const harness = createHarness({
        raw: JSON.stringify({ first: validAction(2000) }),
      });
      expect(harness.document().schemaVersion).toBe(2);
      const writes = harness.store.writes.length;
      harness.store.raw = clobbered;
      expect(harness.api.capture("first")).toBeNull();
      expect(() => harness.api.newer("first", 3000)).toThrow();
      expect(harness.store.writes).toHaveLength(writes);
    },
  );

  it("keeps automatic legacy fallback disabled after observing valid v2 without secure randomness", () => {
    const harness = createHarness({
      raw: JSON.stringify(envelope()),
      noCrypto: true,
    });
    expect(harness.api.newer("first", 2000)).toBe(false);
    harness.store.raw = JSON.stringify({});
    expect(() => harness.api.newer("first", 2000)).toThrow();
    expect(harness.store.writes).toHaveLength(0);
  });

  it("preserves a newer unpersisted local stop while upgrading an older persisted legacy action", () => {
    const harness = createHarness({
      raw: JSON.stringify({ first: validAction(1000, "turn/start") }),
      local: { first: validAction(2000) },
    });
    expect(harness.document().actions.first).toMatchObject({
      method: "turn/start",
      atMs: 1000,
    });
    expect(harness.state.codexUserTurnActions?.first).toMatchObject({
      method: "turn/interrupt",
      atMs: 2000,
      actionId: expect.stringMatching(/^[a-f0-9]{32}$/),
    });
    expect(harness.api.newer("first", 1500)).toBe(true);
    expect(harness.api.newer("first", 2000)).toBe(false);
  });

  it("retains automatic compatibility without secure randomness before any action, but never issues owner evidence", () => {
    const harness = createHarness({ noCrypto: true });
    expect(harness.api.capture("first")).toBeNull();
    expect(harness.api.newer("first", 1000)).toBe(false);
    expect(harness.store.writes).toHaveLength(0);
    harness.api.remember("turn/interrupt", { threadId: "first" });
    expect(harness.store.writes).toHaveLength(0);
    expect(harness.state.codexUserTurnActions?.first.atMs).toBeGreaterThan(
      1000,
    );
    expect(harness.state.codexUserTurnActionPersistenceFailed).toBe(true);
    harness.state.codexUserTurnActions = {};
    expect(() => harness.api.newer("first", Date.now())).toThrow(/uncertain/);
    harness.state.runtimeGeneration += 1;
    const reinstalled = createHarness({
      store: harness.store,
      state: harness.state,
    });
    expect(() => reinstalled.api.newer("first", Date.now())).toThrow(
      /uncertain/,
    );
    expect(reinstalled.api.capture("first")).toBeNull();
  });

  it.each(["throw-before", "throw-after", "partial", "silent"] as const)(
    "blocks automatic and owner sends after an observed action's %s persistence failure",
    (mode) => {
      const harness = createHarness();
      const evidence = harness.api.capture("first");
      harness.store.mode = mode;
      harness.api.remember("turn/interrupt", { threadId: "first" });
      expect(harness.state.codexUserTurnActionPersistenceFailed).toBe(true);
      expect(harness.api.current("first", evidence)).toBe(false);
      expect(harness.api.capture("first")).toBeNull();
      expect(() => harness.api.newer("first", Date.now())).toThrow(/uncertain/);
      harness.store.mode = "normal";
      if (mode !== "partial")
        harness.api.remember("turn/start", { threadId: "other-thread" });
      expect(() => harness.api.newer("first", Date.now())).toThrow(/uncertain/);
      harness.state.codexUserTurnActions = {};
      harness.state.runtimeGeneration += 1;
      const reinstalled = createHarness({
        store: harness.store,
        state: harness.state,
      });
      expect(reinstalled.api.capture("first")).toBeNull();
      expect(() => reinstalled.api.newer("first", Date.now())).toThrow(
        /uncertain/,
      );
    },
  );

  it("does not invoke an accessor or accept a malformed persistence capability flag", () => {
    const getter = vi.fn(() => false);
    const state: ActionState = { runtimeGeneration: 1 };
    Object.defineProperty(state, "codexUserTurnActionPersistenceFailed", {
      get: getter,
    });
    const harness = createHarness({ state });
    expect(harness.api.capture("first")).toBeNull();
    expect(harness.store.writes).toHaveLength(0);
    expect(() => harness.api.newer("first", 1000)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it("keeps same-tick and rollback action identities different regardless of timestamp ordering", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const harness = createHarness();
    harness.api.remember("turn/interrupt", { threadId: "first" });
    const first = harness.api.capture("first");
    expect(first).not.toBeNull();
    harness.api.remember("turn/interrupt", { threadId: "first" });
    expect(harness.api.current("first", first)).toBe(false);
    const second = harness.api.capture("first");
    clock.mockReturnValue(99_000);
    harness.api.remember("turn/interrupt", { threadId: "first" });
    clock.mockReturnValue(100_000);
    expect(harness.api.current("first", second)).toBe(false);
    expect(harness.api.newer("first", 99_000)).toBe(false);
  });
});
