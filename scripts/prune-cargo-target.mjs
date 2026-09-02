import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_GB = 12;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const TAURI_DIR = path.join(REPO_ROOT, "src-tauri");
const MANIFEST_PATH = path.join(TAURI_DIR, "Cargo.toml");
const EXPECTED_TARGET = path.join(TAURI_DIR, "target");

function normalized(value) {
  const resolved = path.resolve(String(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function parseCleanupOptions(args, environment = process.env) {
  const options = {
    dryRun: false,
    force: false,
    maxGb: DEFAULT_MAX_GB,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    if (argument === "--max-gb") {
      index += 1;
      if (index >= args.length) {
        throw new Error("Missing value after --max-gb.");
      }
      options.maxGb = Number(args[index]);
      continue;
    }
    throw new Error(`Unknown argument "${argument}".`);
  }

  if (
    !args.includes("--max-gb") &&
    environment.CCSM_CARGO_TARGET_MAX_GB !== undefined
  ) {
    options.maxGb = Number(environment.CCSM_CARGO_TARGET_MAX_GB);
  }
  if (
    !Number.isFinite(options.maxGb) ||
    options.maxGb < 0 ||
    options.maxGb > 1024
  ) {
    throw new Error(
      `Invalid Cargo target limit "${options.maxGb}". Use 0-1024 GB.`,
    );
  }
  return options;
}

export function directorySizeBytes(root) {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        total += statSync(entryPath).size;
      }
    }
  }
  return total;
}

export function processOwnsCargoTarget(
  candidate,
  targetDirectory = EXPECTED_TARGET,
  repoRoot = REPO_ROOT,
) {
  const name = String(candidate.Name ?? candidate.name ?? "").toLowerCase();
  if (
    ![
      "cargo.exe",
      "cargo",
      "rustc.exe",
      "rustc",
      "cc-switch.exe",
      "cc-switch",
    ].includes(name)
  ) {
    return false;
  }

  const executable = String(
    candidate.ExecutablePath ?? candidate.executablePath ?? "",
  );
  const commandLine = String(
    candidate.CommandLine ?? candidate.commandLine ?? "",
  );
  const haystack = `${executable}\n${commandLine}`.toLowerCase();
  const target = normalized(targetDirectory);
  const repo = normalized(repoRoot);

  return (
    haystack.includes(target) ||
    haystack.includes(repo) ||
    haystack.includes(normalized(MANIFEST_PATH))
  );
}

function windowsCargoProcesses() {
  const script = [
    "Get-CimInstance Win32_Process",
    "Where-Object { $_.Name -in @('cargo.exe','rustc.exe','cc-switch.exe') }",
    "Select-Object Name,ProcessId,ExecutablePath,CommandLine",
    "ConvertTo-Json -Compress",
  ].join(" | ");
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr ?? "").trim() ||
        `PowerShell process query exited with status ${result.status}.`,
    );
  }
  const text = String(result.stdout ?? "").trim();
  if (!text) {
    return [];
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function unixCargoProcesses() {
  const result = spawnSync("ps", ["-eo", "comm=,args="], {
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr ?? "").trim() ||
        `ps exited with status ${result.status}.`,
    );
  }
  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name = "", ...command] = line.trim().split(/\s+/);
      return { Name: name, CommandLine: command.join(" ") };
    });
}

export function findCargoTargetOwners(
  candidates,
  targetDirectory = EXPECTED_TARGET,
  repoRoot = REPO_ROOT,
) {
  return candidates.filter((candidate) =>
    processOwnsCargoTarget(candidate, targetDirectory, repoRoot),
  );
}

function cargoTargetDirectory() {
  const result = spawnSync(
    "cargo",
    [
      "metadata",
      "--manifest-path",
      MANIFEST_PATH,
      "--no-deps",
      "--format-version",
      "1",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr ?? "").trim() ||
        `cargo metadata exited with status ${result.status}.`,
    );
  }
  return JSON.parse(result.stdout).target_directory;
}

export function cleanupDecision({ sizeBytes, maxGb, force, ownerCount }) {
  if (ownerCount > 0) {
    return "active";
  }
  if (force) {
    return "clean";
  }
  if (maxGb === 0) {
    return "disabled";
  }
  return sizeBytes > maxGb * 1024 ** 3 ? "clean" : "keep";
}

function formatGb(bytes) {
  return (bytes / 1024 ** 3).toFixed(2);
}

function queryCargoTargetOwners(actualTarget) {
  const candidates =
    process.platform === "win32"
      ? windowsCargoProcesses()
      : unixCargoProcesses();
  return findCargoTargetOwners(candidates, actualTarget, REPO_ROOT);
}

function activeTargetMessage(owners, phase) {
  const summary = owners
    .map((owner) => `${owner.Name} PID ${owner.ProcessId ?? "unknown"}`)
    .join(", ");
  return `[cargo-clean] Cleanup deferred ${phase} because the target is owned by ${summary}.`;
}

export function maintainCargoTarget({
  actualTarget,
  options,
  getOwners = () => queryCargoTargetOwners(actualTarget),
  measureSize = () => directorySizeBytes(actualTarget),
  clean = () => {
    const result = spawnSync(
      "cargo",
      ["clean", "--manifest-path", MANIFEST_PATH],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        windowsHide: true,
        stdio: "inherit",
      },
    );
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`cargo clean exited with status ${result.status}.`);
    }
  },
  log = console.log,
}) {
  const initialOwners = getOwners();
  if (initialOwners.length > 0) {
    const message = activeTargetMessage(initialOwners, "before size scan");
    if (options.force) {
      throw new Error(message);
    }
    log(message);
    return "active";
  }

  const sizeBytes = measureSize();
  const decision = cleanupDecision({
    sizeBytes,
    maxGb: options.maxGb,
    force: options.force,
    ownerCount: 0,
  });

  if (decision === "disabled") {
    log(
      `[cargo-clean] Automatic cleanup disabled; target is ${formatGb(sizeBytes)} GB.`,
    );
    return decision;
  }
  if (decision === "keep") {
    log(
      `[cargo-clean] Target is ${formatGb(sizeBytes)} GB, below the ${options.maxGb.toFixed(2)} GB limit.`,
    );
    return decision;
  }
  if (options.dryRun) {
    log(
      `[cargo-clean] Would run cargo clean: target is ${formatGb(sizeBytes)} GB.`,
    );
    return "dry-run";
  }

  const finalOwners = getOwners();
  if (finalOwners.length > 0) {
    const message = activeTargetMessage(finalOwners, "after size scan");
    if (options.force) {
      throw new Error(message);
    }
    log(message);
    return "active";
  }

  log(
    `[cargo-clean] Target is ${formatGb(sizeBytes)} GB; running guarded cargo clean before development starts.`,
  );
  clean();
  return decision;
}

function run() {
  const options = parseCleanupOptions(process.argv.slice(2));
  const actualTarget = cargoTargetDirectory();
  if (normalized(actualTarget) !== normalized(EXPECTED_TARGET)) {
    throw new Error(
      `Refusing cleanup because Cargo resolved ${actualTarget}, expected ${EXPECTED_TARGET}.`,
    );
  }
  maintainCargoTarget({ actualTarget, options });
}

if (
  process.argv[1] &&
  normalized(process.argv[1]) === normalized(fileURLToPath(import.meta.url))
) {
  try {
    run();
  } catch (error) {
    console.error(`[cargo-clean] ${error.message}`);
    process.exitCode = 1;
  }
}
