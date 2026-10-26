import assert from "node:assert/strict";
import test from "node:test";
import { parseGuardianJson } from "./ccswitchmulti-guardian-core.mjs";

import {
  createDevReconnectTracker,
  createDevWatchdogOutputReader,
} from "./dev-watchdog-policy.mjs";

const key = "0123456789abcdef";

test("a sustained reconnect loop requests a rebuild without waiting four hours", () => {
  const tracker = createDevReconnectTracker();
  tracker.observe({ event: "reconnect_failed", key }, 0);
  tracker.observe({ event: "reconnect_failed", key }, 30_000);
  tracker.observe({ event: "reconnect_failed", key }, 60_000);
  assert.equal(tracker.recoveryReason(60_000), "reconnect-loop");
});

test("rapid repeated retries retain the duration anchor while memory stays bounded", () => {
  const tracker = createDevReconnectTracker();
  for (let second = 0; second <= 60; second += 1) {
    tracker.observe(
      { event: "retry_scheduled", key, attempt: (second % 5) + 1 },
      second * 1_000,
    );
  }
  assert.equal(tracker.recoveryReason(60_000), "reconnect-loop");
});

test("a single transient failure and stale failures do not request a restart", () => {
  const tracker = createDevReconnectTracker();
  tracker.observe({ event: "reconnect_failed", key }, 0);
  assert.equal(tracker.recoveryReason(60_000), null);
  tracker.observe({ event: "reconnect_failed", key }, 30_000);
  tracker.observe({ event: "reconnect_failed", key }, 60_000);
  assert.equal(tracker.recoveryReason(180_001), null);
});

test("a reconnect opening a socket does not erase repeated stream failures", () => {
  const tracker = createDevReconnectTracker();
  tracker.observe({ event: "reconnect_failed", key }, 0);
  tracker.observe({ event: "reconnected", key }, 20_000);
  tracker.observe({ event: "reconnect_failed", key }, 30_000);
  tracker.observe({ event: "reconnect_failed", key }, 60_000);
  assert.equal(tracker.recoveryReason(60_000), "reconnect-loop");
});

test("repeated reconnect attempts trigger recovery even when opening each socket succeeds", () => {
  const tracker = createDevReconnectTracker();
  tracker.observe({ event: "retry_scheduled", key, attempt: 1 }, 0);
  tracker.observe({ event: "reconnected", key, attempt: 1 }, 20_000);
  tracker.observe({ event: "retry_scheduled", key, attempt: 2 }, 30_000);
  tracker.observe({ event: "retry_scheduled", key, attempt: 3 }, 60_000);
  assert.equal(tracker.recoveryReason(60_000), "reconnect-loop");
});

test("scheduling and failure records for one attempt count only once", () => {
  const tracker = createDevReconnectTracker();
  tracker.observe({ event: "retry_scheduled", key, attempt: 1 }, 0);
  tracker.observe({ event: "reconnect_failed", key, attempt: 1 }, 30_000);
  tracker.observe({ event: "reconnect_failed", key, attempt: 1 }, 60_000);
  assert.equal(tracker.recoveryReason(60_000), null);
});

for (const event of ["stream_finished", "stream_cancelled"]) {
  test(`${event} clears a completed request's sustained retry loop`, () => {
    const tracker = createDevReconnectTracker();
    tracker.observe({ event: "retry_scheduled", key, attempt: 1 }, 0);
    tracker.observe({ event: "retry_scheduled", key, attempt: 2 }, 30_000);
    tracker.observe({ event: "retry_scheduled", key, attempt: 3 }, 60_000);
    assert.equal(tracker.recoveryReason(60_000), "reconnect-loop");

    tracker.observe({ event, key }, 60_001);
    assert.equal(tracker.recoveryReason(60_001), null);
    tracker.observe({ event: "retry_scheduled", key, attempt: 1 }, 60_002);
    assert.equal(tracker.recoveryReason(60_002), null);
  });

  test(`${event} clears only its matching request`, () => {
    const tracker = createDevReconnectTracker();
    const otherKey = "fedcba9876543210";
    for (const streamKey of [key, otherKey]) {
      tracker.observe(
        { event: "retry_scheduled", key: streamKey, attempt: 1 },
        0,
      );
      tracker.observe(
        { event: "retry_scheduled", key: streamKey, attempt: 2 },
        30_000,
      );
      tracker.observe(
        { event: "retry_scheduled", key: streamKey, attempt: 3 },
        60_000,
      );
    }
    tracker.observe({ event, key }, 60_001);
    assert.equal(tracker.recoveryReason(60_001), "reconnect-loop");
    tracker.observe({ event, key: otherKey }, 60_002);
    assert.equal(tracker.recoveryReason(60_002), null);
  });
}

test("different streams and capacity waits cannot create a reconnect loop", () => {
  const tracker = createDevReconnectTracker();
  tracker.observe({ event: "reconnect_failed", key }, 0);
  tracker.observe(
    { event: "reconnect_failed", key: "fedcba9876543210" },
    30_000,
  );
  tracker.observe(
    { event: "retry_scheduled", key, reasonClass: "upstream_capacity" },
    60_000,
  );
  assert.equal(tracker.recoveryReason(60_000), null);
});

test("the dev control reader reconstructs split packets and ignores normal logs", () => {
  const packets = [];
  const reader = createDevWatchdogOutputReader((packet) =>
    packets.push(packet),
  );
  reader.push('ordinary log\n[ccsm-dev-watchdog] {"event":"recon');
  reader.push(`nect_failed","key":"${key}"}\n`);
  reader.push("[ccsm-dev-watchdog] invalid JSON\n");
  assert.deepEqual(packets, [{ event: "reconnect_failed", key }]);
});

test("the dev control reader preserves exact FILETIME through an injected parser", () => {
  const packets = [];
  const reader = createDevWatchdogOutputReader(
    (packet) => packets.push(packet),
    { parsePacket: parseGuardianJson },
  );
  reader.push(
    '[ccsm-dev-watchdog] {"event":"ready","pid":123,"processStartedAtTicks":134058312000000',
  );
  reader.push("039}\n");
  assert.deepEqual(packets, [
    {
      event: "ready",
      pid: 123,
      processStartedAtTicks: "134058312000000039",
    },
  ]);
});
