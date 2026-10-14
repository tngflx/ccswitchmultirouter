import { StringDecoder } from "node:string_decoder";

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
        ["upstream_capacity", "capacity_pressure"].includes(
          packet.reasonClass,
        )
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

export function createDevWatchdogOutputReader(onPacket) {
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
          const packet = JSON.parse(line.slice(PREFIX.length));
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
