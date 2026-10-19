import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const resource = (name: string) =>
  path.resolve(process.cwd(), "src-tauri/src/resources/codex_desktop", name);
const core = readFileSync(resource("model_picker_core.js"), "utf8");
const discovery = readFileSync(resource("client_discovery.js"), "utf8");
const diagnostics = existsSync(resource("model_picker_diagnostics.js"))
  ? readFileSync(resource("model_picker_diagnostics.js"), "utf8")
  : "";
const key = ["models", "list", "local", "chatgpt", 100];
const efforts = ["high", "max", "ultra"];
const row = (levels = efforts) => ({
  model: "relay",
  supportedReasoningEfforts: levels.map((reasoningEffort) => ({
    reasoningEffort,
  })),
});
const payload = () => ({
  modelProvider: "codex_model_router_v2",
  catalogAvailable: true,
  modelNames: ["relay"],
  models: [{ model: "relay", supported_reasoning_levels: [...efforts] }],
});
const loadDiagnostics = (state: object) =>
  new Function(
    "state",
    `${core}\n${discovery}\n${diagnostics}\nreturn typeof codexModelPickerDiagnostics === 'function' ? codexModelPickerDiagnostics : () => null;`,
  )(state) as () => Record<string, unknown> | null;

const harness = <T>(
  select: (value: { data: ReturnType<typeof row>[] }) => T,
) => {
  const client = new QueryClient();
  client.setQueryData(key, { data: [row()] });
  const observer = new QueryObserver(client, {
    queryKey: key,
    enabled: false,
    select,
  });
  const unsubscribe = observer.subscribe(() => {});
  const state = {
    payload: payload(),
    reasoningQueryCaches: new Map([[client.getQueryCache(), {}]]),
  };
  return {
    client,
    observer,
    state,
    read: loadDiagnostics(state),
    dispose: () => {
      unsubscribe();
      client.clear();
    },
  };
};

describe("Codex Desktop picker observer diagnostics", () => {
  it("reports selector errors even when raw query data succeeded", () => {
    const h = harness(() => {
      throw new TypeError("redacted selector failure");
    });
    try {
      expect(h.client.getQueryState(key)?.status).toBe("success");
      expect(h.observer.getCurrentResult().status).toBe("error");
      expect(h.read()).toMatchObject({
        status: "error",
        errorObserverCount: 1,
      });
      expect(JSON.stringify(h.read())).not.toContain("redacted selector");
    } finally {
      h.dispose();
    }
  });

  it("detects missing Max while Ultra remains in a successful selection", () => {
    const h = harness(() => ({ models: [row(["high", "ultra"])] }));
    try {
      expect(h.read()).toMatchObject({
        status: "mismatch",
        effortMismatchCount: 1,
        missingMaxModelCount: 1,
        missingUltraModelCount: 0,
        selectedMaxModelCount: 0,
        selectedUltraModelCount: 1,
      });
    } finally {
      h.dispose();
    }
  });

  it("does not certify absent, pending, or unsupported picker observations", () => {
    expect(
      loadDiagnostics({
        payload: payload(),
        reasoningQueryCaches: new Map(),
      })(),
    ).toMatchObject({ status: "pending", pickerObserverCount: 0 });
    const h = harness((value) => value.data);
    try {
      expect(h.read()).toMatchObject({
        status: "unverified",
        unsupportedObserverCount: 1,
      });
      h.client
        .getQueryCache()
        .find({ queryKey: key })!
        .setState({ data: undefined, status: "pending" });
      expect(h.read()).toMatchObject({
        status: "pending",
        pendingObserverCount: 1,
      });
    } finally {
      h.dispose();
    }
  });

  it("does not let a healthy observer hide an errored observer", () => {
    const h = harness((value) => ({ models: value.data }));
    const other = new QueryObserver(h.client, {
      queryKey: key,
      enabled: false,
      select: () => {
        throw new Error("private error");
      },
    });
    const unsubscribe = other.subscribe(() => {});
    try {
      expect(h.read()).toMatchObject({
        status: "error",
        pickerObserverCount: 2,
        successObserverCount: 1,
        errorObserverCount: 1,
      });
    } finally {
      unsubscribe();
      h.dispose();
    }
  });

  it("requires the native empty effort array without inventing a default", () => {
    const h = harness(() => ({
      models: [{ model: "relay", supportedReasoningEfforts: [] }],
    }));
    try {
      h.state.payload.models[0].supported_reasoning_levels = [];
      expect(h.read()).toMatchObject({
        status: "ready",
        effortMismatchCount: 0,
      });
      h.observer.setOptions({
        queryKey: key,
        enabled: false,
        select: () => ({ models: [{ model: "relay" }] }),
      } as never);
      expect(h.read()).toMatchObject({
        status: "mismatch",
        effortMismatchCount: 1,
      });
    } finally {
      h.dispose();
    }
  });

  it("preserves native availability filtering for absent catalog rows", () => {
    const h = harness((value) => ({ models: value.data }));
    try {
      h.state.payload.modelNames.push("not-currently-available");
      h.state.payload.models.push({
        model: "not-currently-available",
        supported_reasoning_levels: ["high"],
      });
      expect(h.read()).toMatchObject({
        status: "ready",
        effortMismatchCount: 0,
      });
    } finally {
      h.dispose();
    }
  });

  it("checks optional effort flags against selected rows", () => {
    const h = harness((value) => ({
      models: value.data,
      hasModelSupportingMaxReasoningEffort: false,
      hasModelSupportingUltraReasoningEffort: true,
    }));
    try {
      expect(h.read()).toMatchObject({
        status: "mismatch",
        flagMismatchCount: 1,
      });
    } finally {
      h.dispose();
    }
  });

  it("ignores remote and other-provider queries", () => {
    const client = new QueryClient();
    const observers = [
      ["models", "list", "remote", "chatgpt", 100],
      [...key, "other-provider"],
    ].map((queryKey) => {
      client.setQueryData(queryKey, { data: [row()] });
      return new QueryObserver(client, {
        queryKey,
        enabled: false,
        select: () => {
          throw new Error("irrelevant");
        },
      });
    });
    const unsubscribe = observers.map((observer) =>
      observer.subscribe(() => {}),
    );
    try {
      expect(
        loadDiagnostics({
          payload: payload(),
          reasoningQueryCaches: new Map([[client.getQueryCache(), {}]]),
        })(),
      ).toMatchObject({
        status: "pending",
        pickerObserverCount: 0,
        errorObserverCount: 0,
      });
    } finally {
      unsubscribe.forEach((stop) => stop());
      client.clear();
    }
  });

  it("does not invoke result or model accessors", () => {
    const trap = vi.fn(() => {
      throw new Error("private value must not be read");
    });
    for (const result of [
      {
        status: "success",
        get data() {
          return trap();
        },
      },
      {
        status: "success",
        data: {
          models: [
            {
              model: "relay",
              get supportedReasoningEfforts() {
                return trap();
              },
            },
          ],
        },
      },
    ]) {
      const observer = {
        options: { queryKey: key },
        getCurrentResult: () => result,
      };
      const cache = {
        getAll: () => [{ queryKey: key, observers: [observer] }],
      };
      expect(
        loadDiagnostics({
          payload: payload(),
          reasoningQueryCaches: new Map([[cache, {}]]),
        })(),
      ).toMatchObject({ status: "unverified", unreadableObserverCount: 1 });
    }
    expect(trap).not.toHaveBeenCalled();
  });

  it("reads frozen results without requests, notifications, or projection changes", () => {
    const h = harness((value) => ({ models: value.data }));
    try {
      const cached = h.client.getQueryData<{ data: ReturnType<typeof row>[] }>(
        key,
      )!;
      for (const model of cached.data) {
        model.supportedReasoningEfforts.forEach(Object.freeze);
        Object.freeze(model.supportedReasoningEfforts);
        Object.freeze(model);
      }
      Object.freeze(cached.data);
      Object.freeze(cached);
      const result = h.observer.getCurrentResult();
      Object.freeze(result.data);
      Object.freeze(result);
      const setOptions = vi.spyOn(h.observer, "setOptions");
      const fetch = vi.spyOn(h.client, "fetchQuery");
      const notify = vi.fn();
      const unsubscribe = h.client.getQueryCache().subscribe(notify);
      expect(h.read()).toMatchObject({
        status: "ready",
        selectedMaxModelCount: 1,
        selectedUltraModelCount: 1,
      });
      expect(h.read()).toEqual(h.read());
      expect(h.client.getQueryData(key)).toBe(cached);
      expect(h.observer.getCurrentResult()).toBe(result);
      expect(setOptions).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      unsubscribe();
    } finally {
      h.dispose();
    }
  });
});
