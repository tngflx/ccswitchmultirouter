import { samePath, utcTicks } from "./ccswitchmulti-guardian-core.mjs";

const validPid = (value) => Number.isSafeInteger(value) && value > 0;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function inspectCanonicalDevWatchdog(
  session,
  processes,
  { supervisorPid, scriptPath, executable },
) {
  if (!Object.hasOwn(session, "watchdogIdentity"))
    return { canonical: false, identity: null, unknown: false };
  const unknown = { canonical: true, identity: null, unknown: true };
  const recorded = session.watchdogIdentity;
  if (!recorded || typeof recorded !== "object" || Array.isArray(recorded))
    return unknown;
  const commandPattern = new RegExp(
    `^\\s*(?:"${escapeRegex(executable.replaceAll("/", "\\"))}"|${escapeRegex(executable.replaceAll("/", "\\"))})\\s+(?:"${escapeRegex(scriptPath.replaceAll("/", "\\"))}"|${escapeRegex(scriptPath.replaceAll("/", "\\"))})\\s+(?:"--ccsm-dev-watchdog"|--ccsm-dev-watchdog)\\s+(?:"${supervisorPid}"|${supervisorPid})\\s*$`,
    "i",
  );
  const commandMatches = (identity) =>
    typeof identity?.CommandLine === "string" &&
    commandPattern.test(identity.CommandLine.replaceAll("/", "\\"));
  const complete = (identity) => {
    if (
      !validPid(identity?.ProcessId) ||
      !validPid(identity.ParentProcessId) ||
      !samePath(identity.ExecutablePath, executable) ||
      !commandMatches(identity) ||
      typeof identity.CreationDate !== "string"
    )
      return false;
    try {
      const created = utcTicks(identity.CreationDate);
      if (Object.hasOwn(identity, "ProcessStartedAtTicks")) {
        if (
          typeof identity.ProcessStartedAtTicks !== "string" ||
          !/^\d+$/.test(identity.ProcessStartedAtTicks)
        )
          return false;
        const filetime = BigInt(identity.ProcessStartedAtTicks);
        if (
          filetime <= 0n ||
          filetime > 2650467743999999999n ||
          (filetime - 116444736000000000n) / 10n !== created / 10n
        )
          return false;
      }
      return created >= utcTicks(session.supervisorStartedAtUtc);
    } catch {
      return false;
    }
  };
  if (!complete(recorded)) return unknown;
  if (
    processes.some(
      (item) =>
        item.ParentProcessId === supervisorPid &&
        !item.CommandLine &&
        (!item.ExecutablePath || samePath(item.ExecutablePath, executable)),
    )
  )
    return unknown;
  // A second watcher for this owner cannot be silently ignored merely because
  // its PID differs from the canonical one. It may still perform a recovery.
  if (
    processes.some(
      (item) => item.ProcessId !== recorded.ProcessId && commandMatches(item),
    )
  )
    return unknown;
  const candidates = processes.filter(
    (item) => item.ProcessId === recorded.ProcessId,
  );
  if (candidates.length === 0)
    return { canonical: true, identity: null, unknown: false };
  if (candidates.length !== 1 || !complete(candidates[0])) return unknown;
  const current = candidates[0];
  try {
    if (
      current.ParentProcessId !== recorded.ParentProcessId ||
      current.CommandLine !== recorded.CommandLine ||
      !samePath(current.ExecutablePath, recorded.ExecutablePath) ||
      utcTicks(current.CreationDate) !== utcTicks(recorded.CreationDate)
    )
      return unknown;
  } catch {
    return unknown;
  }
  return {
    canonical: true,
    identity: Object.hasOwn(recorded, "ProcessStartedAtTicks")
      ? { ...current, ProcessStartedAtTicks: recorded.ProcessStartedAtTicks }
      : current,
    unknown: false,
  };
}
