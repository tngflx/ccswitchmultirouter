import { readFileSync } from "node:fs";
import path from "node:path";
import React, { useMemo, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Control = { kind: string; disableAllowed: boolean; fingerprint: string };
type Row = {
  model: string;
  enabled?: boolean;
  ccSwitchReasoningControl?: Control;
  supportedReasoningEfforts?: {
    reasoningEffort: string;
    description?: string;
  }[];
};
type Candidate = {
  id: string;
  model: string;
  modelLabel: string;
  reasoningEffort: string;
};
type Runtime = {
  payload: {
    modelProvider: string;
    catalogAvailable: boolean;
    catalogReleased?: boolean;
    models: Row[];
  };
  catalogReleased?: boolean;
  [key: string]: unknown;
};
const resourcePath = path.resolve(
  process.cwd(),
  "src-tauri/src/resources/codex_desktop/native_boolean_reasoning.js",
);
const resource = readFileSync(resourcePath, "utf8");
const booleanRow = (disableAllowed = true): Row => ({
  model: "xiaomi/mimo-v2.6-pro",
  ccSwitchReasoningControl: {
    kind: "boolean",
    disableAllowed,
    fingerprint: "boolean-model-contract-v1",
  },
  supportedReasoningEfforts: [
    ...(disableAllowed
      ? [{ reasoningEffort: "none", description: "Thinking off" }]
      : []),
    { reasoningEffort: "medium", description: "Thinking on" },
  ],
});
const nativeHelpers = new Function(`
// Copied consumer rules from installed Codex 26.1106.6628.0: hI9J.MD/ER5p.SP and TWUU.CT.
const eE = e => ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"].includes(e);
const SP = (e,t) => eE(e) && t.includes(e) ? e : "medium";
const MD = (e,t) => eE(e) && t.some(t => t.reasoningEffort === e) ? e : SP(e,t.map(e => e.reasoningEffort));
const CT = e => e.flatMap(({model:n,supportedReasoningEfforts:r}) => { const o=r.flatMap(({reasoningEffort:e}) => eE(e) && e !== "persistent" ? [e] : []); return (o.length > 0 ? o : ["medium"]).map(e => ({id:n+":"+e,model:n,reasoningEffort:e})); });
return {MD,CT};
`)() as {
  MD: (effort: string, levels: Row["supportedReasoningEfforts"]) => string;
  CT: (rows: Row[]) => Candidate[];
};
const activeBridges: { restoreNativeBooleanReasoningControls: () => void }[] =
  [];
function bridge(rows: Row[] = [booleanRow()]) {
  const state: Runtime = {
    payload: {
      modelProvider: "codex_model_router_v2",
      catalogAvailable: true,
      models: rows,
    },
  };
  const lifecycle = { current: true };
  const api = new Function(
    "state",
    "document",
    "installationIsCurrent",
    `
const currentPayload = () => state.payload;
const catalogRowForName = name => { const rows = currentPayload().models.filter(row => row.model === name); return rows.length === 1 ? rows[0] : null; };
const descriptorFor = name => catalogRowForName(name);
const recordFailure = () => {};
${resource}
return {syncNativeBooleanReasoningControls,restoreNativeBooleanReasoningControls,readNativeBooleanReasoningControlState,nativeBooleanCurrentFiberPath};
`,
  )(state, document, () => lifecycle.current) as {
    nativeBooleanCurrentFiberPath: (button: HTMLElement) => object[] | null;
    syncNativeBooleanReasoningControls: () => void;
    restoreNativeBooleanReasoningControls: () => void;
    readNativeBooleanReasoningControlState: (model: string) => {
      status: string;
      model: string;
      selectedState?: string;
      visibleStates?: string[];
    };
  };
  activeBridges.push(api);
  return { state, lifecycle, ...api };
}
type PickerProps = {
  model: string;
  models: Row[];
  reasoningEffort: string;
  onSelectModel: (model: string, effort: string) => unknown;
  disabled?: boolean;
  saving?: boolean;
};
function NativeDropdown(props: {
  selectedLabelCandidate: Candidate;
  onSelectPower: (selection: Candidate) => unknown;
  powerSelections: Candidate[];
  triggerConfig: object;
  disabled?: boolean;
  modelSelectionDisabled?: boolean;
}) {
  return React.createElement(
    "div",
    { "data-testid": "composer" },
    React.createElement(
      "button",
      {
        type: "button",
        disabled: props.disabled,
        "aria-label": "Choose model Medium",
      },
      React.createElement(
        "span",
        { className: "ModelPickerTriggerLabel-fixture" },
        React.createElement(
          "span",
          { className: "ModelPickerTriggerModelGroup-fixture" },
          props.selectedLabelCandidate.modelLabel,
        ),
        React.createElement(
          "span",
          {
            className: "ModelPickerTriggerEffortLabel-fixture",
            style: { display: "inline-flex" },
          },
          React.createElement("span", { className: "sr-only" }, "Medium"),
          React.createElement(
            "span",
            {
              "data-reasoning-effort":
                props.selectedLabelCandidate.reasoningEffort,
            },
            props.selectedLabelCandidate.reasoningEffort === "none"
              ? "None"
              : "Medium",
          ),
        ),
      ),
    ),
  );
}
function NativePicker(props: PickerProps) {
  const row = props.models.find((row) => row.model === props.model)!;
  const effort = nativeHelpers.MD(
    props.reasoningEffort,
    row.supportedReasoningEfforts ?? [],
  );
  const candidate = useMemo(
    () => ({
      id: `${row.model}:${effort}`,
      model: row.model,
      modelLabel: "Xiaomi: MiMo-V2.6-Pro",
      reasoningEffort: effort,
    }),
    [row.model, effort],
  );
  return React.createElement(NativeDropdown, {
    selectedLabelCandidate: candidate,
    onSelectPower: (selection) =>
      props.onSelectModel(selection.model, selection.reasoningEffort),
    powerSelections: nativeHelpers.CT([row]),
    triggerConfig: {},
    disabled: props.disabled,
    modelSelectionDisabled: props.saving,
  });
}
function NativeHarness({
  row = booleanRow(),
  disabled = false,
  saving = false,
  onSelect = vi.fn(),
}: {
  row?: Row;
  disabled?: boolean;
  saving?: boolean;
  onSelect?: ReturnType<typeof vi.fn>;
}) {
  const [effort, setEffort] = useState("medium");
  return React.createElement(NativePicker, {
    model: row.model,
    models: [row],
    reasoningEffort: effort,
    disabled,
    saving,
    onSelectModel: (model, next) => {
      onSelect(model, next);
      setEffort(next);
    },
  });
}
const sync = (api: ReturnType<typeof bridge>) =>
  act(() => api.syncNativeBooleanReasoningControls());
afterEach(() => {
  for (const api of activeBridges.splice(0))
    api.restoreNativeBooleanReasoningControls();
  cleanup();
});

describe("native Boolean reasoning presentation", () => {
  const deepCurrentPath = (depth: number) => {
    const container = document.createElement("div");
    const button = document.createElement("button");
    container.appendChild(button);
    document.body.appendChild(container);
    const path: Record<string, unknown>[] = [{ stateNode: button }];
    while (path.length < depth) {
      const child = path[path.length - 1];
      const parent = { child };
      child.return = parent;
      path.push(parent);
    }
    const root = path[path.length - 1];
    Object.assign(root, {
      tag: 3,
      stateNode: { current: root, containerInfo: container },
    });
    Object.defineProperty(button, "__reactFiber$deepCurrentPath", {
      configurable: true,
      value: path[0],
    });
    return { button, container, path, root };
  };

  it.each([300, 1024])(
    "proves every committed edge of a valid %i-Fiber native button ancestry",
    (depth) => {
      const api = bridge();
      const h = deepCurrentPath(depth);
      try {
        const current = api.nativeBooleanCurrentFiberPath(h.button);
        expect(current).toHaveLength(depth);
        expect(current?.[0]).toBe(h.path[0]);
        expect(current?.[depth - 1]).toBe(h.root);
      } finally {
        h.container.remove();
      }
    },
  );

  it("refuses a 1025-Fiber ancestry beyond the exact supported current-path bound", () => {
    const api = bridge();
    const h = deepCurrentPath(1025);
    try {
      expect(api.nativeBooleanCurrentFiberPath(h.button)).toBeNull();
    } finally {
      h.container.remove();
    }
  });

  it.each(["stale root", "detached child", "ambiguous branch"] as const)(
    "still rejects a deep native button ancestry with %s",
    (fault) => {
      const api = bridge();
      const h = deepCurrentPath(300);
      if (fault === "stale root") {
        (h.root.stateNode as { current: object }).current = {};
      } else if (fault === "detached child") {
        h.path[1].child = {};
      } else {
        const alternate = { stateNode: h.button, return: h.path[1] };
        h.path[0].alternate = alternate;
        h.path[0].sibling = alternate;
      }
      try {
        expect(api.nativeBooleanCurrentFiberPath(h.button)).toBeNull();
      } finally {
        h.container.remove();
      }
    },
  );

  it("exposes the real installed native fallback and does not advertise a graded ladder", () => {
    const canonical: Row = {
      model: "xiaomi/mimo-v2.6-pro",
      supportedReasoningEfforts: [],
    };
    expect(nativeHelpers.MD("none", [])).toBe("medium");
    expect(
      nativeHelpers.CT([canonical]).map((row) => row.reasoningEffort),
    ).toEqual(["medium"]);
    expect(
      nativeHelpers.MD("none", booleanRow().supportedReasoningEfforts),
    ).toBe("none");
    expect(
      nativeHelpers.CT([booleanRow()]).map((row) => row.reasoningEffort),
    ).toEqual(["none", "medium"]);
  });

  it("removes the native Medium presentation and toggles through the real current native callback", async () => {
    const row = booleanRow();
    const onSelect = vi.fn();
    const api = bridge([row]);
    render(React.createElement(NativeHarness, { row, onSelect }));
    sync(api);
    const toggle = screen.getByRole("switch", { name: "Thinking" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("button", { name: /Xiaomi.*Thinking on/ }),
    ).toBeVisible();
    expect(
      document.querySelector("[class*='ModelPickerTriggerEffortLabel-']"),
    ).not.toBeVisible();
    fireEvent.click(toggle);
    await act(async () => {
      await Promise.resolve();
    });
    sync(api);
    expect(onSelect).toHaveBeenLastCalledWith(row.model, "none");
    expect(screen.getByRole("switch", { name: "Thinking" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(
      screen.getByRole("button", { name: /Xiaomi.*Thinking off/ }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("switch", { name: "Thinking" }));
    sync(api);
    expect(onSelect).toHaveBeenLastCalledWith(row.model, "medium");
    expect(screen.getByRole("switch", { name: "Thinking" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      row.supportedReasoningEfforts?.map((level) => level.reasoningEffort),
    ).toEqual(["none", "medium"]);
  });

  it.each(["graded", "budget", "unknown", "none"])(
    "leaves %s model controls untouched",
    (kind) => {
      const row = {
        ...booleanRow(),
        ccSwitchReasoningControl: {
          ...booleanRow().ccSwitchReasoningControl!,
          kind,
        },
      };
      const api = bridge([row]);
      render(React.createElement(NativeHarness, { row }));
      sync(api);
      expect(screen.queryByRole("switch")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Choose model Medium" }),
      ).toBeVisible();
      expect(
        document.querySelector("[class*='ModelPickerTriggerEffortLabel-']"),
      ).toBeVisible();
    },
  );

  it.each(["openai", "", "different-provider"])(
    "cannot reuse an installed control across provider %s",
    (provider) => {
      const row = booleanRow();
      const onSelect = vi.fn();
      const api = bridge([row]);
      render(React.createElement(NativeHarness, { row, onSelect }));
      sync(api);
      const toggle = screen.getByRole("switch");
      api.state.payload = { ...api.state.payload, modelProvider: provider };
      fireEvent.click(toggle);
      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    },
  );

  it.each([
    "released",
    "unavailable",
    "excluded",
    "missing",
    "duplicate",
    "fingerprint",
  ])("restores native presentation when the catalog becomes %s", (reason) => {
    const row = booleanRow();
    const onSelect = vi.fn();
    const api = bridge([row]);
    render(React.createElement(NativeHarness, { row, onSelect }));
    sync(api);
    const toggle = screen.getByRole("switch");
    if (reason === "released") api.state.catalogReleased = true;
    if (reason === "unavailable") api.state.payload.catalogAvailable = false;
    if (reason === "excluded")
      api.state.payload.models = [{ ...row, enabled: false }];
    if (reason === "missing") api.state.payload.models = [];
    if (reason === "duplicate") api.state.payload.models = [row, { ...row }];
    if (reason === "fingerprint")
      api.state.payload.models = [
        {
          ...row,
          ccSwitchReasoningControl: {
            ...row.ccSwitchReasoningControl!,
            fingerprint: "replacement",
          },
        },
      ];
    fireEvent.click(toggle);
    expect(onSelect).not.toHaveBeenCalled();
    sync(api);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose model Medium" }),
    ).toBeVisible();
    expect(
      document.querySelector("[class*='ModelPickerTriggerEffortLabel-']"),
    ).toHaveStyle({ display: "inline-flex" });
  });

  it.each(["disabled", "saving", "mandatory"])(
    "disables switching while %s",
    (mode) => {
      const row = booleanRow(mode !== "mandatory");
      const onSelect = vi.fn();
      const api = bridge([row]);
      render(
        React.createElement(NativeHarness, {
          row,
          onSelect,
          disabled: mode === "disabled",
          saving: mode === "saving",
        }),
      );
      sync(api);
      const toggle = screen.getByRole("switch");
      expect(toggle).toBeDisabled();
      fireEvent.click(toggle);
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it("never calls a callback replaced since the presentation was last verified", () => {
    const row = booleanRow();
    const first = vi.fn();
    const second = vi.fn();
    const api = bridge([row]);
    const view = render(
      React.createElement(NativeHarness, { row, onSelect: first }),
    );
    sync(api);
    const toggle = screen.getByRole("switch");
    view.rerender(
      React.createElement(NativeHarness, { row, onSelect: second }),
    );
    fireEvent.click(toggle);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    sync(api);
    fireEvent.click(screen.getByRole("switch"));
    expect(second).toHaveBeenLastCalledWith(row.model, "none");
  });

  it("rejects stale/disconnected roots and stale runtime installations", () => {
    const row = booleanRow();
    const onSelect = vi.fn();
    const api = bridge([row]);
    const view = render(React.createElement(NativeHarness, { row, onSelect }));
    sync(api);
    const oldToggle = screen.getByRole("switch");
    view.unmount();
    fireEvent.click(oldToggle);
    expect(onSelect).not.toHaveBeenCalled();
    render(React.createElement(NativeHarness, { row, onSelect }));
    sync(api);
    const toggle = screen.getByRole("switch");
    api.lifecycle.current = false;
    fireEvent.click(toggle);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("restores owned styles and aria values without overwriting later native writes", () => {
    const row = booleanRow();
    const api = bridge([row]);
    render(React.createElement(NativeHarness, { row }));
    sync(api);
    const native = screen.getByRole("button", { name: /Xiaomi.*Thinking on/ });
    native.setAttribute("aria-label", "Native replacement label");
    const effort = document.querySelector<HTMLElement>(
      "[class*='ModelPickerTriggerEffortLabel-']",
    )!;
    effort.style.display = "inline-block";
    act(() => api.restoreNativeBooleanReasoningControls());
    expect(native).toHaveAttribute("aria-label", "Native replacement label");
    expect(effort).toHaveStyle({ display: "inline-block" });
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("proves native binary-control visibility separately from runtime or model-list installation", () => {
    const row = booleanRow();
    const api = bridge([row]);
    const model = row.model;
    expect(api.readNativeBooleanReasoningControlState(model)).toEqual({
      status: "not_observed",
      model,
    });
    render(React.createElement(NativeHarness, { row }));
    expect(api.readNativeBooleanReasoningControlState(model).status).toBe(
      "not_observed",
    );
    sync(api);
    expect(api.readNativeBooleanReasoningControlState(model)).toEqual({
      status: "ready",
      model,
      selectedState: "on",
      visibleStates: ["off", "on"],
    });
    screen.getByRole("switch").setAttribute("aria-checked", "false");
    expect(api.readNativeBooleanReasoningControlState(model).status).toBe(
      "unverified",
    );
    sync(api);
    act(() => api.restoreNativeBooleanReasoningControls());
    expect(api.readNativeBooleanReasoningControlState(model).status).toBe(
      "not_observed",
    );
    api.state.payload.catalogReleased = true;
    expect(api.readNativeBooleanReasoningControlState(model).status).toBe(
      "not_active",
    );
  });

  it("moves mounted control proof to the new Boolean model without certifying the previous selection", () => {
    const first = booleanRow();
    const second = { ...booleanRow(false), model: "fixture/always-thinking" };
    const models = [first, second];
    const api = bridge(models);
    const onSelectModel = vi.fn();
    const picker = (model: string) =>
      React.createElement(NativePicker, {
        model,
        models,
        reasoningEffort: "medium",
        onSelectModel,
      });
    const view = render(picker(first.model));
    sync(api);
    expect(api.readNativeBooleanReasoningControlState(first.model)).toEqual({
      status: "ready",
      model: first.model,
      selectedState: "on",
      visibleStates: ["off", "on"],
    });
    expect(api.readNativeBooleanReasoningControlState(second.model)).toEqual({
      status: "not_observed",
      model: second.model,
    });

    view.rerender(picker(second.model));
    // Even before the adapter resyncs, a stale record is not current proof.
    expect(api.readNativeBooleanReasoningControlState(first.model)).toEqual({
      status: "unverified",
      model: first.model,
    });
    sync(api);
    const toggle = screen.getByRole("switch", { name: "Thinking" });
    expect(toggle).toBeDisabled();
    expect(api.readNativeBooleanReasoningControlState(second.model)).toEqual({
      status: "ready",
      model: second.model,
      selectedState: "on",
      visibleStates: ["on"],
    });
    toggle.setAttribute("aria-checked", "false");
    expect(api.readNativeBooleanReasoningControlState(second.model)).toEqual({
      status: "unverified",
      model: second.model,
    });
    expect(onSelectModel).not.toHaveBeenCalled();
  });

  it("cannot reuse a control after a same-provider payload replacement or same-model row replacement", () => {
    const row = booleanRow();
    const onSelect = vi.fn();
    const api = bridge([row]);
    render(React.createElement(NativeHarness, { row, onSelect }));
    sync(api);
    const first = screen.getByRole("switch");
    api.state.payload = { ...api.state.payload };
    fireEvent.click(first);
    expect(onSelect).not.toHaveBeenCalled();
    sync(api);
    const second = screen.getByRole("switch");
    api.state.payload.models = [{ ...row }];
    fireEvent.click(second);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not claim readiness for a second current-model control with ambiguous ownership", () => {
    const row = booleanRow();
    const api = bridge([row]);
    render(React.createElement(NativeHarness, { row }));
    render(React.createElement(NativeHarness, { row }));
    sync(api);
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    expect(api.readNativeBooleanReasoningControlState(row.model).status).toBe(
      "unverified",
    );
  });

  it("does not invoke accessor-shaped discovery data or trust a second attached fiber", () => {
    const row = booleanRow();
    const api = bridge([row]);
    render(React.createElement(NativeHarness, { row }));
    const button = screen.getByRole("button");
    const getter = vi.fn(() => {
      throw new Error("must not execute");
    });
    Object.defineProperty(button, "__reactFiber$uncertain", {
      configurable: true,
      get: getter,
    });
    sync(api);
    expect(getter).not.toHaveBeenCalled();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    delete (button as unknown as Record<string, unknown>)
      .__reactFiber$uncertain;
    sync(api);
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("does not act on an abandoned fiber whose return points at a current parent", () => {
    const row = booleanRow();
    const onSelect = vi.fn();
    const api = bridge([row]);
    render(React.createElement(NativeHarness, { row, onSelect }));
    const button = screen.getByRole("button");
    sync(api);
    const toggle = screen.getByRole("switch");
    const key = Object.getOwnPropertyNames(button).find((key) =>
      key.startsWith("__reactFiber"),
    )!;
    const original = Object.getOwnPropertyDescriptor(button, key)!;
    const fiber = original.value;
    Object.defineProperty(button, key, {
      ...original,
      value: { ...fiber, alternate: null },
    });
    fireEvent.click(toggle);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    Object.defineProperty(button, key, original);
  });

  it("restores the native graded UI when the selected model changes without replacing the DOM button", () => {
    const row = booleanRow();
    const graded: Row = {
      model: "graded/provider-model",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium" },
        { reasoningEffort: "high" },
      ],
    };
    const api = bridge([row, graded]);
    const view = render(React.createElement(NativeHarness, { row }));
    sync(api);
    const native = screen.getByRole("button", { name: /Xiaomi.*Thinking on/ });
    view.rerender(React.createElement(NativeHarness, { row: graded }));
    sync(api);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(native).toHaveAttribute("aria-label", "Choose model Medium");
    expect(
      document.querySelector("[class*='ModelPickerTriggerEffortLabel-']"),
    ).toBeVisible();
  });

  it("requires the complete binary adapter after native effort-preference filtering", () => {
    const row = booleanRow();
    const filtered = {
      ...row,
      supportedReasoningEfforts: row.supportedReasoningEfforts!.filter(
        (level) => level.reasoningEffort !== "none",
      ),
    };
    const api = bridge([row]);
    const view = render(React.createElement(NativeHarness, { row: filtered }));
    sync(api);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(api.readNativeBooleanReasoningControlState(row.model).status).toBe(
      "unverified",
    );
    view.rerender(React.createElement(NativeHarness, { row }));
    sync(api);
    expect(screen.getByRole("switch")).toBeInTheDocument();
    expect(api.readNativeBooleanReasoningControlState(row.model).status).toBe(
      "ready",
    );
  });

  it("reconciles a valid Fiber binding after an invalid observation without a DOM mutation", () => {
    const row = booleanRow();
    const filtered = {
      ...row,
      supportedReasoningEfforts: row.supportedReasoningEfforts!.filter(
        (level) => level.reasoningEffort !== "none",
      ),
    };
    const api = bridge([row]);
    const view = render(React.createElement(NativeHarness, { row: filtered }));
    sync(api);
    expect(api.readNativeBooleanReasoningControlState(row.model).status).toBe(
      "unverified",
    );

    const mutations = new MutationObserver(() => {});
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    view.rerender(React.createElement(NativeHarness, { row }));
    expect(mutations.takeRecords()).toEqual([]);
    expect(api.readNativeBooleanReasoningControlState(row.model)).toEqual({
      status: "ready",
      model: row.model,
      selectedState: "on",
      visibleStates: ["off", "on"],
    });
    mutations.disconnect();
  });

  it("recovers the native control after a rejected async selection callback", async () => {
    const row = booleanRow();
    const api = bridge([row]);
    const onSelectModel = vi.fn(() => Promise.reject(new Error("rejected")));
    render(
      React.createElement(NativePicker, {
        model: row.model,
        models: [row],
        reasoningEffort: "medium",
        onSelectModel,
      }),
    );
    sync(api);
    fireEvent.click(screen.getByRole("switch", { name: "Thinking" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSelectModel).toHaveBeenCalledWith(row.model, "none");
    expect(screen.getByRole("switch", { name: "Thinking" })).toBeEnabled();
    expect(api.readNativeBooleanReasoningControlState(row.model)).toEqual({
      status: "ready",
      model: row.model,
      selectedState: "on",
      visibleStates: ["off", "on"],
    });
  });

  it("does not rewrite native or owned DOM during an unchanged heartbeat", () => {
    const row = booleanRow();
    const api = bridge([row]);
    render(React.createElement(NativeHarness, { row }));
    sync(api);
    const mutations = new MutationObserver(() => {});
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    sync(api);
    sync(api);
    sync(api);
    expect(mutations.takeRecords()).toEqual([]);
    mutations.disconnect();
  });

  it("observes a native selection rerender before the fallback heartbeat", async () => {
    const row = booleanRow();
    const api = bridge([row]);
    const onSelect = vi.fn();
    const view = render(
      React.createElement(NativePicker, {
        model: row.model,
        models: [row],
        reasoningEffort: "medium",
        onSelectModel: onSelect,
      }),
    );
    sync(api);
    const ownToggle = screen.getByRole("switch");
    view.rerender(
      React.createElement(NativePicker, {
        model: row.model,
        models: [row],
        reasoningEffort: "none",
        onSelectModel: onSelect,
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByRole("switch")).toBe(ownToggle);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("button", { name: /Xiaomi.*Thinking off/ }),
    ).toBeVisible();
    expect(api.readNativeBooleanReasoningControlState(row.model).status).toBe(
      "ready",
    );
  });

  it("disconnects its observer and cancels deferred reconciliation on release", async () => {
    const row = booleanRow();
    const api = bridge([row]);
    render(React.createElement(NativeHarness, { row }));
    sync(api);
    const entry = api.state.nativeBooleanReasoningObserver as
      { observer: MutationObserver } | undefined;
    expect(entry).toBeDefined();
    const disconnected = vi.spyOn(entry!.observer, "disconnect");
    screen
      .getByRole("button", { name: /Xiaomi.*Thinking on/ })
      .setAttribute("aria-label", "Native rerender");
    await Promise.resolve();
    act(() => api.restoreNativeBooleanReasoningControls());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(disconnected).toHaveBeenCalledOnce();
    expect(api.state.nativeBooleanReasoningObserver).toBeNull();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});
