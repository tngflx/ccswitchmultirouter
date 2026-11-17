import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const renderer = readFileSync(
  path.resolve(
    process.cwd(),
    "src-tauri/src/resources/codex_desktop/renderer_runtime.js",
  ),
  "utf8",
);
const start = renderer.indexOf("  const installReactRootObserver = () => {");
const end = renderer.indexOf(
  "  const installAppServerPatch = async () => {",
  start,
);
if (start < 0 || end < start)
  throw new Error("Renderer observer boundary missing");
const installSource = renderer.slice(start, end);
const createHarness = (initialGeneration = 0) => {
  let receive: (records: object[]) => void = () => {};
  let current = true;
  const observe = vi.fn();
  const target = {};
  const root = {};
  const state = {
    pendingReactNodes: new Set<object>(),
    reactMutationGeneration: initialGeneration,
    reactRootObserver: null as object | null,
  };
  class Observer {
    observe = observe;
    constructor(callback: typeof receive) {
      receive = callback;
    }
  }
  const install = new Function(
    "state",
    "document",
    "MutationObserver",
    "installationIsCurrent",
    installSource + "\nreturn installReactRootObserver;",
  )(
    state,
    { documentElement: target, body: target, getElementById: () => root },
    Observer,
    () => current,
  ) as () => void;
  install();
  return {
    state,
    receive: (records: object[]) => receive(records),
    root,
    observe,
    retire: () => {
      current = false;
    },
  };
};

describe("Codex renderer scope mutation generation", () => {
  it("rebinds the root observer on same-fingerprint reinjection instead of retaining an inert generation", () => {
    const generationStart = renderer.indexOf(
      "  const installationGeneration =",
    );
    const generationEnd = renderer.indexOf(
      "  state.catalogReleased =",
      generationStart,
    );
    expect(generationStart).toBeGreaterThanOrEqual(0);
    expect(generationEnd).toBeGreaterThan(generationStart);
    const callbacks: Array<(records: object[]) => void> = [];
    const disconnect = vi.fn();
    class Observer {
      observe() {}
      disconnect = disconnect;
      takeRecords() {
        return [];
      }
      constructor(callback: (records: object[]) => void) {
        callbacks.push(callback);
      }
    }
    const state = {
      rendererRuntimeFingerprint: "unchanged-fingerprint",
      runtimeGeneration: 0,
      reactMutationGeneration: 7,
      pendingReactNodes: new Set<object>(),
      reactRootObserver: null as object | null,
    };
    const target = {};
    const run = new Function(
      "state",
      "document",
      "MutationObserver",
      "clearInterval",
      renderer.slice(generationStart, generationEnd) +
        "\n" +
        installSource +
        "\ninstallReactRootObserver();",
    );
    const document = {
      documentElement: target,
      body: target,
      getElementById: () => target,
    };
    run(state, document, Observer, () => {});
    run(state, document, Observer, () => {});
    expect(callbacks).toHaveLength(2);
    expect(disconnect).toHaveBeenCalledOnce();
    callbacks[0]([{ addedNodes: [{}], removedNodes: [] }]);
    expect(state.reactMutationGeneration).toBe(7);
    callbacks[1]([{ addedNodes: [{}], removedNodes: [] }]);
    expect(state.reactMutationGeneration).toBe(8);
    expect(state.rendererRuntimeFingerprint).toBe("unchanged-fingerprint");
  });
  it("invalidates owner inventory on removal-only commits and queues the current parent", () => {
    const h = createHarness();
    const parent = {};
    h.receive([{ addedNodes: [], removedNodes: [{}], target: parent }]);
    expect(h.state.reactMutationGeneration).toBe(1);
    expect(h.state.pendingReactNodes).toEqual(new Set([parent]));
  });

  it("keeps commit generation independent of draining or bounding pending nodes", () => {
    const h = createHarness(12);
    const added = Array.from({ length: 140 }, () => ({}));
    h.receive([{ addedNodes: added, removedNodes: [] }]);
    expect(h.state.reactMutationGeneration).toBe(13);
    expect(h.state.pendingReactNodes.size).toBeLessThanOrEqual(128);
    h.state.pendingReactNodes.clear();
    h.receive([{ addedNodes: [{}], removedNodes: [] }]);
    expect(h.state.reactMutationGeneration).toBe(14);
  });

  it("does not invalidate for empty observer records or a superseded runtime", () => {
    const h = createHarness(4);
    h.receive([{ addedNodes: [], removedNodes: [] }]);
    expect(h.state.reactMutationGeneration).toBe(4);
    h.retire();
    h.receive([{ addedNodes: [{}], removedNodes: [{}], target: {} }]);
    expect(h.state.reactMutationGeneration).toBe(4);
    expect(h.state.pendingReactNodes.size).toBe(0);
    expect(h.observe).toHaveBeenCalledOnce();
  });
});
