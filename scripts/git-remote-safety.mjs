import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OWNED_REPOSITORY =
  "https://github.com/tngflx/ccswitchmultirouter.git";
export const DISABLED_PUSH_URL =
  "https://example.invalid/UPSTREAM_PUSH_DISABLED.git";
const HOOK_MARKER = "# ccsm-owned-remote-guard-v1";
const ZERO_OID = /^0+$/;

// Match the entire transport/location, not a URL prefix or the remote's label.
// Do not accept credentials, ports, query/fragment, remote helpers or SSH aliases.
export function isOwnedRepository(location) {
  return (
    typeof location === "string" &&
    !/\s/.test(location) &&
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)tngflx\/ccswitchmultirouter(?:\.git)?\/?$/i.test(
      location,
    )
  );
}

function runGit(cwd, args, missing = false) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (
    result.error ||
    (result.status !== 0 && !(missing && result.status === 1))
  ) {
    // Git's raw output and arguments can contain URL credentials. Never echo them.
    throw new Error(
      "Git configuration could not be read or updated; no push is authorized.",
    );
  }
  if (result.status === 1) return [];
  const stdout = result.stdout ?? "";
  if (args.includes("--null")) {
    if (stdout.length === 0) return [];
    const fields = stdout.split("\0");
    if (fields.at(-1) === "") fields.pop();
    return fields;
  }
  const lines = stdout.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.filter(Boolean);
}

function config(cwd, key, { type } = {}) {
  const args = ["config"];
  if (type) args.push(`--type=${type}`);
  args.push("--null", "--get-all", key);
  return runGit(cwd, args, true);
}

function configEntries(cwd, key, { type } = {}) {
  const args = ["config", "--show-origin"];
  if (type) args.push(`--type=${type}`);
  args.push("--null", "--get-all", key);
  const fields = runGit(cwd, args, true);
  if (fields.length % 2 !== 0) {
    throw new Error(
      "Git configuration could not be read or updated; no push is authorized.",
    );
  }
  const entries = [];
  for (let index = 0; index < fields.length; index += 2) {
    entries.push({ origin: fields[index], value: fields[index + 1] });
  }
  return entries;
}

function mainConfigPath(cwd) {
  return path.resolve(
    runGit(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "config",
    ])[0],
  );
}

function originPath(cwd, origin) {
  if (!origin.startsWith("file:")) return null;
  let value = origin.slice("file:".length);
  if (value.startsWith("//")) value = value.slice(2);
  return path.resolve(cwd, value);
}

function samePath(left, right) {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function rejectInheritedConfig(cwd, key) {
  const localConfig = mainConfigPath(cwd);
  if (
    configEntries(cwd, key).some((entry) => {
      const file = originPath(cwd, entry.origin);
      return file === null || !samePath(file, localConfig);
    })
  ) {
    throw new Error(
      "Inherited Git configuration affects the guarded push destination; review it explicitly before installing the local remote guard.",
    );
  }
}

function remoteUrls(cwd, remote, push = false) {
  return runGit(cwd, [
    "remote",
    "get-url",
    ...(push ? ["--push"] : []),
    "--all",
    remote,
  ]);
}

function requireOwnedUrls(urls, description, { single = false } = {}) {
  if (
    !urls.length ||
    (single && urls.length !== 1) ||
    !urls.every(isOwnedRepository)
  ) {
    throw new Error(
      `${description} must point only to ${OWNED_REPOSITORY}. Raw URLs are redacted.`,
    );
  }
}

function localBranches(cwd) {
  return runGit(cwd, [
    "for-each-ref",
    "--format=%(refname:strip=2)",
    "refs/heads/",
  ]);
}

function refusePushRefspecOverrides(cwd) {
  if (config(cwd, "remote.origin.push").length) {
    throw new Error(
      "Remove remote.origin.push refspec overrides before installing/checking same-name branch pushes.",
    );
  }
  if (
    config(cwd, "remote.origin.mirror", { type: "bool" }).some((value) =>
      /^(?:true|yes|on|1)$/i.test(value),
    )
  ) {
    throw new Error("origin must not be a mirror push remote.");
  }
}

function resolveUrl(cwd, location) {
  return runGit(cwd, ["ls-remote", "--get-url", location]);
}

function preflightProposedUrls(cwd, remotes) {
  requireOwnedUrls(
    resolveUrl(cwd, OWNED_REPOSITORY),
    "the proposed origin push URL",
    { single: true },
  );
  for (const remote of remotes) {
    if (remote === "origin") continue;
    const resolved = resolveUrl(cwd, DISABLED_PUSH_URL);
    if (resolved.length !== 1 || resolved[0] !== DISABLED_PUSH_URL) {
      throw new Error(
        "The disabled upstream push URL is rewritten by Git configuration; refusing to install a fetch-only remote.",
      );
    }
  }
}

function guardedConfigKeys(remotes, branches) {
  return [
    "remote.origin.pushurl",
    "remote.pushDefault",
    "push.default",
    "push.autoSetupRemote",
    ...remotes
      .filter((remote) => remote !== "origin")
      .map((remote) => `remote.${remote}.pushurl`),
    ...branches.flatMap((branch) =>
      ["pushRemote", "remote", "merge"].map(
        (field) => `branch.${branch}.${field}`,
      ),
    ),
  ];
}

function rejectInheritedInstallerConfig(cwd, remotes, branches) {
  // `--local --replace-all` cannot hide values supplied by an included, global,
  // system, command, or worktree config. Multi-valued push URLs and branch merge
  // keys must therefore be local-only before this installer writes anything.
  for (const key of guardedConfigKeys(remotes, branches)) {
    rejectInheritedConfig(cwd, key);
  }
}

export function hookContent(nodeExecutable = process.execPath) {
  const quotedNode = `'${nodeExecutable.replaceAll("\\", "/").replaceAll("'", `\'"\'"\'`)}'`;
  return `#!/bin/sh\n${HOOK_MARKER}\nset -eu\nroot=$(git rev-parse --show-toplevel)\nexec ${quotedNode} "$root/scripts/git-remote-safety.mjs" --hook "$@"\n`;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function rejectExternalHookParent(cwd, location) {
  const commonDir = realpathSync(
    runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])[0],
  );
  let candidate = path.dirname(location);
  while (!existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  let resolvedParent;
  try {
    resolvedParent = realpathSync(candidate);
  } catch {
    throw new Error(
      "The Git hooks directory could not be resolved safely; refusing to install a shared or external hook.",
    );
  }
  if (!isWithin(commonDir, resolvedParent)) {
    throw new Error(
      "The Git hooks directory resolves outside this repository; refusing to mutate a shared or external hook directory.",
    );
  }
}

function hookLocation(cwd) {
  // Never replace a shared/global hook configuration to install a local guard.
  if (config(cwd, "core.hooksPath").length) {
    throw new Error(
      "An existing core.hooksPath is configured. Preserve it and integrate the remote guard explicitly; it was not replaced.",
    );
  }
  const location = runGit(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "hooks/pre-push",
  ])[0];
  rejectExternalHookParent(cwd, location);
  return location;
}

function inspectHook(cwd) {
  const location = hookLocation(cwd);
  const expected = hookContent();
  if (existsSync(location)) {
    if (
      lstatSync(location).isSymbolicLink() ||
      readFileSync(location, "utf8") !== expected
    ) {
      throw new Error(
        "An existing pre-push hook is present. It was preserved; compose the remote guard with it explicitly instead of overwriting it.",
      );
    }
  }
  return { location, expected };
}

export function checkRemoteSafety(cwd = process.cwd()) {
  requireOwnedUrls(remoteUrls(cwd, "origin"), "origin fetch URLs");
  requireOwnedUrls(
    remoteUrls(cwd, "origin", true),
    "origin effective push URLs",
    { single: true },
  );
  refusePushRefspecOverrides(cwd);
  const remotes = runGit(cwd, ["remote"]);
  const branches = localBranches(cwd);
  for (const key of guardedConfigKeys(remotes, branches)) {
    rejectInheritedConfig(cwd, key);
  }
  for (const [key, expected] of [
    ["remote.pushDefault", "origin"],
    ["push.default", "simple"],
    ["push.autoSetupRemote", "true"],
  ]) {
    if (config(cwd, key).at(-1) !== expected) {
      throw new Error(
        `${key} must be ${expected}; run pnpm git:remotes:install.`,
      );
    }
  }
  for (const remote of remotes) {
    if (remote === "origin") continue;
    const urls = remoteUrls(cwd, remote, true);
    if (urls.length !== 1 || urls[0] !== DISABLED_PUSH_URL) {
      throw new Error(
        "Non-origin remotes must be fetch-only; run pnpm git:remotes:install. Raw URLs are redacted.",
      );
    }
  }
  for (const branch of localBranches(cwd)) {
    // A new, untracked branch is safe: autoSetupRemote will establish its
    // same-name origin tracking after the first successful push. Explicit
    // branch overrides must not override those repository-wide defaults.
    const pushRemote = config(cwd, `branch.${branch}.pushRemote`);
    const remote = config(cwd, `branch.${branch}.remote`);
    const merges = config(cwd, `branch.${branch}.merge`);
    if (
      (pushRemote.length && pushRemote.at(-1) !== "origin") ||
      (remote.length && remote.at(-1) !== "origin") ||
      (merges.length &&
        (merges.length !== 1 || merges[0] !== `refs/heads/${branch}`))
    ) {
      throw new Error(
        "Local branches must track and push to their same-name origin branch; run pnpm git:remotes:install.",
      );
    }
  }
  const { location } = inspectHook(cwd);
  if (!existsSync(location)) {
    throw new Error(
      "The local pre-push guard is not installed; run pnpm git:remotes:install.",
    );
  }
  if (process.platform !== "win32" && !(lstatSync(location).mode & 0o111)) {
    throw new Error(
      "The local pre-push guard is not executable; run pnpm git:remotes:install.",
    );
  }
  return { repository: OWNED_REPOSITORY, hook: location };
}

function runGitStatus(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.error ? { status: null } : { status: result.status };
}

function requireCommit(cwd, oid) {
  if (!/^[0-9a-f]+$/i.test(oid) || ZERO_OID.test(oid)) {
    throw new Error(
      "Push blocked: the pre-push update contains an invalid or empty commit; fetch origin first.",
    );
  }
  if (runGitStatus(cwd, ["cat-file", "-e", `${oid}^{commit}`]).status !== 0) {
    throw new Error(
      "Push blocked: the pre-push update references an unknown commit; fetch origin first.",
    );
  }
}

function validatePushRefs(cwd, input) {
  const lines = String(input ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const fields = line.split(/\s+/);
    if (fields.length !== 4) {
      throw new Error(
        "Push blocked: Git supplied an invalid ref update; only same-name branch pushes are permitted.",
      );
    }
    const [localRef, localOid, remoteRef, remoteOid] = fields;
    const remoteMatch = /^refs\/heads\/(.+)$/.exec(remoteRef);
    if (!remoteMatch || localRef === "(delete)") {
      throw new Error(
        "Push blocked: tags, deletions, and non-branch refs are not permitted.",
      );
    }
    const remoteBranch = remoteMatch[1];
    let localBranch;
    if (localRef === "HEAD") {
      localBranch = runGit(
        cwd,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        true,
      )[0];
      if (!localBranch) {
        throw new Error(
          "Push blocked: detached HEAD cannot publish through the same-name branch guard.",
        );
      }
    } else {
      const localMatch = /^refs\/heads\/(.+)$/.exec(localRef);
      if (!localMatch) {
        throw new Error(
          "Push blocked: tags, deletions, and non-branch refs are not permitted.",
        );
      }
      localBranch = localMatch[1];
    }
    if (localBranch !== remoteBranch) {
      throw new Error(
        "Push blocked: local and remote branch names must match; use an explicit same-name origin branch.",
      );
    }
    requireCommit(cwd, localOid);
    if (!ZERO_OID.test(remoteOid)) {
      requireCommit(cwd, remoteOid);
      if (
        runGitStatus(cwd, ["merge-base", "--is-ancestor", remoteOid, localOid])
          .status !== 0
      ) {
        throw new Error(
          "Push blocked: the update is not a fast-forward; fetch origin and integrate before pushing.",
        );
      }
    }
  }
}

export function installRemoteSafety(cwd = process.cwd()) {
  // Reject a repointed origin rather than silently converting another checkout.
  requireOwnedUrls(remoteUrls(cwd, "origin"), "origin fetch URLs");
  requireOwnedUrls(
    remoteUrls(cwd, "origin", true),
    "origin effective push URLs",
    { single: true },
  );
  refusePushRefspecOverrides(cwd);
  const remotes = runGit(cwd, ["remote"]);
  const branches = localBranches(cwd);
  rejectInheritedInstallerConfig(cwd, remotes, branches);
  preflightProposedUrls(cwd, remotes);
  const { location, expected } = inspectHook(cwd);
  mkdirSync(path.dirname(location), { recursive: true });
  if (!existsSync(location)) {
    writeFileSync(location, expected, { flag: "wx", mode: 0o755 });
  }
  chmodSync(location, 0o755);
  const set = (key, value) =>
    runGit(cwd, ["config", "--local", "--replace-all", key, value]);
  // Replace *all* push URLs: Git otherwise pushes to every configured pushurl.
  set("remote.origin.pushurl", OWNED_REPOSITORY);
  set("remote.pushDefault", "origin");
  set("push.default", "simple");
  set("push.autoSetupRemote", "true");
  for (const remote of remotes) {
    if (remote !== "origin") set(`remote.${remote}.pushurl`, DISABLED_PUSH_URL);
  }
  for (const branch of branches) {
    set(`branch.${branch}.pushRemote`, "origin");
    set(`branch.${branch}.remote`, "origin");
    set(`branch.${branch}.merge`, `refs/heads/${branch}`);
  }
  return checkRemoteSafety(cwd);
}

export function checkPushTarget(
  remote,
  location,
  cwd = process.cwd(),
  pushInput = "",
) {
  // Check the actual destination even if a caller renamed a remote or uses a URL.
  // No raw URL is included in failures, because it may carry credentials.
  if (
    !isOwnedRepository(location) ||
    (remote !== "origin" && !isOwnedRepository(remote))
  ) {
    throw new Error(
      `Push blocked: only origin / ${OWNED_REPOSITORY} is permitted. Upstream remotes are fetch-only. Destination redacted.`,
    );
  }
  const result = checkRemoteSafety(cwd);
  validatePushRefs(cwd, pushInput);
  return result;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "--install" && args.length === 0) {
      installRemoteSafety();
      console.log(
        `Installed local push protection for ${OWNED_REPOSITORY}. No branches were switched and nothing was pushed.`,
      );
    } else if (command === "--check" && args.length === 0) {
      checkRemoteSafety();
      console.log(
        `Remote safety passed: only ${OWNED_REPOSITORY} is writable.`,
      );
    } else if (command === "--hook" && args.length === 2) {
      const input = readFileSync(0, "utf8");
      checkPushTarget(args[0], args[1], process.cwd(), input);
    } else {
      throw new Error(
        "Usage: node scripts/git-remote-safety.mjs --install | --check | --hook <remote> <destination>",
      );
    }
  } catch (error) {
    console.error(`[git-remote-safety] ${error.message}`);
    process.exitCode = 1;
  }
}
