import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import includedReasoningFixture from "../fixtures/codexIncludedModelReasoning.json";

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
const loadDiagnostics = (state: object, visibilityCode = "") =>
  new Function(
    "state",
    `${core}\n${discovery}\n${visibilityCode}\n${diagnostics}\nreturn typeof codexModelPickerDiagnostics === 'function' ? codexModelPickerDiagnostics : () => null;`,
  )(state) as (options?: {
    includeModelObservations?: boolean;
  }) => Record<string, unknown> | null;

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
    scopedAppServerScopeScanComplete: true,
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
  it("drops unknown descriptor tokens without losing Max, Ultra or native GPT efforts", () => {
    const normalize = new Function(
      "state",
      `${core}\nreturn normalizeReasoningDescriptor;`,
    )({ payload: payload() }) as (
      value: Record<string, unknown>,
    ) => Record<string, any>;
    const descriptor = normalize({
      default_reasoning_level: "fixture-unknown-effort",
      supported_reasoning_levels: [
        "high",
        "fixture-unknown-effort",
        "xhigh",
        "max",
        "ultra",
        "max",
      ],
    });
    expect(
      descriptor.supportedReasoningEfforts.map(
        (level: { reasoningEffort: string }) => level.reasoningEffort,
      ),
    ).toEqual(["high", "xhigh", "max", "ultra"]);
    expect(descriptor.defaultReasoningEffort).toBe("high");
    expect(
      normalize({ supported_reasoning_levels: ["fixture-unknown-effort"] }),
    ).toEqual({ supportedReasoningEfforts: [] });
  });

  it("preserves canonical fixed metadata and Boolean bridge ownership when filtering tokens", () => {
    const marker = {
      kind: "boolean",
      disableAllowed: true,
      fingerprint: "canonical-binary",
    };
    const state = {
      payload: {
        ...payload(),
        models: [
          {
            model: "fixed",
            supported_reasoning_levels: [],
            reasoning: { controlKind: "fixed", enabled: true },
          },
          {
            model: "binary",
            supported_reasoning_levels: [],
            ccSwitchReasoningControl: marker,
          },
        ],
      },
    };
    const before = JSON.stringify(state.payload);
    const descriptor = new Function("state", `${core}\nreturn descriptorFor;`)(
      state,
    ) as (model: string) => Record<string, any>;
    expect(descriptor("fixed")).toMatchObject({
      supportedReasoningEfforts: [],
      reasoning: { controlKind: "fixed", enabled: true },
    });
    expect(descriptor("binary")).toMatchObject({
      ccSwitchReasoningControl: marker,
      supportedReasoningEfforts: [
        { reasoningEffort: "none" },
        { reasoningEffort: "medium" },
      ],
    });
    expect(JSON.stringify(state.payload)).toBe(before);
  });

  it.each([
    { name: "missing visibility reader", reader: "" },
    {
      name: "throwing visibility reader",
      reader:
        "const readCodexNativeReasoningVisibility = () => { throw new Error('fixture'); };",
    },
  ])("fails closed for a required $name", ({ reader }) => {
    const h = harness((value) => ({ models: value.data }));
    try {
      const state = { ...h.state, nativeReasoningVisibilityRequired: true };
      const visibility = `
        const codexCurrentNativeReasoningQueryCaches = () => new Set(state.reasoningQueryCaches.keys());
        ${reader}
      `;
      expect(loadDiagnostics(state, visibility)()).toMatchObject({
        status: "unverified",
        successObserverCount: 1,
        nativeVisibilityUnverifiedObserverCount: 1,
      });
    } finally {
      h.dispose();
    }
  });

  it("keeps unobserved Boolean controls unverified without treating transport aliases as graded mismatches", () => {
    const marker = {
      kind: "boolean",
      disableAllowed: true,
      fingerprint: "canonical-binary",
    };
    const binary = {
      model: "relay",
      supportedReasoningEfforts: ["none", "medium"].map((reasoningEffort) => ({
        reasoningEffort,
      })),
    };
    const observer = {
      options: { queryKey: key },
      getCurrentResult: () => ({
        status: "success",
        data: { models: [binary] },
      }),
    };
    const cache = { getAll: () => [{ queryKey: key, observers: [observer] }] };
    const state: Record<string, any> = {
      payload: {
        ...payload(),
        models: [
          {
            model: "relay",
            supported_reasoning_levels: [],
            ccSwitchReasoningControl: marker,
          },
        ],
      },
      reasoningQueryCaches: new Map([[cache, {}]]),
      nativeReasoningVisibilityRequired: true,
    };
    const nativeVisible = new Set(["low", "medium", "high", "xhigh"]);
    const visibilityCode = `
      const codexCurrentNativeReasoningQueryCaches = () => new Set(state.reasoningQueryCaches.keys());
      const readCodexNativeReasoningVisibility = () => ({status: "mismatch", missingEfforts: ["none"]});
    `;
    expect(loadDiagnostics(state, visibilityCode)()).toMatchObject({
      status: "unverified",
      booleanControlUnverifiedModelCount: 1,
      booleanControlReadyModelCount: 0,
      effortMismatchCount: 0,
    });
    state.readNativeBooleanReasoningControlDiagnostics = () => ({
      status: "ready",
      model: "relay",
      selectedState: "off",
      visibleStates: ["off", "on"],
    });
    expect(loadDiagnostics(state, visibilityCode)()).toMatchObject({
      status: "ready",
      booleanControlReadyModelCount: 1,
      effortMismatchCount: 0,
    });
    expect([...nativeVisible]).toEqual(["low", "medium", "high", "xhigh"]);
    // A matching callback cannot bless a graded row's hidden None preference.
    state.payload.models = [
      { model: "relay", supported_reasoning_levels: ["none", "medium"] },
    ];
    expect(loadDiagnostics(state, visibilityCode)()).toMatchObject({
      status: "mismatch",
      effortMismatchCount: 1,
    });
  });
  it("requires independently observed Boolean UI controls, not just installed aliases", () => {
    const marker = {
      kind: "boolean",
      disableAllowed: true,
      fingerprint: "canonical-binary",
    };
    const binary = {
      model: "relay",
      ccSwitchReasoningControl: marker,
      supportedReasoningEfforts: ["none", "medium"].map((reasoningEffort) => ({
        reasoningEffort,
      })),
    };
    const modelCatalog = {
      ...payload(),
      models: [
        {
          model: "relay",
          supported_reasoning_levels: [],
          ccSwitchReasoningControl: marker,
        },
      ],
    };
    const observer = {
      options: { queryKey: key },
      getCurrentResult: () => ({
        status: "success",
        data: { models: [binary] },
      }),
    };
    const cache = { getAll: () => [{ queryKey: key, observers: [observer] }] };
    const state: Record<string, any> = {
      payload: modelCatalog,
      reasoningQueryCaches: new Map([[cache, {}]]),
    };
    expect(loadDiagnostics(state)()).toMatchObject({
      status: "unverified",
      booleanControlUnverifiedModelCount: 1,
    });
    state.readNativeBooleanReasoningControlDiagnostics = () => ({
      status: "ready",
      model: "relay",
      selectedState: "on",
      visibleStates: ["off", "on"],
    });
    expect(loadDiagnostics(state)()).toMatchObject({
      status: "ready",
      booleanControlReadyModelCount: 1,
    });
    state.readNativeBooleanReasoningControlDiagnostics = () => ({
      status: "ready",
      model: "another-provider-model",
      selectedState: "on",
      visibleStates: ["off", "on"],
    });
    expect(loadDiagnostics(state)()).toMatchObject({
      status: "unverified",
      booleanControlUnverifiedModelCount: 1,
    });
  });

  it("does not downgrade readiness for Boolean models that are not the mounted picker selection", () => {
    const marker = {
      kind: "boolean",
      disableAllowed: true,
      fingerprint: "canonical-binary",
    };
    const models = ["selected", "off-selection"];
    const observer = {
      options: { queryKey: key },
      getCurrentResult: () => ({
        status: "success",
        data: {
          models: models.map((model) => ({
            model,
            supportedReasoningEfforts: ["none", "medium"].map(
              (reasoningEffort) => ({ reasoningEffort }),
            ),
          })),
        },
      }),
    };
    const cache = { getAll: () => [{ queryKey: key, observers: [observer] }] };
    const state: Record<string, any> = {
      payload: {
        ...payload(),
        modelNames: models,
        models: models.map((model) => ({
          model,
          supported_reasoning_levels: [],
          ccSwitchReasoningControl: marker,
        })),
      },
      reasoningQueryCaches: new Map([[cache, {}]]),
      readNativeBooleanReasoningControlDiagnostics: (model: string) =>
        model === "selected"
          ? {
              status: "ready",
              model,
              selectedState: "on",
              visibleStates: ["off", "on"],
            }
          : { status: "not_observed", model },
    };

    expect(loadDiagnostics(state)()).toMatchObject({
      status: "ready",
      booleanControlReadyModelCount: 1,
      booleanControlUnverifiedModelCount: 0,
      booleanControlNotObservedModelCount: 1,
    });
  });

  it.each([
    {
      name: "three unverified observers",
      proofs: ["unverified", "unverified", "unverified"],
      status: "unverified",
      ready: 0,
      unverified: 1,
      unreadable: 0,
    },
    {
      name: "three ready observers",
      proofs: ["ready", "ready", "ready"],
      status: "ready",
      ready: 1,
      unverified: 0,
      unreadable: 0,
    },
    ...[
      ["unverified", "ready", "ready"],
      ["ready", "unverified", "ready"],
      ["ready", "ready", "unverified"],
      ["ready", "throw", "ready"],
      ["ready", "accessor", "ready"],
    ].map((proofs) => ({
      name: `conflicting proofs ${proofs.join("/")}`,
      proofs,
      status: "unverified",
      ready: 0,
      unverified: 1,
      unreadable: proofs.some((proof) => ["throw", "accessor"].includes(proof))
        ? 1
        : 0,
    })),
  ])(
    "counts each Boolean model once and never lets ready proof hide uncertainty: $name",
    ({ proofs, status, ready, unverified, unreadable }) => {
      const marker = {
        kind: "boolean",
        disableAllowed: true,
        fingerprint: "canonical-binary",
      };
      const binary = row(["none", "medium"]);
      const observers = proofs.map(() => ({
        options: { queryKey: key },
        getCurrentResult: () => ({
          status: "success",
          data: { models: [binary] },
        }),
      }));
      const cache = { getAll: () => [{ queryKey: key, observers }] };
      let proofIndex = 0;
      const accessorTrap = vi.fn(() => {
        throw new Error("fixture-private-proof-getter");
      });
      const readControl = vi.fn((model: string) => {
        const status = proofs[proofIndex++];
        if (status === "throw") throw new Error("fixture-private-proof-error");
        const proof = {
          status,
          model,
          selectedState: "on",
          visibleStates: ["off", "on"],
        };
        if (status === "accessor")
          Object.defineProperty(proof, "status", { get: accessorTrap });
        return proof;
      });
      const state = {
        payload: {
          ...payload(),
          models: [
            {
              model: "relay",
              supported_reasoning_levels: [],
              ccSwitchReasoningControl: marker,
            },
          ],
        },
        reasoningQueryCaches: new Map([[cache, {}]]),
        readNativeBooleanReasoningControlDiagnostics: readControl,
      };
      const result = loadDiagnostics(state)();
      expect(result).toMatchObject({
        status,
        pickerObserverCount: 3,
        successObserverCount: 3,
        booleanControlUnverifiedModelCount: unverified,
        booleanControlReadyModelCount: ready,
        effortMismatchCount: 0,
        unreadableObserverCount: unreadable,
      });
      // Deduplicating the counters must not skip a conflicting later proof.
      expect(readControl).toHaveBeenCalledTimes(3);
      expect(accessorTrap).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("fixture-private-proof");
    },
  );

  it("counts distinct public Boolean model identities separately even when they share an upstream slug", () => {
    const models = ["relay-a", "relay-b"].map((model) => ({
      ...row(["none", "medium"]),
      model,
    }));
    const marker = {
      kind: "boolean",
      disableAllowed: true,
      fingerprint: "canonical-binary",
    };
    const observers = Array.from({ length: 3 }, () => ({
      options: { queryKey: key },
      getCurrentResult: () => ({ status: "success", data: { models } }),
    }));
    const cache = { getAll: () => [{ queryKey: key, observers }] };
    const state = {
      payload: {
        ...payload(),
        modelNames: models.map(({ model }) => model),
        models: models.map(({ model }) => ({
          model,
          upstreamModel: "shared-reasoner",
          supported_reasoning_levels: [],
          ccSwitchReasoningControl: marker,
        })),
      },
      reasoningQueryCaches: new Map([[cache, {}]]),
      readNativeBooleanReasoningControlDiagnostics: (model: string) => ({
        status: "ready",
        model,
        selectedState: "on",
        visibleStates: ["off", "on"],
      }),
    };
    expect(loadDiagnostics(state)()).toMatchObject({
      status: "ready",
      pickerObserverCount: 3,
      booleanControlReadyModelCount: 2,
      booleanControlUnverifiedModelCount: 0,
      effortMismatchCount: 0,
    });
  });

  it.each([
    { actualEfforts: [] },
    { actualEfforts: ["medium"] },
    { actualEfforts: ["none"] },
    { actualEfforts: ["none", "medium", "high"] },
  ])(
    "never lets a Boolean UI proof hide missing or extra native adapter tokens: $actualEfforts",
    ({ actualEfforts }) => {
      const marker = {
        kind: "boolean",
        disableAllowed: true,
        fingerprint: "canonical-binary",
      };
      const observer = {
        options: { queryKey: key },
        getCurrentResult: () => ({
          status: "success",
          data: {
            models: [
              {
                model: "relay",
                supportedReasoningEfforts: actualEfforts.map(
                  (reasoningEffort) => ({
                    reasoningEffort,
                  }),
                ),
              },
            ],
          },
        }),
      };
      const cache = {
        getAll: () => [{ queryKey: key, observers: [observer] }],
      };
      const state = {
        payload: {
          ...payload(),
          models: [
            {
              model: "relay",
              supported_reasoning_levels: [],
              ccSwitchReasoningControl: marker,
            },
          ],
        },
        reasoningQueryCaches: new Map([[cache, {}]]),
        readNativeBooleanReasoningControlDiagnostics: () => ({
          status: "ready",
          model: "relay",
          selectedState: "off",
          visibleStates: ["off", "on"],
        }),
      };
      expect(loadDiagnostics(state)()).toMatchObject({
        status: "mismatch",
        effortMismatchCount: 1,
      });
    },
  );

  it("does not accept Boolean transport aliases without a validated canonical control", () => {
    const h = harness(() => ({ models: [row(["none", "medium"])] }));
    try {
      h.state.payload.models[0].supported_reasoning_levels = [];
      Object.assign(h.state, {
        readNativeBooleanReasoningControlDiagnostics: () => ({
          status: "ready",
          model: "relay",
          selectedState: "off",
          visibleStates: ["off", "on"],
        }),
      });
      expect(h.read()).toMatchObject({
        status: "mismatch",
        effortMismatchCount: 1,
        booleanControlReadyModelCount: 0,
      });
      Object.assign(h.state.payload.models[0], {
        ccSwitchReasoningControl: {
          kind: "boolean",
          disableAllowed: true,
          fingerprint: "",
        },
      });
      expect(h.read()).toMatchObject({
        status: "mismatch",
        effortMismatchCount: 1,
        booleanControlReadyModelCount: 0,
      });
    } finally {
      h.dispose();
    }
  });

  it("treats an authoritative empty catalog as not required without certifying an unavailable catalog", () => {
    const empty = {
      ...payload(),
      catalogAvailable: true,
      modelNames: [],
      models: [],
    };
    expect(
      loadDiagnostics({ payload: empty, reasoningQueryCaches: new Map() })(),
    ).toMatchObject({
      status: "not_required",
      pickerObserverCount: 0,
    });
    expect(
      loadDiagnostics({
        payload: { ...empty, catalogAvailable: false },
        reasoningQueryCaches: new Map(),
      })(),
    ).toMatchObject({
      status: "unverified",
      pickerObserverCount: 0,
    });
  });

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

type ModelObservationSnapshot = {
  renderedMenuVerified: false;
  queryRowsVerified: boolean;
  truncated: boolean;
  unavailable: boolean;
  unavailableReasons: string[];
  rows: Array<{
    model: string;
    expectedEfforts: string[];
    observedEfforts: string[];
    nativeVisibleEfforts: string[];
    missingEfforts: string[];
  }>;
};
const observationVisibility = `
  const codexCurrentNativeReasoningQueryCaches = () => state.currentNativeCaches;
  const readCodexNativeReasoningVisibility = (_cache, requested) => {
    state.visibilityReadCount += 1;
    return {status: state.visibilityStatus, missingEfforts: requested.filter(effort => !state.nativeVisibleEfforts.has(effort))};
  };
`;
const observationHarness = <T>(
  select: (value: { data: ReturnType<typeof row>[] }) => T,
) => {
  const h = harness(select);
  const state = Object.assign(h.state, {
    nativeReasoningVisibilityRequired: true,
    currentNativeCaches: new Set([
      h.client.getQueryCache(),
    ]) as Set<object> | null,
    nativeVisibleEfforts: new Set(efforts),
    visibilityStatus: "known",
    visibilityReadCount: 0,
  });
  return { ...h, state, read: loadDiagnostics(state, observationVisibility) };
};
const observations = (read: ReturnType<typeof loadDiagnostics>) =>
  read({ includeModelObservations: true })
    ?.modelObservations as ModelObservationSnapshot;

describe("optional current-owner picker model observations", () => {
  it("adds exact bounded query/visibility evidence without changing default diagnostics", () => {
    const h = observationHarness((value) => ({ models: value.data }));
    try {
      const original = h.read();
      expect(original).not.toHaveProperty("modelObservations");
      const detailed = h.read({ includeModelObservations: true })!;
      const { modelObservations, ...counts } = detailed;
      expect(counts).toEqual(original);
      expect(modelObservations).toEqual({
        renderedMenuVerified: false,
        queryRowsVerified: true,
        truncated: false,
        unavailable: false,
        unavailableReasons: [],
        rows: [
          {
            model: "relay",
            expectedEfforts: efforts,
            observedEfforts: efforts,
            nativeVisibleEfforts: efforts,
            missingEfforts: [],
          },
        ],
      });
      expect(h.read()).toEqual(original);
      expect(h.read({ includeModelObservations: false })).toEqual(original);
    } finally {
      h.dispose();
    }
  });

  it("separates all 37 router bindings and nine Boolean controls from native graded Max and Ultra evidence", () => {
    const bindings = includedReasoningFixture.providers
      .filter(({ profile }) => profile === "router")
      .flatMap(({ models }) => models);
    const booleanModels = bindings
      .filter(({ expected }) => expected.controlKind === "boolean")
      .map(({ pickerModel }) => pickerModel);
    const models = bindings.map(({ pickerModel: model, expected }) => ({
      model,
      supportedReasoningEfforts: (expected.controlKind === "boolean"
        ? [...(expected.disableAllowed ? ["none"] : []), "medium"]
        : expected.pickerEfforts
      ).map((reasoningEffort) => ({ reasoningEffort })),
    }));
    const h = observationHarness(() => ({ models }));
    try {
      expect(bindings).toHaveLength(37);
      expect(booleanModels).toHaveLength(9);
      h.state.payload.modelNames = models.map(({ model }) => model);
      h.state.payload.models = bindings.map(
        ({ pickerModel: model, expected }) => ({
          model,
          supported_reasoning_levels: [...expected.pickerEfforts],
          ...(expected.controlKind === "boolean"
            ? {
                ccSwitchReasoningControl: {
                  kind: "boolean",
                  disableAllowed: expected.disableAllowed,
                  fingerprint: "canonical-binary-fixture",
                },
              }
            : {}),
        }),
      );
      h.state.nativeVisibleEfforts = new Set([
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ]);
      expect(h.read()).toMatchObject({
        status: "unverified",
        effortMismatchCount: 0,
        booleanControlUnverifiedModelCount: 9,
        booleanControlReadyModelCount: 0,
        selectedMaxModelCount: 16,
        missingMaxModelCount: 0,
        selectedUltraModelCount: 13,
        missingUltraModelCount: 0,
      });
      const evidence = observations(h.read);
      expect(evidence).toMatchObject({
        renderedMenuVerified: false,
        queryRowsVerified: true,
        unavailable: false,
      });
      expect(evidence.rows).toHaveLength(37);
      expect(
        evidence.rows.filter(({ model }) => booleanModels.includes(model)),
      ).toEqual(
        booleanModels.map((model) => ({
          model,
          expectedEfforts: [],
          observedEfforts: ["none", "medium"],
          nativeVisibleEfforts: ["medium"],
          missingEfforts: [],
        })),
      );
      // The Boolean classification never masks a native graded visibility loss.
      h.state.nativeVisibleEfforts.delete("max");
      expect(h.read()).toMatchObject({
        status: "mismatch",
        effortMismatchCount: 16,
        missingMaxModelCount: 16,
        selectedMaxModelCount: 16,
        booleanControlUnverifiedModelCount: 9,
      });
    } finally {
      h.dispose();
    }
  });

  it("distinguishes selected-query Max from the final native visibility gate", () => {
    const h = observationHarness((value) => ({ models: value.data }));
    try {
      h.state.nativeVisibleEfforts.delete("max");
      expect(observations(h.read)).toMatchObject({
        renderedMenuVerified: false,
        queryRowsVerified: true,
        rows: [
          {
            model: "relay",
            expectedEfforts: efforts,
            observedEfforts: efforts,
            nativeVisibleEfforts: ["high", "ultra"],
            missingEfforts: ["max"],
          },
        ],
      });
      expect(h.read()).toMatchObject({
        status: "mismatch",
        missingMaxModelCount: 1,
      });
    } finally {
      h.dispose();
    }
  });

  it("ignores historical orphan caches even if they contain readable successful rows", () => {
    const h = observationHarness((value) => ({ models: value.data }));
    const orphanRead = vi.fn(() => {
      throw new Error("private orphan must not be read");
    });
    const orphan = { getAll: orphanRead };
    try {
      h.state.reasoningQueryCaches.set(orphan as never, {});
      expect(observations(h.read)).toMatchObject({
        queryRowsVerified: true,
        unavailable: false,
        rows: [{ model: "relay" }],
      });
      expect(orphanRead).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  });

  it("never verifies a partial/unknown native owner inventory or reads its native signal", () => {
    const h = observationHarness((value) => ({ models: value.data }));
    try {
      h.state.currentNativeCaches = null;
      expect(observations(h.read)).toMatchObject({
        renderedMenuVerified: false,
        queryRowsVerified: false,
        unavailable: true,
        rows: [],
        unavailableReasons: expect.arrayContaining(["native_owner_unverified"]),
      });
      expect(h.state.visibilityReadCount).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("keeps readiness pending while the current native owner scan is incomplete", () => {
    const h = observationHarness((value) => ({ models: value.data }));
    try {
      h.state.currentNativeCaches = null;
      h.state.scopedAppServerScopeScanComplete = false;
      expect(h.read()).toMatchObject({
        status: "pending",
        nativeVisibilityUnverifiedObserverCount: 0,
        pickerObserverCount: 1,
      });
      expect(h.state.visibilityReadCount).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("does not bless rows whose native visibility has not been established", () => {
    const h = observationHarness((value) => ({ models: value.data }));
    try {
      h.state.visibilityStatus = "unverified";
      expect(observations(h.read)).toMatchObject({
        queryRowsVerified: false,
        unavailable: true,
        rows: [],
        unavailableReasons: expect.arrayContaining([
          "native_visibility_unverified",
        ]),
      });
    } finally {
      h.dispose();
    }
  });

  it("does not invoke row accessors or serialize unrelated private fields", () => {
    const trap = vi.fn(() => {
      throw new Error("private getter must not execute");
    });
    const h = observationHarness(() => ({
      models: [
        {
          model: "relay",
          get supportedReasoningEfforts() {
            return trap();
          },
          apiKey: "sk-fixture-private-value",
          url: "https://fixture.private.invalid",
          threadId: "private-fixture-thread",
        },
      ],
    }));
    try {
      const evidence = observations(h.read);
      expect(evidence).toMatchObject({
        queryRowsVerified: false,
        unavailable: true,
        rows: [],
        unavailableReasons: expect.arrayContaining([
          "unreadable_picker_evidence",
        ]),
      });
      expect(trap).not.toHaveBeenCalled();
      expect(JSON.stringify(evidence)).not.toMatch(
        /sk-fixture|fixture\.private|private-fixture-thread|private getter/,
      );
    } finally {
      h.dispose();
    }
  });

  it.each([
    "~deepseek/deepseek-flash-latest",
    `~${"a".repeat(255)}`,
    "relay@provider name",
  ])(
    "retains a bounded safe model identity in query observations: %s",
    (model) => {
      const h = observationHarness(() => ({ models: [{ ...row(), model }] }));
      try {
        h.state.payload.modelNames = [model];
        h.state.payload.models = [
          { model, supported_reasoning_levels: [...efforts] },
        ];
        expect(observations(h.read)).toMatchObject({
          queryRowsVerified: true,
          unavailable: false,
          unavailableReasons: [],
          rows: [{ model, expectedEfforts: efforts, observedEfforts: efforts }],
        });
      } finally {
        h.dispose();
      }
    },
  );

  it("omits unsafe model identities and unknown effort strings rather than serializing them", () => {
    for (const model of [
      "https://fixture.private.invalid/secret",
      "sk-fixture-private-value",
      "~sk-fixture-private-value",
      "~rk_fixture-private-value",
      "~pk-fixture-private-value",
      "~https://fixture.private.invalid/model",
      "~relay?token=fixture-private-value",
      "~relay-secret=fixture-private-value",
      "~",
      "~~relay",
      `~${"a".repeat(256)}`,
    ]) {
      const h = observationHarness(() => ({ models: [{ ...row(), model }] }));
      try {
        h.state.payload.modelNames = [model];
        h.state.payload.models = [
          { model, supported_reasoning_levels: [...efforts] },
        ];
        const evidence = observations(h.read);
        expect(evidence).toMatchObject({
          queryRowsVerified: false,
          unavailable: true,
          rows: [],
          unavailableReasons: expect.arrayContaining([
            "invalid_model_observation",
          ]),
        });
        expect(JSON.stringify(evidence)).not.toContain(model);
      } finally {
        h.dispose();
      }
    }
    const h = observationHarness(() => ({
      models: [row(["high", "sk-fixture-private-token"])],
    }));
    try {
      const evidence = observations(h.read);
      expect(evidence).toMatchObject({
        queryRowsVerified: false,
        unavailable: true,
        rows: [],
        unavailableReasons: expect.arrayContaining([
          "invalid_model_observation",
        ]),
      });
      expect(JSON.stringify(evidence)).not.toContain(
        "sk-fixture-private-token",
      );
    } finally {
      h.dispose();
    }
  });

  it("caps observation rows without changing legacy aggregate counts", () => {
    const models = Array.from({ length: 65 }, (_, index) => ({
      model: `model-${index}`,
      supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    }));
    const h = observationHarness(() => ({ models }));
    try {
      h.state.payload.modelNames = models.map((model) => model.model);
      h.state.payload.models = models.map((model) => ({
        model: model.model,
        supported_reasoning_levels: ["high"],
      }));
      const original = h.read();
      const detailed = h.read({ includeModelObservations: true })!;
      const { modelObservations, ...counts } = detailed;
      expect(counts).toEqual(original);
      const snapshot = modelObservations as ModelObservationSnapshot;
      expect(snapshot.rows).toHaveLength(64);
      expect(snapshot).toMatchObject({
        renderedMenuVerified: false,
        queryRowsVerified: false,
        truncated: true,
        unavailable: true,
        unavailableReasons: expect.arrayContaining(["row_limit"]),
      });
      expect(snapshot.rows.at(-1)?.model).toBe("model-63");
    } finally {
      h.dispose();
    }
  });

  it.each(["pending", "error"])(
    "reports unavailable %s selected-query evidence without returning rows",
    (status) => {
      const observer = {
        options: { queryKey: key },
        getCurrentResult: () => ({ status, data: { models: [row()] } }),
      };
      const cache = {
        getAll: () => [{ queryKey: key, observers: [observer] }],
      };
      const state = {
        payload: payload(),
        reasoningQueryCaches: new Map([[cache, {}]]),
        nativeReasoningVisibilityRequired: true,
        currentNativeCaches: new Set([cache]),
        nativeVisibleEfforts: new Set(efforts),
        visibilityStatus: "known",
        visibilityReadCount: 0,
      };
      expect(
        observations(loadDiagnostics(state, observationVisibility)),
      ).toMatchObject({
        queryRowsVerified: false,
        unavailable: true,
        rows: [],
        unavailableReasons: expect.arrayContaining([
          status === "error" ? "picker_query_error" : "picker_query_pending",
        ]),
      });
    },
  );

  it("never certifies a partial selected-row snapshot after an unreadable sibling", () => {
    const trap = vi.fn(() => {
      throw new Error("private sibling");
    });
    const h = observationHarness(() => ({
      models: [
        row(),
        {
          model: "second",
          get supportedReasoningEfforts() {
            return trap();
          },
        },
      ],
    }));
    try {
      h.state.payload.modelNames.push("second");
      h.state.payload.models.push({
        model: "second",
        supported_reasoning_levels: [...efforts],
      });
      expect(observations(h.read)).toMatchObject({
        queryRowsVerified: false,
        unavailable: true,
        truncated: false,
        rows: [{ model: "relay" }],
        unavailableReasons: expect.arrayContaining([
          "unreadable_picker_evidence",
        ]),
      });
      expect(trap).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  });

  it("marks an unavailable catalog explicitly without leaking its data", () => {
    const h = observationHarness((value) => ({ models: value.data }));
    try {
      h.state.payload.catalogAvailable = false;
      expect(observations(h.read)).toMatchObject({
        queryRowsVerified: false,
        unavailable: true,
        rows: [],
        unavailableReasons: expect.arrayContaining([
          "catalog_unavailable",
          "no_verified_query_rows",
        ]),
      });
    } finally {
      h.dispose();
    }
  });

  it("does not invoke an accessor to enable optional observations", () => {
    const h = observationHarness((value) => ({ models: value.data }));
    const trap = vi.fn(() => true);
    try {
      const options = Object.defineProperty({}, "includeModelObservations", {
        get: trap,
      });
      expect(h.read(options)).toEqual(h.read());
      expect(trap).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  });
});
