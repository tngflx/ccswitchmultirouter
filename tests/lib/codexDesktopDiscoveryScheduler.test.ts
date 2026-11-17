import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const resource = (name: string) =>
  readFileSync(
    path.resolve(process.cwd(), "src-tauri/src/resources/codex_desktop", name),
    "utf8",
  );
const renderer = resource("renderer_runtime.js");
const start = renderer.indexOf("  const yieldReactDiscovery = ");
const end = renderer.indexOf("  const monotonicNow = ", start);
if (start < 0 || end < 0)
  throw new Error("Production discovery yield helper missing");
const helper = renderer.slice(start, end);
const discovery = resource("client_discovery.js");

const createPlatform = (
  options: {
    scheduler?: "resolve" | "reject";
    channel?: boolean;
    throwPost?: boolean;
    idle?: boolean;
    taskMs?: number;
  } = {},
) => {
  const clock = { now: 0, commits: 0, nextCommit: 1000, onCommit: () => {} };
  // Deterministic host-task clock: callbacks advance virtual time and execute
  // recurring committed-root changes before resuming the awaiting scanner.
  const task = (delay: number, callback: () => void) => {
    void Promise.resolve().then(() => {
      clock.now += delay;
      while (clock.nextCommit <= clock.now) {
        clock.commits += 1;
        clock.nextCommit += 1000;
        clock.onCommit();
      }
      callback();
    });
  };
  const ports: {
    onmessage: (() => void) | null;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const platform: Record<string, unknown> = {};
  const idle = vi.fn((callback: () => void, config: { timeout: number }) =>
    task(config.timeout, callback),
  );
  const timeout = vi.fn((callback: () => void) => task(1, callback));
  if (options.idle !== false) platform.requestIdleCallback = idle;
  if (options.scheduler)
    platform.scheduler = {
      yield: vi.fn(() =>
        options.scheduler === "reject"
          ? Promise.reject(new Error("Synthetic scheduler unavailable"))
          : new Promise<void>((resolve) => task(options.taskMs ?? 1, resolve)),
      ),
    };
  if (options.channel)
    platform.MessageChannel = class {
      port1 = { onmessage: null as (() => void) | null, close: vi.fn() };
      port2 = {
        onmessage: null as (() => void) | null,
        close: vi.fn(),
        postMessage: vi.fn(() => {
          if (options.throwPost)
            throw new Error("Synthetic channel unavailable");
          task(options.taskMs ?? 1, () => this.port1.onmessage?.());
        }),
      };
      constructor() {
        ports.push(this.port1, this.port2);
      }
    };
  const productionYield = new Function(
    "globalThis",
    "setTimeout",
    `${helper}\nreturn yieldReactDiscovery;`,
  )(platform, timeout) as () => Promise<void>;
  const idleYield = () =>
    new Promise<void>((resolve) => idle(resolve, { timeout: 50 }));
  return { clock, platform, ports, idle, timeout, productionYield, idleYield };
};

const createScan = (
  host: ReturnType<typeof createPlatform>,
  yieldDiscovery = host.productionYield,
) => {
  const client = {
    getQueryCache: () => ({}),
    getQueryData() {},
    setQueryData() {},
  };
  const scope = {
    chain: {},
    node: { queryClient: client },
    queryClient: client,
    get() {},
    set() {},
    watch() {},
  };
  const first: Record<string, unknown> = { dependencies: { scope } };
  const second: Record<string, unknown> = {
    dependencies: first.dependencies,
    alternate: first,
  };
  first.alternate = second;
  let fiber = first;
  for (let index = 0; index < 26_000; index += 1) {
    const child = {};
    fiber.child = child;
    fiber = child;
  }
  second.child = first.child;
  const window = { __codexRoot: { _internalRoot: { current: first } } };
  host.clock.onCommit = () => {
    window.__codexRoot._internalRoot.current =
      window.__codexRoot._internalRoot.current === first ? second : first;
  };
  const state: Record<string, unknown> = {
    pendingReactNodes: new Set(),
    reactMutationGeneration: 0,
  };
  const api = new Function(
    "state",
    "window",
    "document",
    "monotonicNow",
    "yieldReactDiscovery",
    "installationIsCurrent",
    `${discovery}\nreturn { scan: codexRendererScopeCandidates, current: codexRendererScopeSnapshotIsCurrent };`,
  )(
    state,
    window,
    { getElementById: () => null },
    () => host.clock.now,
    yieldDiscovery,
    () => true,
  ) as { scan: () => Promise<unknown[]>; current: () => boolean };
  return { api, state, scope };
};

describe("Codex Desktop cooperative discovery scheduling", () => {
  it("reproduces three invalidated large-tree scans when idle waits overlap recurring commits", async () => {
    const host = createPlatform();
    const h = createScan(host, host.idleYield);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await h.api.scan();
      expect(h.state.scopedAppServerScopeScanComplete).toBe(false);
      expect(h.api.current()).toBe(false);
    }
    expect(host.clock.commits).toBeGreaterThanOrEqual(3);
    expect(host.clock.now).toBeGreaterThan(30_000);
  });

  it.each(["scheduler", "message"] as const)(
    "completes a 26k-Fiber inventory before unrelated 1s commits using %s tasks",
    async (mode) => {
      const host = createPlatform(
        mode === "scheduler" ? { scheduler: "resolve" } : { channel: true },
      );
      const h = createScan(host);
      expect(await h.api.scan()).toEqual([h.scope]);
      expect(h.state.scopedAppServerScopeScanComplete).toBe(true);
      expect(h.api.current()).toBe(true);
      expect(host.clock.now).toBeGreaterThan(0);
      expect(host.clock.now).toBeLessThan(1000);
      expect(host.clock.commits).toBe(0);
      expect(host.idle).not.toHaveBeenCalled();
      for (const port of host.ports) {
        expect(port.close).toHaveBeenCalledTimes(1);
        expect(port.onmessage).toBeNull();
      }
    },
  );

  it("keeps exact committed-root invalidation even with cooperative scheduling", async () => {
    const host = createPlatform({ scheduler: "resolve", taskMs: 5 });
    const h = createScan(host);
    await h.api.scan();
    expect(host.clock.commits).toBeGreaterThan(0);
    expect(h.state.scopedAppServerScopeScanComplete).toBe(false);
    expect(h.api.current()).toBe(false);
  });

  it("falls back from rejected scheduler tasks and closes both owned message ports", async () => {
    const host = createPlatform({ scheduler: "reject", channel: true });
    await host.productionYield();
    expect(host.ports).toHaveLength(2);
    for (const port of host.ports) {
      expect(port.close).toHaveBeenCalledTimes(1);
      expect(port.onmessage).toBeNull();
    }
    expect(host.idle).not.toHaveBeenCalled();
  });

  it("closes failed channel ports before using the legacy idle fallback", async () => {
    const host = createPlatform({ channel: true, throwPost: true });
    await host.productionYield();
    expect(host.ports).toHaveLength(2);
    for (const port of host.ports) expect(port.close).toHaveBeenCalledTimes(1);
    expect(host.idle).toHaveBeenCalledTimes(1);
  });

  it("retains a legacy timer fallback when no cooperative or idle API exists", async () => {
    const host = createPlatform({ idle: false });
    await host.productionYield();
    expect(host.timeout).toHaveBeenCalledTimes(1);
  });
});
