import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  DEV_RECOVERY_POLICY,
  readDevWatchdogOverride,
  readWatchdogEnabledSetting,
  recentDevRestartTimesMs,
} from "./dev-watchdog-policy.mjs";

const FILETIME_UNIX_OFFSET = 116444736000000000n;
const validPid = (value) => Number.isSafeInteger(value) && value > 0;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const parseGuardianJson = (source) =>
  JSON.parse(source.replace(/^\uFEFF/, ""), (key, value, context) => {
    if (key === "processStartedAtTicks" && typeof value === "number") {
      // The app writes u64 FILETIME as a JSON number. Use Node 22's raw source
      // rather than the already rounded Number delivered to the reviver.
      if (!context?.source || !/^\d+$/.test(context.source))
        throw new Error("Invalid process FILETIME source");
      return context.source;
    }
    return value;
  });
const readJson = (filename) =>
  parseGuardianJson(readFileSync(filename, "utf8"));
const isAbsolute = (value) =>
  typeof value === "string" &&
  !value.includes("\0") &&
  (/^[a-z]:[\\/]/i.test(value) ||
    /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value) ||
    (process.platform !== "win32" && path.posix.isAbsolute(value)));
const pathApi = (value) =>
  /^[a-z]:[\\/]|^\\\\/i.test(value) ? path.win32 : path;
export const canonicalPath = (value) =>
  pathApi(value)
    .resolve(value)
    .replace(/[\\/]+$/, "");

export function hostLocalPath(value, localAppData = process.env.LOCALAPPDATA) {
  const canonical = canonicalPath(value);
  if (!localAppData) return canonical;
  const local = canonicalPath(localAppData);
  const escaped = local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^${escaped}\\\\Packages\\\\OpenAI\\.Codex_[^\\\\]+\\\\LocalCache\\\\Local(?:\\\\(.*))?$`,
    "i",
  ).exec(canonical);
  return match
    ? canonicalPath(path.win32.join(local, match[1] ?? ""))
    : canonical;
}

export function samePath(left, right, localAppData = process.env.LOCALAPPDATA) {
  if (
    typeof left !== "string" ||
    !left.trim() ||
    typeof right !== "string" ||
    !right.trim()
  )
    return false;
  return (
    hostLocalPath(left, localAppData).toLowerCase() ===
    hostLocalPath(right, localAppData).toLowerCase()
  );
}

export function pathInside(parent, candidate) {
  if (!isAbsolute(parent) || !isAbsolute(candidate)) return false;
  const separator = pathApi(parent).sep;
  return canonicalPath(candidate)
    .toLowerCase()
    .startsWith(`${canonicalPath(parent).toLowerCase()}${separator}`);
}

// Windows process identity needs 100ns precision. Date alone would collapse PID
// reuse one FILETIME tick apart into the same millisecond.
export function utcTicks(value) {
  const text = value instanceof Date ? value.toISOString() : String(value);
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})$/i.exec(
      text,
    );
  if (!match) throw new Error("Invalid UTC timestamp");
  const [year, month, day, hour, minute, second] = match[1]
    .split(/[-T:]/)
    .map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    throw new Error("Invalid UTC timestamp");
  const seconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(seconds)) throw new Error("Invalid UTC timestamp");
  return BigInt(seconds) * 10_000n + BigInt((match[2] ?? "").padEnd(7, "0"));
}

function markerFiletime(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw new Error("Invalid process FILETIME");
  const ticks = BigInt(value);
  if (ticks <= 0n || ticks > 2650467743999999999n)
    throw new Error("Invalid process FILETIME");
  return ticks - FILETIME_UNIX_OFFSET;
}

export function watchdogEnabled({ configPath, environment = {} }) {
  const override = readDevWatchdogOverride(environment);
  if (override !== undefined) return override;
  const settingsPath = path.join(configPath, "settings.json");
  if (!existsSync(settingsPath)) return true;
  try {
    return readWatchdogEnabledSetting(readJson(settingsPath));
  } catch {
    return false;
  }
}

export function devSessionEnvironment(environment) {
  return Object.fromEntries(
    DEV_RECOVERY_POLICY.sessionEnvironmentKeys.flatMap((key) => {
      const value = environment?.[key];
      return typeof value === "string" && !value.includes("\0")
        ? [[key, value]]
        : [];
    }),
  );
}

export function devRestartTimes(session, nowMs = Date.now()) {
  return recentDevRestartTimesMs(
    Array.isArray(session?.restartTimesMs)
      ? session.restartTimesMs
      : session?.supervisorRestartTimesMs,
    nowMs,
  );
}

export async function devSessionRecoveryPlan({
  configPath,
  getProcessIdentity,
  inspectWatchdogOwnership = async () => ({ Active: false, Unknown: true }),
}) {
  const plan = {
    Exists: false,
    Active: false,
    Recoverable: false,
    PreventInstalledFallback: false,
    State: "",
    Executable: "",
    ScriptPath: "",
    RepoRoot: "",
    Args: [],
    Roots: [],
    Environment: {},
    SupervisorPid: 0,
    Marker: null,
    ConfigPath: path.resolve(configPath),
    SessionPath: path.join(configPath, "logs", "dev-session.json"),
    Session: null,
    SessionJson: "",
    WatchdogActive: false,
    WatchdogOwnershipUnknown: false,
  };
  if (!existsSync(plan.SessionPath)) return plan;
  plan.Exists = true;
  plan.PreventInstalledFallback = true;
  try {
    const sessionJson = readFileSync(plan.SessionPath, "utf8");
    const session = JSON.parse(sessionJson.replace(/^\uFEFF/, ""));
    if (
      session.schemaVersion !== 1 ||
      !["running", "stopping"].includes(session.state) ||
      !isAbsolute(session.repoRoot) ||
      !isAbsolute(session.scriptPath)
    )
      return plan;
    const repoRoot = canonicalPath(session.repoRoot);
    const scriptPath = canonicalPath(session.scriptPath);
    if (
      !samePath(
        scriptPath,
        pathApi(repoRoot).join(repoRoot, "scripts", "dev-tauri-delayed.mjs"),
      ) ||
      !existsSync(scriptPath) ||
      !existsSync(pathApi(repoRoot).join(repoRoot, "package.json"))
    )
      return plan;
    Object.assign(plan, {
      State: session.state,
      RepoRoot: repoRoot,
      ScriptPath: scriptPath,
    });
    try {
      plan.Marker = readJson(
        path.join(configPath, "logs", "app-run-marker.json"),
      );
    } catch {
      /* A missing or invalid app marker cannot authorize listener cleanup. */
    }
    if (
      !validPid(session.supervisorPid) ||
      !isAbsolute(session.supervisorExecutablePath) ||
      pathApi(session.supervisorExecutablePath)
        .basename(session.supervisorExecutablePath)
        .toLowerCase() !== "node.exe" ||
      !existsSync(session.supervisorExecutablePath) ||
      !Array.isArray(session.args) ||
      !Array.isArray(session.roots)
    )
      return plan;
    if (
      session.args.some(
        (arg) => typeof arg !== "string" || /[\0\r\n]/.test(arg),
      )
    )
      return plan;
    if (
      session.roots.some(
        (root) =>
          !validPid(root?.pid) ||
          !["tauri", "vite"].includes(root.role) ||
          root.identity?.ProcessId !== root.pid ||
          !isAbsolute(root.identity?.ExecutablePath) ||
          typeof root.identity?.CreationDate !== "string" ||
          !root.identity.CreationDate.trim(),
      )
    )
      return plan;
    const expectedStart = utcTicks(session.supervisorStartedAtUtc);
    utcTicks(session.startedAtUtc);
    Object.assign(plan, {
      Executable: canonicalPath(session.supervisorExecutablePath),
      SupervisorPid: session.supervisorPid,
      Args: [...session.args],
      Roots: [...session.roots],
      Session: session,
      SessionJson: sessionJson,
      Environment: devSessionEnvironment(session.environment),
    });
    let owner;
    try {
      owner = await getProcessIdentity(plan.SupervisorPid);
    } catch {
      /* Watchdog inspection below must still fail closed on unavailable ownership. */
    }
    if (
      owner?.ProcessId === plan.SupervisorPid &&
      samePath(owner.Path, plan.Executable)
    ) {
      const actualStart = utcTicks(owner.CimStartTimeUtc ?? owner.StartTimeUtc);
      const script = scriptPath
        .replaceAll("/", "\\")
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const token = new RegExp(
        `(?:^|[\\s"])(?:${script}|scripts\\\\dev-tauri-delayed\\.mjs)(?=$|[\\s"])`,
        "i",
      );
      plan.Active =
        expectedStart / 10_000n === actualStart / 10_000n &&
        token.test(String(owner.CommandLine ?? "").replaceAll("/", "\\"));
    }
    if (!plan.Active && plan.State === "running") {
      let ownership;
      try {
        ownership = await inspectWatchdogOwnership(plan);
      } catch {
        ownership = { Active: false, Unknown: true };
      }
      plan.WatchdogActive = ownership?.Active === true;
      plan.WatchdogOwnershipUnknown =
        !object(ownership) || ownership.Unknown !== false;
    }
    plan.Recoverable =
      !plan.Active &&
      !plan.WatchdogActive &&
      !plan.WatchdogOwnershipUnknown &&
      plan.State === "running";
  } catch {
    plan.Active = false;
    plan.Recoverable = false;
  }
  return plan;
}

export function devSessionListenerIdentity({ plan, identity }) {
  try {
    return (
      plan.Marker?.pid === identity.ProcessId &&
      pathInside(
        pathApi(plan.RepoRoot).join(plan.RepoRoot, "src-tauri", "target"),
        identity.Path,
      ) &&
      pathApi(identity.Path).basename(identity.Path).toLowerCase() ===
        "cc-switch.exe" &&
      samePath(plan.Marker.executablePath, identity.Path) &&
      markerFiletime(plan.Marker.processStartedAtTicks) ===
        utcTicks(identity.StartTimeUtc)
    );
  } catch {
    return false;
  }
}

export async function devSessionRecovery({
  plan,
  isMaintenance,
  getListenerOwner,
  getProcessIdentity,
  inspectWatchdogOwnership,
  startDevSession,
  writeEvent,
  nowMs = Date.now(),
  assertHeld = () => {},
  persistBudget = (filename, source, updated) => {
    // A reread prevents a stale plan from overwriting a newer owner. Runtime
    // ownership is rechecked before this bounded, synchronous atomic replacement.
    if (readFileSync(filename, "utf8") !== source)
      throw new Error("Development ownership changed before restart charge");
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(updated), {
        encoding: "utf8",
        flag: "wx",
      });
      renameSync(temporary, filename);
    } finally {
      rmSync(temporary, { force: true });
    }
  },
}) {
  const deferred = async (current = plan) =>
    writeEvent("info", "dev-session-recovery-deferred", {
      State: current.State,
      Active: current.Active,
    });
  if (
    plan.Active ||
    plan.WatchdogActive ||
    plan.WatchdogOwnershipUnknown ||
    plan.State === "stopping" ||
    (await isMaintenance())
  )
    return deferred();
  if (!plan.Recoverable)
    return writeEvent("warning", "dev-session-recovery-required", {
      RepoRoot: plan.RepoRoot,
    });
  const enabled = (current) =>
    watchdogEnabled({
      configPath: current.ConfigPath,
      environment: current.Environment,
    });
  if (!enabled(plan))
    return writeEvent(
      "info",
      "dev-session-restart-skipped-watchdog-disabled",
      null,
    );
  const ownerPid = await getListenerOwner();
  if (ownerPid != null) {
    let identity;
    try {
      identity = await getProcessIdentity(ownerPid);
    } catch {
      /* An unidentified listener blocks replacement. */
    }
    if (!identity || !devSessionListenerIdentity({ plan, identity }))
      return writeEvent("error", "foreign-listener-blocked-dev-recovery", {
        ProcessId: ownerPid,
      });
  }
  if ((await isMaintenance()) || !enabled(plan)) return deferred();
  const current = await devSessionRecoveryPlan({
    configPath: plan.ConfigPath,
    getProcessIdentity,
    inspectWatchdogOwnership,
  });
  if (
    !current.Recoverable ||
    current.SupervisorPid !== plan.SupervisorPid ||
    !samePath(current.ScriptPath, plan.ScriptPath) ||
    !samePath(current.Executable, plan.Executable)
  )
    return deferred(current);
  plan = current;
  if (!enabled(plan))
    return writeEvent(
      "info",
      "dev-session-restart-skipped-watchdog-disabled",
      null,
    );
  const history = devRestartTimes(plan.Session, nowMs);
  if (history.length >= DEV_RECOVERY_POLICY.maxRestarts)
    return writeEvent("warning", "dev-session-restart-rate-limited", {
      RestartsInWindow: history.length,
    });
  const updated = { ...plan.Session, restartTimesMs: [...history, nowMs] };
  delete updated.supervisorRestartTimesMs;
  assertHeld();
  try {
    await persistBudget(plan.SessionPath, plan.SessionJson, updated);
  } catch {
    return writeEvent(
      "error",
      "dev-session-restart-budget-persist-failed",
      null,
    );
  }
  assertHeld();
  const startedPid = await startDevSession(plan);
  assertHeld();
  await writeEvent("warning", "dev-session-started", {
    ProcessId: startedPid,
    Executable: plan.Executable,
    ScriptPath: plan.ScriptPath,
    RepoRoot: plan.RepoRoot,
  });
  return writeEvent("info", "dev-session-rebuild-pending", {
    ProcessId: startedPid,
  });
}

export function maintenanceLeaseRecord({
  ownerIdentity,
  leaseId,
  nowUtc,
  durationSeconds,
  purpose,
}) {
  if (
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds < 1 ||
    typeof leaseId !== "string" ||
    !leaseId.trim() ||
    !validPid(ownerIdentity?.ProcessId) ||
    !isAbsolute(ownerIdentity?.Path)
  )
    throw new Error("Invalid maintenance lease owner or duration");
  utcTicks(ownerIdentity.StartTimeUtc);
  const created = new Date(nowUtc);
  return {
    schemaVersion: 1,
    leaseId,
    purpose,
    ownerPid: ownerIdentity.ProcessId,
    ownerExecutablePath: canonicalPath(ownerIdentity.Path),
    ownerStartTimeUtc: ownerIdentity.StartTimeUtc,
    createdAtUtc: created.toISOString(),
    expiresAtUtc: new Date(
      created.getTime() + durationSeconds * 1000,
    ).toISOString(),
  };
}

export async function maintenanceLeaseRecordActive({
  lease,
  nowUtc,
  getProcessIdentity,
}) {
  try {
    if (
      !object(lease) ||
      lease.schemaVersion !== 1 ||
      typeof lease.leaseId !== "string" ||
      !lease.leaseId.trim() ||
      !validPid(lease.ownerPid) ||
      !isAbsolute(lease.ownerExecutablePath) ||
      utcTicks(lease.expiresAtUtc) <= utcTicks(nowUtc)
    )
      return false;
    const owner = await getProcessIdentity(lease.ownerPid);
    return (
      owner?.ProcessId === lease.ownerPid &&
      samePath(owner.Path, lease.ownerExecutablePath) &&
      utcTicks(owner.StartTimeUtc) === utcTicks(lease.ownerStartTimeUtc)
    );
  } catch {
    return false;
  }
}

export async function maintenanceLeaseActive({
  markerPath,
  nowUtc = new Date(),
  getProcessIdentity,
}) {
  try {
    return maintenanceLeaseRecordActive({
      lease: readJson(markerPath),
      nowUtc,
      getProcessIdentity,
    });
  } catch {
    return false;
  }
}

export function fileSha256(filename) {
  return createHash("sha256")
    .update(readFileSync(filename))
    .digest("hex")
    .toUpperCase();
}

export function tauriNsisPayloadHash(filename) {
  const bytes = readFileSync(filename);
  const unknown = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK", "ascii");
  const nsis = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS", "ascii");
  const index = bytes.indexOf(unknown);
  if (index < 0 || bytes.indexOf(unknown, index + 1) >= 0)
    throw new Error("Expected exactly one Tauri unknown bundle marker");
  nsis.copy(bytes, index);
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

export async function guardianIteration({
  state,
  nowUtc,
  failureThresholdSeconds,
  isMaintenance,
  inspectRuntime,
  recover,
  writeEvent,
}) {
  if (await isMaintenance()) {
    state.FailureSinceUtc = null;
    return;
  }
  const runtime = await inspectRuntime();
  if (runtime.Healthy) {
    state.FailureSinceUtc = null;
    return;
  }
  const now = new Date(nowUtc);
  if (state.FailureSinceUtc == null) {
    state.FailureSinceUtc = now;
    await writeEvent("warning", "health-loss-detected", {
      Owner: runtime.ListenerOwner,
    });
    return;
  }
  const elapsed = (now - new Date(state.FailureSinceUtc)) / 1000;
  if (elapsed < failureThresholdSeconds) return;
  await writeEvent("warning", "health-loss-threshold-reached", {
    ElapsedSeconds: Math.trunc(elapsed),
  });
  await recover();
  state.FailureSinceUtc = now;
}

export async function guardianUncleanExit({
  configPath,
  getProcessIdentity,
  expectedExecutable,
}) {
  let marker;
  try {
    marker = readJson(path.join(configPath, "logs", "app-run-marker.json"));
  } catch {
    return false;
  }
  if (!object(marker)) return false;
  const hasIdentity =
    Object.hasOwn(marker, "executablePath") ||
    Object.hasOwn(marker, "processStartedAtTicks");
  let expectedStart;
  try {
    if (Object.hasOwn(marker, "pid") && !Number.isSafeInteger(marker.pid))
      return false;
    if (hasIdentity) {
      if (!validPid(marker.pid) || !isAbsolute(marker.executablePath))
        return false;
      expectedStart = markerFiletime(marker.processStartedAtTicks);
      if (
        expectedExecutable !== undefined &&
        (!isAbsolute(expectedExecutable) ||
          !samePath(marker.executablePath, expectedExecutable))
      )
        return false;
    } else if (!validPid(marker.pid)) {
      return true;
    }
  } catch {
    return false;
  }
  let identity;
  try {
    identity = await getProcessIdentity(marker.pid);
  } catch {
    return true;
  }
  if (identity == null) return true;
  if (!hasIdentity) return false;
  try {
    if (!validPid(identity.ProcessId) || !isAbsolute(identity.Path))
      return false;
    return (
      identity.ProcessId !== marker.pid ||
      !samePath(marker.executablePath, identity.Path) ||
      expectedStart !== utcTicks(identity.StartTimeUtc)
    );
  } catch {
    return false;
  }
}

export function guardianRestartBudget({
  restartTimesUtc,
  nowUtc,
  windowMinutes,
  maxRestarts,
}) {
  if (
    !Number.isSafeInteger(windowMinutes) ||
    windowMinutes < 1 ||
    !Number.isSafeInteger(maxRestarts) ||
    maxRestarts < 1
  )
    return false;
  const start = new Date(nowUtc).getTime() - windowMinutes * 60_000;
  return (
    restartTimesUtc.filter((value) => new Date(value).getTime() >= start)
      .length < maxRestarts
  );
}

export async function guardianSafeIteration({ action, writeEvent }) {
  try {
    await action();
    return true;
  } catch {
    // Probe/native errors may contain arguments or provider data; event names
    // establish the failure without serializing arbitrary exception messages.
    await writeEvent("error", "iteration-failed", null);
    return false;
  }
}

export async function guardianRecovery({
  installedExecutable,
  isMaintenance,
  installedExecutableExists,
  getListenerOwner,
  getProcessIdentity,
  isExpectedProductIdentity,
  getExpectedProductProcesses,
  stopVerifiedProductProcess,
  waitPortFree,
  startProduct,
  waitReady,
  writeEvent,
}) {
  if (await isMaintenance())
    return writeEvent("info", "recovery-deferred-maintenance", null);
  if (!(await installedExecutableExists()))
    return writeEvent("error", "installed-executable-missing", {
      Path: installedExecutable,
    });
  const stopped = new Set();
  const ownerPid = await getListenerOwner();
  if (ownerPid != null) {
    let identity;
    try {
      identity = await getProcessIdentity(ownerPid);
    } catch {
      return writeEvent("warning", "listener-owner-transient", {
        ProcessId: ownerPid,
      });
    }
    if (!identity || !(await isExpectedProductIdentity(identity)))
      return writeEvent("error", "foreign-listener-blocked-recovery", {
        ProcessId: ownerPid,
        Path: identity?.Path ?? "",
      });
    await writeEvent("warning", "stopping-unhealthy-product", {
      ProcessId: ownerPid,
    });
    await stopVerifiedProductProcess(identity);
    stopped.add(ownerPid);
  }
  for (const identity of await getExpectedProductProcesses()) {
    if (
      !identity ||
      stopped.has(identity.ProcessId) ||
      !(await isExpectedProductIdentity(identity))
    )
      continue;
    await writeEvent("warning", "stopping-stale-product", {
      ProcessId: identity.ProcessId,
    });
    await stopVerifiedProductProcess(identity);
    stopped.add(identity.ProcessId);
  }
  if (!(await waitPortFree()))
    return writeEvent("error", "port-did-not-release", {
      Owner: await getListenerOwner(),
    });
  if (await isMaintenance())
    return writeEvent("info", "recovery-deferred-maintenance", null);
  const startedPid = await startProduct();
  await writeEvent("warning", "product-started", {
    ProcessId: startedPid,
    Path: installedExecutable,
  });
  const ready = await waitReady(startedPid);
  return writeEvent(
    ready ? "info" : "error",
    ready ? "recovery-ready" : "recovery-not-ready",
    { ProcessId: startedPid },
  );
}
