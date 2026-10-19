state.requestHealthWarningsSuppressed = __CCSWITCH_REQUEST_HEALTH_SUPPRESSED__;
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
  if (state.requestHealthWarningsSuppressed) {
    try {
      localStorage.removeItem(requestHealthWarningStorageKey);
    } catch {}
    document.getElementById(requestHealthWarningContainerId)?.remove();
    if (state.requestHealthWarningExpiryTimer)
      clearTimeout(state.requestHealthWarningExpiryTimer);
    state.requestHealthWarningExpiryTimer = null;
    return { active: 0 };
  }
  const now = Date.now();
  const active = (Array.isArray(warnings) ? warnings : [])
    .filter(
      (warning) =>
        warning &&
        String(warning.token || "").trim() &&
        Number(warning.expiresAtMs) > now,
    )
    .sort(
      (left, right) => Number(left.expiresAtMs) - Number(right.expiresAtMs),
    );
  try {
    if (active.length)
      localStorage.setItem(
        requestHealthWarningStorageKey,
        JSON.stringify(active),
      );
    else localStorage.removeItem(requestHealthWarningStorageKey);
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
      fontFamily: "system-ui, sans-serif",
    });
    (document.body || document.documentElement).appendChild(container);
  }
  const activeTokens = new Set(active.map((warning) => String(warning.token)));
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
        candidate.getAttribute("data-ccswitch-request-health-token") === token,
    );
    if (!card) {
      card = document.createElement("article");
      card.setAttribute("data-ccswitch-request-health-token", token);
      Object.assign(card.style, {
        border: "1px solid rgba(245, 158, 11, .65)",
        borderRadius: "10px",
        background: "rgba(24, 24, 27, .96)",
        color: "#fafafa",
        boxShadow: "0 18px 48px rgba(0,0,0,.38)",
        padding: "12px 14px",
        lineHeight: "1.4",
        pointerEvents: "none",
      });
      container.appendChild(card);
    }
    card.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = String(warning.title || "Request paused for approval");
    const detail = document.createElement("div");
    detail.textContent = String(warning.detail || "");
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
    () => {
      if (!state.requestHealthWarningsSuppressed) {
        renderRequestHealthWarnings(readStoredRequestHealthWarnings());
      }
    },
    Math.max(50, nextExpiry - now + 25),
  );
  return { active: active.length };
};
state.syncRequestHealthWarnings = (
  warnings,
  suppressed = state.requestHealthWarningsSuppressed,
) => {
  state.requestHealthWarningsSuppressed = Boolean(suppressed);
  return renderRequestHealthWarnings(warnings);
};
if (state.requestHealthWarningsSuppressed) {
  try {
    localStorage.removeItem(requestHealthWarningStorageKey);
  } catch {}
  renderRequestHealthWarnings([]);
} else {
  renderRequestHealthWarnings(readStoredRequestHealthWarnings());
}
