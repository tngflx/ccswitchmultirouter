// Native Desktop has only enum effort tokens: an empty effort list becomes
// "medium" in both its model-settings and power-picker consumers. The model
// patch supplies a renderer-only Boolean adapter; this fragment presents that
// adapter as on/off without claiming provider-native graded capabilities.
// All DOM is reversible presentation. The current native callback remains the
// only writer of selection state; no capability or preference is persisted.
const nativeBooleanInstallation = {};
const nativeBooleanOwn = (value, key) => {
  if (!value || !["object", "function"].includes(typeof value))
    return undefined;
  try {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field && "value" in field ? field.value : undefined;
  } catch {
    return undefined;
  }
};
const nativeBooleanMarker = (value) => {
  const marker = nativeBooleanOwn(value, "ccSwitchReasoningControl");
  const fingerprint = nativeBooleanOwn(marker, "fingerprint");
  const disableAllowed = nativeBooleanOwn(marker, "disableAllowed");
  return nativeBooleanOwn(marker, "kind") === "boolean" &&
    typeof disableAllowed === "boolean" &&
    typeof fingerprint === "string" &&
    fingerprint.trim().length > 0
    ? { fingerprint, disableAllowed }
    : null;
};
const nativeBooleanAdapterEffortsMatch = (row, marker) => {
  const levels = nativeBooleanOwn(row, "supportedReasoningEfforts");
  const expected = marker.disableAllowed ? ["none", "medium"] : ["medium"];
  if (
    !Array.isArray(levels) ||
    nativeBooleanOwn(levels, "length") !== expected.length
  )
    return false;
  const actual = expected.map((_, index) =>
    nativeBooleanOwn(
      nativeBooleanOwn(levels, String(index)),
      "reasoningEffort",
    ),
  );
  return (
    actual.length === new Set(actual).size &&
    expected.every((effort) => actual.includes(effort))
  );
};
const nativeBooleanSameMarker = (left, right) =>
  left &&
  right &&
  left.fingerprint === right.fingerprint &&
  left.disableAllowed === right.disableAllowed;
const nativeBooleanProvider = () => {
  if (typeof installationIsCurrent === "function" && !installationIsCurrent())
    return null;
  const payload = currentPayload();
  const provider = nativeBooleanOwn(payload, "modelProvider");
  return nativeBooleanOwn(payload, "catalogAvailable") === true &&
    nativeBooleanOwn(payload, "catalogReleased") !== true &&
    state.catalogReleased !== true &&
    typeof provider === "string" &&
    provider.trim() &&
    provider.trim() !== "openai"
    ? provider.trim()
    : null;
};
// React may keep the initially attached host Fiber after it has committed its
// alternate. Accept only the branch whose EVERY child edge belongs to the
// current root. A .return chain alone can end at the new root while still
// containing abandoned siblings, so it is not sufficient ownership proof.
const CODEX_NATIVE_CURRENT_FIBER_PATH_LIMIT = 1024;
const nativeBooleanCurrentFiberPath = (button) => {
  if (!button?.isConnected || button.ownerDocument !== document) return null;
  let keys;
  try {
    keys = Object.getOwnPropertyNames(button).filter(
      (key) =>
        key.startsWith("__reactFiber") ||
        key.startsWith("__reactInternalInstance"),
    );
  } catch {
    return null;
  }
  if (keys.length !== 1) return null;
  const attached = nativeBooleanOwn(button, keys[0]);
  const starts = [attached, nativeBooleanOwn(attached, "alternate")].filter(
    Boolean,
  );
  const paths = [];
  for (const start of starts) {
    if (nativeBooleanOwn(start, "stateNode") !== button) continue;
    const path = [];
    const seen = new Set();
    let fiber = start;
    let valid = true;
    for (
      let depth = 0;
      fiber && depth < CODEX_NATIVE_CURRENT_FIBER_PATH_LIMIT;
      depth += 1
    ) {
      if (seen.has(fiber)) {
        valid = false;
        break;
      }
      seen.add(fiber);
      path.push(fiber);
      const parent = nativeBooleanOwn(fiber, "return");
      if (!parent) break;
      let child = nativeBooleanOwn(parent, "child");
      const siblings = new Set();
      let found = false;
      for (let index = 0; child && index < 512; index += 1) {
        if (siblings.has(child)) break;
        siblings.add(child);
        if (child === fiber) {
          found = true;
          break;
        }
        child = nativeBooleanOwn(child, "sibling");
      }
      if (!found) {
        valid = false;
        break;
      }
      fiber = parent;
    }
    const root = path[path.length - 1];
    if (
      !valid ||
      nativeBooleanOwn(root, "return") ||
      nativeBooleanOwn(root, "tag") !== 3
    )
      continue;
    const rootState = nativeBooleanOwn(root, "stateNode");
    const container = nativeBooleanOwn(rootState, "containerInfo");
    if (
      nativeBooleanOwn(rootState, "current") !== root ||
      !container?.isConnected ||
      typeof container.contains !== "function" ||
      !container.contains(button)
    )
      continue;
    paths.push(path);
  }
  return paths.length === 1 ? paths[0] : null;
};
const nativeBooleanBinding = (button) => {
  const provider = nativeBooleanProvider();
  const path = provider && nativeBooleanCurrentFiberPath(button);
  if (!path) return null;
  const candidates = [];
  for (let index = 0; index < path.length; index += 1) {
    const props = nativeBooleanOwn(path[index], "memoizedProps");
    const candidate = nativeBooleanOwn(props, "selectedLabelCandidate");
    const callback = nativeBooleanOwn(props, "onSelectPower");
    if (
      candidate &&
      typeof callback === "function" &&
      Array.isArray(nativeBooleanOwn(props, "powerSelections")) &&
      nativeBooleanOwn(props, "triggerConfig") &&
      typeof nativeBooleanOwn(props, "triggerConfig") === "object"
    ) {
      candidates.push({ props, candidate, callback, index });
    }
  }
  if (candidates.length !== 1) return null;
  const native = candidates[0];
  const model = nativeBooleanOwn(native.candidate, "model");
  const effort = nativeBooleanOwn(native.candidate, "reasoningEffort");
  const label = nativeBooleanOwn(native.candidate, "modelLabel");
  if (
    typeof model !== "string" ||
    !model.trim() ||
    !["none", "medium"].includes(effort) ||
    typeof label !== "string" ||
    !label.trim()
  )
    return null;
  const payload = currentPayload();
  const row = catalogRowForName(model);
  const marker = nativeBooleanMarker(row);
  const descriptorMarker = nativeBooleanMarker(descriptorFor(model));
  const includedNames = nativeBooleanOwn(payload, "modelNames");
  if (
    !row ||
    nativeBooleanOwn(row, "model") !== model ||
    nativeBooleanOwn(row, "enabled") === false ||
    (Array.isArray(includedNames) && !includedNames.includes(model)) ||
    !nativeBooleanSameMarker(marker, descriptorMarker) ||
    (!marker.disableAllowed && effort === "none")
  )
    return null;
  const owners = [];
  for (let index = native.index + 1; index < path.length; index += 1) {
    const props = nativeBooleanOwn(path[index], "memoizedProps");
    const models = nativeBooleanOwn(props, "models");
    if (
      nativeBooleanOwn(props, "model") !== model ||
      !Array.isArray(models) ||
      typeof nativeBooleanOwn(props, "onSelectModel") !== "function"
    )
      continue;
    if (models.length > 2048) return null;
    const matched = models.filter(
      (value) => nativeBooleanOwn(value, "model") === model,
    );
    if (
      matched.length !== 1 ||
      nativeBooleanOwn(matched[0], "enabled") === false ||
      !nativeBooleanSameMarker(marker, nativeBooleanMarker(matched[0])) ||
      !nativeBooleanAdapterEffortsMatch(matched[0], marker)
    )
      return null;
    owners.push(props);
  }
  if (owners.length !== 1) return null;
  const owner = owners[0];
  const ownerEffort = nativeBooleanOwn(owner, "reasoningEffort");
  if (ownerEffort !== effort) return null;
  const effects = button.querySelectorAll(
    "[class*='ModelPickerTriggerEffortLabel-']",
  );
  if (effects.length !== 1) return null;
  const effect = effects[0];
  const parent = button.parentElement;
  if (!parent || !effect.parentElement || effect.closest("button") !== button)
    return null;
  const disabled =
    button.disabled ||
    button.getAttribute("aria-disabled") === "true" ||
    nativeBooleanOwn(native.candidate, "isLocked") === true ||
    nativeBooleanOwn(
      nativeBooleanOwn(native.props, "selectedPowerSelection"),
      "isLocked",
    ) === true ||
    ["disabled", "modelSelectionDisabled", "powerSelectionDisabled"].some(
      (key) => nativeBooleanOwn(native.props, key) === true,
    ) ||
    ["disabled", "modelOptionsDisabled", "reasoningEffortDisabled"].some(
      (key) => nativeBooleanOwn(owner, key) === true,
    ) ||
    nativeBooleanOwn(nativeBooleanOwn(owner, "daybreak"), "isSaving") === true;
  return {
    provider,
    payload,
    row,
    model,
    effort,
    label,
    marker,
    ...native,
    owner,
    effect,
    parent,
    disabled,
    root: path[path.length - 1],
  };
};
const nativeBooleanRestoreRecord = (record) => {
  record.active = false;
  record.toggle.removeEventListener("click", record.onClick);
  record.toggle.remove();
  record.label.remove();
  const effect = record.effect;
  if (
    effect.style.getPropertyValue("display") === "none" &&
    effect.style.getPropertyPriority("display") === "important"
  ) {
    if (record.display.value)
      effect.style.setProperty(
        "display",
        record.display.value,
        record.display.priority,
      );
    else effect.style.removeProperty("display");
  }
  if (effect.getAttribute("aria-hidden") === "true") {
    if (record.effectAria === null) effect.removeAttribute("aria-hidden");
    else effect.setAttribute("aria-hidden", record.effectAria);
  }
  if (record.button.getAttribute("aria-label") === record.ariaApplied) {
    if (record.buttonAria === null) record.button.removeAttribute("aria-label");
    else record.button.setAttribute("aria-label", record.buttonAria);
  }
};
const disconnectNativeBooleanReasoningObserver = () => {
  const entry = state.nativeBooleanReasoningObserver;
  if (!entry) return;
  state.nativeBooleanReasoningObserver = null;
  entry.active = false;
  entry.observer.disconnect();
  if (entry.frame !== null && typeof entry.cancelFrame === "function")
    entry.cancelFrame(entry.frame);
  entry.frame = null;
};
const restoreNativeBooleanReasoningControls = () => {
  // Disconnect before restoring DOM, otherwise our own cleanup would schedule
  // a new installation after catalog release or renderer disposal.
  disconnectNativeBooleanReasoningObserver();
  const records = state.nativeBooleanReasoningControls;
  for (const record of records?.values() || [])
    nativeBooleanRestoreRecord(record);
  records?.clear();
};
const nativeBooleanMatchesRecord = (record, binding) =>
  binding &&
  record.active &&
  record.provider === binding.provider &&
  record.payload === binding.payload &&
  record.row === binding.row &&
  record.model === binding.model &&
  record.root === binding.root &&
  record.callback === binding.callback &&
  record.effect === binding.effect &&
  record.parent === binding.parent &&
  nativeBooleanSameMarker(record.marker, binding.marker);
const syncNativeBooleanReasoningControls = () => {
  state.nativeBooleanReasoningControls =
    state.nativeBooleanReasoningControls || new Map();
  const records = state.nativeBooleanReasoningControls;
  if (!nativeBooleanProvider()) {
    restoreNativeBooleanReasoningControls();
    return;
  }
  const effects = document.querySelectorAll(
    "[class*='ModelPickerTriggerEffortLabel-']",
  );
  if (effects.length > 32) {
    restoreNativeBooleanReasoningControls();
    return;
  }
  const active = new Set();
  for (const effect of effects) {
    const button = effect.closest("button");
    const binding = button && nativeBooleanBinding(button);
    if (!binding) continue;
    active.add(button);
    let record = records.get(button);
    if (
      record &&
      (record.provider !== binding.provider ||
        record.model !== binding.model ||
        !nativeBooleanSameMarker(record.marker, binding.marker) ||
        record.effect !== binding.effect ||
        record.parent !== binding.parent ||
        !record.toggle.isConnected ||
        !record.label.isConnected)
    ) {
      nativeBooleanRestoreRecord(record);
      records.delete(button);
      record = null;
    }
    if (!record) {
      const label = document.createElement("span");
      label.setAttribute("data-ccswitch-boolean-reasoning-label", "");
      label.style.cssText =
        "margin-inline-start:4px;opacity:.7;white-space:nowrap";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-label", "Thinking");
      toggle.setAttribute("data-ccswitch-boolean-reasoning-toggle", "");
      toggle.style.cssText =
        "margin-inline-start:6px;padding:2px 7px;border:1px solid currentColor;border-radius:999px;background:transparent;color:inherit;font:inherit;white-space:nowrap";
      record = {
        ...binding,
        button,
        label,
        toggle,
        active: true,
        pending: false,
        display: {
          value: effect.style.getPropertyValue("display"),
          priority: effect.style.getPropertyPriority("display"),
        },
        effectAria: effect.getAttribute("aria-hidden"),
        buttonAria: button.getAttribute("aria-label"),
        ariaApplied: null,
      };
      record.onClick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const current = nativeBooleanBinding(button);
        if (!nativeBooleanMatchesRecord(record, current)) {
          nativeBooleanRestoreRecord(record);
          records.delete(button);
          return;
        }
        if (
          record.pending ||
          current.disabled ||
          !current.marker.disableAllowed
        )
          return;
        // Never optimistically change the selected state. The callback owns
        // native selection; the next current Fiber observation updates us.
        record.pending = true;
        record.toggle.disabled = true;
        try {
          const selection = {};
          for (const [key, field] of Object.entries(
            Object.getOwnPropertyDescriptors(current.candidate),
          )) {
            if (field.enumerable && "value" in field)
              Object.defineProperty(selection, key, {
                value: field.value,
                enumerable: true,
                writable: true,
                configurable: true,
              });
          }
          selection.reasoningEffort =
            current.effort === "none" ? "medium" : "none";
          selection.id = `${current.model}:${selection.reasoningEffort}`;
          const result = current.callback(selection);
          Promise.resolve(result)
            .catch(() => {
              if (typeof recordFailure === "function")
                recordFailure("Boolean thinking selection failed");
            })
            .finally(() => {
              record.pending = false;
              if (record.active) syncNativeBooleanReasoningControls();
            });
        } catch {
          record.pending = false;
          if (typeof recordFailure === "function")
            recordFailure("Boolean thinking selection failed");
          syncNativeBooleanReasoningControls();
        }
      };
      toggle.addEventListener("click", record.onClick);
      records.set(button, record);
      effect.parentElement.appendChild(label);
      button.insertAdjacentElement("afterend", toggle);
    }
    // A fresh, fully validated observation may rebind current native props and
    // callbacks in place. Recreating our DOM for every ordinary React commit
    // causes focus loss/flicker and feeds unnecessary childList mutations back
    // into the guardian. Clicks still require this exact verified binding.
    const { label: nativeLabel, ...currentBinding } = binding;
    Object.assign(record, currentBinding);
    // Native rerenders can update attributes on an existing host. Remember
    // their latest values before applying our reversible presentation again.
    const display = effect.style.getPropertyValue("display");
    const priority = effect.style.getPropertyPriority("display");
    if (display !== "none" || priority !== "important")
      record.display = { value: display, priority };
    const effectAria = effect.getAttribute("aria-hidden");
    if (effectAria !== "true") record.effectAria = effectAria;
    const buttonAria = button.getAttribute("aria-label");
    if (buttonAria !== record.ariaApplied) record.buttonAria = buttonAria;
    const on = binding.effort !== "none";
    const text = on ? "Thinking on" : "Thinking off";
    if (display !== "none" || priority !== "important")
      effect.style.setProperty("display", "none", "important");
    if (effectAria !== "true") effect.setAttribute("aria-hidden", "true");
    if (record.label.textContent !== text) record.label.textContent = text;
    record.ariaApplied = `${binding.label}, ${text}`;
    if (buttonAria !== record.ariaApplied)
      button.setAttribute("aria-label", record.ariaApplied);
    if (record.toggle.getAttribute("aria-checked") !== String(on))
      record.toggle.setAttribute("aria-checked", String(on));
    const toggleText = on ? "On" : "Off";
    if (record.toggle.textContent !== toggleText)
      record.toggle.textContent = toggleText;
    const disabled = Boolean(
      record.pending || binding.disabled || !binding.marker.disableAllowed,
    );
    if (record.toggle.disabled !== disabled) record.toggle.disabled = disabled;
    const title = binding.marker.disableAllowed
      ? "Toggle thinking on or off. This model has no graded reasoning effort."
      : "Thinking is required for this model.";
    if (record.toggle.title !== title) record.toggle.title = title;
  }
  for (const [button, record] of records) {
    if (active.has(button)) continue;
    nativeBooleanRestoreRecord(record);
    records.delete(button);
  }
  installNativeBooleanReasoningObserver();
};
const nativeBooleanOwnedNode = (node) => {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  return Boolean(
    element?.closest?.(
      "[data-ccswitch-boolean-reasoning-label], [data-ccswitch-boolean-reasoning-toggle]",
    ),
  );
};
const nativeBooleanSubtreeHasTrigger = (node) => {
  const pending = node?.nodeType === 1 ? [node] : [];
  for (let index = 0; index < pending.length && index < 256; index += 1) {
    const element = pending[index];
    if (nativeBooleanOwnedNode(element)) continue;
    if (element.matches?.("[class*='ModelPickerTriggerEffortLabel-']"))
      return true;
    for (
      let child = element.firstElementChild;
      child;
      child = child.nextElementSibling
    ) {
      if (pending.length >= 256) return true; // One coalesced exact-trigger scan, never an unbounded tree walk.
      pending.push(child);
    }
  }
  return false;
};
const nativeBooleanMutationIsRelevant = (mutation) => {
  if (nativeBooleanOwnedNode(mutation.target)) return false;
  const records = state.nativeBooleanReasoningControls;
  const changed =
    mutation.type === "childList"
      ? [...mutation.addedNodes, ...mutation.removedNodes]
      : [];
  if (changed.length && changed.every(nativeBooleanOwnedNode)) return false;
  for (const record of records?.values() || []) {
    if (!record.active) continue;
    // These exact current values are our presentation, not another native
    // selection. Ignoring them prevents observer feedback after a real update.
    if (
      mutation.type === "attributes" &&
      mutation.target === record.button &&
      mutation.attributeName === "aria-label" &&
      record.button.getAttribute("aria-label") === record.ariaApplied
    )
      return false;
    if (
      record.button === mutation.target ||
      record.button.contains(mutation.target)
    )
      return true;
    for (const node of changed.slice(0, 32)) {
      if (
        node === record.button ||
        node === record.effect ||
        (node.nodeType === 1 && node.contains(record.button))
      )
        return true;
    }
  }
  return changed.slice(0, 32).some(nativeBooleanSubtreeHasTrigger);
};
const installNativeBooleanReasoningObserver = () => {
  if (!nativeBooleanProvider() || typeof MutationObserver !== "function")
    return false;
  const roots = [];
  const root = document.getElementById("root");
  if (root?.isConnected) roots.push(root);
  for (const record of state.nativeBooleanReasoningControls?.values() || []) {
    const container = nativeBooleanOwn(
      nativeBooleanOwn(record.root, "stateNode"),
      "containerInfo",
    );
    if (container?.isConnected && !roots.includes(container))
      roots.push(container);
    if (roots.length > 16) {
      disconnectNativeBooleanReasoningObserver();
      return false;
    }
  }
  if (!roots.length) {
    disconnectNativeBooleanReasoningObserver();
    return false;
  }
  const retained = state.nativeBooleanReasoningObserver;
  if (
    retained?.owner === nativeBooleanInstallation &&
    retained.active &&
    retained.roots.length === roots.length &&
    roots.every((value, index) => value === retained.roots[index])
  )
    return true;
  disconnectNativeBooleanReasoningObserver();
  const view = document.defaultView;
  const entry = {
    owner: nativeBooleanInstallation,
    active: true,
    roots,
    frame: null,
    scheduled: false,
    cancelFrame:
      typeof view?.cancelAnimationFrame === "function"
        ? view.cancelAnimationFrame.bind(view)
        : null,
  };
  const schedule = () => {
    if (
      entry.scheduled ||
      !entry.active ||
      state.nativeBooleanReasoningObserver !== entry
    )
      return;
    entry.scheduled = true;
    const update = () => {
      entry.frame = null;
      entry.scheduled = false;
      if (
        !entry.active ||
        state.nativeBooleanReasoningObserver !== entry ||
        entry.owner !== nativeBooleanInstallation
      )
        return;
      if (!nativeBooleanProvider()) {
        restoreNativeBooleanReasoningControls();
        return;
      }
      syncNativeBooleanReasoningControls();
    };
    if (typeof view?.requestAnimationFrame === "function")
      entry.frame = view.requestAnimationFrame(update);
    else queueMicrotask(update);
  };
  entry.observer = new MutationObserver((mutations) => {
    if (!entry.active || state.nativeBooleanReasoningObserver !== entry) return;
    // Only this known trigger's text/disabled state, or a bounded native
    // trigger mount/removal, schedules work. Streaming transcript mutations and
    // unrelated app internals do not cause another React scan or DOM write.
    if (mutations.slice(0, 256).some(nativeBooleanMutationIsRelevant))
      schedule();
  });
  state.nativeBooleanReasoningObserver = entry;
  const parents = new Set();
  for (const target of roots) {
    entry.observer.observe(target, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "disabled",
        "aria-disabled",
        "aria-label",
        "data-reasoning-effort",
        "class",
      ],
    });
    const parent = target.parentElement;
    if (parent && !roots.includes(parent)) parents.add(parent);
  }
  for (const parent of parents)
    entry.observer.observe(parent, { childList: true });
  return true;
};
// This is separate from runtime installation and model/list correctness. Only
// a currently owned, correctly labelled native control proves that these
// binary aliases are actually usable despite account-wide graded preferences.
const readNativeBooleanReasoningControlState = (model) => {
  const row = typeof model === "string" ? catalogRowForName(model) : null;
  const marker = nativeBooleanMarker(row);
  if (
    !nativeBooleanProvider() ||
    !row ||
    nativeBooleanOwn(row, "enabled") === false ||
    !marker
  ) {
    return { status: "not_active", model };
  }
  const records = state.nativeBooleanReasoningControls;
  const ready = [];
  for (const record of records?.values() || []) {
    if (record.model !== model) continue;
    const binding = nativeBooleanBinding(record.button);
    if (!nativeBooleanMatchesRecord(record, binding)) continue;
    const on = binding.effort !== "none";
    const text = on ? "Thinking on" : "Thinking off";
    if (
      !record.label.isConnected ||
      !record.toggle.isConnected ||
      record.toggle.parentElement !== binding.parent ||
      record.label.parentElement !== binding.effect.parentElement ||
      binding.effect.style.getPropertyValue("display") !== "none" ||
      binding.effect.getAttribute("aria-hidden") !== "true" ||
      record.label.textContent !== text ||
      record.button.getAttribute("aria-label") !==
        `${binding.label}, ${text}` ||
      record.toggle.getAttribute("role") !== "switch" ||
      record.toggle.getAttribute("aria-label") !== "Thinking" ||
      record.toggle.getAttribute("aria-checked") !== String(on) ||
      record.toggle.disabled !==
        Boolean(record.pending || binding.disabled || !marker.disableAllowed)
    )
      continue;
    ready.push({
      status: "ready",
      model,
      selectedState: on ? "on" : "off",
      visibleStates: marker.disableAllowed ? ["off", "on"] : ["on"],
    });
  }
  return ready.length === 1 ? ready[0] : { status: "unverified", model };
};
// Reinjection owns a new generation. Old scheduled frames and listeners are
// restoration state only and cannot survive registration of the new helpers.
if (typeof state.nativeBooleanReasoningRestore === "function")
  state.nativeBooleanReasoningRestore();
state.nativeBooleanReasoningRestore = restoreNativeBooleanReasoningControls;
state.readNativeBooleanReasoningControlDiagnostics =
  readNativeBooleanReasoningControlState;
