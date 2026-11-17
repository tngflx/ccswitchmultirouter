import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createReleaseStage,
  createTauriBuildConfig,
  releaseFileSha256,
  replaceReleaseRootFromStage,
  resolveReleaseRoot,
  tauriNsisInstalledExeSha256,
  stampReleaseOutputOwner,
} from "./release-build-config.mjs";

const OWNER_FILE = ".ccswitchmulti-release-owner.json";
const VERSION = "3.20.4-3";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccsm-release-root-"));
  const repo = path.join(root, "checkout");
  mkdirSync(path.join(repo, "src-tauri"), { recursive: true });
  writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ version: VERSION }),
  );
  writeFileSync(
    path.join(repo, "src-tauri", "Cargo.toml"),
    "[package]\nname='fixture'\n",
  );
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^ccsm-release-root-/u);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, output: path.join(root, "release") };
}

function fixtureExe({ installer = false } = {}) {
  const bytes = Buffer.alloc(1024);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(installer ? 0x14c : 0x8664, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(installer ? 0xe0 : 0xf0, 0x94);
  bytes.writeUInt16LE(installer ? 0x10b : 0x20b, 0x98);
  Buffer.from("CCSwitchMulti\0", "utf16le").copy(bytes, 512);
  bytes.write(
    installer ? "NullsoftInst" : "__TAURI_BUNDLE_TYPE_VAR_UNK",
    640,
    "ascii",
  );
  return bytes;
}

function regularFiles(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(current, entry.name);
    return entry.isDirectory() ? regularFiles(root, file) : [file];
  });
}

function writeChecksums(root) {
  const lines = regularFiles(root)
    .filter(
      (file) => !["SHA256SUMS.txt", OWNER_FILE].includes(path.basename(file)),
    )
    .map(
      (file) =>
        `${releaseFileSha256(file)}  ${path.relative(root, file).split(path.sep).join("/")}`,
    )
    .sort();
  writeFileSync(path.join(root, "SHA256SUMS.txt"), lines.join("\r\n"));
}

function releasePayload(
  root,
  { validIdentity = true, label = "new payload" } = {},
) {
  const raw = path.join(root, "windows", "raw-exe");
  const installer = path.join(root, "windows", "installer");
  const portable = path.join(root, "windows", "portable");
  mkdirSync(raw, { recursive: true });
  mkdirSync(installer, { recursive: true });
  mkdirSync(portable, { recursive: true });
  const executable = path.join(raw, "CCSwitchMulti.exe");
  writeFileSync(
    executable,
    validIdentity
      ? fixtureExe()
      : "__TAURI_BUNDLE_TYPE_VAR_UNKnot-an-application",
  );
  writeFileSync(
    path.join(raw, `CCSwitchMulti_${VERSION}_x64.exe`),
    readFileSync(executable),
  );
  writeFileSync(
    path.join(installer, `CCSwitchMulti_${VERSION}_x64-setup.exe`),
    validIdentity ? fixtureExe({ installer: true }) : "not-an-installer",
  );
  writeFileSync(
    path.join(installer, `CCSwitchMulti_${VERSION}_x64-installed-exe.sha256`),
    `${validIdentity ? tauriNsisInstalledExeSha256(executable) : "0".repeat(64)}\n`,
  );
  writeFileSync(
    path.join(portable, `CCSwitchMulti_${VERSION}_x64-portable.zip`),
    Buffer.from("PK\x03\x04fixture archive", "binary"),
  );
  writeFileSync(path.join(root, "RELEASE-METADATA.md"), label);
  writeChecksums(root);
}

function localBuildPayload(
  root,
  { generatedBy = "local-build-pipeline.ps1", validIdentity = true } = {},
) {
  mkdirSync(path.join(root, "bundle", "nsis"), { recursive: true });
  writeFileSync(
    path.join(root, "cc-switch.exe"),
    validIdentity ? fixtureExe() : "not-an-application",
  );
  writeFileSync(
    path.join(root, "bundle", "nsis", `CCSwitchMulti_${VERSION}_x64-setup.exe`),
    validIdentity ? fixtureExe({ installer: true }) : "not-an-installer",
  );
  writeFileSync(
    path.join(root, "LOCAL-BUILD.json"),
    JSON.stringify({ generatedBy, updaterSigned: false }),
  );
}

function promote(repo, output, label = "new payload", options = {}) {
  const stage = createReleaseStage(output);
  releasePayload(stage, { label });
  replaceReleaseRootFromStage(stage, output, {
    repoRoot: repo,
    environment: {},
    ...options,
  });
  return stage;
}

test("unsafe explicit release roots reject filesystem roots, repository source and ancestors", (t) => {
  const { root, repo } = fixture(t);
  for (const output of [
    repo,
    root,
    path.parse(repo).root,
    path.join(repo, "src"),
    path.join(repo, "src-tauri"),
    path.join(repo, "output"),
  ]) {
    assert.throws(
      () => resolveReleaseRoot(repo, output, { environment: {} }),
      /release output|release root|repository|source|filesystem/u,
      output,
    );
  }
  assert.equal(
    resolveReleaseRoot(repo, path.join(repo, "output", "release"), {
      environment: {},
    }),
    path.join(repo, "output", "release"),
  );
});

test("unsafe active Cargo target overlap is rejected outside the repository too", (t) => {
  const { root, repo } = fixture(t);
  const target = path.join(root, "external-cargo");
  for (const output of [
    target,
    path.join(target, "release"),
    path.dirname(target),
  ]) {
    assert.throws(
      () =>
        resolveReleaseRoot(repo, output, {
          environment: { CARGO_TARGET_DIR: target },
        }),
      /Cargo|overlap|repository/u,
    );
  }
});

test("unrelated nonempty release output cannot be replaced and all files survive", (t) => {
  const { repo, output } = fixture(t);
  mkdirSync(output);
  writeFileSync(path.join(output, "keep.txt"), "unrelated work");
  assert.throws(
    () => resolveReleaseRoot(repo, output, { environment: {} }),
    /owned|ownership|unrelated/u,
  );
  assert.throws(() => promote(repo, output), /owned|ownership|unrelated/u);
  assert.equal(
    readFileSync(path.join(output, "keep.txt"), "utf8"),
    "unrelated work",
  );
});

test("release output and stage junctions reject before touching unrelated directories", (t) => {
  const { root, repo, output } = fixture(t);
  const foreign = path.join(root, "foreign");
  mkdirSync(foreign);
  writeFileSync(path.join(foreign, "keep.txt"), "unrelated work");
  symlinkSync(
    foreign,
    output,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => resolveReleaseRoot(repo, output, { environment: {} }),
    /reparse|symbolic|junction/u,
  );
  assert.throws(() => promote(repo, output), /reparse|symbolic|junction/u);
  assert.equal(
    readFileSync(path.join(foreign, "keep.txt"), "utf8"),
    "unrelated work",
  );
});

test("legacy release migration requires complete hashes and independently valid application identity", (t) => {
  const { root, repo, output } = fixture(t);
  releasePayload(output, { label: "legacy" });
  assert.equal(resolveReleaseRoot(repo, output, { environment: {} }), output);
  promote(repo, output);
  assert.equal(existsSync(path.join(output, OWNER_FILE)), true);
  assert.equal(
    readFileSync(path.join(output, "RELEASE-METADATA.md"), "utf8"),
    "new payload",
  );

  const spoof = path.join(root, "spoof");
  releasePayload(spoof, { validIdentity: false });
  assert.throws(
    () => resolveReleaseRoot(repo, spoof, { environment: {} }),
    /identity|executable|application|owned|ownership/u,
  );

  const incomplete = path.join(root, "incomplete");
  releasePayload(incomplete);
  writeFileSync(
    path.join(incomplete, "keep.txt"),
    "not in the checksum manifest",
  );
  assert.throws(
    () => resolveReleaseRoot(repo, incomplete, { environment: {} }),
    /checksum|inventory|unrelated|owned|ownership/u,
  );
});

test("marker-only legacy local-build output is preserved until explicitly migrated from known artifacts", (t) => {
  const { repo } = fixture(t);
  const output = path.join(repo, "output", "production");
  localBuildPayload(output);
  assert.throws(
    () => resolveReleaseRoot(repo, output, { environment: {} }),
    /owned|ownership/u,
  );
  assert.equal(existsSync(path.join(output, "cc-switch.exe")), true);
  // The caller explicitly knows this fixture was freshly generated. Production
  // callers stamp only their new stage, never as an unowned-destination fallback.
  stampReleaseOutputOwner(output, {
    repoRoot: repo,
    environment: {},
    layout: "local-build",
  });
  assert.equal(resolveReleaseRoot(repo, output, { environment: {} }), output);
  promote(repo, output);
  assert.equal(existsSync(path.join(output, OWNER_FILE)), true);
});

test("canonical ownership is authoritative and detects missing, changed, and extra files", (t) => {
  const { repo, output } = fixture(t);
  promote(repo, output);
  assert.equal(resolveReleaseRoot(repo, output, { environment: {} }), output);
  const marker = JSON.parse(
    readFileSync(path.join(output, OWNER_FILE), "utf8"),
  );
  assert.equal(marker.schemaVersion, 1);
  assert.equal(marker.repository, "tngflx/ccswitchmultirouter");
  assert.ok(Array.isArray(marker.artifacts));
  writeFileSync(path.join(output, "keep.txt"), "unrelated newer work");
  assert.throws(
    () => promote(repo, output, "replacement"),
    /inventory|owned|ownership|unrelated/u,
  );
  assert.equal(
    readFileSync(path.join(output, "keep.txt"), "utf8"),
    "unrelated newer work",
  );
  rmSync(path.join(output, "keep.txt"));
  writeFileSync(
    path.join(output, "RELEASE-METADATA.md"),
    "changed after export",
  );
  assert.throws(
    () => resolveReleaseRoot(repo, output, { environment: {} }),
    /inventory|checksum|owned|ownership/u,
  );
});

test("invalid canonical ownership cannot fall back to a valid legacy checksum manifest", (t) => {
  const { repo, output } = fixture(t);
  releasePayload(output);
  writeFileSync(
    path.join(output, OWNER_FILE),
    JSON.stringify({ schemaVersion: 0, repository: "foreign" }),
  );
  assert.throws(
    () => resolveReleaseRoot(repo, output, { environment: {} }),
    /ownership|owner|canonical/u,
  );
});

test("promotion refuses a symlink in staged payload before renaming previous output", (t) => {
  const { root, repo, output } = fixture(t);
  releasePayload(output, { label: "previous" });
  const stage = createReleaseStage(output);
  releasePayload(stage);
  const foreign = path.join(root, "private");
  mkdirSync(foreign);
  writeFileSync(path.join(foreign, "keep.txt"), "unrelated");
  symlinkSync(
    foreign,
    path.join(stage, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () =>
      replaceReleaseRootFromStage(stage, output, {
        repoRoot: repo,
        environment: {},
      }),
    /reparse|symbolic|link/u,
  );
  assert.equal(
    readFileSync(path.join(output, "RELEASE-METADATA.md"), "utf8"),
    "previous",
  );
  assert.equal(
    readFileSync(path.join(foreign, "keep.txt"), "utf8"),
    "unrelated",
  );
});

test("a late change to previous output is retained in its backup, never recursively deleted", (t) => {
  const { repo, output } = fixture(t);
  promote(repo, output, "previous");
  let previousBackup;
  const warnings = [];
  promote(repo, output, "next", {
    rename(source, destination) {
      renameSync(source, destination);
      if (source === output) {
        previousBackup = destination;
        writeFileSync(
          path.join(destination, "late-unrelated.txt"),
          "keep late write",
        );
      }
    },
    warn: (message) => warnings.push(message),
  });
  assert.equal(
    readFileSync(path.join(output, "RELEASE-METADATA.md"), "utf8"),
    "next",
  );
  assert.equal(
    readFileSync(path.join(previousBackup, "late-unrelated.txt"), "utf8"),
    "keep late write",
  );
  assert.ok(
    warnings.some((message) => /backup|changed|preserv|retain/u.test(message)),
  );
});

test("a failed stage promotion restores previous output without deleting its content", (t) => {
  const { repo, output } = fixture(t);
  promote(repo, output, "previous");
  const previousMarker = readFileSync(path.join(output, OWNER_FILE), "utf8");
  const stage = createReleaseStage(output);
  releasePayload(stage);
  assert.throws(
    () =>
      replaceReleaseRootFromStage(stage, output, {
        repoRoot: repo,
        environment: {},
        rename(source, destination) {
          if (source === stage) throw new Error("fixture promotion failure");
          renameSync(source, destination);
        },
      }),
    /fixture promotion failure/u,
  );
  assert.equal(
    readFileSync(path.join(output, "RELEASE-METADATA.md"), "utf8"),
    "previous",
  );
  assert.equal(
    readFileSync(path.join(output, OWNER_FILE), "utf8"),
    previousMarker,
  );
});

test("local Tauri overrides disable generated elevated-update PowerShell tasks", () => {
  const config = createTauriBuildConfig();
  try {
    const value = JSON.parse(readFileSync(config.path, "utf8"));
    assert.equal(value.bundle.windows?.wix?.enableElevatedUpdateTask, false);
    assert.equal(value.bundle.createUpdaterArtifacts, false);
  } finally {
    config.remove();
  }
});

test("canonical ownership rejects missing artifacts and unrecorded empty directories", (t) => {
  const { repo, output } = fixture(t);
  promote(repo, output);
  const extra = path.join(output, "unrelated-empty-directory");
  mkdirSync(extra);
  assert.throws(
    () => resolveReleaseRoot(repo, output, { environment: {} }),
    /inventory|ownership/u,
  );
  rmdirSync(extra);
  rmSync(path.join(output, "RELEASE-METADATA.md"));
  assert.throws(
    () => resolveReleaseRoot(repo, output, { environment: {} }),
    /inventory|ownership/u,
  );
});

test("a dangling canonical ownership junction cannot authorize a legacy fallback", (t) => {
  const { root, repo, output } = fixture(t);
  releasePayload(output);
  const missing = path.join(root, "missing-owner-target");
  symlinkSync(
    missing,
    path.join(output, OWNER_FILE),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => resolveReleaseRoot(repo, output, { environment: {} }),
    /ownership|owner|canonical/u,
  );
});

test("promotion requires repository context before it can rename any directory", (t) => {
  const { output } = fixture(t);
  const stage = createReleaseStage(output);
  releasePayload(stage);
  let renamed = false;
  assert.throws(
    () =>
      replaceReleaseRootFromStage(stage, output, {
        rename() {
          renamed = true;
        },
      }),
    /repository/u,
  );
  assert.equal(renamed, false);
  assert.equal(existsSync(stage), true);
});

test("late stage writes are detected before promotion and the previous output is restored", (t) => {
  const { repo, output } = fixture(t);
  promote(repo, output, "previous");
  const stage = createReleaseStage(output);
  releasePayload(stage, { label: "next" });
  assert.throws(
    () =>
      replaceReleaseRootFromStage(stage, output, {
        repoRoot: repo,
        environment: {},
        rename(source, destination) {
          renameSync(source, destination);
          if (source === output)
            writeFileSync(
              path.join(stage, "late-unrelated.txt"),
              "keep stage write",
            );
        },
      }),
    /inventory|ownership/u,
  );
  assert.equal(
    readFileSync(path.join(output, "RELEASE-METADATA.md"), "utf8"),
    "previous",
  );
  assert.equal(
    readFileSync(path.join(stage, "late-unrelated.txt"), "utf8"),
    "keep stage write",
  );
});
