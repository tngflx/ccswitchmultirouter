import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_UPSTREAM_URL =
  "https://github.com/BigStrongSun/ccswitchmulti.git";
export const DEFAULT_BRANCH = "main";
export const DEFAULT_REMOTE_NAME = "ccswitchmulti-upstream";
export const DEFAULT_MAX_COUNT = 50;

// Keep upstream-analysis remotes explicitly non-routable for pushes. A blank
// push URL is not sufficient: Git can fall back to the fetch URL in that case.
export const DISABLED_PUSH_URL =
  "https://example.invalid/UPSTREAM_PUSH_DISABLED.git";

const OPTION_ALIASES = new Map([
  ["--upstream-url", "upstreamUrl"],
  ["--upstreamurl", "upstreamUrl"],
  ["-upstreamurl", "upstreamUrl"],
  ["-u", "upstreamUrl"],
  ["--branch", "branch"],
  ["-branch", "branch"],
  ["-b", "branch"],
  ["--remote-name", "remoteName"],
  ["--remotename", "remoteName"],
  ["-remotename", "remoteName"],
  ["-r", "remoteName"],
  ["--max-count", "maxCount"],
  ["--maxcount", "maxCount"],
  ["-maxcount", "maxCount"],
  ["-n", "maxCount"],
]);

const OPTION_LABELS = {
  upstreamUrl: "--upstream-url",
  branch: "--branch",
  remoteName: "--remote-name",
  maxCount: "--max-count",
};

function usage() {
  return `Usage: node scripts/check-upstream-updates.mjs [options]

Checks the configured upstream branch without changing the user's origin remote.

Options:
  --upstream-url URL   Upstream fetch URL (default: ${DEFAULT_UPSTREAM_URL})
  --branch NAME        Upstream branch (default: ${DEFAULT_BRANCH})
  --remote-name NAME   Local fetch-only remote name (default: ${DEFAULT_REMOTE_NAME})
  --max-count N        Maximum commits to report, 1-500 (default: ${DEFAULT_MAX_COUNT})
  -h, --help           Show this help

Legacy option names (-UpstreamUrl, -Branch, -RemoteName, -MaxCount)
remain accepted for callers migrating from the former checker.
`;
}

function optionValue(argv, index, optionName, inlineValue) {
  if (inlineValue !== undefined) {
    if (inlineValue.length === 0) {
      throw new Error(`${optionName} requires a value.`);
    }
    return { value: inlineValue, nextIndex: index };
  }
  if (index + 1 >= argv.length || argv[index + 1] === "--") {
    throw new Error(`${optionName} requires a value.`);
  }
  return { value: argv[index + 1], nextIndex: index + 1 };
}

export function parseArgs(argv = []) {
  const options = {
    upstreamUrl: DEFAULT_UPSTREAM_URL,
    branch: DEFAULT_BRANCH,
    remoteName: DEFAULT_REMOTE_NAME,
    maxCount: DEFAULT_MAX_COUNT,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h" || arg === "-?") {
      options.help = true;
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    const rawName = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const key = OPTION_ALIASES.get(rawName.toLowerCase());
    if (!key) {
      throw new Error("Unknown option. Use --help for usage.");
    }

    const inlineValue =
      equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    const parsed = optionValue(argv, index, OPTION_LABELS[key], inlineValue);
    options[key] = parsed.value;
    index = parsed.nextIndex;
  }

  for (const key of ["upstreamUrl", "branch", "remoteName"]) {
    if (typeof options[key] !== "string" || options[key].length === 0) {
      throw new Error(`${OPTION_LABELS[key]} requires a non-empty value.`);
    }
  }

  if (typeof options.maxCount === "string") {
    if (!/^\d+$/.test(options.maxCount)) {
      throw new Error("--max-count must be an integer between 1 and 500.");
    }
    options.maxCount = Number(options.maxCount);
  }
  if (
    !Number.isInteger(options.maxCount) ||
    options.maxCount < 1 ||
    options.maxCount > 500
  ) {
    throw new Error("--max-count must be an integer between 1 and 500.");
  }

  return options;
}

function splitLines(stdout) {
  const text = String(stdout ?? "");
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function splitNulls(stdout) {
  const text = String(stdout ?? "");
  if (text.length === 0) return [];
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

function runGit(
  cwd,
  args,
  { allowMissing = false, nullSeparated = false } = {},
) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const status = result.status;
  if (result.error || (status !== 0 && !(allowMissing && status === 1))) {
    const exitCode = typeof status === "number" ? status : "unknown";
    // Never echo Git's arguments or stderr: either can contain credentials.
    throw new Error(`git operation failed (exit code ${exitCode}).`);
  }
  if (allowMissing && status === 1) return [];
  return nullSeparated ? splitNulls(result.stdout) : splitLines(result.stdout);
}

function getConfigurationValues(cwd, key) {
  try {
    return runGit(cwd, ["config", "--null", "--get-all", key], {
      allowMissing: true,
      nullSeparated: true,
    });
  } catch {
    throw new Error(
      "Unable to validate upstream configuration without exposing its values.",
    );
  }
}

function getExistingRemoteName(remoteNames, requestedName) {
  const requested = requestedName.toLowerCase();
  return remoteNames.find((name) => name.toLowerCase() === requested);
}

function getRemoteFetchUrls(cwd, name) {
  return runGit(cwd, ["remote", "get-url", "--all", name])
    .map((url) => url.trim())
    .filter(Boolean);
}

function assertUpstreamIsFetchOnly(cwd, name) {
  const pushUrls = runGit(cwd, ["remote", "get-url", "--push", "--all", name])
    .map((url) => url.trim())
    .filter(Boolean);
  if (pushUrls.length !== 1 || pushUrls[0] !== DISABLED_PUSH_URL) {
    throw new Error(
      "Upstream analysis requires an effectively fetch-only remote with pushes disabled; no configuration was changed.",
    );
  }
}

function assertNewUpstreamCanBeFetchOnly(cwd, name) {
  // A remote name may be supplied by inherited config even when `git remote`
  // does not list it. Never hide those values with a local disabled push URL.
  for (const field of ["url", "pushurl", "fetch"]) {
    if (getConfigurationValues(cwd, `remote.${name}.${field}`).length > 0) {
      throw new Error(
        "Upstream analysis requires an unambiguous fetch-only remote with pushes disabled; inherited configuration must be reviewed without rewriting it.",
      );
    }
  }

  // Resolve insteadOf rules without contacting a server. A rewritten sentinel
  // could otherwise turn the supposedly disabled destination into a live one.
  const resolvedPushUrl = runGit(cwd, [
    "ls-remote",
    "--get-url",
    DISABLED_PUSH_URL,
  ]).map((url) => url.trim());
  if (
    resolvedPushUrl.length !== 1 ||
    resolvedPushUrl[0] !== DISABLED_PUSH_URL
  ) {
    throw new Error(
      "Upstream analysis cannot create a fetch-only remote because the disabled push URL is rewritten; no configuration was changed.",
    );
  }
}

function assertInsideWorkTree(cwd) {
  const insideWorkTree = runGit(cwd, ["rev-parse", "--is-inside-work-tree"])[0];
  if (insideWorkTree !== "true") {
    throw new Error(
      "Run this command from inside the cc-switch-multi Git worktree.",
    );
  }
}

export function checkUpstream(options, cwd = process.cwd()) {
  if (options.remoteName.toLowerCase() === "origin") {
    throw new Error(
      "The remote name 'origin' is reserved for the user's repository and cannot be used for upstream analysis.",
    );
  }

  assertInsideWorkTree(cwd);

  const remoteNames = runGit(cwd, ["remote"]);
  let existingRemoteName = getExistingRemoteName(
    remoteNames,
    options.remoteName,
  );

  if (existingRemoteName === undefined) {
    // Validate all inherited rewrites before changing local Git config.
    assertNewUpstreamCanBeFetchOnly(cwd, options.remoteName);

    let createdRemote = false;
    try {
      runGit(cwd, ["remote", "add", options.remoteName, options.upstreamUrl]);
      createdRemote = true;
      runGit(cwd, [
        "remote",
        "set-url",
        "--push",
        options.remoteName,
        DISABLED_PUSH_URL,
      ]);
    } catch (error) {
      if (createdRemote) {
        try {
          runGit(cwd, ["remote", "remove", options.remoteName]);
        } catch {
          throw new Error(
            "Unable to establish or roll back the fetch-only upstream remote; no push is authorized.",
          );
        }
      }
      throw error;
    }
    existingRemoteName = options.remoteName;
  } else {
    let existingUrls;
    try {
      existingUrls = getRemoteFetchUrls(cwd, existingRemoteName);
    } catch {
      throw new Error(
        "The existing upstream remote cannot be resolved as an effectively fetch-only remote; refusing to rewrite it.",
      );
    }
    if (existingUrls.length !== 1 || existingUrls[0] !== options.upstreamUrl) {
      throw new Error(
        "The existing upstream remote has a fetch URL mismatch or ambiguous URLs; refusing to rewrite it.",
      );
    }
    assertUpstreamIsFetchOnly(cwd, existingRemoteName);
  }

  runGit(cwd, [
    "fetch",
    "--no-tags",
    existingRemoteName,
    `+refs/heads/${options.branch}:refs/remotes/${existingRemoteName}/${options.branch}`,
  ]);

  const upstreamRef = `${existingRemoteName}/${options.branch}`;
  const newCommits = runGit(cwd, [
    "log",
    "--no-merges",
    "--format=%h %s",
    `--max-count=${options.maxCount}`,
    `HEAD..${upstreamRef}`,
  ]);

  return { branch: options.branch, upstreamRef, newCommits };
}

function printResult(result) {
  if (result.newCommits.length === 0) {
    console.log(
      `No new commits from the configured upstream (${result.branch}).`,
    );
    return;
  }

  console.warn(
    `New commits are available from the configured upstream (${result.branch}):`,
  );
  for (const commit of result.newCommits) console.log(`  ${commit}`);
  console.log("");
  console.log(`Review with: git log HEAD..${result.upstreamRef}`);
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  );
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  printResult(checkUpstream(options, cwd));
  return 0;
}

if (isMainModule()) {
  try {
    main();
  } catch (error) {
    // Keep failures useful but do not expose Git's stderr, arguments, or URLs.
    console.error(
      error instanceof Error && error.message
        ? error.message
        : "Upstream analysis failed.",
    );
    process.exitCode = 1;
  }
}
