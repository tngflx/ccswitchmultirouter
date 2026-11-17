import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONTROL_FILE_NAME,
  DEFAULT_MAX_EVENTS,
  DEFAULT_MINUTES,
  executeCodexErrorCapture,
  formatCodexErrorCaptureHelp,
  isCanonicalUuid,
  normalizeBoundedConfigDir,
  normalizeCodexErrorCaptureOptions,
  parseCodexErrorCaptureArguments,
  readCodexErrorCaptureControl,
} from "./codex-error-capture.mjs";

const SESSION = "01a05b75-d141-7652-ac6c-a6258653316d";
const CAPTURE = "11111111-2222-3333-4444-555555555555";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccsm-codex-error-capture-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("argument parser accepts JavaScript and PowerShell-style aliases", () => {
  assert.deepEqual(
    parseCodexErrorCaptureArguments([
      "-Action",
      "enable",
      "-SessionId",
      SESSION,
      "-Minutes",
      "7",
      "-MaxEvents",
      "4",
      "-ConfigDir",
      "fixture",
    ]),
    {
      action: "enable",
      sessionId: SESSION,
      minutes: "7",
      maxEvents: "4",
      configDir: "fixture",
    },
  );
  assert.deepEqual(
    parseCodexErrorCaptureArguments(["--action=status", "--max-events=2"]),
    { action: "status", maxEvents: "2" },
  );
  assert.deepEqual(parseCodexErrorCaptureArguments([]), {});
  assert.throws(
    () => parseCodexErrorCaptureArguments(["--unknown"]),
    /Unknown Codex error capture option/,
  );
  assert.throws(
    () =>
      parseCodexErrorCaptureArguments([
        "--action",
        "status",
        "--action",
        "enable",
      ]),
    /specified twice/,
  );
  assert.throws(
    () => parseCodexErrorCaptureArguments(["--action"]),
    /requires a value/,
  );
});

test("option normalization validates canonical UUID, bounded expiry/count, and config path", () => {
  const home = path.join(os.tmpdir(), "ccsm-home");
  const options = normalizeCodexErrorCaptureOptions(
    {
      action: "enable",
      sessionId: SESSION.toUpperCase(),
      minutes: "30",
      maxEvents: "20",
      configDir: path.join(home, ".cc-switch"),
    },
    { homeDir: home },
  );
  assert.equal(options.sessionId, SESSION);
  assert.equal(options.minutes, 30);
  assert.equal(options.maxEvents, 20);
  assert.equal(options.configDir, path.join(home, ".cc-switch"));
  assert.throws(
    () => normalizeCodexErrorCaptureOptions({ action: "enable" }),
    /SessionId must be a canonical task UUID/,
  );
  assert.throws(
    () =>
      normalizeCodexErrorCaptureOptions({
        action: "enable",
        sessionId: "not-a-uuid",
      }),
    /SessionId must be a canonical task UUID/,
  );
  assert.throws(
    () =>
      normalizeCodexErrorCaptureOptions({
        action: "enable",
        sessionId: SESSION,
        minutes: 0,
      }),
    /Minutes must be an integer from 1 to 30/,
  );
  assert.throws(
    () =>
      normalizeCodexErrorCaptureOptions({
        action: "enable",
        sessionId: SESSION,
        maxEvents: 21,
      }),
    /MaxEvents must be an integer from 1 to 20/,
  );
  assert.throws(
    () => normalizeBoundedConfigDir(path.parse(home).root),
    /must not be a filesystem root/,
  );
  assert.throws(
    () => normalizeBoundedConfigDir(`${home}\0bad`),
    /valid config directory/,
  );
  assert.equal(isCanonicalUuid(SESSION), true);
  assert.equal(
    isCanonicalUuid("{01a05b75-d141-7652-ac6c-a6258653316d}"),
    false,
  );
});

test("enable writes the bounded four-field control schema and never restarts a service", () => {
  const f = fixture();
  try {
    const result = executeCodexErrorCapture(
      {
        action: "enable",
        sessionId: SESSION,
        minutes: 10,
        maxEvents: 6,
        configDir: f.root,
      },
      { now: 1_700_000_000_000, makeUuid: () => CAPTURE },
    );
    assert.deepEqual(result.control, {
      capture_id: CAPTURE,
      session_id: SESSION,
      expires_at: 1_700_000_600,
      max_events: 6,
    });
    assert.deepEqual(
      JSON.parse(readFileSync(result.controlPath, "utf8")),
      result.control,
    );
    assert.equal(path.basename(result.controlPath), CONTROL_FILE_NAME);
    assert.equal(result.lines[0].includes("no service was restarted"), true);
    assert.equal(
      result.lines[1],
      path.join(f.root, "logs", "codex-error-captures", CAPTURE),
    );
    assert.equal(existsSync(result.outputDir), false);
    assert.throws(
      () =>
        executeCodexErrorCapture(
          { action: "enable", sessionId: SESSION, configDir: f.root },
          { now: 1_700_000_000_000, makeUuid: () => "not-a-uuid" },
        ),
      /capture ID generator returned an invalid UUID/,
    );
  } finally {
    f.cleanup();
  }
});

test("status reports active and expired controls, while malformed controls stay rejected", () => {
  const f = fixture();
  try {
    executeCodexErrorCapture(
      { action: "enable", sessionId: SESSION, configDir: f.root },
      { now: 1_700_000_000_000, makeUuid: () => CAPTURE },
    );
    const active = executeCodexErrorCapture(
      { action: "status", configDir: f.root },
      { now: 1_700_000_100_000 },
    );
    assert.equal(active.status.SessionId, SESSION);
    assert.equal(active.status.CaptureId, CAPTURE);
    assert.equal(active.status.Expired, false);
    assert.equal(active.status.MaxEvents, DEFAULT_MAX_EVENTS);
    assert.equal(active.status.ExpiresAt, "2023-11-14T22:23:20.000Z");
    assert.deepEqual(JSON.parse(active.lines[0]), active.status);

    const expired = executeCodexErrorCapture(
      { action: "status", configDir: f.root },
      { now: 1_700_000_600_000 },
    );
    assert.equal(expired.status.Expired, true);

    const controlPath = path.join(f.root, CONTROL_FILE_NAME);
    const control = JSON.parse(readFileSync(controlPath, "utf8"));
    control.capture_id = "../escape";
    writeFileSync(controlPath, JSON.stringify(control));
    assert.throws(
      () => readCodexErrorCaptureControl(f.root),
      /control file is malformed/,
    );
  } finally {
    f.cleanup();
  }
});

test("disable removes only the control file and preserves existing captures", () => {
  const f = fixture();
  try {
    const enabled = executeCodexErrorCapture(
      { action: "enable", sessionId: SESSION, configDir: f.root },
      { now: 1_700_000_000_000, makeUuid: () => CAPTURE },
    );
    const retained = path.join(enabled.outputDir, "00.json");
    mkdirSync(enabled.outputDir, { recursive: true });
    writeFileSync(retained, "{}\n");
    const disabled = executeCodexErrorCapture({
      action: "disable",
      configDir: f.root,
    });
    assert.deepEqual(disabled.lines, [
      "Capture disabled; existing diagnostic files retained.",
    ]);
    assert.equal(existsSync(enabled.controlPath), false);
    assert.equal(existsSync(retained), true);
    const missing = executeCodexErrorCapture({
      action: "status",
      configDir: f.root,
    });
    assert.deepEqual(missing.lines, ["Capture disabled."]);
  } finally {
    f.cleanup();
  }
});

test("default values and help keep the no-restart boundary explicit", () => {
  const options = normalizeCodexErrorCaptureOptions(
    { action: "status" },
    { homeDir: "C:\\Users\\fixture" },
  );
  assert.equal(options.minutes, DEFAULT_MINUTES);
  assert.equal(options.maxEvents, DEFAULT_MAX_EVENTS);
  const help = formatCodexErrorCaptureHelp();
  assert.match(help, /never restarts a service/i);
  assert.match(help, /--config-dir PATH/);
});
