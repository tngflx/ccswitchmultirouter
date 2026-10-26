import { StringDecoder } from "node:string_decoder";
import { readFileSync } from "node:fs";

const recoveryPolicy = JSON.parse(
  readFileSync(new URL("./dev-recovery-policy.json", import.meta.url), "utf8"),
);
if (
  recoveryPolicy.schemaVersion !== 1 ||
  !Number.isSafeInteger(recoveryPolicy.restartWindowMs) ||
  recoveryPolicy.restartWindowMs <= 0 ||
  !Number.isSafeInteger(recoveryPolicy.maxRestarts) ||
  recoveryPolicy.maxRestarts <= 0 ||
  typeof recoveryPolicy.recoveryLaunchFlag !== "string" ||
  !/^--ccsm-dev-[a-z-]+$/.test(recoveryPolicy.recoveryLaunchFlag) ||
  ![
    "watchdogSettingKeys",
    "enabledOverrideValues",
    "sessionEnvironmentKeys",
  ].every(
    (key) =>
      Array.isArray(recoveryPolicy[key]) &&
      recoveryPolicy[key].length > 0 &&
      recoveryPolicy[key].every(
        (value) => typeof value === "string" && value.length > 0,
      ),
  ) ||
  typeof recoveryPolicy.watchdogOverrideKey !== "string"
) {
  throw new Error("Invalid development recovery policy contract");
}
for (const value of Object.values(recoveryPolicy)) {
  if (Array.isArray(value)) Object.freeze(value);
}
export const DEV_RECOVERY_POLICY = Object.freeze(recoveryPolicy);

export function readWatchdogEnabledSetting(settings) {
  for (const key of DEV_RECOVERY_POLICY.watchdogSettingKeys) {
    if (settings && Object.hasOwn(settings, key)) {
      return typeof settings[key] === "boolean" ? settings[key] : true;
    }
  }
  return true;
}

export function readDevWatchdogOverride(environment) {
  const override = environment[DEV_RECOVERY_POLICY.watchdogOverrideKey];
  if (override === undefined) return undefined;
  return DEV_RECOVERY_POLICY.enabledOverrideValues.includes(
    String(override).trim().toLowerCase(),
  );
}

export function recentDevRestartTimesMs(history, nowMs = Date.now()) {
  if (!Array.isArray(history)) return [];
  return history.filter(
    (timestamp) =>
      Number.isSafeInteger(timestamp) &&
      timestamp >= nowMs - DEV_RECOVERY_POLICY.restartWindowMs,
  );
}

// All dev recovery owners apply this policy after their own process/marker
// observations establish whether the exit was intentional.
export function devRestartDecision({
  intentionalExitReason,
  cleanExit,
  watchdogEnabled,
  nowMs,
  restartTimesMs,
}) {
  if (intentionalExitReason)
    return { restart: false, reason: intentionalExitReason };
  if (!watchdogEnabled) return { restart: false, reason: "disabled" };
  if (cleanExit) return { restart: false, reason: "clean-exit" };
  if (
    recentDevRestartTimesMs(restartTimesMs, nowMs).length >=
    DEV_RECOVERY_POLICY.maxRestarts
  ) {
    return { restart: false, reason: "rate-limited" };
  }
  return { restart: true, reason: "unexpected-exit" };
}

const PREFIX = "[ccsm-dev-watchdog] ";
const RECONNECT_WINDOW_MS = 120_000;
const RECONNECT_MIN_DURATION_MS = 60_000;
const RECONNECT_FAILURE_THRESHOLD = 3;
const MAX_TRACKED_STREAMS = 64;
const MAX_PACKET_BYTES = 16_384;

export function createDevReconnectTracker() {
  const streams = new Map();
  const prune = (nowMs) => {
    for (const [key, failures] of streams) {
      const recent = failures.filter(
        (failure) => failure.time >= nowMs - RECONNECT_WINDOW_MS,
      );
      if (recent.length === 0) {
        streams.delete(key);
      } else {
        streams.set(key, recent);
      }
    }
  };
  return {
    observe(packet, nowMs = Date.now()) {
      if (!/^[a-f0-9]{16}$/.test(packet.key ?? "")) {
        return;
      }
      if (["stream_finished", "stream_cancelled"].includes(packet.event)) {
        streams.delete(packet.key);
        return;
      }
      if (
        !["reconnect_failed", "retry_scheduled"].includes(packet.event) ||
        ["upstream_capacity", "capacity_pressure"].includes(packet.reasonClass)
      ) {
        return;
      }
      prune(nowMs);
      if (!streams.has(packet.key) && streams.size >= MAX_TRACKED_STREAMS) {
        streams.delete(streams.keys().next().value);
      }
      const failures = streams.get(packet.key) ?? [];
      if (
        Number.isInteger(packet.attempt) &&
        failures.at(-1)?.attempt === packet.attempt
      ) {
        return;
      }
      failures.push({ time: nowMs, attempt: packet.attempt });
      // Keep the first failure as the duration anchor even during rapid churn.
      streams.set(
        packet.key,
        failures.length > 32 ? [failures[0], ...failures.slice(-31)] : failures,
      );
    },
    recoveryReason(nowMs = Date.now()) {
      prune(nowMs);
      for (const failures of streams.values()) {
        if (
          failures.length >= RECONNECT_FAILURE_THRESHOLD &&
          failures.at(-1).time - failures[0].time >= RECONNECT_MIN_DURATION_MS
        ) {
          return "reconnect-loop";
        }
      }
      return null;
    },
  };
}

export function createDevWatchdogOutputReader(
  onPacket,
  { parsePacket = JSON.parse } = {},
) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let skippingOversizedLine = false;
  return {
    push(chunk) {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      const lines = `${pending}${text}`.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (skippingOversizedLine) {
          skippingOversizedLine = false;
          continue;
        }
        if (!line.startsWith(PREFIX) || line.length > MAX_PACKET_BYTES) {
          continue;
        }
        try {
          const packet = parsePacket(line.slice(PREFIX.length));
          if (packet && typeof packet === "object" && !Array.isArray(packet)) {
            onPacket(packet);
          }
        } catch {
          // Ordinary output and incomplete control records are not signals.
        }
      }
      if (pending.length > MAX_PACKET_BYTES) {
        pending = "";
        skippingOversizedLine = true;
      }
    },
  };
}
