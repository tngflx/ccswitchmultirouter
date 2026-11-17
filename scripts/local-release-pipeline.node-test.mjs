import assert from "node:assert/strict";
import {
  existsSync,
  utimesSync,
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
  exportReleaseArtifacts,
  exitPipelineLock,
  enterPipelineLock,
  parseLocalReleaseOptions,
  runLocalRelease,
  writeReleaseChecksums,
} from "./local-release-pipeline.mjs";
import {
  assertReleaseSourceIdentity,
  getReleaseSourceIdentity,
  releaseFileSha256,
  resolveReleaseRoot,
  tauriNsisInstalledExeSha256,
  withLocalReleaseCargoTarget,
} from "./release-build-config.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccsm-local-release-js-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(
    path.join(root, "src-tauri", "target", "release", "bundle", "nsis"),
    {
      recursive: true,
    },
  );
  mkdirSync(path.join(root, "node_modules", "@tauri-apps", "cli"), {
    recursive: true,
  });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      version: "3.20.4-1",
      devDependencies: { "@tauri-apps/cli": "2.10.1" },
    }),
  );
  writeFileSync(
    path.join(root, "node_modules", "@tauri-apps", "cli", "package.json"),
    JSON.stringify({ version: "2.10.1" }),
  );
  writeFileSync(
    path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"),
    "fixture",
  );
  writeFileSync(
    path.join(root, "src-tauri", "Cargo.toml"),
    "[package]\nname='fixture'\n",
  );
  writeFileSync(
    path.join(root, "src-tauri", "target", "release", "cc-switch.exe"),
    "before__TAURI_BUNDLE_TYPE_VAR_UNKafter",
  );
  writeFileSync(
    path.join(
      root,
      "src-tauri",
      "target",
      "release",
      "bundle",
      "nsis",
      "CCSwitchMulti_3.20.4-1_x64-setup.exe",
    ),
    "fixture installer",
  );
  return root;
}

test("local release parser accepts Node and legacy PowerShell spellings", () => {
  assert.deepEqual(
    parseLocalReleaseOptions([
      "--release-root",
      "D:/release",
      "-SkipBuild",
      "--no-typecheck",
      "-Reason",
      "post-commit",
    ]),
    {
      releaseRoot: "D:/release",
      skipBuild: true,
      noTypecheck: true,
      reason: "post-commit",
      help: false,
    },
  );
  assert.throws(() => parseLocalReleaseOptions(["--reason"]), /Missing value/);
  assert.throws(
    () => parseLocalReleaseOptions(["--unknown"]),
    /Unknown local release option/,
  );
});

test("release lock only removes the token it created", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccsm-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, "local-release.lock");
  const token = enterPipelineLock(lock, { token: "owner-token" });
  assert.equal(token, "owner-token");
  assert.throws(
    () => enterPipelineLock(lock, { token: "contender-token" }),
    /already running/,
  );
  exitPipelineLock(lock, "contender-token");
  assert.equal(existsSync(lock), true);
  exitPipelineLock(lock, token);
  assert.equal(existsSync(lock), false);
});

test("release identity and default root helpers preserve the source guard", (t) => {
  const root = fixture(t);
  const calls = [];
  const identity = getReleaseSourceIdentity(root, {
    run: (_executable, args) => {
      calls.push(args);
      if (args.includes("--abbrev-ref")) return { status: 0, stdout: "main\n" };
      if (args.includes("HEAD")) return { status: 0, stdout: "commit-a\n" };
      return { status: 0, stdout: "" };
    },
  });
  assert.deepEqual(identity, {
    commit: "commit-a",
    branch: "main",
    version: "3.20.4-1",
    trackedWorktree: "clean",
  });
  assert.equal(calls.length, 3);
  assert.doesNotThrow(() =>
    assertReleaseSourceIdentity(identity, { ...identity }),
  );
  assert.throws(
    () =>
      assertReleaseSourceIdentity(identity, {
        ...identity,
        commit: "commit-b",
      }),
    /release source identity changed/,
  );
  const commonDir = path.join(root, ".git");
  assert.equal(
    resolveReleaseRoot(root, "", { gitCommonDir: commonDir }),
    path.join(path.dirname(root), "最新版ccswitchmulti"),
  );
});

test("release helpers hash raw and NSIS-projected executables", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccsm-hash-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "raw.exe");
  writeFileSync(file, "ccswitchmulti-release");
  assert.equal(
    releaseFileSha256(file),
    "7C10D97BCA5D29117B515F045186B8A7AA535CE7A0F1E775AEC72A1AC9504C2F",
  );
  writeFileSync(file, "before__TAURI_BUNDLE_TYPE_VAR_UNKafter");
  assert.equal(
    tauriNsisInstalledExeSha256(file),
    "2609555DE77DC53CFF714B5AD8D8054D8E7322EDCC395A47828F06E6797695B1",
  );
  writeFileSync(file, "no marker");
  assert.throws(
    () => tauriNsisInstalledExeSha256(file),
    /exactly one restored UNK/,
  );
});

test("isolated Cargo target restores caller environment after action failure", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccsm-target-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const environment = { CARGO_TARGET_DIR: "caller-target" };
  let target;
  assert.throws(
    () =>
      withLocalReleaseCargoTarget(
        root,
        true,
        (value) => {
          target = value;
          writeFileSync(path.join(value, "partial.bin"), "partial");
          throw new Error("simulated export failure");
        },
        {
          environment,
          cleanup: (_repo, value) =>
            rmSync(value, { recursive: true, force: true }),
          warn() {},
        },
      ),
    /simulated export failure/,
  );
  assert.equal(environment.CARGO_TARGET_DIR, "caller-target");
  assert.equal(existsSync(target), false);
});

test("export writes installer, portable zip, raw exe, notes and checksums", (t) => {
  const root = fixture(t);
  const stage = path.join(root, "stage");
  mkdirSync(stage, { recursive: true });
  exportReleaseArtifacts(
    root,
    path.join(root, "src-tauri", "target"),
    stage,
    "3.20.4-1",
    { warn() {} },
  );
  assert.equal(
    existsSync(
      path.join(
        stage,
        "windows",
        "installer",
        "CCSwitchMulti_3.20.4-1_x64-setup.exe",
      ),
    ),
    true,
  );
  assert.equal(
    existsSync(
      path.join(
        stage,
        "windows",
        "portable",
        "CCSwitchMulti_3.20.4-1_x64-portable.zip",
      ),
    ),
    true,
  );
  assert.equal(
    existsSync(path.join(stage, "windows", "raw-exe", "CCSwitchMulti.exe")),
    true,
  );
  assert.equal(existsSync(path.join(stage, "linux-build-note.md")), true);
  writeReleaseChecksums(stage);
  const checksums = readFileSync(path.join(stage, "SHA256SUMS.txt"), "utf8");
  assert.match(checksums, /CCSwitchMulti_3\.20\.4-1_x64-portable\.zip/);
  assert.match(checksums, /CCSwitchMulti_3\.20\.4-1_x64-installed-exe\.sha256/);
});

test("export accepts the Tauri signer's stdout fallback and writes latest.json", (t) => {
  const root = fixture(t);
  const key = path.join(root, ".ccswitchmulti", "tauri-update.key");
  mkdirSync(path.dirname(key), { recursive: true });
  writeFileSync(key, "fixture signing key");
  const stage = path.join(root, "signed-stage");
  mkdirSync(stage, { recursive: true });
  exportReleaseArtifacts(
    root,
    path.join(root, "src-tauri", "target"),
    stage,
    "3.20.4-1",
    {
      environment: { USERPROFILE: root },
      run: () => ({
        status: 0,
        stdout: "Public signature:\nfixture-signature\n",
      }),
      warn() {},
      now: () => new Date("2026-11-16T00:00:00.000Z"),
    },
  );
  assert.equal(
    readFileSync(
      path.join(
        stage,
        "windows",
        "installer",
        "CCSwitchMulti_3.20.4-1_x64-setup.exe.sig",
      ),
      "utf8",
    ),
    "fixture-signature\r\n",
  );
  assert.match(
    readFileSync(path.join(stage, "latest.json"), "utf8"),
    /fixture-signature/,
  );
});

test("skip-build release runs catalog verification and atomically promotes staged output", (t) => {
  const root = fixture(t);
  const output = path.join(root, "output", "release-output");
  const calls = [];
  const identity = {
    commit: "commit-a",
    branch: "main",
    version: "3.20.4-1",
    trackedWorktree: "clean",
  };
  runLocalRelease(
    { releaseRoot: output, skipBuild: true, noTypecheck: true, reason: "test" },
    {
      repoRoot: root,
      getIdentity: () => identity,
      resolveRoot: (_repo, requested) => requested,
      run: (executable, args, options) => {
        calls.push({ executable, args, options });
        if (executable === process.execPath && args.includes("--version"))
          return { status: 0, stdout: "tauri-cli 2.10.1\n" };
        return { status: 0 };
      },
      log() {},
      warn() {},
    },
  );
  assert.equal(existsSync(path.join(output, "RELEASE-METADATA.md")), true);
  assert.equal(existsSync(path.join(output, "SHA256SUMS.txt")), true);
  assert.equal(
    calls.some(({ args }) => args.join(" ") === "catalog:verify"),
    true,
  );
  assert.equal(
    existsSync(path.join(root, "scripts", "logs", "local-release.lock")),
    false,
  );
});

test("signing replaces copied stale signatures and targets this fork's release URL", (t) => {
  const root = fixture(t);
  const key = path.join(root, ".ccswitchmulti", "tauri-update.key");
  mkdirSync(path.dirname(key), { recursive: true });
  writeFileSync(key, "fixture signing key");
  const setup = path.join(
    root,
    "src-tauri",
    "target",
    "release",
    "bundle",
    "nsis",
    "CCSwitchMulti_3.20.4-1_x64-setup.exe",
  );
  writeFileSync(setup + ".sig", "fixture-stale-signature");
  const stage = path.join(root, "stale-signature-stage");
  mkdirSync(stage);
  exportReleaseArtifacts(
    root,
    path.join(root, "src-tauri", "target"),
    stage,
    "3.20.4-1",
    {
      environment: { USERPROFILE: root },
      run: () => ({
        status: 0,
        stdout: "Public signature:\nfixture-fresh-signature\n",
      }),
      log() {},
      warn() {},
    },
  );
  const latest = JSON.parse(
    readFileSync(path.join(stage, "latest.json"), "utf8"),
  );
  assert.equal(
    latest.platforms["windows-x86_64"].signature,
    "fixture-fresh-signature",
  );
  assert.match(
    latest.platforms["windows-x86_64"].url,
    /github\.com\/tngflx\/ccswitchmultirouter\/releases\//u,
  );
});

test("a successful signer cannot reuse a stale signature when it emits no new result", (t) => {
  const root = fixture(t);
  const key = path.join(root, ".ccswitchmulti", "tauri-update.key");
  mkdirSync(path.dirname(key), { recursive: true });
  writeFileSync(key, "fixture signing key");
  const setup = path.join(
    root,
    "src-tauri",
    "target",
    "release",
    "bundle",
    "nsis",
    "CCSwitchMulti_3.20.4-1_x64-setup.exe",
  );
  writeFileSync(setup + ".sig", "fixture-stale-signature");
  const stage = path.join(root, "no-signature-stage");
  mkdirSync(stage);
  assert.throws(
    () =>
      exportReleaseArtifacts(
        root,
        path.join(root, "src-tauri", "target"),
        stage,
        "3.20.4-1",
        {
          environment: { USERPROFILE: root },
          run: () => ({ status: 0, stdout: "" }),
          log() {},
          warn() {},
        },
      ),
    /did not produce a signature/u,
  );
});

test("release export excludes generated history-tool environments and arbitrary files", (t) => {
  const root = fixture(t);
  const tool = path.join(root, "scripts", "codex-history-tool");
  mkdirSync(path.join(tool, ".venv"), { recursive: true });
  writeFileSync(path.join(tool, "codex_history_tool.py"), "# fixture tool");
  writeFileSync(path.join(tool, "README.md"), "fixture readme");
  writeFileSync(
    path.join(tool, ".venv", "fixture-private.txt"),
    "not-for-export",
  );
  writeFileSync(path.join(tool, "fixture-private.txt"), "not-for-export");
  const stage = path.join(root, "tool-stage");
  mkdirSync(stage);
  exportReleaseArtifacts(
    root,
    path.join(root, "src-tauri", "target"),
    stage,
    "3.20.4-1",
    { environment: { USERPROFILE: root }, log() {}, warn() {} },
  );
  assert.equal(
    existsSync(path.join(stage, "tools", "codex-history-tool", "README.md")),
    true,
  );
  assert.equal(
    existsSync(path.join(stage, "tools", "codex-history-tool", ".venv")),
    false,
  );
  assert.equal(
    existsSync(
      path.join(stage, "tools", "codex-history-tool", "fixture-private.txt"),
    ),
    false,
  );
});

test("lock age alone never authorizes deleting a previous owner's lock", (t) => {
  const root = fixture(t);
  const lock = path.join(root, "local-release.lock");
  writeFileSync(lock, "fixture-owner\n2000-01-01T00:00:00Z");
  utimesSync(
    lock,
    new Date("2000-01-01T00:00:00Z"),
    new Date("2000-01-01T00:00:00Z"),
  );
  assert.throws(
    () => enterPipelineLock(lock, { token: "contender" }),
    /already running|existing lock/iu,
  );
  assert.equal(
    readFileSync(lock, "utf8"),
    "fixture-owner\n2000-01-01T00:00:00Z",
  );
});

test("environment-only signing keys stay out of command arguments and still sign", (t) => {
  const root = fixture(t);
  const stage = path.join(root, "environment-signing-stage");
  mkdirSync(stage);
  const calls = [];
  exportReleaseArtifacts(
    root,
    path.join(root, "src-tauri", "target"),
    stage,
    "3.20.4-1",
    {
      environment: {
        USERPROFILE: root,
        TAURI_SIGNING_PRIVATE_KEY: "fixture-private-value",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "fixture-password-value",
      },
      run: (executable, args, options) => {
        calls.push({ executable, args, options });
        return {
          status: 0,
          stdout: "Public signature:\nfixture-env-signature\n",
        };
      },
      log() {},
      warn() {},
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, process.execPath);
  assert.equal(
    calls[0].args.some(
      (arg) =>
        arg.includes("fixture-private-value") ||
        arg.includes("fixture-password-value"),
    ),
    false,
  );
  assert.equal(calls[0].args.includes("--password="), false);
  assert.match(
    readFileSync(path.join(stage, "latest.json"), "utf8"),
    /fixture-env-signature/u,
  );
});
