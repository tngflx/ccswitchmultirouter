import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  launchIndependentWindowsProcess,
  quoteWindowsProcessArgument,
  stopIndependentWindowsProcess,
} from "./dev-independent-watchdog.mjs";

const helperUrl = new URL("./dev-independent-watchdog.mjs", import.meta.url)
  .href;
function installedNativePnpm() {
  const configured = process.env.npm_execpath;
  if (
    configured &&
    path.win32.basename(configured).toLowerCase() === "pnpm.exe" &&
    existsSync(configured)
  ) {
    return configured;
  }
  if (process.platform !== "win32") return null;
  const located = spawnSync("where.exe", ["pnpm.cmd"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 3000,
  });
  for (const shim of String(located.stdout ?? "")
    .trim()
    .split(/\r?\n/)) {
    if (!shim || !existsSync(shim)) continue;
    const relative = readFileSync(shim, "utf8").match(
      /"%~dp0[\\/]([^"\r\n]*[\\/]pnpm\.exe)"/i,
    )?.[1];
    if (!relative) continue;
    const executable = path.win32.resolve(path.win32.dirname(shim), relative);
    if (existsSync(executable)) return executable;
  }
  return null;
}
const pnpmExecutable = installedNativePnpm();

async function waitUntil(predicate, message, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test("independent launch quotes Windows argv and sends environment only over stdin", () => {
  let observed;
  const executable = "C:\\Program Files\\nodejs\\node.exe";
  const args = ["C:\\fixture\\watchdog.mjs", 'a"b', "trailing\\", "文 & $x"];
  const commandLine = [executable, ...args]
    .map(quoteWindowsProcessArgument)
    .join(" ");
  const identity = launchIndependentWindowsProcess(
    {
      executable,
      args,
      cwd: "C:\\fixture",
      env: { FIXTURE_TOKEN: "redacted-fixture" },
    },
    {
      run(command, nativeArgs, options) {
        observed = { command, nativeArgs, options };
        return {
          status: 0,
          stdout: JSON.stringify({
            ProcessId: 4242,
            ParentProcessId: 4241,
            ExecutablePath: executable,
            CommandLine: commandLine,
            CreationDate: "2026-10-27T02:00:00.123456Z",
            ProcessStartedAtTicks: "134375400001234567",
          }),
        };
      },
    },
  );
  assert.equal(identity.ProcessId, 4242);
  assert.equal(observed.command, "pwsh.exe");
  assert.equal(observed.nativeArgs.includes("-File"), false);
  assert.equal(
    observed.nativeArgs.join(" ").includes("redacted-fixture"),
    false,
  );
  assert.deepEqual(JSON.parse(observed.options.input).environment, [
    "FIXTURE_TOKEN=redacted-fixture",
  ]);
  assert.equal(observed.options.windowsHide, true);
  assert.equal(observed.options.timeout, 15_000);
  assert.match(observed.nativeArgs.at(-1), /CreateFlags=\[uint32\]0x01000000/);
  assert.equal(quoteWindowsProcessArgument('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsProcessArgument("trailing\\"), '"trailing\\\\"');
});

test("independent launch fails closed without exposing native diagnostics or environment", () => {
  for (const result of [
    { status: 1, stderr: "redacted-fixture-token" },
    { status: null, error: new Error("redacted-fixture-token") },
    { status: 0, stdout: "redacted-fixture-token" },
    { status: 0, stdout: JSON.stringify({ ProcessId: 4242 }) },
  ]) {
    assert.throws(
      () =>
        launchIndependentWindowsProcess(
          { executable: "C:\\node.exe", args: [], cwd: "C:\\fixture", env: {} },
          { run: () => result },
        ),
      (error) =>
        /Independent development watchdog/.test(error.message) &&
        !error.message.includes("redacted-fixture-token"),
    );
  }
});

test("independent launch rolls back a created process after post-create validation fails", () => {
  let script;
  assert.throws(
    () =>
      launchIndependentWindowsProcess(
        {
          executable: "C:\\node.exe",
          args: ["C:\\fixture\\watchdog.mjs"],
          cwd: "C:\\fixture",
          env: {},
        },
        {
          run(_command, args) {
            script = args.at(-1);
            return { status: 1, stderr: "redacted-native-diagnostic" };
          },
        },
      ),
    /Independent development watchdog launch failed/,
  );
  assert.match(script, /\$createdPid = 0/);
  assert.match(script, /\$handle\.Kill\(\)/);
  assert.match(script, /\$handle\.Path -ieq \$payload\.executable/);
  assert.match(script, /\$current\.CommandLine -ceq \$payload\.commandLine/);
  assert.doesNotMatch(script, /redacted-native-diagnostic/);
});

test(
  "native launch rollback kills a retained process after identity validation fails",
  {
    skip:
      process.platform !== "win32"
        ? "Windows PowerShell process identity only"
        : false,
    timeout: 15_000,
  },
  async (context) => {
    const childArgs = ["-e", "setTimeout(() => {}, 60000)"];
    const child = spawn(process.execPath, childArgs, {
      windowsHide: true,
      stdio: "ignore",
    });
    context.after(() => {
      if (alive(child.pid)) child.kill();
    });
    let cimCalls = 0;
    assert.throws(
      () =>
        launchIndependentWindowsProcess(
          {
            executable: process.execPath,
            args: childArgs,
            cwd: process.cwd(),
            env: {},
          },
          {
            run(command, args, options) {
              const script = args.at(-1);
              const prefix = `
function Invoke-CimMethod { [pscustomobject]@{ ReturnValue = 0; ProcessId = ${child.pid} } }
function Get-CimInstance {
  $script:cimCalls++
  if ($script:cimCalls -eq 1) { return [pscustomobject]@{ ExecutablePath = 'C:\\foreign.exe'; CommandLine = 'foreign' } }
  return [pscustomobject]@{ ExecutablePath = $payload.executable; CommandLine = $payload.commandLine }
}
`;
              return spawnSync(
                command,
                [...args.slice(0, -1), `${prefix}\n${script}`],
                options,
              );
            },
          },
        ),
      /Independent development watchdog launch failed/,
    );
    await waitUntil(() => !alive(child.pid), "rollback child must exit");
  },
);

test("independent cleanup validates the exact native identity before termination", () => {
  let observed;
  const identity = {
    ProcessId: 4242,
    ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
    CommandLine:
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\fixture\\watchdog.mjs"',
    ProcessStartedAtTicks: "134375400001234567",
  };
  const result = stopIndependentWindowsProcess(identity, {
    run(command, args, options) {
      observed = { command, args, options };
      return { status: 0, stdout: '{"stopped":true,"absent":false}' };
    },
  });
  assert.deepEqual(result, { stopped: true, absent: false });
  assert.equal(observed.command, "pwsh.exe");
  assert.equal(observed.options.windowsHide, true);
  assert.equal(observed.options.timeout, 15_000);
  assert.match(observed.args.at(-1), /ProcessStartedAtTicks/);
  assert.doesNotMatch(observed.args.at(-1), /Stop-Process/);
  assert.deepEqual(JSON.parse(observed.options.input), identity);
});

test(
  "native independent watchdog survives supervisor death and pnpm ancestor exit",
  {
    skip:
      process.platform !== "win32"
        ? "Windows ancestor jobs only"
        : !pnpmExecutable
          ? "This regression requires the installed native pnpm.exe distribution"
          : false,
    timeout: 30_000,
  },
  async (context) => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "ccsm-watchdog-ancestor-"),
    );
    const supervisorReady = path.join(directory, "supervisor-ready.json");
    const watchdogReady = path.join(directory, "watchdog-ready.json");
    const release = path.join(directory, "ancestor-exited.json");
    const completed = path.join(directory, "watchdog-completed.json");
    let identities;
    let supervisorKilled = false;
    context.after(async () => {
      if (identities && !supervisorKilled && alive(identities.supervisorPid)) {
        process.kill(identities.supervisorPid);
      }
      if (identities) {
        await waitUntil(
          () => !alive(identities.watchdog.ProcessId),
          "the finite owned watchdog must self-exit",
          17_000,
        );
      }
      assert.equal(path.dirname(directory), os.tmpdir());
      assert.ok(path.basename(directory).startsWith("ccsm-watchdog-ancestor-"));
      rmSync(directory, { recursive: true, force: true });
    });
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ scripts: { dev: "node supervisor.mjs" } }),
    );
    writeFileSync(
      path.join(directory, "supervisor.mjs"),
      `import {launchIndependentWindowsProcess} from ${JSON.stringify(helperUrl)};
import {writeFileSync} from 'node:fs';
const watchdog=launchIndependentWindowsProcess({executable:process.execPath,args:['watchdog.mjs','argument with spaces','quote"value','trailing\\\\','文 & $value'],cwd:process.cwd(),env:{...process.env,CCSM_ANCESTOR_FIXTURE:'fixture value 文'}});
writeFileSync('supervisor-ready.json',JSON.stringify({supervisorPid:process.pid,watchdog}));
setTimeout(()=>process.exit(3),20000);
`,
    );
    writeFileSync(
      path.join(directory, "watchdog.mjs"),
      `import {existsSync,writeFileSync} from 'node:fs';
writeFileSync('watchdog-ready.json',JSON.stringify({pid:process.pid,parent:process.ppid,argv:process.argv.slice(2),value:process.env.CCSM_ANCESTOR_FIXTURE,cwd:process.cwd()}));
const deadline=Date.now()+15000;
while(!existsSync('ancestor-exited.json')){if(Date.now()>deadline)process.exit(2);await new Promise(r=>setTimeout(r,25));}
writeFileSync('watchdog-completed.json',JSON.stringify({pid:process.pid,afterAncestorExit:true}));
`,
    );
    const pnpm = spawn(pnpmExecutable, ["dev"], {
      cwd: directory,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostics = "";
    pnpm.stdout.resume();
    pnpm.stderr.on("data", (chunk) => {
      diagnostics += chunk;
    });
    const pnpmExit = new Promise((resolve, reject) => {
      pnpm.once("error", reject);
      pnpm.once("exit", (code, signal) => resolve({ code, signal }));
    });
    await waitUntil(
      () => existsSync(supervisorReady) && existsSync(watchdogReady),
      `both native fixture processes must start: ${diagnostics.slice(0, 200)}`,
    );
    identities = JSON.parse(readFileSync(supervisorReady, "utf8"));
    const ready = JSON.parse(readFileSync(watchdogReady, "utf8"));
    assert.equal(ready.pid, identities.watchdog.ProcessId);
    assert.notEqual(ready.parent, identities.supervisorPid);
    assert.deepEqual(ready.argv, [
      "argument with spaces",
      'quote"value',
      "trailing\\",
      "文 & $value",
    ]);
    assert.equal(ready.value, "fixture value 文");
    assert.equal(ready.cwd, directory);
    process.kill(identities.supervisorPid);
    supervisorKilled = true;
    await pnpmExit;
    assert.equal(alive(identities.supervisorPid), false);
    assert.equal(
      alive(identities.watchdog.ProcessId),
      true,
      "the watchdog must outlive pnpm's job teardown",
    );
    writeFileSync(release, JSON.stringify({ pnpmExited: true }));
    await waitUntil(
      () => existsSync(completed),
      "the independent watchdog must run after pnpm exits",
    );
    assert.equal(
      JSON.parse(readFileSync(completed, "utf8")).afterAncestorExit,
      true,
    );
    await waitUntil(
      () => !alive(identities.watchdog.ProcessId),
      "the finite watchdog must self-exit",
    );
  },
);
