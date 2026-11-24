import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertLocalTauriCliVersion,
  assertReleaseSourceIdentity,
  assertReleaseOutputRoot,
  assertUnlinkedDirectories,
  cleanupLocalReleaseCargoTarget,
  createReleaseStage,
  createTauriBuildConfig,
  releaseFileSha256,
  replaceReleaseRootFromStage,
  requireBuildCommandSuccess,
  resolveCargoTargetDir,
  resolveReleaseRoot,
  getReleaseSourceIdentity,
  runBuildCommand,
  tauriNsisInstalledExeSha256,
  withLocalReleaseCargoTarget,
} from "./release-build-config.mjs";
import { buildHistoryRepairSidecar } from "./local-build-pipeline.mjs";

const SCRIPT_REPO = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_GITHUB_REPOSITORY = "tngflx/ccswitchmultirouter";

export function parseLocalReleaseOptions(args) {
  const options = {
    releaseRoot: "",
    skipBuild: false,
    noTypecheck: false,
    reason: "manual",
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["--help", "-h", "-?"].includes(argument)) {
      options.help = true;
      continue;
    }
    if (["--skip-build", "-SkipBuild"].includes(argument)) {
      options.skipBuild = true;
      continue;
    }
    if (["--no-typecheck", "-NoTypecheck"].includes(argument)) {
      options.noTypecheck = true;
      continue;
    }
    if (["--release-root", "-ReleaseRoot"].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith("-") || value === "-ReleaseRoot")
        throw new Error(`Missing value after ${argument}.`);
      options.releaseRoot = value;
      continue;
    }
    if (["--reason", "-Reason"].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith("-") || value === "-Reason")
        throw new Error(`Missing value after ${argument}.`);
      options.reason = value;
      continue;
    }
    throw new Error(`Unknown local release option: ${argument}`);
  }
  return options;
}

function runCommand(
  executable,
  args,
  { run = runBuildCommand, cwd, environment, log = console.log },
) {
  logLine(`RUN ${executable} ${args.join(" ")}`, log);
  const result = run(executable, args, {
    cwd,
    env: { ...environment },
    stdio: "inherit",
    windowsHide: true,
  });
  return requireBuildCommandSuccess(result, `${executable} ${args.join(" ")}`);
}

function logLine(message, log = console.log, now = () => new Date()) {
  log(
    `[${now()
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "")
      .replace(/Z$/, "")}] ${message}`,
  );
}

export function enterPipelineLock(
  lockPath,
  {
    pid = process.pid,
    now = () => new Date(),
    token = `${pid}-${randomUUID().replaceAll("-", "")}`,
  } = {},
) {
  assertUnlinkedDirectories(path.dirname(lockPath));
  if (existsSync(lockPath)) {
    throw new Error(
      "Local release pipeline is already running or its existing lock needs an owner audit; the existing lock is preserved.",
    );
  }
  try {
    writeFileSync(lockPath, `${token}\r\n${now().toISOString()}`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (error?.code === "EEXIST")
      throw new Error(
        `local release pipeline is already running. Lock: ${lockPath}`,
      );
    throw error;
  }
  return token;
}

export function exitPipelineLock(lockPath, token) {
  if (!token || !existsSync(lockPath)) return;
  try {
    const owner = readFileSync(lockPath, "utf8").split(/\r?\n/, 1)[0].trim();
    if (owner === token) rmSync(lockPath, { force: true });
  } catch {
    // A failed contender must never remove another run's lock.
  }
}

export function writeReleaseMetadata(
  root,
  reason,
  identity,
  now = () => new Date(),
) {
  const content = [
    "# Local Release Metadata",
    "",
    `Reason: ${reason}`,
    `Branch: ${identity.branch}`,
    `Commit: ${identity.commit}`,
    `Version: ${identity.version}`,
    `GeneratedAt: ${now().toISOString()}`,
  ].join("\r\n");
  writeFileSync(path.join(root, "RELEASE-METADATA.md"), content, "utf8");
}

function listFiles(root) {
  const files = [];
  const visit = (current) => {
    const item = lstatSync(current);
    if (item.isSymbolicLink())
      throw new Error(
        `release artifact must not be a reparse point: ${current}`,
      );
    if (item.isFile()) {
      files.push(current);
      return;
    }
    if (!item.isDirectory())
      throw new Error(
        `release artifact is not a regular file or directory: ${current}`,
      );
    for (const entry of readdirSync(current)) visit(path.join(current, entry));
  };
  visit(root);
  return files;
}

export function writeReleaseChecksums(root) {
  const normalizedRoot = path.resolve(root);
  const lines = listFiles(normalizedRoot)
    .filter((file) => path.basename(file) !== "SHA256SUMS.txt")
    .map((file) => {
      const relative = path
        .relative(normalizedRoot, file)
        .split(path.sep)
        .join("/");
      return `${releaseFileSha256(file)}  ${relative}`;
    })
    .sort();
  writeFileSync(
    path.join(normalizedRoot, "SHA256SUMS.txt"),
    lines.join("\r\n"),
    "utf8",
  );
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function storeZip(entries, destination) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime();
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll("\\", "/"), "utf8");
    const data = readFileSync(entry.path);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, name, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(crc32(data), 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + data.length;
  }
  const centralOffset = offset;
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  writeFileSync(destination, Buffer.concat([...chunks, centralBytes, end]));
}

function copyHistoryRepairTool(repoRoot, destination) {
  const source = path.join(repoRoot, "scripts", "codex-history-tool");
  if (!existsSync(path.join(source, "codex_history_tool.py"))) return false;
  mkdirSync(destination, { recursive: true });
  // Export only the supported source entry point and its documentation. Local
  // virtual environments, caches, release builds and unknown files are not assets.
  assertUnlinkedDirectories(source);
  for (const name of ["codex_history_tool.py", "README.md"]) {
    const filename = path.join(source, name);
    if (!existsSync(filename)) continue;
    const item = lstatSync(filename);
    if (!item.isFile() || item.isSymbolicLink())
      throw new Error(
        "History tool export source must be a regular unlinked file.",
      );
    cpSync(filename, path.join(destination, name), { force: true });
  }
  return true;
}

function writePlatformNote(root, platform, reason) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, "BUILD_ON_PLATFORM.md"),
    [
      `# ${platform} build note`,
      "",
      reason,
      "",
      "This directory was generated by scripts/local-release-pipeline.mjs.",
      "Build this platform on its native OS, or configure a complete cross-compile toolchain, then run the same Node release command.",
    ].join("\r\n"),
    "utf8",
  );
}

function writeReleaseReadme(root, version) {
  writeFileSync(
    path.join(root, "README.md"),
    [
      "# Latest CCSwitchMulti",
      "",
      `Version: ${version}`,
      "",
      "Directories:",
      "- windows/installer: Windows installers, including NSIS setup and MSI when available.",
      "- windows/portable: Windows portable zip. Unzip and run the executable.",
      "- windows/raw-exe: Raw Tauri release executable for quick local verification.",
      "- tools/codex-history-tool: Standalone Python script for listing and repairing Codex Desktop history visibility.",
      "- linux and macos: Build notes when this Windows host cannot produce native artifacts.",
      "- latest.json: Tauri updater index when updater signatures are available.",
      "- SHA256SUMS.txt: SHA256 checksums for exported files.",
      "",
      "Note: the portable build still stores app data under the user's normal system app-data directory.",
    ].join("\r\n"),
    "utf8",
  );
}

function signSetupIfAvailable(
  repoRoot,
  setupPath,
  signingKeyPath,
  { run = runBuildCommand, environment = process.env, log = console.log } = {},
) {
  const keyFromEnvironment = Boolean(
    environment.TAURI_SIGNING_PRIVATE_KEY?.trim(),
  );
  const configuredKeyPath =
    environment.TAURI_SIGNING_PRIVATE_KEY_PATH || signingKeyPath;
  if (!existsSync(setupPath))
    throw new Error("Staged installer is missing before signing.");
  if (!keyFromEnvironment && !existsSync(configuredKeyPath))
    throw new Error("The configured updater signing key is unavailable.");
  log("Signing the staged installer with the configured Tauri updater key.");
  const signaturePath = `${setupPath}.sig`;
  // A copied prior signature is not evidence that this signing invocation
  // produced one. Remove only the known staged file, never a source artifact.
  if (existsSync(signaturePath)) {
    const item = lstatSync(signaturePath);
    if (!item.isFile() || item.isSymbolicLink())
      throw new Error("Staged signature must be a regular unlinked file.");
    rmSync(signaturePath);
  }
  const result = run(
    process.execPath,
    [
      path.join(repoRoot, "node_modules", "@tauri-apps", "cli", "tauri.js"),
      "signer",
      "sign",
      ...(!keyFromEnvironment ? ["--private-key-path", configuredKeyPath] : []),
      ...(environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined
        ? ["--password="]
        : []),
      setupPath,
    ],
    {
      cwd: repoRoot,
      env: environment,
      stdio: "pipe",
      windowsHide: true,
      encoding: "utf8",
    },
  );
  requireBuildCommandSuccess(result, "tauri signer");
  if (existsSync(signaturePath)) {
    if (!readFileSync(signaturePath, "utf8").trim())
      throw new Error(
        `tauri signer returned an empty signature for ${setupPath}`,
      );
    return true;
  }
  const output =
    `${String(result?.stdout ?? "")}\n${String(result?.stderr ?? "")}`.split(
      /\r?\n/,
    );
  const marker = output.findIndex(
    (line) => line.trim() === "Public signature:",
  );
  const signature =
    marker >= 0
      ? output
          .slice(marker + 1)
          .find((line) => line.trim())
          ?.trim()
      : "";
  if (!signature)
    throw new Error(
      `tauri signer did not produce a signature: ${signaturePath}`,
    );
  writeFileSync(signaturePath, `${signature}\r\n`, "utf8");
  return true;
}

function writeLatestJson(
  root,
  version,
  repository = DEFAULT_GITHUB_REPOSITORY,
  now = () => new Date(),
) {
  const installerDir = path.join(root, "windows", "installer");
  const setupName = `CCSwitchMulti_${version}_x64-setup.exe`;
  const setup = path.join(installerDir, setupName);
  const signaturePath = `${setup}.sig`;
  if (!existsSync(setup) || !existsSync(signaturePath)) return false;
  const signature = readFileSync(signaturePath, "utf8").trim();
  if (!signature) return false;
  writeFileSync(
    path.join(root, "latest.json"),
    JSON.stringify(
      {
        version,
        notes: `CCSwitchMulti v${version}`,
        pub_date: now()
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z"),
        platforms: {
          "windows-x86_64": {
            signature,
            url: `https://github.com/${repository}/releases/download/v${version}/${setupName}`,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return true;
}

export function exportReleaseArtifacts(
  repoRoot,
  cargoTargetDir,
  stageRoot,
  version,
  {
    run = runBuildCommand,
    environment = process.env,
    log = console.log,
    warn = console.warn,
    now = () => new Date(),
    repository = DEFAULT_GITHUB_REPOSITORY,
  } = {},
) {
  const releaseDir = path.join(path.resolve(cargoTargetDir), "release");
  const sourceExe = path.join(releaseDir, "cc-switch.exe");
  if (!existsSync(sourceExe) || !lstatSync(sourceExe).isFile())
    throw new Error(
      `raw executable is missing while exporting release: ${sourceExe}`,
    );
  const bundleDir = path.join(releaseDir, "bundle", "nsis");
  const setupName = `CCSwitchMulti_${version}_x64-setup.exe`;
  const setup = path.join(bundleDir, setupName);
  if (!existsSync(setup) || !lstatSync(setup).isFile())
    throw new Error(
      `Windows NSIS installer is missing while exporting release: ${setup}`,
    );

  const installer = path.join(stageRoot, "windows", "installer");
  const portable = path.join(stageRoot, "windows", "portable");
  const raw = path.join(stageRoot, "windows", "raw-exe");
  mkdirSync(installer, { recursive: true });
  mkdirSync(portable, { recursive: true });
  mkdirSync(raw, { recursive: true });
  cpSync(setup, path.join(installer, setupName), { force: true });
  if (existsSync(`${setup}.sig`))
    cpSync(`${setup}.sig`, path.join(installer, `${setupName}.sig`), {
      force: true,
    });

  const signingKeyPath = path.join(
    environment.USERPROFILE || os.homedir(),
    ".ccswitchmulti",
    "tauri-update.key",
  );
  const hasSigningKey =
    Boolean(environment.TAURI_SIGNING_PRIVATE_KEY?.trim()) ||
    Boolean(environment.TAURI_SIGNING_PRIVATE_KEY_PATH?.trim()) ||
    existsSync(signingKeyPath);
  if (hasSigningKey)
    signSetupIfAvailable(
      repoRoot,
      path.join(installer, setupName),
      signingKeyPath,
      { run, environment, log },
    );

  const rawName = `CCSwitchMulti_${version}_x64.exe`;
  cpSync(sourceExe, path.join(raw, rawName), { force: true });
  cpSync(sourceExe, path.join(raw, "CCSwitchMulti.exe"), { force: true });
  storeZip(
    [{ name: "CCSwitchMulti.exe", path: sourceExe }],
    path.join(portable, `CCSwitchMulti_${version}_x64-portable.zip`),
  );
  writeFileSync(
    path.join(installer, `CCSwitchMulti_${version}_x64-installed-exe.sha256`),
    `${tauriNsisInstalledExeSha256(sourceExe)}\r\n`,
    "utf8",
  );
  if (
    !copyHistoryRepairTool(
      repoRoot,
      path.join(stageRoot, "tools", "codex-history-tool"),
    )
  )
    warn(
      `Codex history Python tool was not found: ${path.join(repoRoot, "scripts", "codex-history-tool")}`,
    );
  writePlatformNote(
    path.join(stageRoot, "linux"),
    "Linux",
    "Run pnpm tauri build on a Linux host with Rust, Node/pnpm, and Tauri WebKit/GTK dependencies installed, then run this Node release command.",
  );
  writePlatformNote(
    path.join(stageRoot, "macos"),
    "macOS",
    "Run pnpm tauri build on a macOS host with Xcode Command Line Tools, Rust, and Node/pnpm installed, then run this Node release command.",
  );
  cpSync(
    path.join(stageRoot, "linux", "BUILD_ON_PLATFORM.md"),
    path.join(stageRoot, "linux-build-note.md"),
  );
  cpSync(
    path.join(stageRoot, "macos", "BUILD_ON_PLATFORM.md"),
    path.join(stageRoot, "macos-build-note.md"),
  );
  writeReleaseReadme(stageRoot, version);
  if (hasSigningKey) writeLatestJson(stageRoot, version, repository, now);
  return stageRoot;
}

export function runLocalRelease(
  options,
  {
    repoRoot = SCRIPT_REPO,
    environment = process.env,
    run = runBuildCommand,
    log = console.log,
    warn = console.warn,
    now = () => new Date(),
    getIdentity = (root) => getReleaseSourceIdentity(root, { run }),
    resolveRoot = (root, requested) =>
      resolveReleaseRoot(root, requested, { run, environment }),
    lock = enterPipelineLock,
    unlock = exitPipelineLock,
  } = {},
) {
  const repo = path.resolve(repoRoot);
  const releaseRoot = assertReleaseOutputRoot(
    repo,
    path.resolve(resolveRoot(repo, options.releaseRoot)),
    { environment },
  );
  const logDir = path.join(repo, "scripts", "logs");
  const lockPath = path.join(logDir, "local-release.lock");
  mkdirSync(logDir, { recursive: true });
  const lockToken = lock(lockPath, { now });
  try {
    logLine(
      `Local release pipeline started. reason=${options.reason} target=${releaseRoot}`,
      log,
      now,
    );
    const sourceIdentity = getIdentity(repo);
    if (sourceIdentity.trackedWorktree !== "clean")
      throw new Error(
        "local release requires a clean tracked worktree; commit or stash tracked changes before building",
      );

    return withLocalReleaseCargoTarget(
      repo,
      !options.skipBuild,
      (cargoTargetDir) => {
        let stageRoot;
        let config;
        try {
          if (cargoTargetDir)
            log(
              `Using isolated Cargo target for this release: ${cargoTargetDir}`,
            );
          stageRoot = createReleaseStage(releaseRoot);
          assertUnlinkedDirectories(stageRoot);
          runCommand("pnpm", ["install", "--frozen-lockfile", "--force"], {
            run,
            cwd: repo,
            environment,
            log,
          });
          assertLocalTauriCliVersion(repo, { run, environment });
          assertReleaseSourceIdentity(sourceIdentity, getIdentity(repo));
          if (!options.noTypecheck)
            runCommand("pnpm", ["typecheck"], {
              run,
              cwd: repo,
              environment,
              log,
            });
          runCommand("pnpm", ["catalog:verify"], {
            run,
            cwd: repo,
            environment,
            log,
          });

          const selectedTarget =
            cargoTargetDir ||
            resolveCargoTargetDir(
              path.join(repo, "src-tauri"),
              environment.CARGO_TARGET_DIR || "",
            );
          if (!options.skipBuild) {
            config = createTauriBuildConfig();
            buildHistoryRepairSidecar(repo, selectedTarget, {
              run,
              environment,
            });
            runCommand(
              "pnpm",
              [
                "tauri",
                "build",
                "--bundles",
                "nsis",
                "--config",
                config.path,
              ],
              { run, cwd: repo, environment, log },
            );
          }
          assertReleaseSourceIdentity(sourceIdentity, getIdentity(repo));
          exportReleaseArtifacts(
            repo,
            selectedTarget,
            stageRoot,
            sourceIdentity.version,
            { run, environment, log, warn, now },
          );
          writeReleaseMetadata(stageRoot, options.reason, sourceIdentity, now);
          writeReleaseChecksums(stageRoot);
          assertReleaseSourceIdentity(sourceIdentity, getIdentity(repo));
          replaceReleaseRootFromStage(stageRoot, releaseRoot, {
            warn,
            repoRoot: repo,
            environment,
            cargoTargetDir: selectedTarget,
          });
          stageRoot = undefined;
          log(
            `Local release pipeline completed. Artifacts exported to: ${releaseRoot}`,
          );
          return releaseRoot;
        } finally {
          try {
            config?.remove();
          } catch {
            warn(
              "local release build configuration cleanup failed; its temporary file may remain.",
            );
          }
          if (stageRoot && existsSync(stageRoot)) {
            try {
              assertUnlinkedDirectories(stageRoot);
              rmSync(stageRoot, { recursive: true, force: true });
            } catch {
              warn(
                "local release staging cleanup failed; its temporary output may remain.",
              );
            }
          }
        }
      },
      {
        environment,
        warn,
        cleanup: (root, target, { environment: scopedEnvironment }) =>
          cleanupLocalReleaseCargoTarget(root, target, {
            run,
            environment: scopedEnvironment,
          }),
      },
    );
  } finally {
    unlock(lockPath, lockToken);
  }
}

export function main(args = process.argv.slice(2), dependencies = {}) {
  const options = parseLocalReleaseOptions(args);
  if (options.help) {
    console.log(
      "Usage: node scripts/local-release-pipeline.mjs [--release-root PATH] [--skip-build] [--no-typecheck] [--reason TEXT]",
    );
    return;
  }
  return runLocalRelease(options, dependencies);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
