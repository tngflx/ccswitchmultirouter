import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitPlannedDevExit,
  stopPlannedWindowsApp,
} from "./dev-app-exit.mjs";
import {
  runPlannedDevCleanup,
  stopVerifiedWindowsApp,
} from "./dev-tauri-delayed.mjs";
import { windowsGuardianQuery } from "./watch-ccswitchmulti.mjs";
import { parseGuardianJson } from "./ccswitchmulti-guardian-core.mjs";

const journalFixture = parseGuardianJson(
  readFileSync(
    new URL("../tests/fixtures/devPlannedExit.json", import.meta.url),
    "utf8",
  ),
);

const app = {
  ProcessId: 42,
  Name: "cc-switch.exe",
  ExecutablePath: "C:/repo/src-tauri/target/debug/cc-switch.exe",
  CreationDate: "2026-10-22T00:00:00.0000000Z",
  NativeStartedAtFiletime: "134371008000000000",
};

const appIdentity = {
  pid: app.ProcessId,
  executablePath: app.ExecutablePath,
  processStartedAtTicks: app.NativeStartedAtFiletime,
  markerPath: path.resolve("fixture-app-config", "logs", "app-run-marker.json"),
};

test("a planned native app termination commits only after all tree and listener cleanup", async () => {
  const events = [];
  const proof = { terminated: true };
  await runPlannedDevCleanup(
    async (options) => {
      await stopVerifiedWindowsApp(app, {
        ...options,
        appIdentities: [appIdentity],
        queryProcesses: () => [app],
        queryListeners: () => [{ address: "127.0.0.1", port: 15721 }],
        stopPlannedApp: () => {
          events.push("native-terminated");
          return proof;
        },
        terminate: () =>
          assert.fail(
            "planned termination must use its retained native app handle",
          ),
        waitForProcessExit: async () => events.push("process-exited"),
        waitForListenersReleased: async () => events.push("listeners-released"),
        log: () => {},
      });
      events.push("tree-cleaned");
    },
    "development_manual_restart",
    {
      commit: (value) => {
        assert.equal(value, proof);
        events.push("planned-event");
      },
    },
  );
  assert.deepEqual(events, [
    "native-terminated",
    "process-exited",
    "listeners-released",
    "tree-cleaned",
    "planned-event",
  ]);
});

test("a failed cleanup and an already-dead app never commit a planned exit", async () => {
  let commits = 0;
  await assert.rejects(
    runPlannedDevCleanup(
      async ({ plannedAppExits }) => {
        plannedAppExits.push({ terminated: true });
        throw new Error("owned listener still active");
      },
      "development_backend_reload",
      { commit: () => commits++ },
    ),
    /owned listener/,
  );
  await runPlannedDevCleanup(
    async (options) =>
      stopVerifiedWindowsApp(app, {
        ...options,
        queryProcesses: () => [],
        queryListeners: () => [],
        stopPlannedApp: () =>
          assert.fail("dead app cannot become a planned termination"),
        log: () => {},
      }),
    "development_requested_exit",
    { commit: () => commits++ },
  );
  assert.equal(commits, 0);
});

test("unexpected cleanup does not use planned termination or create a planned receipt", async () => {
  let killed = 0;
  await stopVerifiedWindowsApp(app, {
    queryProcesses: () => [app],
    queryListeners: () => [],
    terminate: () => {
      killed++;
      return { status: 0 };
    },
    stopPlannedApp: () =>
      assert.fail("automatic crash cleanup must preserve crash classification"),
    waitForProcessExit: async () => {},
    log: () => {},
  });
  assert.equal(killed, 1);
});

test("an app exiting during planned termination cannot let fallback kill its reused PID", async () => {
  let queries = 0;
  await stopVerifiedWindowsApp(app, {
    plannedExitReason: "development_manual_restart",
    plannedAppExits: [],
    appIdentities: [appIdentity],
    queryProcesses: () =>
      ++queries === 1
        ? [app]
        : [{ ...app, CreationDate: "2026-10-22T00:00:00.0000001Z" }],
    queryListeners: () => [],
    stopPlannedApp: () => ({ terminated: false }),
    terminate: () =>
      assert.fail("the earlier app identity no longer owns this PID"),
    waitForProcessExit: async () => {},
    log: () => {},
  });
});

test("planned exit entry points reject incomplete proof without running Windows commands", () => {
  const runQuery = () =>
    assert.fail("invalid input cannot reach a process operation");
  assert.throws(
    () =>
      stopPlannedWindowsApp(app, {
        reason: "automatic_crash",
        markerPath: "C:/x",
        runQuery,
      }),
    /Invalid planned/,
  );
  assert.throws(
    () =>
      stopPlannedWindowsApp(
        {},
        { reason: "development_manual_restart", markerPath: "C:/x", runQuery },
      ),
    /complete process identity/,
  );
  for (const NativeStartedAtFiletime of [
    undefined,
    "",
    Number(app.NativeStartedAtFiletime),
    "18446744073709551616",
  ]) {
    assert.throws(
      () =>
        stopPlannedWindowsApp(
          { ...app, NativeStartedAtFiletime },
          {
            reason: "development_manual_restart",
            markerPath: appIdentity.markerPath,
            requireMarker: true,
            runQuery,
          },
        ),
      /complete process identity/,
    );
  }
  assert.equal(
    commitPlannedDevExit({ terminated: false }, { runQuery }),
    false,
  );
});

test(
  "native planned app exit retains exact marker identity and rejects stale receipts",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "ccswitch-planned-exit-"),
    );
    const markerPath = path.join(directory, "app-run-marker.json");
    const journalPath = path.join(directory, "app-exit-events.jsonl");
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await once(child, "spawn");
    try {
      const identity = windowsGuardianQuery(
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}' -ErrorAction Stop; $h = Get-Process -Id ${child.pid} -ErrorAction Stop; try { [pscustomobject]@{ ProcessId=[int]$p.ProcessId; Name=$p.Name; ExecutablePath=$p.ExecutablePath; CreationDate=$p.CreationDate.ToUniversalTime().ToString('o'); ticks=$h.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() } | ConvertTo-Json -Compress } finally { $h.Dispose() }`,
        "planned exit native fixture",
      );
      const marker = {
        startedAt: "2026-10-22 12:00:00.000",
        pid: child.pid,
        executablePath: identity.ExecutablePath,
        processStartedAtTicks: identity.ticks,
        configScope: "fixture-scope",
        version: "fixture",
        os: "windows",
        arch: "x86_64",
      };
      const writeMarker = (value) =>
        writeFileSync(
          markerPath,
          JSON.stringify(value).replace(
            /"processStartedAtTicks":"(\d+)"/,
            '"processStartedAtTicks":$1',
          ),
        );
      writeMarker({
        ...marker,
        processStartedAtTicks: String(
          BigInt(marker.processStartedAtTicks) + 1n,
        ),
      });
      assert.throws(
        () =>
          stopPlannedWindowsApp(identity, {
            markerPath,
            reason: "development_manual_restart",
          }),
        /planned development app stop/,
      );
      assert.doesNotThrow(
        () => process.kill(child.pid, 0),
        "a one-tick marker mismatch cannot kill the app",
      );
      writeMarker(marker);
      assert.throws(
        () =>
          stopPlannedWindowsApp(
            {
              ...identity,
              NativeStartedAtFiletime: (BigInt(identity.ticks) + 1n).toString(),
            },
            {
              markerPath,
              reason: "development_manual_restart",
              requireMarker: true,
            },
          ),
        /planned development app stop/,
        "a stale exact native query proof cannot authorize a new process even when its marker matches the live handle",
      );
      assert.doesNotThrow(
        () => process.kill(child.pid, 0),
        "a one-tick native proof mismatch cannot kill the disposable fixture",
      );
      const proof = stopPlannedWindowsApp(
        { ...identity, NativeStartedAtFiletime: identity.ticks },
        {
          markerPath,
          reason: "development_manual_restart",
          requireMarker: true,
        },
      );
      assert.equal(proof.terminated, true);
      assert.equal(commitPlannedDevExit(proof), true);
      const event = JSON.parse(readFileSync(journalPath, "utf8").trim());
      assert.deepEqual(
        Object.keys(event).sort(),
        Object.keys(journalFixture.event).sort(),
      );
      assert.deepEqual(
        Object.keys(event.details).sort(),
        Object.keys(journalFixture.event.details).sort(),
      );
      assert.equal(typeof event.details.processStartedAtTicks, "string");
      assert.equal(event.kind, "planned_restart");
      assert.equal(event.pid, child.pid);
      assert.deepEqual(event.details, {
        executablePath: marker.executablePath,
        processStartedAtTicks: marker.processStartedAtTicks,
        configScope: marker.configScope,
        startedAt: marker.startedAt,
      });
      assert.equal(
        readFileSync(markerPath, "utf8"),
        proof.markerText,
        "the canonical marker remains for startup classification",
      );
      writeMarker({
        ...marker,
        processStartedAtTicks: String(
          BigInt(marker.processStartedAtTicks) + 1n,
        ),
      });
      assert.throws(
        () => commitPlannedDevExit(proof),
        /planned development app exit commit/,
      );
      assert.equal(
        readFileSync(journalPath, "utf8").trim().split(/\r?\n/).length,
        1,
      );
      assert.deepEqual(
        stopPlannedWindowsApp(identity, {
          markerPath,
          reason: "development_requested_exit",
        }),
        { terminated: false },
      );
    } finally {
      if (child.exitCode === null) child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "planned app stop precedes child teardown when losing a child exits the app",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "ccswitch-planned-child-exit-"),
    );
    const markerPath = path.join(directory, "app-run-marker.json");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const { spawn } = require("node:child_process");
      const worker = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
      worker.once("exit", () => process.exit(0));
      worker.once("spawn", () => process.send({ childPid: worker.pid }));
      setInterval(()=>{},1000);
    `,
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true },
    );
    const [{ childPid }] = await once(child, "message");
    try {
      const identity = windowsGuardianQuery(
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}' -ErrorAction Stop; $h = Get-Process -Id ${child.pid} -ErrorAction Stop; try { [pscustomobject]@{ ProcessId=[int]$p.ProcessId; Name=$p.Name; ExecutablePath=$p.ExecutablePath; CreationDate=$p.CreationDate.ToUniversalTime().ToString('o'); ticks=$h.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() } | ConvertTo-Json -Compress } finally { $h.Dispose() }`,
        "planned child-dependent app fixture",
      );
      writeFileSync(
        markerPath,
        JSON.stringify({
          startedAt: "2026-10-22 12:00:00.000",
          pid: child.pid,
          executablePath: identity.ExecutablePath,
          processStartedAtTicks: identity.ticks,
          configScope: "fixture-scope",
          version: "fixture",
          os: "windows",
          arch: "x86_64",
        }),
      );
      const proof = stopPlannedWindowsApp(identity, {
        markerPath,
        reason: "development_manual_restart",
      });
      assert.equal(
        proof.terminated,
        true,
        "the retained app must receive our unique planned exit code before child loss can make it exit naturally",
      );
      assert.throws(
        () => process.kill(childPid, 0),
        "verified child cleanup must still finish",
      );
      assert.equal(commitPlannedDevExit(proof), true);
    } finally {
      if (child.exitCode === null) child.kill();
      try {
        process.kill(childPid);
      } catch {}
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a live app with a removed clean-exit marker still stops without a false planned receipt",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "ccswitch-planned-no-marker-"),
    );
    const markerPath = path.join(directory, "app-run-marker.json");
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await once(child, "spawn");
    try {
      const identity = windowsGuardianQuery(
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}' -ErrorAction Stop; [pscustomobject]@{ ProcessId=[int]$p.ProcessId; Name=$p.Name; ExecutablePath=$p.ExecutablePath; CreationDate=$p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress`,
        "planned markerless app fixture",
      );
      const proof = stopPlannedWindowsApp(identity, {
        markerPath,
        reason: "development_requested_exit",
      });
      assert.equal(proof.terminated, true);
      assert.equal(proof.markerText, null);
      assert.equal(commitPlannedDevExit(proof), false);
      assert.throws(() => process.kill(child.pid, 0));
    } finally {
      if (child.exitCode === null) child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("planned glue requires the verified marker to survive until native termination validation", () => {
  let captured;
  stopPlannedWindowsApp(app, {
    markerPath: appIdentity.markerPath,
    reason: "development_manual_restart",
    requireMarker: true,
    runQuery: (script) => {
      captured = script;
      return '{"terminated":false}';
    },
  });
  const payload = JSON.parse(
    Buffer.from(
      captured.match(/FromBase64String\('([^']+)'\)/)[1],
      "base64",
    ).toString("utf8"),
  );
  assert.equal(payload.requireMarker, true);
  const guard = captured.indexOf(
    "if ($proof.requireMarker -and $null -eq $marker)",
  );
  const mutation = captured.indexOf(
    "[CcsmPlannedExitNative]::TerminateProcess($handle.Handle",
  );
  assert.ok(
    guard >= 0 && guard < mutation,
    "a marker disappearing after JavaScript verification must fail before the native mutation",
  );
  assert.match(
    captured.slice(guard, mutation),
    /throw 'The verified development app marker disappeared before planned termination/,
  );
});
