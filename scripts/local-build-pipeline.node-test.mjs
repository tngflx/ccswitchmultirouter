import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertLocalProductionOutputRoot,
  buildHistoryRepairSidecar,
  invokeLocalProductionBuild,
  parseLocalBuildOptions,
  resolveLocalProductionOutputRoot,
} from "./local-build-pipeline.mjs";
import {
  assertLocalTauriCliVersion,
  cleanupLocalReleaseCargoTarget,
  createLocalReleaseCargoTarget,
  createTauriBuildConfig,
  replaceReleaseRootFromStage,
} from "./release-build-config.mjs";

function fixture(t) {
  // Spaces and shell metacharacters must remain ordinary path characters.
  const root = mkdtempSync(path.join(os.tmpdir(), "ccsm JS build & fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "src-tauri", "resources"), { recursive: true });
  writeFileSync(
    path.join(root, "src-tauri", "Cargo.toml"),
    '[package]\nname="build-fixture"\nversion="0.1.0"\nedition="2021"\n',
  );
  writeFileSync(
    path.join(root, "src-tauri", "resources", "capabilities.json"),
    '{"models":[]}',
  );
  const cliRoot = path.join(root, "node_modules", "@tauri-apps", "cli");
  mkdirSync(cliRoot, { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    '{"devDependencies":{"@tauri-apps/cli":"2.10.1"}}',
  );
  writeFileSync(path.join(cliRoot, "package.json"), '{"version":"2.10.1"}');
  writeFileSync(path.join(cliRoot, "tauri.js"), "// fixture only");
  return { root, cliRoot, output: path.join(root, "output", "production") };
}

function writeArtifacts(target, { installer = true } = {}) {
  const release = path.join(target, "release");
  mkdirSync(path.join(release, "bundle", "nsis"), { recursive: true });
  writeFileSync(path.join(release, "cc-switch.exe"), "production executable");
  writeFileSync(path.join(release, "cc-switch.pdb"), "temporary symbols");
  if (installer)
    writeFileSync(
      path.join(release, "bundle", "nsis", "CCSwitchMulti_0.1.0_x64-setup.exe"),
      "production installer",
    );
}

function previousOutput(output, generatedBy = "local-build-pipeline.ps1") {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    path.join(output, "LOCAL-BUILD.json"),
    JSON.stringify({ generatedBy }),
  );
  writeFileSync(path.join(output, "cc-switch.exe"), "previous executable");
  writeFileSync(path.join(output, "old-installer.exe"), "previous installer");
}

function controlledRunner(
  onBuild = ({ target }) => writeArtifacts(target),
  { cleanupError = false } = {},
) {
  const calls = [];
  const run = (executable, args, options) => {
    calls.push({ executable, args, options });
    if (executable === "cargo") {
      const target = options.env.CARGO_TARGET_DIR;
      if (args[0] === "build") {
        assert.deepEqual(args, [
          "build",
          "--release",
          "--bin",
          "codex-history-repairer",
          "--features",
          "history-repairer",
          "--manifest-path",
          path.join(options.cwd, "src-tauri", "Cargo.toml"),
        ]);
        mkdirSync(path.join(target, "release"), { recursive: true });
        writeFileSync(
          path.join(target, "release", "codex-history-repairer.exe"),
          "history repair helper",
        );
        return { status: 0 };
      }
      assert.equal(args[0], "clean");
      assert.equal(args[args.indexOf("--target-dir") + 1], target);
      if (cleanupError) return { status: 4 };
      rmSync(target, { recursive: true, force: true });
      return { status: 0 };
    }
    assert.equal(executable, process.execPath);
    if (args.includes("--version"))
      return { status: 0, stdout: "tauri-cli 2.10.1\n" };
    return (
      onBuild({
        target: options.env.CARGO_TARGET_DIR,
        config: args.at(-1),
        executable,
        args,
        options,
      }) ?? { status: 0 }
    );
  };
  return { run, calls };
}

const quiet = { log() {}, warn() {} };

test("JS build accepts current and former output-directory spelling and rejects incomplete arguments", () => {
  assert.deepEqual(
    parseLocalBuildOptions(["-OutputDir", "D:\\builds\\candidate"]),
    { outputDir: "D:\\builds\\candidate", help: false },
  );
  assert.deepEqual(
    parseLocalBuildOptions(["--output-dir", "output/candidate"]),
    { outputDir: "output/candidate", help: false },
  );
  assert.equal(parseLocalBuildOptions(["--help"]).help, true);
  assert.throws(
    () => parseLocalBuildOptions(["--output-dir"]),
    /Missing value/,
  );
  assert.throws(
    () => parseLocalBuildOptions(["--execute"]),
    /Unknown local build option/,
  );
});

test("production output defaults and relative overrides resolve against the repository", (t) => {
  const { root, output } = fixture(t);
  assert.equal(resolveLocalProductionOutputRoot(root), output);
  assert.equal(
    resolveLocalProductionOutputRoot(root, "output/candidate"),
    path.join(root, "output", "candidate"),
  );
});

test("history repair sidecar build uses the isolated target and canonical feature", (t) => {
  const { root } = fixture(t);
  const target = mkdtempSync(path.join(os.tmpdir(), "ccsm-sidecar-target-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const calls = [];
  const sidecar = buildHistoryRepairSidecar(root, target, {
    environment: { CARGO_TARGET_DIR: "caller-owned-target" },
    run(executable, args, options) {
      calls.push({ executable, args, options });
      mkdirSync(path.join(target, "release"), { recursive: true });
      writeFileSync(
        path.join(target, "release", "codex-history-repairer.exe"),
        "history repair helper",
      );
      return { status: 0 };
    },
  });
  assert.equal(
    sidecar,
    path.join(target, "release", "codex-history-repairer.exe"),
  );
  assert.deepEqual(calls, [
    {
      executable: "cargo",
      args: [
        "build",
        "--release",
        "--bin",
        "codex-history-repairer",
        "--features",
        "history-repairer",
        "--manifest-path",
        path.join(root, "src-tauri", "Cargo.toml"),
      ],
      options: {
        cwd: root,
        env: { CARGO_TARGET_DIR: target },
        stdio: "inherit",
      },
    },
  ]);
});

test("history repair sidecar build fails closed when Cargo omits the helper", (t) => {
  const { root } = fixture(t);
  const target = mkdtempSync(path.join(os.tmpdir(), "ccsm-sidecar-target-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  assert.throws(
    () =>
      buildHistoryRepairSidecar(root, target, {
        run: () => ({ status: 0 }),
      }),
    /codex-history-repairer sidecar was not produced/,
  );
});

test("successful isolated build preserves binaries/resources after cleanup and leaves caller environment unchanged", (t) => {
  const { root, output } = fixture(t);
  previousOutput(output);
  const environment = {
    ...process.env,
    CARGO_TARGET_DIR: "caller-owned-target",
  };
  let target;
  let config;
  const { run, calls } = controlledRunner((build) => {
    ({ target, config } = build);
    assert.equal(environment.CARGO_TARGET_DIR, "caller-owned-target");
    assert.equal(
      JSON.parse(readFileSync(config, "utf8")).bundle.createUpdaterArtifacts,
      false,
    );
    assert.deepEqual(build.args.slice(1, -1), [
      "build",
      "--bundles",
      "nsis",
      "--config",
    ]);
    writeArtifacts(target);
  });
  assert.equal(
    invokeLocalProductionBuild(root, output, { run, environment, ...quiet }),
    output,
  );
  assert.equal(
    readFileSync(path.join(output, "cc-switch.exe"), "utf8"),
    "production executable",
  );
  assert.equal(
    readFileSync(path.join(output, "resources", "capabilities.json"), "utf8"),
    '{"models":[]}',
  );
  assert.equal(
    existsSync(
      path.join(output, "bundle", "nsis", "CCSwitchMulti_0.1.0_x64-setup.exe"),
    ),
    true,
  );
  assert.equal(existsSync(path.join(output, "cc-switch.pdb")), false);
  assert.equal(existsSync(path.join(output, "old-installer.exe")), false);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(config), false);
  assert.equal(environment.CARGO_TARGET_DIR, "caller-owned-target");
  assert.equal(calls.length, 4);
  assert.equal(calls[1].executable, "cargo");
  assert.equal(calls[2].executable, process.execPath);
  assert.equal(
    JSON.parse(readFileSync(path.join(output, "LOCAL-BUILD.json"), "utf8"))
      .generatedBy,
    "local-build-pipeline.mjs",
  );
});

test("failed native build leaves previous output intact and cleans only its own target/config", (t) => {
  const { root, output } = fixture(t);
  previousOutput(output);
  let target;
  let config;
  const { run } = controlledRunner((build) => {
    ({ target, config } = build);
    writeArtifacts(target);
    return { status: 7 };
  });
  assert.throws(
    () => invokeLocalProductionBuild(root, output, { run, ...quiet }),
    /tauri build failed with exit code 7/,
  );
  assert.equal(
    readFileSync(path.join(output, "cc-switch.exe"), "utf8"),
    "previous executable",
  );
  assert.equal(existsSync(path.join(output, "bundle")), false);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(config), false);
  assert.deepEqual(readdirSync(path.dirname(output)), ["production"]);
});

test("a thrown build error keeps the original error while cleanup failures become warnings", (t) => {
  const { root, output } = fixture(t);
  previousOutput(output);
  const warnings = [];
  const { run } = controlledRunner(
    () => {
      throw new Error("fixture build failure");
    },
    { cleanupError: true },
  );
  assert.throws(
    () =>
      invokeLocalProductionBuild(root, output, {
        run,
        log() {},
        warn: (message) => warnings.push(message),
      }),
    /fixture build failure/,
  );
  assert.equal(
    readFileSync(path.join(output, "cc-switch.exe"), "utf8"),
    "previous executable",
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cargo clean failed with exit code 4/);
});

test("locked config cleanup cannot skip Cargo cleanup or replace the primary build error", (t) => {
  const { root, output } = fixture(t);
  const config = createTauriBuildConfig();
  t.after(config.remove);
  const warnings = [];
  let target;
  const { run } = controlledRunner((build) => {
    target = build.target;
    throw new Error("primary fixture build failure");
  });
  assert.throws(
    () =>
      invokeLocalProductionBuild(root, output, {
        run,
        createConfig: () => ({
          path: config.path,
          remove() {
            throw new Error("fixture config is locked");
          },
        }),
        log() {},
        warn: (message) => warnings.push(message),
      }),
    /primary fixture build failure/,
  );
  assert.equal(existsSync(target), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /configuration cleanup failed/);
});

test("missing installer blocks export even when Tauri reports success", (t) => {
  const { root, output } = fixture(t);
  previousOutput(output);
  const { run } = controlledRunner(({ target }) =>
    writeArtifacts(target, { installer: false }),
  );
  assert.throws(
    () => invokeLocalProductionBuild(root, output, { run, ...quiet }),
    /did not produce an NSIS installer/,
  );
  assert.equal(
    readFileSync(path.join(output, "cc-switch.exe"), "utf8"),
    "previous executable",
  );
  assert.equal(existsSync(path.join(output, "bundle")), false);
});

test("missing executable blocks export before an existing output is touched", (t) => {
  const { root, output } = fixture(t);
  previousOutput(output);
  const { run } = controlledRunner(() => {});
  assert.throws(
    () => invokeLocalProductionBuild(root, output, { run, ...quiet }),
    /did not produce the raw executable/,
  );
  assert.equal(
    readFileSync(path.join(output, "cc-switch.exe"), "utf8"),
    "previous executable",
  );
});

test("copy failure leaves previous output intact and removes the unique staging directory", (t) => {
  const { root, output } = fixture(t);
  previousOutput(output);
  const { run } = controlledRunner();
  assert.throws(
    () =>
      invokeLocalProductionBuild(root, output, {
        run,
        ...quiet,
        exportOptions: {
          copy(source, destination, options) {
            if (path.basename(source) === "bundle")
              throw new Error("simulated installer copy failure");
            return cpSync(source, destination, options);
          },
        },
      }),
    /simulated installer copy failure/,
  );
  assert.equal(
    readFileSync(path.join(output, "cc-switch.exe"), "utf8"),
    "previous executable",
  );
  assert.deepEqual(readdirSync(path.dirname(output)), ["production"]);
});

test("failed staging promotion restores previous output and removes staging", (t) => {
  const { root, output } = fixture(t);
  previousOutput(output);
  const { run } = controlledRunner();
  assert.throws(
    () =>
      invokeLocalProductionBuild(root, output, {
        run,
        ...quiet,
        exportOptions: {
          promote(stage, release) {
            replaceReleaseRootFromStage(stage, release, {
              rename(source, destination) {
                if (source === stage)
                  throw new Error("simulated output replacement failure");
                renameSync(source, destination);
              },
            });
          },
        },
      }),
    /simulated output replacement failure/,
  );
  assert.equal(
    readFileSync(path.join(output, "cc-switch.exe"), "utf8"),
    "previous executable",
  );
  assert.deepEqual(readdirSync(path.dirname(output)), ["production"]);
});

test("locked staging cleanup preserves the primary export error and the previous output", (t) => {
  const { root, output } = fixture(t);
  previousOutput(output);
  const { run } = controlledRunner();
  const warnings = [];
  assert.throws(
    () =>
      invokeLocalProductionBuild(root, output, {
        run,
        ...quiet,
        exportOptions: {
          copy() {
            throw new Error("primary fixture copy failure");
          },
          removeStage() {
            throw new Error("fixture staging is locked");
          },
          warn: (message) => warnings.push(message),
        },
      }),
    /primary fixture copy failure/,
  );
  assert.equal(
    readFileSync(path.join(output, "cc-switch.exe"), "utf8"),
    "previous executable",
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /staging cleanup failed/);
});

test("failed export never deletes through a staging junction while preserving its primary error", (t) => {
  const { root, output } = fixture(t);
  previousOutput(output);
  const foreign = path.join(root, "foreign-output");
  mkdirSync(foreign);
  writeFileSync(path.join(foreign, "keep.txt"), "unrelated file");
  const { run } = controlledRunner();
  let attemptedRemoval = false;
  const warnings = [];
  assert.throws(
    () =>
      invokeLocalProductionBuild(root, output, {
        run,
        ...quiet,
        exportOptions: {
          copy(_source, destination) {
            const stage = path.dirname(destination);
            rmSync(stage, { recursive: true });
            symlinkSync(
              foreign,
              stage,
              process.platform === "win32" ? "junction" : "dir",
            );
            throw new Error("primary fixture copy failure");
          },
          removeStage() {
            attemptedRemoval = true;
          },
          warn: (message) => warnings.push(message),
        },
      }),
    /primary fixture copy failure/,
  );
  assert.equal(attemptedRemoval, false);
  assert.equal(warnings.length, 1);
  assert.equal(
    readFileSync(path.join(foreign, "keep.txt"), "utf8"),
    "unrelated file",
  );
  assert.equal(
    readFileSync(path.join(output, "cc-switch.exe"), "utf8"),
    "previous executable",
  );
});

test("unsafe source, scratch, repository ancestor and filesystem-root outputs are rejected before build", (t) => {
  const { root } = fixture(t);
  for (const unsafe of [
    root,
    path.dirname(root),
    path.parse(root).root,
    path.join(root, "src-tauri"),
    path.join(root, ".tmp", "local-release-cargo", "run-fixture"),
    path.join(root, "output"),
  ]) {
    let called = false;
    assert.throws(
      () =>
        invokeLocalProductionBuild(root, unsafe, {
          run() {
            called = true;
          },
          ...quiet,
        }),
      /local production output/,
    );
    assert.equal(called, false);
  }
});

test("foreign or malformed output ownership markers cannot authorize replacement", (t) => {
  const { root, output } = fixture(t);
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "keep.txt"), "unrelated file");
  for (const marker of [
    undefined,
    "invalid JSON",
    '{"generatedBy":"foreign"}',
  ]) {
    if (marker !== undefined)
      writeFileSync(path.join(output, "LOCAL-BUILD.json"), marker);
    assert.throws(
      () => assertLocalProductionOutputRoot(root, output),
      /not owned by this build pipeline/,
    );
    assert.equal(
      readFileSync(path.join(output, "keep.txt"), "utf8"),
      "unrelated file",
    );
  }
});

test("new JavaScript marker authorizes the next output replacement", (t) => {
  const { root, output } = fixture(t);
  previousOutput(output, "local-build-pipeline.mjs");
  const { run } = controlledRunner();
  invokeLocalProductionBuild(root, output, { run, ...quiet });
  assert.equal(
    readFileSync(path.join(output, "cc-switch.exe"), "utf8"),
    "production executable",
  );
});

test("output junction ancestor cannot redirect replacement into a foreign directory", (t) => {
  const { root } = fixture(t);
  const foreign = path.join(root, "foreign");
  mkdirSync(foreign);
  writeFileSync(path.join(foreign, "keep.txt"), "unrelated file");
  const outputLink = path.join(root, "output");
  symlinkSync(
    foreign,
    outputLink,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () =>
      assertLocalProductionOutputRoot(
        root,
        path.join(outputLink, "production"),
      ),
    /reparse point/,
  );
  assert.equal(
    readFileSync(path.join(foreign, "keep.txt"), "utf8"),
    "unrelated file",
  );
});

test("Cargo scratch junctions are rejected before a build or cleanup command", (t) => {
  const { root } = fixture(t);
  const foreign = path.join(root, "foreign");
  mkdirSync(foreign);
  symlinkSync(
    foreign,
    path.join(root, ".tmp"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => createLocalReleaseCargoTarget(root), /reparse point/);
});

test("Cargo cleanup refuses targets outside its cache before spawning anything", (t) => {
  const { root } = fixture(t);
  let called = false;
  assert.throws(
    () =>
      cleanupLocalReleaseCargoTarget(
        root,
        path.join(root, "src-tauri", "target"),
        {
          run() {
            called = true;
          },
        },
      ),
    /outside the repository-owned/,
  );
  assert.equal(called, false);
});

test("stale installed or reported Tauri versions block native compilation", (t) => {
  const { root, cliRoot, output } = fixture(t);
  writeFileSync(path.join(cliRoot, "package.json"), '{"version":"2.8.1"}');
  let called = false;
  assert.throws(
    () =>
      invokeLocalProductionBuild(root, output, {
        run() {
          called = true;
        },
        ...quiet,
      }),
    /package version mismatch/,
  );
  assert.equal(called, false);
  writeFileSync(path.join(cliRoot, "package.json"), '{"version":"2.10.1"}');
  assert.throws(
    () =>
      assertLocalTauriCliVersion(root, {
        run: () => ({ status: 0, stdout: "tauri-cli 2.8.1\n" }),
      }),
    /binary version mismatch/,
  );
  writeFileSync(
    path.join(root, "package.json"),
    '{"devDependencies":{"@tauri-apps/cli":"^2.10.1"}}',
  );
  assert.throws(
    () => assertLocalTauriCliVersion(root),
    /pinned to an exact version/,
  );
});

test("real Node fixture CLI keeps shell metacharacters literal and tolerates stderr progress", (t) => {
  const { root, cliRoot, output } = fixture(t);
  const cli = `const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')){console.log('tauri-cli 2.10.1');process.exit(0)}
fs.writeFileSync(path.join(__dirname,'captured-args.json'),JSON.stringify(process.argv.slice(2)));
const release=path.join(process.env.CARGO_TARGET_DIR,'release');
fs.mkdirSync(path.join(release,'bundle','nsis'),{recursive:true});
fs.writeFileSync(path.join(release,'cc-switch.exe'),'fixture executable');
fs.writeFileSync(path.join(release,'bundle','nsis','fixture-setup.exe'),'fixture installer');
console.error('successful fixture build progress');`;
  writeFileSync(path.join(cliRoot, "tauri.js"), cli);
  const run = (executable, args, options) => {
    if (executable === "cargo") {
      const target = options.env.CARGO_TARGET_DIR;
      if (args[0] === "build") {
        mkdirSync(path.join(target, "release"), { recursive: true });
        writeFileSync(
          path.join(target, "release", "codex-history-repairer.exe"),
          "history repair helper",
        );
        return { status: 0 };
      }
      assert.equal(args[0], "clean");
      rmSync(target, { recursive: true, force: true });
      return { status: 0 };
    }
    assert.equal(executable, process.execPath);
    return spawnSync(executable, args, {
      ...options,
      stdio: "pipe",
      encoding: "utf8",
      windowsHide: true,
    });
  };
  invokeLocalProductionBuild(root, output, { run, ...quiet });
  assert.equal(
    readFileSync(path.join(output, "cc-switch.exe"), "utf8"),
    "fixture executable",
  );
  assert.deepEqual(
    JSON.parse(
      readFileSync(path.join(cliRoot, "captured-args.json"), "utf8"),
    ).slice(0, -1),
    ["build", "--bundles", "nsis", "--config"],
  );
});
