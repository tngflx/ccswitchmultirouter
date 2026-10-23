import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, open, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Temporary, bounded launcher. The default is a read-only HOLD plan.
// Only --start creates the real verifier process. --self-test uses fixtures.
const self = fileURLToPath(import.meta.url);
const repository = "D:\\repos\\ccswitchmultirouter";
const node = "C:\\Program Files\\nodejs\\node.exe";
const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const verifier = path.join(
  repository,
  "scripts",
  "verify-codex-desktop-continuation.mjs",
);
const ccswitchLog = path.join(
  os.homedir(),
  ".cc-switch",
  "logs",
  "cc-switch.log",
);
const binary = path.join(
  repository,
  "src-tauri",
  "target",
  "debug",
  "cc-switch.exe",
);
const output = path.join(
  repository,
  "docs",
  "audits",
  "2026-10-22-desktop-continuation-runtime.json",
);
const prefix = path.join(
  os.tmpdir(),
  "ccswitch-desktop-continuation-watcher-20261022",
);
const manifestPath = `${prefix}.launch.json`;
const completionPath = `${prefix}.completion.json`;
const logPath = `${prefix}.log`;
const maximumLifetimeMs = 900_000 + 120_000;
const verifierArgs = [
  verifier,
  "--port",
  "9229",
  "--wait-ms",
  "900000",
  "--run-disposable-test",
  "--ccswitch-log",
  ccswitchLog,
  "--ccswitch-binary",
  binary,
  "--output",
  output,
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = async (file) =>
  access(file, constants.F_OK).then(
    () => true,
    () => false,
  );
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const writeExclusive = async (file, value) => {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(json(value));
  } finally {
    await handle.close();
  }
};
const digest = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const waitForJson = async (file, waitMs) => {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      return await readJson(file);
    } catch {}
    await sleep(50);
  }
  throw new Error("fixture_receipt_timeout");
};
const quoteWindowsArgument = (argument) => {
  assert.equal(typeof argument, "string");
  assert.ok(
    !/[\0\r\n"]/.test(argument) && !argument.endsWith("\\"),
    "Unsupported Windows argument",
  );
  return `"${argument}"`;
};
const createIndependentProcess = (arguments_, directory) => {
  const payload = Buffer.from(
    JSON.stringify({
      commandLine: [node, ...arguments_].map(quoteWindowsArgument).join(" "),
      directory,
    }),
    "utf8",
  ).toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion -lt [version]'7.5') { throw 'powershell_version_unsupported' }
$payload = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')))
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=[string]$payload.commandLine; CurrentDirectory=[string]$payload.directory; ProcessStartupInformation=$startup}
[pscustomobject]@{returnValue=[uint32]$created.ReturnValue; pid=[uint32]$created.ProcessId} | ConvertTo-Json -Compress
if ($created.ReturnValue -ne 0) { exit 1 }
`;
  const result = spawnSync(
    pwsh,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, encoding: "utf8", timeout: 15_000 },
  );
  assert.equal(result.status, 0, "independent_process_create_failed");
  const created = JSON.parse(result.stdout);
  assert.equal(created.returnValue, 0);
  assert.ok(Number.isInteger(created.pid) && created.pid > 0);
  return created.pid;
};
const plan = () => ({
  status: "HOLD",
  realWatcherStarted: false,
  node,
  pwsh,
  repository,
  verifier,
  args: verifierArgs.slice(1),
  ccswitchLog,
  binary,
  output,
  logPath,
  manifestPath,
  completionPath,
  maximumLifetimeMs,
});
const checkResources = async () => {
  assert.equal(process.platform, "win32");
  for (const file of [node, pwsh, self, verifier, ccswitchLog, binary]) {
    assert.ok(path.isAbsolute(file));
    assert.ok((await stat(file)).isFile(), "Required launch resource missing");
  }
  for (const file of [output, logPath, manifestPath, completionPath]) {
    assert.ok(path.isAbsolute(file));
    assert.equal(
      await exists(file),
      false,
      "Existing evidence or launch artifacts must not be overwritten",
    );
  }
  assert.ok((await stat(path.dirname(output))).isDirectory());
};
const mode = process.argv[2] || "--hold";
if (mode === "--hold") {
  assert.ok(process.argv.length <= 3);
  const snapshot = plan();
  snapshot.evidenceAlreadyExists = await exists(output);
  process.stdout.write(json(snapshot));
} else if (mode === "--start") {
  assert.equal(process.argv.length, 3);
  await checkResources();
  const token = randomUUID();
  await writeExclusive(manifestPath, {
    ...plan(),
    status: "launch_requested",
    token,
    launcherSha256: await digest(self),
    verifierSha256: await digest(verifier),
    requestedAtUtc: new Date().toISOString(),
    requestingPid: process.pid,
  });
  const pid = createIndependentProcess(
    [self, "--run-bound-watcher", token],
    repository,
  );
  process.stdout.write(
    json({
      status: "watcher_process_created",
      watcherPid: pid,
      manifestPath,
      completionPath,
      logPath,
      output,
      deliveryEvaluated: false,
    }),
  );
} else if (mode === "--run-bound-watcher") {
  assert.equal(process.argv.length, 4);
  const manifest = await readJson(manifestPath);
  assert.equal(manifest.token, process.argv[3], "launch_lease_mismatch");
  assert.equal(manifest.launcherSha256, await digest(self), "launcher_changed");
  assert.equal(
    manifest.verifierSha256,
    await digest(verifier),
    "verifier_changed",
  );
  assert.equal(await exists(output), false, "output_exists");
  const log = await open(logPath, "wx");
  let child;
  let timedOut = false;
  let timer;
  let status;
  try {
    await log.writeFile(
      json({
        status: "watcher_started",
        watcherPid: process.pid,
        nativeParentPid: process.ppid,
        maximumLifetimeMs,
        startedAtUtc: new Date().toISOString(),
      }),
    );
    child = spawn(node, verifierArgs, {
      cwd: repository,
      windowsHide: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, maximumLifetimeMs);
    status = await new Promise((resolve) => {
      child.once("error", () =>
        resolve({ failure: "verifier_process_start_failed" }),
      );
      child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    });
  } finally {
    clearTimeout(timer);
    await log.close();
  }
  await writeExclusive(completionPath, {
    status: timedOut ? "watcher_deadline" : "watcher_exited",
    ...status,
    watcherPid: process.pid,
    finishedAtUtc: new Date().toISOString(),
    outputPresent: await exists(output),
    deliveryEvaluated: false,
    evidenceAuthority: output,
  });
} else if (mode === "--self-test") {
  assert.equal(process.argv.length, 3);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ccswitch-independent-launch-fixture-"),
  );
  const parent = spawn(node, [self, "--fixture-parent", directory], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  parent.stderr.on("data", (data) => {
    stderr += data;
  });
  parent.stdout.resume();
  const exitCode = await new Promise((resolve, reject) => {
    parent.once("error", reject);
    parent.once("exit", resolve);
  });
  assert.equal(exitCode, 0, `fixture_parent_failed:${stderr.slice(0, 100)}`);
  const exitedAtUtc = new Date().toISOString();
  const done = await waitForJson(path.join(directory, "done.json"), 20_000);
  assert.equal(done.requestingParentPid, parent.pid);
  assert.equal(done.requestingParentAlive, false);
  assert.notEqual(done.nativeParentPid, parent.pid);
  assert.ok(Date.parse(done.doneAtUtc) >= Date.parse(exitedAtUtc));
  const report = {
    status: "independence_verified",
    realWatcherStarted: false,
    fixtureDirectory: directory,
    disposableParentPid: parent.pid,
    disposableParentExitCode: exitCode,
    parentExitedAtUtc: exitedAtUtc,
    child: done,
    verifiedAtUtc: new Date().toISOString(),
  };
  await writeExclusive(path.join(directory, "self-test.json"), report);
  process.stdout.write(json(report));
} else if (mode === "--fixture-parent") {
  const directory = process.argv[3];
  assert.ok(
    directory.startsWith(
      path.join(os.tmpdir(), "ccswitch-independent-launch-fixture-"),
    ),
  );
  const childPid = createIndependentProcess(
    [self, "--fixture-child", directory, String(process.pid)],
    repository,
  );
  const ready = await waitForJson(path.join(directory, "ready.json"), 15_000);
  assert.equal(ready.pid, childPid);
  assert.notEqual(ready.nativeParentPid, process.pid);
  await writeExclusive(path.join(directory, "parent-retiring.json"), {
    parentPid: process.pid,
    childPid,
    atUtc: new Date().toISOString(),
  });
} else if (mode === "--fixture-child") {
  const directory = process.argv[3];
  const requestingParentPid = Number(process.argv[4]);
  assert.ok(
    directory.startsWith(
      path.join(os.tmpdir(), "ccswitch-independent-launch-fixture-"),
    ),
  );
  assert.ok(Number.isInteger(requestingParentPid) && requestingParentPid > 0);
  await writeExclusive(path.join(directory, "ready.json"), {
    pid: process.pid,
    nativeParentPid: process.ppid,
    requestingParentPid,
    readyAtUtc: new Date().toISOString(),
  });
  const deadline = Date.now() + 20_000;
  while (alive(requestingParentPid) && Date.now() < deadline) await sleep(50);
  assert.equal(
    alive(requestingParentPid),
    false,
    "fixture_parent_did_not_exit",
  );
  await sleep(300);
  await writeExclusive(path.join(directory, "done.json"), {
    pid: process.pid,
    nativeParentPid: process.ppid,
    requestingParentPid,
    requestingParentAlive: alive(requestingParentPid),
    doneAtUtc: new Date().toISOString(),
  });
} else {
  throw new Error("Unsupported launcher mode");
}
