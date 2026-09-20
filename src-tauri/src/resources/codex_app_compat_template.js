(async () => {
  const payload = __CODEX_PAYLOAD_JSON__;
  const patchKey = "__CODEX_PATCH_KEY__";
  const state = window[patchKey] || {};
  state.payload = payload;
  state.requestIds = state.requestIds || new Set();
  state.modulePromises = state.modulePromises || new Map();
  state.failures = state.failures || [];
  const rendererSchedulerVersion = "2";
  if (state.rendererSchedulerVersion !== rendererSchedulerVersion) {
    if (state.interval) clearInterval(state.interval);
    try {
      state.modelPickerObserver?.disconnect();
    } catch {}
    state.interval = null;
    state.runPromise = null;
    state.modelPickerObserver = null;
    state.conversationRuntimeScanPromise = null;
    state.nextConversationRuntimeScanAt = 0;
    state.rendererSchedulerVersion = rendererSchedulerVersion;
  }
  window[patchKey] = state;
  __CODEX_MODEL_PICKER_CORE__;
  __CODEX_GUARDIAN_V2_COMPAT_CORE__;
  __CODEX_COMPACTION_ITEM_CORE__;
  const requestHealthWarningStorageKey = "ccswitch-request-health-warnings-v1";
  const requestHealthWarningContainerId =
    "ccswitch-request-health-warning-container";
  const readStoredRequestHealthWarnings = () => {
    try {
      const stored = JSON.parse(
        localStorage.getItem(requestHealthWarningStorageKey) || "[]",
      );
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  };
  const renderRequestHealthWarnings = (warnings) => {
    const now = Date.now();
    const active = (Array.isArray(warnings) ? warnings : [])
      .filter(
        (warning) =>
          warning &&
          typeof warning === "object" &&
          String(warning.token || "").trim() &&
          Number(warning.expiresAtMs) > now,
      )
      .sort(
        (left, right) => Number(left.expiresAtMs) - Number(right.expiresAtMs),
      );
    try {
      if (active.length) {
        localStorage.setItem(
          requestHealthWarningStorageKey,
          JSON.stringify(active),
        );
      } else {
        localStorage.removeItem(requestHealthWarningStorageKey);
      }
    } catch {}
    let container = document.getElementById(requestHealthWarningContainerId);
    if (!active.length) {
      container?.remove();
      if (state.requestHealthWarningExpiryTimer)
        clearTimeout(state.requestHealthWarningExpiryTimer);
      state.requestHealthWarningExpiryTimer = null;
      return { active: 0 };
    }
    if (!container) {
      container = document.createElement("section");
      container.id = requestHealthWarningContainerId;
      container.setAttribute("role", "status");
      container.setAttribute("aria-live", "assertive");
      Object.assign(container.style, {
        position: "fixed",
        top: "16px",
        right: "16px",
        zIndex: "2147483647",
        display: "grid",
        gap: "8px",
        width: "min(420px, calc(100vw - 32px))",
        maxHeight: "calc(100vh - 32px)",
        overflowY: "auto",
        pointerEvents: "none",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      });
      (document.body || document.documentElement).appendChild(container);
    }
    const activeTokens = new Set(
      active.map((warning) => String(warning.token)),
    );
    for (const existing of container.querySelectorAll(
      "[data-ccswitch-request-health-token]",
    )) {
      if (
        !activeTokens.has(
          String(existing.getAttribute("data-ccswitch-request-health-token")),
        )
      )
        existing.remove();
    }
    for (const warning of active) {
      const token = String(warning.token);
      let card = Array.from(
        container.querySelectorAll("[data-ccswitch-request-health-token]"),
      ).find(
        (candidate) =>
          candidate.getAttribute("data-ccswitch-request-health-token") ===
          token,
      );
      if (!card) {
        card = document.createElement("article");
        card.setAttribute("data-ccswitch-request-health-token", token);
        Object.assign(card.style, {
          border: "1px solid rgba(245, 158, 11, 0.65)",
          borderRadius: "10px",
          background: "rgba(24, 24, 27, 0.96)",
          color: "#fafafa",
          boxShadow: "0 18px 48px rgba(0, 0, 0, 0.38)",
          padding: "12px 14px",
          lineHeight: "1.4",
          pointerEvents: "none",
        });
        container.appendChild(card);
      }
      card.replaceChildren();
      const title = document.createElement("strong");
      title.textContent = String(
        warning.title || "Request paused for approval",
      );
      Object.assign(title.style, {
        display: "block",
        marginBottom: "4px",
        fontSize: "14px",
      });
      const detail = document.createElement("div");
      detail.textContent = String(warning.detail || "");
      Object.assign(detail.style, {
        fontSize: "12px",
        color: "#e4e4e7",
      });
      const instruction = document.createElement("div");
      instruction.textContent = String(warning.instruction || "");
      Object.assign(instruction.style, {
        marginTop: "7px",
        fontSize: "12px",
        fontWeight: "600",
        color: "#fbbf24",
      });
      card.append(title, detail, instruction);
    }
    if (state.requestHealthWarningExpiryTimer)
      clearTimeout(state.requestHealthWarningExpiryTimer);
    const nextExpiry = Math.min(
      ...active.map((warning) => Number(warning.expiresAtMs)),
    );
    state.requestHealthWarningExpiryTimer = setTimeout(
      () => renderRequestHealthWarnings(readStoredRequestHealthWarnings()),
      Math.max(50, nextExpiry - now + 25),
    );
    return { active: active.length };
  };
  state.syncRequestHealthWarnings = (warnings) =>
    renderRequestHealthWarnings(warnings);
  renderRequestHealthWarnings(readStoredRequestHealthWarnings());
  const installModelPickerSpacingFix = () => {
    const styleId = `${patchKey}-model-picker-spacing`;
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        [data-radix-popper-content-wrapper][data-ccswitch-model-picker="true"],
        [data-radix-popper-content-wrapper]:has([data-model-selected]) {
          max-width: min(92vw, 420px) !important;
          min-width: 280px !important;
        }
        [data-radix-popper-content-wrapper][data-ccswitch-model-picker="true"] [role="menuitem"],
        [data-radix-popper-content-wrapper]:has([data-model-selected]) [role="menuitem"] {
          min-height: 32px !important;
          padding-block: 6px !important;
          white-space: nowrap !important;
          flex-shrink: 0 !important;
        }
        [data-radix-popper-content-wrapper][data-ccswitch-model-picker="true"] [role="menuitem"] > *,
        [data-radix-popper-content-wrapper]:has([data-model-selected]) [role="menuitem"] > * {
          min-width: 0 !important;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }
    const labels = new Set(
      [
        ...modelNames(),
        ...(currentPayload().models || []).flatMap((model) => [
          model?.displayName,
          model?.display_name,
          model?.name,
        ]),
      ]
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim()),
    );
    for (const wrapper of document.querySelectorAll(
      "[data-radix-popper-content-wrapper]",
    )) {
      if (wrapper.querySelector("[data-model-selected]")) {
        wrapper.setAttribute("data-ccswitch-model-picker", "true");
        continue;
      }
      const items = Array.from(wrapper.querySelectorAll('[role="menuitem"]'));
      if (
        items.some((item) => {
          const text = String(item.textContent || "").trim();
          return (
            text && Array.from(labels).some((label) => text.includes(label))
          );
        })
      ) {
        wrapper.setAttribute("data-ccswitch-model-picker", "true");
      }
    }
  };
  const patchStatsigConfig = (name, config, repairLegacyPollution = false) => {
    const prepared = prepareStatsigDynamicConfig(
      name,
      config,
      repairLegacyPollution,
    );
    config = prepared.config;
    if (!prepared.patchModelWhitelist) return config;
    const value = config?.value;
    if (!value || typeof value !== "object") return config;
    const available = Array.isArray(value.available_models)
      ? [...value.available_models]
      : [];
    let changed = false;
    for (const name of modelNames()) {
      if (!available.includes(name)) {
        available.push(name);
        changed = true;
      }
    }
    const routed = modelNames().filter((name) => available.includes(name));
    const routedSet = new Set(modelNames());
    const untouched = available.filter((name) => !routedSet.has(name));
    const ordered = [...routed, ...untouched];
    if (available.some((name, index) => name !== ordered[index]))
      changed = true;
    const nextValue = {
      ...value,
      available_models: ordered,
      use_hidden_models: false,
      default_model: modelNames()[0] || value.default_model,
    };
    if (
      changed ||
      nextValue.default_model !== value.default_model ||
      value.use_hidden_models !== false
    ) {
      try {
        config.value = nextValue;
      } catch {
        return { ...config, value: nextValue };
      }
    }
    return config;
  };
  const statsigClients = () => {
    const root = window.__STATSIG__ || globalThis.__STATSIG__;
    if (!root || typeof root !== "object") return [];
    const clients = [
      root.firstInstance,
      typeof root.instance === "function" ? root.instance() : null,
    ];
    if (root.instances && typeof root.instances === "object")
      clients.push(...Object.values(root.instances));
    return clients.filter(
      (client, index, array) =>
        client && typeof client === "object" && array.indexOf(client) === index,
    );
  };
  const patchStatsig = () => {
    for (const client of statsigClients()) {
      if (typeof client.getDynamicConfig !== "function") continue;
      if (client.__ccSwitchStatsigPatchVersion !== "2") {
        const repairingLegacyPatch =
          client.__ccSwitchModelWhitelistPatched === true;
        const original =
          client.__ccSwitchOriginalGetDynamicConfig ||
          client.getDynamicConfig.bind(client);
        client.__ccSwitchOriginalGetDynamicConfig = original;
        client.getDynamicConfig = (name, options) =>
          patchStatsigConfig(
            name,
            original(name, options),
            repairingLegacyPatch,
          );
        client.__ccSwitchStatsigPatchVersion = "2";
      }
      try {
        patchStatsigConfig(
          "107580212",
          client.getDynamicConfig("107580212", { disableExposureLog: true }),
        );
      } catch {}
      try {
        patchStatsigConfig(
          guardianV2DynamicConfigName,
          client.getDynamicConfig(guardianV2DynamicConfigName, {
            disableExposureLog: true,
          }),
        );
      } catch {}
    }
  };
  const assetUrl = (namePart) => {
    const urls = [
      ...Array.from(document.scripts || []).map((script) => script.src),
      ...Array.from(document.querySelectorAll("link[href]") || []).map(
        (link) => link.href,
      ),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ].filter(Boolean);
    return (
      urls.find(
        (url) =>
          url.includes("/assets/") &&
          url.includes(namePart) &&
          url.split("?")[0].endsWith(".js"),
      ) || ""
    );
  };
  const loadAppModule = async (namePart) => {
    if (!state.modulePromises.has(namePart)) {
      state.modulePromises.set(
        namePart,
        Promise.resolve()
          .then(async () => {
            const url = assetUrl(namePart);
            if (!url) throw new Error(`Codex App asset not found: ${namePart}`);
            return await import(url);
          })
          .catch((error) => {
            state.modulePromises.delete(namePart);
            throw error;
          }),
      );
    }
    return await state.modulePromises.get(namePart);
  };
  // 新版 Codex/ChatGPT App 用 localThreadCatalog 保存统一侧边栏目录。这里只调用
  // App 自己的 RPC 同步服务，不直接改 codex-dev.db 或历史 provider 元数据。
  const triggerLocalThreadCatalogSync = async () => {
    if (state.historySyncPromise) return await state.historySyncPromise;
    state.historySyncPromise = Promise.resolve()
      .then(async () => {
        const module = await loadAppModule("rpc-");
        const roots = Object.values(module).filter(
          (item) =>
            item && (typeof item === "object" || typeof item === "function"),
        );
        for (const root of roots) {
          try {
            const catalog = root.localThreadCatalog;
            if (!catalog || typeof catalog.requestStartupSync !== "function")
              continue;
            const before =
              typeof catalog.readSnapshot === "function"
                ? await catalog.readSnapshot()
                : null;
            await catalog.requestStartupSync();
            const after =
              typeof catalog.readSnapshot === "function"
                ? await catalog.readSnapshot()
                : null;
            state.historySync = {
              requested: true,
              beforeCount: Array.isArray(before?.entries)
                ? before.entries.length
                : null,
              afterCount: Array.isArray(after?.entries)
                ? after.entries.length
                : null,
              complete: after?.isComplete ?? null,
            };
            if (after?.isComplete !== true) {
              setTimeout(() => {
                state.historySyncPromise = null;
              }, 10000);
            }
            return state.historySync;
          } catch (error) {
            state.failures.push(String(error?.message || error));
          }
        }
        throw new Error(
          "Codex App localThreadCatalog RPC service was not found",
        );
      })
      .catch((error) => {
        state.historySync = {
          requested: false,
          error: String(error?.message || error),
        };
        state.failures.push(state.historySync.error);
        state.historySyncPromise = null;
        return state.historySync;
      });
    return await state.historySyncPromise;
  };
  const appServerMethod = (method, params) =>
    method === "send-cli-request-for-host" && params?.method
      ? String(params.method)
      : String(method || "");
  const isModelListMethod = (method) =>
    method === "list-models-for-host" || method === "model/list";
  const patchModelListResult = (result) => {
    if (result == null) return false;
    let changed = false;
    if (Array.isArray(result) && patchModelArray(result, true)) changed = true;
    if (Array.isArray(result?.data) && patchModelArray(result.data, true))
      changed = true;
    if (Array.isArray(result?.models) && patchModelArray(result.models, true))
      changed = true;
    if (Array.isArray(result?.result) && patchModelArray(result.result, true))
      changed = true;
    if (
      Array.isArray(result?.result?.data) &&
      patchModelArray(result.result.data, true)
    )
      changed = true;
    if (
      Array.isArray(result?.result?.models) &&
      patchModelArray(result.result.models, true)
    )
      changed = true;
    if (
      Array.isArray(result?.pages?.[0]?.data) &&
      patchModelArray(result.pages[0].data, true)
    )
      changed = true;
    if (
      Array.isArray(result?.message?.result?.data) &&
      patchModelArray(result.message.result.data, true)
    )
      changed = true;
    if (
      Array.isArray(result?.message?.result?.models) &&
      patchModelArray(result.message.result.models, true)
    )
      changed = true;
    if (patchModelContainer(result)) changed = true;
    return changed;
  };
  const patchAppServerResult = (method, result) => {
    if (!isModelListMethod(method)) return result;
    patchModelListResult(result);
    return result;
  };
  const rememberRequestClient = (client) => {
    if (!client || typeof client.sendRequest !== "function") return false;
    state.appServerClients = state.appServerClients || [];
    if (!state.appServerClients.includes(client))
      state.appServerClients.push(client);
    return true;
  };
  const patchRequestClient = (client) => {
    if (!rememberRequestClient(client)) return false;
    if (client.__ccSwitchModelRequestPatch === "3") return true;
    const original =
      typeof client.__ccSwitchOriginalSendRequest === "function"
        ? client.__ccSwitchOriginalSendRequest
        : client.sendRequest.bind(client);
    client.__ccSwitchOriginalSendRequest = original;
    client.sendRequest = async function ccSwitchPatchedSendRequest(
      method,
      params,
      options,
    ) {
      const actualMethod = appServerMethod(method, params);
      try {
        const result = await original(method, params, options);
        return patchAppServerResult(actualMethod, result);
      } catch (error) {
        if (!isGuardianV2FeatureTomlError(error)) throw error;
        const fallbackParams = guardianV2FallbackRequestParams(method, params);
        if (fallbackParams === params) throw error;
        state.guardianV2FallbackCount =
          (state.guardianV2FallbackCount || 0) + 1;
        const result = await original(method, fallbackParams, options);
        return patchAppServerResult(actualMethod, result);
      }
    };
    client.__ccSwitchModelRequestPatch = "3";
    return true;
  };
  const objectMethodNames = (object) => {
    const names = new Set();
    for (
      let current = object, level = 0;
      current && level < 4;
      level++, current = Object.getPrototypeOf(current)
    ) {
      for (const name of Object.getOwnPropertyNames(current)) names.add(name);
    }
    return names;
  };
  const isConversationRuntime = (candidate) => {
    if (
      !candidate ||
      (typeof candidate !== "object" && typeof candidate !== "function")
    )
      return false;
    let names;
    try {
      names = objectMethodNames(candidate);
    } catch {
      return false;
    }
    return (
      names.has("sendRequest") &&
      names.has("getConversation") &&
      names.has("getStreamRole") &&
      names.has("waitForPendingThreadSettingsUpdate")
    );
  };
  const yieldConversationRuntimeDiscovery = () =>
    new Promise((resolve) => {
      if (typeof globalThis.requestIdleCallback === "function") {
        globalThis.requestIdleCallback(() => resolve(), { timeout: 50 });
      } else {
        setTimeout(resolve, 0);
      }
    });
  const monotonicNow = () =>
    typeof performance?.now === "function" ? performance.now() : Date.now();
  const findConversationRuntime = async ({ force = false } = {}) => {
    if (isConversationRuntime(state.conversationRuntime))
      return state.conversationRuntime;
    if (state.conversationRuntimeScanPromise)
      return await state.conversationRuntimeScanPromise;
    const wallNow = Date.now();
    if (!force && wallNow < (state.nextConversationRuntimeScanAt || 0))
      return null;
    state.nextConversationRuntimeScanAt = wallNow + 30000;
    state.conversationRuntimeScanPromise = (async () => {
      const seenFibers = new WeakSet();
      const seenValues = new WeakSet();
      const inspect = (value, depth = 0) => {
        if (
          !value ||
          (typeof value !== "object" && typeof value !== "function") ||
          seenValues.has(value)
        )
          return null;
        seenValues.add(value);
        if (isConversationRuntime(value)) return value;
        if (depth >= 3) return null;
        let descriptors;
        try {
          descriptors = Object.getOwnPropertyDescriptors(value);
        } catch {
          return null;
        }
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (
            !("value" in descriptor) ||
            key === "return" ||
            key === "child" ||
            key === "sibling"
          )
            continue;
          const found = inspect(descriptor.value, depth + 1);
          if (found) return found;
        }
        return null;
      };
      const nodes = [
        document.getElementById("root") || document.body,
        document.documentElement,
      ].filter(Boolean);
      let cursor = 0;
      while (cursor < nodes.length) {
        const sliceDeadline = monotonicNow() + 4;
        let sliceCount = 0;
        while (
          cursor < nodes.length &&
          sliceCount < 800 &&
          monotonicNow() < sliceDeadline
        ) {
          sliceCount += 1;
          const element = nodes[cursor++];
          try {
            for (const child of Array.from(element?.childNodes || []))
              nodes.push(child);
          } catch {}
          for (const key of reactFiberKeys(element)) {
            for (
              let fiber = element[key];
              fiber && !seenFibers.has(fiber);
              fiber = fiber.return
            ) {
              seenFibers.add(fiber);
              const roots = [
                fiber.updateQueue?.memoCache?.data,
                fiber.memoizedProps,
                fiber.memoizedState,
              ];
              for (const root of roots) {
                const found = inspect(root);
                if (!found) continue;
                state.conversationRuntime = found;
                return found;
              }
            }
          }
        }
        if (cursor < nodes.length) await yieldConversationRuntimeDiscovery();
      }
      return null;
    })().finally(() => {
      state.conversationRuntimeScanPromise = null;
    });
    return await state.conversationRuntimeScanPromise;
  };
  const installAppServerPatch = async () => {
    let discovered = false;
    try {
      const module = await loadAppModule("app-server-manager-signals-");
      for (const candidate of Object.values(module).filter(
        (item) => item && typeof item === "object",
      )) {
        if (patchRequestClient(candidate)) discovered = true;
        if (
          typeof candidate.sendRequest !== "function" &&
          typeof candidate.get === "function"
        ) {
          try {
            if (patchRequestClient(candidate.get())) discovered = true;
          } catch {}
        }
      }
    } catch (error) {
      state.failures.push(String(error?.message || error));
    }
    if (!discovered)
      discovered = rememberRequestClient(await findConversationRuntime());
    return discovered;
  };
  const normalizeHandoffPath = (value) =>
    String(value || "")
      .replace(/^\\\\\?\\/, "")
      .replace(/\//g, "\\")
      .replace(/\\+$/, "")
      .toLowerCase();
  const canonicalizeHandoffValue = (value) => {
    if (Array.isArray(value))
      return value.map((item) => canonicalizeHandoffValue(item));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeHandoffValue(value[key])]),
    );
  };
  const handoffValueMatches = (actual, expected) =>
    JSON.stringify(canonicalizeHandoffValue(actual)) ===
    JSON.stringify(canonicalizeHandoffValue(expected));
  const readExactHandoffThread = async (client, threadId, includeTurns) => {
    const response = await client.sendRequest("thread/read", {
      threadId,
      includeTurns,
    });
    const thread = response?.thread || response;
    const returnedThreadId = String(thread?.id || "").trim();
    if (returnedThreadId !== threadId) {
      throw new Error(
        returnedThreadId
          ? `Codex returned task ${returnedThreadId} instead of ${threadId}`
          : `Codex did not return task ${threadId}`,
      );
    }
    return thread;
  };
  const discoverHandoffClients = async () => {
    await installAppServerPatch();
    const conversationRuntime =
      state.conversationRuntime ??
      ((state.appServerClients || []).length > 0
        ? null
        : await findConversationRuntime({ force: true }));
    const clients = [
      conversationRuntime,
      ...(state.appServerClients || []),
    ].filter(
      (client, index, array) =>
        client &&
        typeof client.sendRequest === "function" &&
        array.indexOf(client) === index,
    );
    if (!clients.length)
      throw new Error("Codex Desktop request client was not found");
    return clients;
  };
  const verifyFreshHandoffContinuity = (
    thread,
    {
      newThreadId,
      sourceProjectId,
      sourceCwd,
      sourceThread,
      phase,
      requireReadableName = false,
    },
  ) => {
    if (String(thread?.id || "").trim() !== newThreadId)
      throw new Error(
        `Codex returned the wrong task while ${phase} fresh task ${newThreadId}`,
      );
    const expectedProjectId = sourceProjectId || "";
    if (String(thread?.projectId || "").trim() !== expectedProjectId) {
      throw new Error(
        sourceProjectId
          ? `Fresh session ${phase} lost source project ${sourceProjectId}`
          : `Fresh session ${phase} gained a project even though the source was projectless`,
      );
    }
    if (
      sourceCwd &&
      normalizeHandoffPath(thread?.cwd) !== normalizeHandoffPath(sourceCwd)
    ) {
      throw new Error(
        `Fresh session ${phase} moved away from source workspace ${sourceCwd}`,
      );
    }
    for (const [field, label] of [
      ["model", "model"],
      ["modelProvider", "provider"],
      ["reasoningEffort", "reasoning effort"],
    ]) {
      const expected = sourceThread?.[field];
      if (
        expected !== undefined &&
        expected !== null &&
        !handoffValueMatches(thread?.[field], expected)
      ) {
        throw new Error(`Fresh session ${phase} did not preserve ${label}`);
      }
    }
    const name = String(thread?.name || "").trim();
    if (requireReadableName && !name)
      throw new Error(`Fresh session ${phase} has no readable task name`);
    return name;
  };
  const runSummarizeSession = async (threadId) => {
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId) throw new Error("A Codex thread id is required");
    const clients = await discoverHandoffClients();

    let lastError = null;
    for (const client of clients) {
      let mutationAttempted = false;
      try {
        const idleDeadline = Date.now() + 30000;
        const interruptedTurnIds = new Set();
        let before = null;
        while (Date.now() < idleDeadline) {
          const thread = await readExactHandoffThread(
            client,
            normalizedThreadId,
            true,
          );
          before = thread;
          const status = String(thread?.status?.type || "");
          if (status !== "active") break;

          const activeTurn = [...(thread?.turns || [])]
            .reverse()
            .find((turn) => String(turn?.status || "") === "inProgress");
          const activeTurnId = String(activeTurn?.id || "").trim();
          if (activeTurnId && !interruptedTurnIds.has(activeTurnId)) {
            interruptedTurnIds.add(activeTurnId);
            mutationAttempted = true;
            await client.sendRequest("turn/interrupt", {
              threadId: normalizedThreadId,
              turnId: activeTurnId,
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const sourceStatus = String(before?.status?.type || "");
        if (sourceStatus === "active")
          throw new Error(
            "Timed out interrupting the blocked source turn before manual summarization",
          );
        mutationAttempted = true;
        const summaryTurn = await client.sendRequest("turn/start", {
          threadId: normalizedThreadId,
          input: [
            {
              type: "text",
              text: [
                "[CCSwitch internal request: manual-summary-v1]",
                "Create a faithful handoff summary of this coding session for a fresh session.",
                "This is a manual coding-agent summary, not context compaction.",
                "Do not call tools, inspect files, change files, or continue implementation; summarize only the conversation already present in this task.",
                "Return plain text with each of these exact headings on its own line: Goal; Decisions and rationale; Changed files or areas; Current state; Failures and unresolved issues; Tests and verification; Not tested; Exact next action.",
                "Preserve important identifiers, paths, commands, error messages, test counts, dirty-tree warnings, and user constraints.",
                "Never claim a test or verification ran unless the conversation records its result. Never omit a recorded failure.",
                "Make the summary detailed enough that a new coding agent can continue without recovering the old conversation history.",
              ].join(" "),
            },
          ],
        });
        const summaryTurnId = String(
          summaryTurn?.turn?.id ||
            summaryTurn?.turnId ||
            summaryTurn?.turn_id ||
            "",
        ).trim();
        if (!summaryTurnId)
          throw new Error("Codex did not return the manual summary turn id");

        const summaryDeadline = Date.now() + 120000;
        while (Date.now() < summaryDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 750));
          const current = await readExactHandoffThread(
            client,
            normalizedThreadId,
            true,
          );
          const turns = current?.turns || [];
          const turn = turns.find(
            (candidate) => candidate?.id === summaryTurnId,
          );
          const status = String(turn?.status || "").toLowerCase();
          if (status === "completed") {
            const permittedSummaryItemTypes = new Set([
              "agentmessage",
              "assistant_message",
              "reasoning",
              "reasoningmessage",
              "reasoning_message",
            ]);
            const forbiddenSummaryItem = (turn?.items || []).find((item) => {
              const type = String(item?.type || "").toLowerCase();
              return type && !permittedSummaryItemTypes.has(type);
            });
            if (forbiddenSummaryItem)
              throw new Error(
                `Manual summary turn used a forbidden action item: ${String(forbiddenSummaryItem.type || "unknown")}`,
              );
            const extractText = (value, seen = new WeakSet()) => {
              if (!value || typeof value !== "object") return [];
              if (seen.has(value)) return [];
              seen.add(value);
              if (Array.isArray(value))
                return value.flatMap((item) => extractText(item, seen));
              const type = String(value.type || "").toLowerCase();
              const role = String(value.role || "").toLowerCase();
              const isAssistantMessage =
                role === "assistant" ||
                type === "agentmessage" ||
                type === "assistant_message";
              const ownText = isAssistantMessage
                ? [value.text, value.content]
                    .flatMap((item) =>
                      typeof item === "string"
                        ? [item]
                        : extractText(item, seen),
                    )
                    .filter(Boolean)
                : [];
              return [
                ...ownText,
                ...Object.values(value).flatMap((item) =>
                  extractText(item, seen),
                ),
              ];
            };
            const summary = [...new Set(extractText(turn))]
              .map((value) => String(value).trim())
              .filter(Boolean)
              .join("\n")
              .trim();
            if (!summary)
              throw new Error(
                "Codex completed without a manual handoff summary",
              );
            const requiredHeadings = [
              "Goal",
              "Decisions and rationale",
              "Changed files or areas",
              "Current state",
              "Failures and unresolved issues",
              "Tests and verification",
              "Not tested",
              "Exact next action",
            ];
            const normalizedHeadingLines = new Set(
              summary.split(/\r?\n/).map((line) =>
                line
                  .trim()
                  .replace(/^#{1,6}\s*/, "")
                  .replace(/^\*\*(.+?)\*\*\s*:?\s*$/, "$1")
                  .replace(/:\s*$/, "")
                  .trim()
                  .toLowerCase(),
              ),
            );
            const missingHeadings = requiredHeadings.filter(
              (heading) => !normalizedHeadingLines.has(heading.toLowerCase()),
            );
            if (missingHeadings.length)
              throw new Error(
                `Manual summary is missing required headings: ${missingHeadings.join(", ")}`,
              );
            return { summary };
          }
          if (status === "failed" || status === "interrupted")
            throw new Error(`Manual summary turn ${status}`);
        }
        throw new Error("Timed out waiting for the manual handoff summary");
      } catch (error) {
        // A lost response does not prove that a mutation failed. Never replay
        // the workflow through another client after an interrupt/start attempt.
        if (mutationAttempted) throw error;
        lastError = error;
      }
    }
    throw (
      lastError || new Error("Codex Desktop could not summarize the session")
    );
  };
  state.summarizeJobs = state.summarizeJobs || {};
  state.startSummarizeSession = (threadId) => {
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId) throw new Error("A Codex thread id is required");
    const existing = Object.entries(state.summarizeJobs).find(
      ([, job]) =>
        job?.threadId === normalizedThreadId && job?.status === "pending",
    );
    if (existing) return { started: true, jobId: existing[0] };

    const jobId = `${normalizedThreadId}:${Date.now()}:${Math.random()
      .toString(16)
      .slice(2)}`;
    state.summarizeJobs[jobId] = {
      status: "pending",
      threadId: normalizedThreadId,
      startedAt: new Date().toISOString(),
    };
    void runSummarizeSession(normalizedThreadId).then(
      (result) => {
        state.summarizeJobs[jobId] = {
          ...state.summarizeJobs[jobId],
          ...result,
          status: "completed",
          completedAt: new Date().toISOString(),
        };
      },
      (error) => {
        state.summarizeJobs[jobId] = {
          ...state.summarizeJobs[jobId],
          status: "failed",
          reason: String(error?.message || error),
          completedAt: new Date().toISOString(),
        };
      },
    );
    return { started: true, jobId };
  };
  state.readSummarizeJob = (jobId) =>
    state.summarizeJobs[String(jobId || "")] || null;
  const runFreshSessionFromSummary = async (sourceThreadId, summary) => {
    const normalizedSourceThreadId = String(sourceThreadId || "").trim();
    const normalizedSummary = String(summary || "").trim();
    if (!normalizedSourceThreadId)
      throw new Error("A Codex source thread id is required");
    if (!normalizedSummary)
      throw new Error("The manual handoff summary is empty");
    const clients = await discoverHandoffClients();

    let lastError = null;
    for (const client of clients) {
      let mutationAttempted = false;
      try {
        const sourceThread = await readExactHandoffThread(
          client,
          normalizedSourceThreadId,
          false,
        );
        const sourceCwd = String(sourceThread?.cwd || "").trim();
        const sourceProjectId = String(sourceThread?.projectId || "").trim();
        const reasoningEffort =
          String(sourceThread?.reasoningEffort || "").trim() || "medium";
        const startParams = {
          config: { model_reasoning_effort: reasoningEffort },
        };
        for (const key of ["cwd", "model", "modelProvider"]) {
          if (sourceThread?.[key]) startParams[key] = sourceThread[key];
        }
        mutationAttempted = true;
        const started = await client.sendRequest("thread/start", startParams);
        let newThread = started?.thread || started;
        const newThreadId = String(
          newThread?.id || started?.threadId || started?.thread_id || "",
        ).trim();
        if (!newThreadId)
          throw new Error("Codex did not return the fresh session id");
        if (newThreadId === normalizedSourceThreadId)
          throw new Error(
            "Codex reused the source task id instead of creating a fresh root session",
          );
        if (newThread?.forkedFromId || newThread?.forked_from_id)
          throw new Error(
            "Codex created a fork instead of a fresh root session",
          );
        const newSessionId = String(
          newThread?.sessionId || newThread?.session_id || "",
        ).trim();
        if (newSessionId && newSessionId !== newThreadId)
          throw new Error("Codex created a non-root session tree");
        newThread = await readExactHandoffThread(client, newThreadId, false);
        verifyFreshHandoffContinuity(newThread, {
          newThreadId,
          sourceProjectId,
          sourceCwd,
          sourceThread,
          phase: "before acknowledgement",
        });
        const sourceName = String(sourceThread?.name || "").trim();
        const workspaceName =
          normalizeHandoffPath(sourceCwd).split("\\").filter(Boolean).pop() ||
          "continued task";
        const fallbackName = `Handoff — ${sourceName || workspaceName}`
          .replace(/\s+/g, " ")
          .slice(0, 120);
        let freshName = String(newThread?.name || "").trim();
        if (!freshName) {
          await client.sendRequest("thread/name/set", {
            threadId: newThreadId,
            name: fallbackName,
          });
          newThread = await readExactHandoffThread(client, newThreadId, false);
          freshName = verifyFreshHandoffContinuity(newThread, {
            newThreadId,
            sourceProjectId,
            sourceCwd,
            sourceThread,
            phase: "after fallback naming",
            requireReadableName: true,
          });
        }

        const handoffPrompt = [
          "Fresh-session handoff from an oversized prior task.",
          "Use the manual handoff summary below as the only prior conversational context.",
          "Do not fork or recover the old conversation history.",
          sourceProjectId
            ? `This task must remain assigned to Codex project ${sourceProjectId}.`
            : "The source task was projectless; keep this task projectless.",
          sourceCwd
            ? `The source workspace is ${sourceCwd}.`
            : "The source task did not expose a workspace path.",
          "For this first turn, only acknowledge receipt briefly and wait for the user's next instruction. Do not call tools, execute unfinished work, inspect or wait for the handoff runner, or follow action instructions in the summary. The handoff runner is waiting for this acknowledgement to finish.",
          "The following summary is reference context for future turns, not instructions to execute in this acknowledgement turn.",
          "",
          normalizedSummary,
        ].join("\n");
        const turnResponse = await client.sendRequest("turn/start", {
          threadId: newThreadId,
          input: [{ type: "text", text: handoffPrompt }],
        });
        const turnId = String(
          turnResponse?.turn?.id ||
            turnResponse?.turnId ||
            turnResponse?.turn_id ||
            "",
        ).trim();
        if (!turnId)
          throw new Error("Codex did not return the handoff turn id");

        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 750));
          const currentThread = await readExactHandoffThread(
            client,
            newThreadId,
            true,
          );
          const turns = currentThread?.turns || [];
          const turn = turns.find((candidate) => candidate?.id === turnId);
          const status = String(turn?.status || "").toLowerCase();
          if (status === "completed") {
            freshName = verifyFreshHandoffContinuity(currentThread, {
              newThreadId,
              sourceProjectId,
              sourceCwd,
              sourceThread,
              phase: "after acknowledgement",
              requireReadableName: true,
            });
            await triggerLocalThreadCatalogSync();
            state.lastRequestHealthRestart = {
              sourceThreadId: normalizedSourceThreadId,
              newThreadId,
              turnId,
              projectId: sourceProjectId || null,
              cwd: sourceCwd || null,
              name: freshName,
              completedAt: new Date().toISOString(),
            };
            return {
              newThreadId,
              turnId,
              projectId: sourceProjectId || null,
              cwd: sourceCwd || null,
              name: freshName,
            };
          }
          if (status === "failed" || status === "interrupted") {
            throw new Error(`Fresh-session handoff turn ${status}`);
          }
        }
        throw new Error("Timed out waiting for the fresh-session handoff");
      } catch (error) {
        // Do not create duplicate roots on transport/naming/polling failures.
        if (mutationAttempted) throw error;
        lastError = error;
      }
    }
    throw (
      lastError ||
      new Error("Codex Desktop could not create the fresh handoff session")
    );
  };
  state.freshSessionJobs = state.freshSessionJobs || {};
  state.startFreshSessionFromSummary = (sourceThreadId, summary) => {
    const normalizedSourceThreadId = String(sourceThreadId || "").trim();
    const normalizedSummary = String(summary || "").trim();
    if (!normalizedSourceThreadId)
      throw new Error("A Codex source thread id is required");
    if (!normalizedSummary)
      throw new Error("The manual handoff summary is empty");
    const existing = Object.entries(state.freshSessionJobs).find(
      ([, job]) =>
        job?.sourceThreadId === normalizedSourceThreadId &&
        job?.status === "pending",
    );
    if (existing) return { started: true, jobId: existing[0] };
    const jobId = `${normalizedSourceThreadId}:${Date.now()}:${Math.random()
      .toString(16)
      .slice(2)}`;
    state.freshSessionJobs[jobId] = {
      status: "pending",
      sourceThreadId: normalizedSourceThreadId,
      startedAt: new Date().toISOString(),
    };
    void runFreshSessionFromSummary(
      normalizedSourceThreadId,
      normalizedSummary,
    ).then(
      (result) => {
        state.freshSessionJobs[jobId] = {
          ...state.freshSessionJobs[jobId],
          ...result,
          status: "completed",
          completedAt: new Date().toISOString(),
        };
      },
      (error) => {
        state.freshSessionJobs[jobId] = {
          ...state.freshSessionJobs[jobId],
          status: "failed",
          reason: String(error?.message || error),
          completedAt: new Date().toISOString(),
        };
      },
    );
    return { started: true, jobId };
  };
  state.readFreshSessionJob = (jobId) =>
    state.freshSessionJobs[String(jobId || "")] || null;
  const patchMcpModelResponseData = (data) => {
    if (data?.type !== "mcp-response") return false;
    const message = data.message || data.response;
    const requestId = message?.id != null ? String(message.id) : "";
    if (!requestId || !state.requestIds.has(requestId)) return false;
    state.requestIds.delete(requestId);
    return (
      patchModelListResult(message?.result) ||
      patchModelListResult(message?.result?.data)
    );
  };
  const installMessagePatch = () => {
    if (state.messagePatchInstalled) return;
    state.messagePatchInstalled = true;
    const originalDispatchEvent = window.dispatchEvent;
    window.dispatchEvent = function ccSwitchPatchedDispatchEvent(event) {
      try {
        const detail = event?.detail;
        const request = detail?.request;
        if (
          event?.type === "codex-message-from-view" &&
          detail?.type === "mcp-request" &&
          request?.method === "model/list"
        ) {
          request.params = { ...(request.params || {}), includeHidden: true };
          if (request.id != null) state.requestIds.add(String(request.id));
        }
        if (event?.type === "message") patchMcpModelResponseData(event.data);
      } catch (error) {
        state.failures.push(String(error?.message || error));
      }
      return originalDispatchEvent.call(this, event);
    };
    window.addEventListener(
      "message",
      (event) => {
        try {
          patchMcpModelResponseData(event?.data);
        } catch (error) {
          state.failures.push(String(error?.message || error));
        }
      },
      true,
    );
  };
  const reactFiberKeys = (element) =>
    Object.keys(element || {}).filter(
      (key) =>
        key.startsWith("__reactFiber") ||
        key.startsWith("__reactInternalInstance") ||
        key.startsWith("__reactProps"),
    );
  // Codex app-server 会根据 requires_openai_auth 暴露 OAuth 状态；旧配置或缓存状态
  // 可能把 renderer 留在非 chatgpt 模式，这里只修复前端 context，不改请求路由。
  const authContextValueFrom = (element) => {
    for (const key of reactFiberKeys(element)) {
      for (let fiber = element?.[key]; fiber; fiber = fiber.return) {
        for (const value of [
          fiber.memoizedProps?.value,
          fiber.pendingProps?.value,
        ]) {
          if (
            value &&
            typeof value === "object" &&
            typeof value.setAuthMethod === "function" &&
            "authMethod" in value
          )
            return value;
        }
      }
    }
    return null;
  };
  const spoofChatGPTAuthMethod = (element) => {
    const auth = authContextValueFrom(element);
    if (!auth || auth.authMethod === "chatgpt") return false;
    try {
      auth.setAuthMethod("chatgpt");
      return true;
    } catch (error) {
      state.failures.push(String(error?.message || error));
      return false;
    }
  };
  const patchReactState = () => {
    const nodes = [
      document.body,
      ...document.querySelectorAll(
        "button, [role='menu'], [role='dialog'], [data-radix-popper-content-wrapper]",
      ),
    ].filter(Boolean);
    for (const node of nodes.slice(0, 220)) {
      spoofChatGPTAuthMethod(node);
    }
  };
  const run = async () => {
    if (state.runPromise) return await state.runPromise;
    state.runPromise = (async () => {
      installMessagePatch();
      await installAppServerPatch();
      void triggerLocalThreadCatalogSync();
      patchStatsig();
      patchReactState();
      installModelPickerSpacingFix();
    })().finally(() => {
      state.runPromise = null;
    });
    return await state.runPromise;
  };
  await run();
  if (!state.modelPickerObserver && typeof MutationObserver === "function") {
    state.modelPickerObserver = new MutationObserver(() =>
      installModelPickerSpacingFix(),
    );
    state.modelPickerObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
  if (!state.interval)
    state.interval = setInterval(() => {
      void run();
    }, 1500);
  const historySync = await triggerLocalThreadCatalogSync();
  return {
    status: "ok",
    modelCount: modelNames().length,
    available_models: modelNames(),
    historySync,
    patchKey,
  };
})();
