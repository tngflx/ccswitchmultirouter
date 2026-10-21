import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertLocalTauriCliVersion,
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
const OUTPUT_OWNERS = new Set([CURRENT_OWNER, "local-build-pipeline.ps1"]);

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

function isInside(target, parent) {
  const relative = path.relative(parent, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function assertLocalProductionOutputRoot(repoRoot, outputRoot) {
  const repo = path.resolve(repoRoot);
  const output = path.resolve(outputRoot);
  if (output === path.parse(output).root)
    throw new Error("local production output must not be a filesystem root");
  const allowed = path.join(repo, "output");
  if (
    isInside(repo, output) ||
    (isInside(output, repo) &&
      (!isInside(output, allowed) || path.relative(allowed, output) === ""))
  ) {
    throw new Error(
      "local production output inside the repository must be a child of its output directory",
    );
  }
  assertUnlinkedDirectories(output);
  if (existsSync(output) && readdirSync(output).length > 0) {
    let marker;
    try {
      marker = JSON.parse(
        readFileSync(path.join(output, "LOCAL-BUILD.json"), "utf8"),
      );
    } catch {}
    if (!OUTPUT_OWNERS.has(marker?.generatedBy)) {
      throw new Error(
        "local production output is not owned by this build pipeline; choose an empty output directory",
      );
    }
  }
  return output;
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
    copy = cpSync,
    promote = replaceReleaseRootFromStage,
    now = () => new Date(),
    removeStage = (stage) => rmSync(stage, { recursive: true, force: true }),
    warn = console.warn,
  } = {},
) {
  const output = assertLocalProductionOutputRoot(repoRoot, outputRoot);
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
    assertLocalProductionOutputRoot(repoRoot, output);
    promote(stage, output);
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
  const output = assertLocalProductionOutputRoot(repo, outputRoot);
  // Invoke the pinned package's JS entry point directly. No shell, global Tauri
  // binary, PowerShell script, or interpolated command string is involved.
  const cliPath = assertLocalTauriCliVersion(repo, { run, environment });
  const target = createLocalReleaseCargoTarget(repo);
  let config;
  try {
    config = createConfig();
    log(`Using isolated Cargo target for this build: ${target}`);
    requireBuildCommandSuccess(
      run(
        process.execPath,
        [cliPath, "build", "--bundles", "nsis", "--config", config.path],
        {
          cwd: repo,
          env: { ...environment, CARGO_TARGET_DIR: target },
          stdio: "inherit",
        },
      ),
      "tauri build",
    );
    return exportLocalProductionArtifacts(repo, target, output, exportOptions);
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
      cleanupLocalReleaseCargoTarget(repo, target, { run, environment });
    } catch (error) {
      warn(
        `local release Cargo target cleanup failed for '${target}': ${error.message}`,
      );
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
