import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const resource = (name: string) =>
  readFileSync(
    path.resolve(process.cwd(), "src-tauri/src/resources/codex_desktop", name),
    "utf8",
  );
const renderer = resource("renderer_runtime.js");
const reactStart = renderer.indexOf("  const reactRootValue = ");
const reactEnd = renderer.indexOf(
  "  const installReactRootObserver = ",
  reactStart,
);
if (reactStart < 0 || reactEnd < 0)
  throw new Error("React discovery resource boundary missing");
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
const createClient = () => ({
  hostId: "local",
  async sendRequest() {
    return {};
  },
  getCompatibleThreadSortKey() {},
  supportsPaginatedThreadHistory() {},
});
const createHarness = (client = createClient()) => {
  const manager = { requestClient: client };
  const fiber = { memoizedState: { manager } };
  let root = { __reactContainerFixture: fiber, childNodes: [] };
  const state: Record<string, unknown> = {
    appServerClients: [],
    moduleAppServerClientOwners: new Map(),
    reactAppServerClientOwners: new Map(),
    pendingReactNodes: new Set(),
    historyManagerCandidates: new Set(),
  };
  const patchRequestClient = (
    value: ReturnType<typeof createClient> & Record<string, unknown>,
  ) => {
    if (!value.__ccSwitchOriginalSendRequest) {
      const original = value.sendRequest.bind(value);
      const wrapper = async () => original();
      Object.defineProperty(wrapper, "__ccSwitchRequestHook", {
        value: Object.freeze({
          client: value,
          original,
          version: "standalone",
        }),
      });
      value.__ccSwitchOriginalSendRequest = original;
      value.sendRequest = wrapper;
      value.__ccSwitchModelRequestPatch = "standalone";
    }
    const clients = state.appServerClients as unknown[];
    if (!clients.includes(value)) clients.push(value);
    return true;
  };
  const api = new Function(
    "state",
    "document",
    "window",
    "patchRequestClient",
    "patchCodexModelReasoningQueryCache",
    "recordFailure",
    "installationIsCurrent",
    "localStorage",
    "installAppServerPatch",
    `${resource("client_discovery.js")}\n${renderer.slice(reactStart, reactEnd)}\n${continuation}\nreturn { patchReactAppServerClients, patchAppServerModuleClients, patchCodexScopedAppServerClients, current: codexContinuationClientIsCurrent };`,
  )(
    state,
    { getElementById: () => root, body: null, documentElement: null },
    {},
    patchRequestClient,
    () => false,
    () => {},
    () => true,
    { getItem: () => null, setItem() {} },
    async () => {},
  ) as {
    patchReactAppServerClients: (
      nodes: object[],
      caches: Set<object>,
    ) => Promise<number>;
    patchAppServerModuleClients: (module: object) => number;
    patchCodexScopedAppServerClients: (module: object) => Promise<number>;
    current: (client: object) => boolean;
  };
  return {
    state,
    api,
    manager,
    fiber,
    client,
    scan: () => api.patchReactAppServerClients([root], new Set()),
    replaceRoot: () => {
      root = {
        __reactContainerFixture: {
          memoizedState: { manager: { requestClient: createClient() } },
        },
        childNodes: [],
      };
    },
  };
};

describe("Codex Desktop live request-client source ownership", () => {
  it("keeps broad React fallback available but revokes its client when the live root is replaced", async () => {
    const h = createHarness();
    await h.scan();
    expect(h.api.current(h.client)).toBe(true);
    h.replaceRoot();
    expect(h.api.current(h.client)).toBe(false);
  });

  it("revokes a broad React manager's replaced client before the next heartbeat", async () => {
    const h = createHarness();
    await h.scan();
    expect(h.api.current(h.client)).toBe(true);
    const replacement = createClient();
    h.manager.requestClient = replacement;
    expect(h.api.current(h.client)).toBe(false);
    await h.scan();
    expect(h.api.current(replacement)).toBe(true);
    expect(h.state.appServerClients).toEqual([replacement]);
  });

  it("does not authorize a historical alternate Fiber's request client", async () => {
    const h = createHarness();
    const historical = createClient();
    Object.assign(h.fiber, {
      alternate: { memoizedState: { manager: { requestClient: historical } } },
    });
    await h.scan();
    expect(h.api.current(h.client)).toBe(true);
    expect(h.api.current(historical)).toBe(false);
  });

  it("rechecks a scoped registry manager before the next ownership scan", async () => {
    const h = createHarness();
    const queryClient = {
      getQueryCache: () => ({}),
      getQueryData() {},
      setQueryData() {},
    };
    const scope = {
      chain: {},
      node: { queryClient },
      queryClient,
      get: (_host: string) => h.manager,
      set() {},
      watch() {},
    };
    type Scope = typeof scope;
    class Registry {
      scope: Scope;
      constructor(scope: Scope) {
        this.scope = scope;
      }
      getForHostId(host: string) {
        return this.scope.get(host);
      }
      getAll() {
        return [];
      }
      getImplForHostId() {
        return null;
      }
    }
    Object.assign(h.fiber.memoizedState, { scope });
    await h.api.patchCodexScopedAppServerClients({ Registry });
    expect(h.api.current(h.client)).toBe(true);
    h.manager.requestClient = createClient();
    expect(h.api.current(h.client)).toBe(false);
  });

  it("checks the exact legacy signal value before the next module discovery pass", () => {
    const h = createHarness();
    let current = h.client;
    const module = { signal: { get: () => current } };
    h.api.patchAppServerModuleClients(module);
    expect(h.api.current(h.client)).toBe(true);
    current = createClient();
    expect(h.api.current(h.client)).toBe(false);
    h.api.patchAppServerModuleClients(module);
    expect(h.api.current(current)).toBe(true);
    expect(h.state.appServerClients).toEqual([current]);
  });

  it("revokes an overwritten module data export without waiting for discovery", () => {
    const h = createHarness();
    const module = { client: h.client };
    h.api.patchAppServerModuleClients(module);
    expect(h.api.current(h.client)).toBe(true);
    module.client = createClient();
    expect(h.api.current(h.client)).toBe(false);
  });
});
