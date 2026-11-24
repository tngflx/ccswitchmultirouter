import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertLocalTauriCliVersion,
  assertReleaseOutputRoot,
  assertUnlinkedDirectories,
  cleanupLocalReleaseCargoTarget,
  createLocalReleaseCargoTarget,
  createReleaseStage,
  createTauriBuildConfig,
  replaceReleaseRootFromStage,
  requireBuildCommandSuccess,
  runBuildCommand,
} from "./release-build-config.mjs";

const SCRIPT_REPO = fileURLToPath(new URL("../", import.meta.url));
const CURRENT_OWNER = "local-build-pipeline.mjs";

export function parseLocalBuildOptions(args) {
  const options = { outputDir: "", help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["--help", "-h", "-?"].includes(argument)) {
      options.help = true;
      continue;
    }
    if (["--output-dir", "-OutputDir"].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith("--") || value === "-OutputDir")
        throw new Error(`Missing value after ${argument}.`);
      options.outputDir = value;
      continue;
    }
    throw new Error(`Unknown local build option: ${argument}`);
  }
  return options;
}

export function resolveLocalProductionOutputRoot(repoRoot, requested = "") {
  return path.resolve(
    repoRoot,
    requested.trim() || path.join("output", "production"),
  );
}

// Output location and replacement ownership have one shared contract across
// local builds and signed releases. LOCAL-BUILD.json is informational only.
export function assertLocalProductionOutputRoot(
  repoRoot,
  outputRoot,
  options = {},
) {
  return assertReleaseOutputRoot(repoRoot, outputRoot, options);
}

// Inputs may contain nested resources. Refuse links instead of following them
// into unrelated directories while copying a production artifact tree.
function assertArtifactTree(root) {
  const item = lstatSync(root);
  if (item.isSymbolicLink())
    throw new Error(
      "local production artifacts must not contain symbolic links or reparse points",
    );
  if (item.isDirectory()) {
    for (const name of readdirSync(root))
      assertArtifactTree(path.join(root, name));
  } else if (!item.isFile())
    throw new Error("local production artifact is not a regular file");
}

export function exportLocalProductionArtifacts(
  repoRoot,
  cargoTargetDir,
  outputRoot,
  {
    environment = process.env,
    copy = cpSync,
    promote = replaceReleaseRootFromStage,
    now = () => new Date(),
    removeStage = (stage) => rmSync(stage, { recursive: true, force: true }),
    warn = console.warn,
  } = {},
) {
  const context = { environment, cargoTargetDir };
  const output = assertLocalProductionOutputRoot(repoRoot, outputRoot, context);
  const release = path.join(cargoTargetDir, "release");
  const executable = path.join(release, "cc-switch.exe");
  const bundle = path.join(release, "bundle");
  if (!existsSync(executable) || !lstatSync(executable).isFile())
    throw new Error(
      "local production build did not produce the raw executable",
    );
  const installerRoot = path.join(bundle, "nsis");
  const installers = existsSync(installerRoot)
    ? readdirSync(installerRoot, { withFileTypes: true }).filter(
        (item) => item.isFile() && /-setup\.exe$/i.test(item.name),
      )
    : [];
  if (!installers.length)
    throw new Error("local production build did not produce an NSIS installer");
  assertArtifactTree(executable);
  assertArtifactTree(bundle);
  const resources = path.join(repoRoot, "src-tauri", "resources");
  if (existsSync(resources)) assertArtifactTree(resources);
  const stage = createReleaseStage(output);
  try {
    copy(executable, path.join(stage, "cc-switch.exe"), { force: true });
    copy(bundle, path.join(stage, "bundle"), { recursive: true, force: true });
    if (existsSync(resources))
      copy(resources, path.join(stage, "resources"), {
        recursive: true,
        force: true,
      });
    writeFileSync(
      path.join(stage, "LOCAL-BUILD.json"),
      `${JSON.stringify({ generatedBy: CURRENT_OWNER, generatedAt: now().toISOString(), updaterSigned: false }, null, 2)}\n`,
      "utf8",
    );
    assertLocalProductionOutputRoot(repoRoot, output, context);
    promote(stage, output, { repoRoot, ...context, warn });
  } finally {
    // createReleaseStage owns this unique, validated sibling path.
    if (existsSync(stage)) {
      try {
        assertUnlinkedDirectories(stage);
        removeStage(stage);
      } catch {
        warn(
          "local production staging cleanup failed; its temporary output may remain.",
        );
      }
    }
  }
  return output;
}

export function buildHistoryRepairSidecar(
  repoRoot,
  cargoTargetDir,
  {
    run = runBuildCommand,
    environment = process.env,
  } = {},
) {
  const repo = path.resolve(repoRoot);
  const target = path.resolve(cargoTargetDir);
  const manifest = path.join(repo, "src-tauri", "Cargo.toml");
  requireBuildCommandSuccess(
    run(
      "cargo",
      [
        "build",
        "--release",
        "--bin",
        "codex-history-repairer",
        "--features",
        "history-repairer",
        "--manifest-path",
        manifest,
      ],
      {
        cwd: repo,
        env: { ...environment, CARGO_TARGET_DIR: target },
        stdio: "inherit",
      },
    ),
    "codex-history-repairer sidecar build",
  );
  const sidecar = path.join(target, "release", "codex-history-repairer.exe");
  if (!existsSync(sidecar) || !lstatSync(sidecar).isFile())
    throw new Error(
      `codex-history-repairer sidecar was not produced: ${sidecar}`,
    );
  return sidecar;
}

export function invokeLocalProductionBuild(
  repoRoot,
  outputRoot,
  {
    run = runBuildCommand,
    environment = process.env,
    log = console.log,
    warn = console.warn,
    exportOptions,
    createConfig = createTauriBuildConfig,
  } = {},
) {
  const repo = path.resolve(repoRoot);
  const buildEnvironment = environment;
  let target;
  {
    const output = assertLocalProductionOutputRoot(repo, outputRoot, {
      environment: buildEnvironment,
    });
    // Invoke the pinned package's JS entry point directly. No shell, global Tauri
    // binary, PowerShell script, or interpolated command string is involved.
    const cliPath = assertLocalTauriCliVersion(repo, {
      run,
      environment: buildEnvironment,
    });
    target = createLocalReleaseCargoTarget(repo);
    let config;
    try {
      config = createConfig();
      log(`Using isolated Cargo target for this build: ${target}`);
      buildHistoryRepairSidecar(repo, target, {
        run,
        environment: buildEnvironment,
      });
      requireBuildCommandSuccess(
        run(
          process.execPath,
          [cliPath, "build", "--bundles", "nsis", "--config", config.path],
          {
            cwd: repo,
            env: { ...buildEnvironment, CARGO_TARGET_DIR: target },
            stdio: "inherit",
          },
        ),
        "tauri build",
      );
      return exportLocalProductionArtifacts(repo, target, output, {
        ...exportOptions,
        environment: buildEnvironment,
      });
    } finally {
      try {
        config?.remove();
      } catch {
        // Cleanup stages are independent: a locked temp file must neither hide
        // the build error nor prevent reclaiming this invocation's Cargo target.
        warn(
          "local build configuration cleanup failed; its temporary file may remain.",
        );
      }
      try {
        cleanupLocalReleaseCargoTarget(repo, target, {
          run,
          environment: buildEnvironment,
        });
      } catch (error) {
        warn(
          `local release Cargo target cleanup failed for '${target}': ${error.message}`,
        );
      }
    }
  }
}

export function main(
  args = process.argv.slice(2),
  { repoRoot = SCRIPT_REPO, platform = process.platform, ...options } = {},
) {
  const parsed = parseLocalBuildOptions(args);
  if (parsed.help) {
    console.log(
      "Usage: node scripts/local-build-pipeline.mjs [--output-dir PATH]\nBuilds and exports the Windows NSIS application without installing or publishing.\nThe existing -OutputDir PATH spelling is also supported.",
    );
    return;
  }
  if (platform !== "win32")
    throw new Error("Local NSIS production builds require Windows.");
  const output = invokeLocalProductionBuild(
    repoRoot,
    resolveLocalProductionOutputRoot(repoRoot, parsed.outputDir),
    options,
  );
  console.log(`Local production artifacts exported to: ${output}`);
  console.log(`Raw executable: ${path.join(output, "cc-switch.exe")}`);
  console.log(`Installer bundles: ${path.join(output, "bundle", "nsis")}`);
  return output;
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
