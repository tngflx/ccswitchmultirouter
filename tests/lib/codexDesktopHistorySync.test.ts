import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const renderer = readFileSync(
  path.resolve("src-tauri/src/resources/codex_desktop/renderer_runtime.js"),
  "utf8",
);
const start = renderer.indexOf("  const localCatalogFromModule =");
const end = renderer.indexOf(
  "  /*__CCSWITCH_APP_SERVER_MODEL_LIST_SCOPE_CORE__*/",
  start,
);
if (start < 0 || end < start) throw new Error("History sync boundary missing");

const createHarness = (catalog: object) => {
  let clock = 1;
  const state: {
    historySync?: object;
    historySyncPromise?: Promise<void> | null;
    historySyncAttempts?: number;
    historySyncRetryAt?: number;
  } = {};
  const loadModule = vi.fn(async () => ({
    appServices: { localThreadCatalog: catalog },
  }));
  const recordFailure = vi.fn();
  const install = () => {
    return new Function(
      "state",
      "loadAppModule",
      "recordFailure",
      "installationIsCurrent",
      "monotonicNow",
      renderer.slice(start, end) + "\nreturn triggerLocalThreadCatalogSync;",
    )(
      state,
      loadModule,
      recordFailure,
      () => true,
      () => clock,
    ) as (options?: { explicit: boolean }) => void;
  };
  return {
    install,
    state,
    recordFailure,
    loadModule,
    advance: (milliseconds: number) => (clock += milliseconds),
  };
};

describe("Codex Desktop native history sync resource bounds", () => {
  it("backs off incomplete or failing legacy sync and stops after five attempts", async () => {
    const requestStartupSync = vi.fn().mockResolvedValue(undefined);
    requestStartupSync.mockRejectedValueOnce(new Error("temporary failure"));
    const readSnapshot = vi.fn(async () => ({
      entries: [],
      isComplete: false,
    }));
    const harness = createHarness({ requestStartupSync, readSnapshot });
    const tick = harness.install();

    for (const [index, delay] of [5000, 10000, 20000, 40000, 80000].entries()) {
      tick();
      await harness.state.historySyncPromise;
      expect(requestStartupSync).toHaveBeenCalledTimes(index + 1);
      harness.advance(delay - 1);
      tick();
      expect(harness.state.historySyncPromise).toBeNull();
      harness.advance(1);
    }
    tick();
    expect(harness.state.historySyncPromise).toBeNull();
    expect(harness.recordFailure).toHaveBeenCalledOnce();

    readSnapshot.mockResolvedValue({ entries: [], isComplete: true });
    tick({ explicit: true });
    await harness.state.historySyncPromise;
    expect(requestStartupSync).toHaveBeenCalledTimes(6);
    expect(harness.state.historySync).toMatchObject({ complete: true });
    harness.advance(80000);
    tick();
    expect(harness.state.historySyncPromise).toBeNull();
  });

  it("does not return a new waiter or start a second RPC while one hangs across reinjection", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const requestStartupSync = vi.fn(() => blocked);
    const harness = createHarness({ requestStartupSync });
    const firstTick = harness.install();
    expect(firstTick()).toBeUndefined();
    const pending = harness.state.historySyncPromise;
    await vi.waitFor(() => expect(requestStartupSync).toHaveBeenCalledOnce());

    try {
      const replacementTick = harness.install();
      for (let i = 0; i < 500; i += 1) {
        harness.advance(1500);
        expect(replacementTick()).toBeUndefined();
      }
      expect(harness.state.historySyncPromise).toBe(pending);
      expect(harness.loadModule).toHaveBeenCalledOnce();
    } finally {
      release();
      await pending;
    }
  });

  it("uses the modern status without requesting sync when already complete", async () => {
    const requestStartupSync = vi.fn();
    const readStatus = vi.fn(async () => ({
      hosts: [{ hostId: "local", isComplete: true }],
    }));
    const harness = createHarness({ requestStartupSync, readStatus });
    const tick = harness.install();
    tick();
    await harness.state.historySyncPromise;
    harness.advance(60000);
    tick();
    expect(readStatus).toHaveBeenCalledOnce();
    expect(requestStartupSync).not.toHaveBeenCalled();
    expect(harness.state.historySync).toMatchObject({
      requested: false,
      complete: true,
    });
  });
});
