import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  parseWindowsJsonQueryOutput,
  runWindowsJsonQuery,
  windowsJsonQueryCommand,
} from "./windows-json-query.mjs";

test("Windows JSON probes require PowerShell 7 and preserve the supplied query", () => {
  const query = "[pscustomobject]@{ProcessId=42} | ConvertTo-Json -Compress";
  const command = windowsJsonQueryCommand(query);
  const output = runWindowsJsonQuery(command, "process", {
    run: (executable, args, options) => {
      assert.equal(executable, "pwsh.exe");
      assert.deepEqual(args.slice(0, 3), [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
      ]);
      assert.equal(args[3], command);
      assert.equal(options.timeout, 10_000);
      assert.equal(options.encoding, "utf8");
      assert.equal(options.windowsHide, true);
      assert.match(command, /\$PSVersionTable\.PSVersion\.Major -lt 7/);
      assert.ok(command.endsWith(`\n${query}`));
      return { status: 0, stdout: '{"ProcessId":42}' };
    },
  });
  assert.deepEqual(parseWindowsJsonQueryOutput(output, "process"), {
    ProcessId: 42,
  });
});

test("a timed-out Windows process probe fails with a bounded redacted diagnostic", () => {
  assert.throws(
    () =>
      runWindowsJsonQuery("[REDACTED_QUERY]", "process", {
        run: () => ({
          error: Object.assign(new Error("[REDACTED_QUERY]"), {
            code: "ETIMEDOUT",
          }),
          stdout: "[REDACTED_STDOUT]",
          stderr: "[REDACTED_STDERR]",
        }),
      }),
    (error) => {
      assert.match(error.message, /timed out after 10000ms/);
      assert.equal(error.message.includes("REDACTED"), false);
      assert.equal(Object.hasOwn(error, "cause"), false);
      return true;
    },
  );
});

test("missing PowerShell 7 never falls back to the legacy host", () => {
  let attempts = 0;
  assert.throws(
    () =>
      runWindowsJsonQuery("[REDACTED_QUERY]", "listener", {
        run: (executable) => {
          attempts += 1;
          assert.equal(executable, "pwsh.exe");
          return {
            error: Object.assign(new Error("[REDACTED_QUERY]"), {
              code: "ENOENT",
            }),
          };
        },
      }),
    /PowerShell 7 \(pwsh\.exe\) is required/,
  );
  assert.equal(attempts, 1);
});

test("unsuccessful and malformed Windows query outputs stay out of diagnostics", () => {
  assert.throws(
    () =>
      runWindowsJsonQuery("[REDACTED_QUERY]", "process", {
        run: () => ({
          status: 1,
          stdout: "[REDACTED_STDOUT]",
          stderr: "[REDACTED_STDERR]",
        }),
      }),
    (error) => {
      assert.match(error.message, /failed with status 1/);
      assert.equal(error.message.includes("REDACTED"), false);
      return true;
    },
  );
  assert.throws(
    () => parseWindowsJsonQueryOutput("[REDACTED_PROCESS_OUTPUT]", "process"),
    (error) => {
      assert.equal(
        error.message,
        "PowerShell process query returned malformed JSON.",
      );
      return true;
    },
  );
});

test("Windows probe timeouts cannot be disabled with an invalid override", () => {
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        runWindowsJsonQuery("query", "process", {
          timeoutMs,
          run: () => assert.fail("an invalid timeout must not start a host"),
        }),
      /requires a positive timeout/,
    );
  }
});

test(
  "the installed PowerShell 7 host returns safe UTF-8 JSON",
  { skip: process.platform !== "win32" },
  () => {
    const output = runWindowsJsonQuery(
      windowsJsonQueryCommand(
        "[pscustomobject]@{ProcessId=42;Label=([char]0x4e2d).ToString()} | ConvertTo-Json -Compress",
      ),
      "fixture",
      { run: spawnSync },
    );
    assert.deepEqual(parseWindowsJsonQueryOutput(output, "fixture"), {
      ProcessId: 42,
      Label: "\u4e2d",
    });
  },
);
