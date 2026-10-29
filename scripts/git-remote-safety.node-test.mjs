import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DISABLED_PUSH_URL,
  hookContent,
  isOwnedRepository,
  OWNED_REPOSITORY,
} from "./git-remote-safety.mjs";

const source = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "git-remote-safety.mjs",
);
// Tests never read the user's global config or contact GitHub, even in failures.
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL =
  process.platform === "win32" ? "NUL" : "/dev/null";
process.env.GIT_ALLOW_PROTOCOL = "file";
process.env.GIT_TERMINAL_PROMPT = "0";
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
])
  delete process.env[key];

function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const root = mkdtempSync(path.join(parent, "ccsm-remote-safety-"));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith("ccsm-remote-safety-"));
    rmSync(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, "work with spaces 'quotes' & characters");
  mkdirSync(cwd);
  const run = (args, options = {}) =>
    spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      ...options,
    });
  const git = (...args) => {
    const result = run(args);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--initial-branch=main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Remote safety fixture");
  git("commit", "--allow-empty", "-m", "fixture");
  git("remote", "add", "origin", OWNED_REPOSITORY);
  git(
    "remote",
    "add",
    "upstream",
    "https://github.com/BigStrongSun/ccswitchmulti.git",
  );
  const script = path.join(cwd, "scripts", "git-remote-safety.mjs");
  mkdirSync(path.dirname(script));
  copyFileSync(source, script);
  const cli = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd,
      encoding: "utf8",
      input: "",
      windowsHide: true,
      timeout: 15000,
    });
  const cliWithInput = (input, ...args) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd,
      encoding: "utf8",
      input,
      windowsHide: true,
      timeout: 15000,
    });
  const install = () => {
    const result = cli("--install");
    assert.equal(result.status, 0, result.stderr);
  };
  const hook = path.join(cwd, ".git", "hooks", "pre-push");
  const configPath = path.join(cwd, ".git", "config");
  const bare = path.join(root, "not-your-repository.git");
  return {
    root,
    cwd,
    run,
    git,
    cli,
    cliWithInput,
    install,
    hook,
    script,
    configPath,
    bare,
  };
}

for (const url of [
  OWNED_REPOSITORY,
  "https://github.com/tngflx/ccswitchmultirouter",
  "https://github.com/TNGFLX/CCSwitchMultiRouter.git/",
  "git@github.com:tngflx/ccswitchmultirouter.git",
  "ssh://git@github.com/tngflx/ccswitchmultirouter.git",
]) {
  test(`accepts owned GitHub transport: ${url}`, () =>
    assert.ok(isOwnedRepository(url)));
}

for (const [description, url] of [
  ["upstream", "https://github.com/BigStrongSun/ccswitchmulti.git"],
  ["different repo", "https://github.com/tngflx/other.git"],
  ["different owner", "git@github.com:other/ccswitchmultirouter.git"],
  [
    "lookalike host",
    "https://github.com.evil.test/tngflx/ccswitchmultirouter.git",
  ],
  ["extra path", `${OWNED_REPOSITORY}/other`],
  ["query", `${OWNED_REPOSITORY}?token=redacted-test-value`],
  ["fragment", `${OWNED_REPOSITORY}#main`],
  [
    "credential",
    "https://redacted-test-value@github.com/tngflx/ccswitchmultirouter.git",
  ],
  ["port", "https://github.com:443/tngflx/ccswitchmultirouter.git"],
  ["HTTP", "http://github.com/tngflx/ccswitchmultirouter.git"],
  ["SSH alias", "git@github-alias:tngflx/ccswitchmultirouter.git"],
  ["encoded path", "https://github.com/tngflx%2Fccswitchmultirouter.git"],
  ["remote helper", "ext::git anything"],
  ["newline", `${OWNED_REPOSITORY}\n`],
  ["whitespace", ` ${OWNED_REPOSITORY}`],
  ["missing", undefined],
]) {
  test(`rejects ${description} without trusting a URL prefix`, () =>
    assert.equal(isOwnedRepository(url), false));
}

test("installer is local, idempotent, preserves fetch URLs and binds every existing branch to own same-name origin", (t) => {
  const f = fixture(t);
  f.git("branch", "other");
  f.git("config", "branch.other.pushRemote", "upstream");
  f.git("config", "branch.other.remote", "upstream");
  f.git("config", "branch.other.merge", "refs/heads/main");
  const head = f.git("rev-parse", "HEAD");
  f.install();
  const installed = readFileSync(f.hook, "utf8");
  const configuration = readFileSync(f.configPath, "utf8");
  f.install();
  assert.equal(readFileSync(f.hook, "utf8"), installed);
  assert.equal(readFileSync(f.configPath, "utf8"), configuration);
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(
    f.git("remote", "get-url", "upstream"),
    "https://github.com/BigStrongSun/ccswitchmulti.git",
  );
  assert.equal(
    f.git("remote", "get-url", "--push", "upstream"),
    DISABLED_PUSH_URL,
  );
  assert.equal(f.git("config", "remote.pushDefault"), "origin");
  assert.equal(f.git("config", "push.default"), "simple");
  assert.equal(f.git("config", "push.autoSetupRemote"), "true");
  assert.equal(f.git("config", "branch.other.pushRemote"), "origin");
  assert.equal(f.git("config", "branch.other.remote"), "origin");
  assert.equal(f.git("config", "branch.other.merge"), "refs/heads/other");
  assert.equal(f.cli("--check").status, 0);
});

test("new untracked branches inherit safe defaults without being repointed or blocking first publication", (t) => {
  const f = fixture(t);
  f.install();
  f.git("switch", "-c", "new-local-branch");
  assert.equal(f.cli("--check").status, 0);
  assert.equal(f.cli("--hook", "origin", OWNED_REPOSITORY).status, 0);
  assert.equal(f.git("branch", "--show-current"), "new-local-branch");
});

test("hook accepts origin's verified destination and an explicit owned URL", (t) => {
  const f = fixture(t);
  f.install();
  for (const remote of ["origin", OWNED_REPOSITORY]) {
    const result = f.cli("--hook", remote, OWNED_REPOSITORY);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("hook rejects upstream, renamed remotes and direct wrong URLs without logging a credential", (t) => {
  const f = fixture(t);
  f.install();
  const wrong =
    "https://redacted-test-value@github.com/BigStrongSun/ccswitchmulti.git";
  for (const [remote, target] of [
    ["origin", wrong],
    [wrong, wrong],
    ["upstream", OWNED_REPOSITORY],
  ]) {
    const result = f.cli("--hook", remote, target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Push blocked/);
    assert.doesNotMatch(result.stderr, /redacted-test-value/);
  }
});

for (const [name, alter] of [
  [
    "an extra malicious push URL",
    (f) =>
      f.git(
        "config",
        "--add",
        "remote.origin.pushurl",
        "https://github.com/other/other.git",
      ),
  ],
  [
    "a duplicate push URL",
    (f) => f.git("config", "--add", "remote.origin.pushurl", OWNED_REPOSITORY),
  ],
  [
    "a repository-wide wrong default",
    (f) => f.git("config", "remote.pushDefault", "upstream"),
  ],
  [
    "a branch-specific push override",
    (f) => f.git("config", "branch.main.pushRemote", "upstream"),
  ],
  [
    "an upstream tracking remote",
    (f) => f.git("config", "branch.main.remote", "upstream"),
  ],
  [
    "a mismatched destination branch",
    (f) => f.git("config", "branch.main.merge", "refs/heads/wrong"),
  ],
  [
    "implicit upstream push fallback",
    (f) => f.git("config", "--unset-all", "remote.upstream.pushurl"),
  ],
  [
    "a rewritten effective URL",
    (f) =>
      f.git(
        "config",
        "url.https://github.com/other/other.git.insteadOf",
        OWNED_REPOSITORY,
      ),
  ],
  ["a mirror remote", (f) => f.git("config", "remote.origin.mirror", "true")],
  [
    "a default push refspec override",
    (f) => f.git("config", "remote.origin.push", "HEAD:refs/heads/wrong"),
  ],
]) {
  test(`check and pre-push fail closed on ${name}`, (t) => {
    const f = fixture(t);
    f.install();
    alter(f);
    assert.equal(f.cli("--check").status, 1);
    assert.equal(f.cli("--hook", "origin", OWNED_REPOSITORY).status, 1);
  });
}

test("installer pins an explicit owned push URL past pushInsteadOf rewrites", (t) => {
  const f = fixture(t);
  const sshOwned = "git@github.com:tngflx/ccswitchmultirouter.git";
  f.git("remote", "set-url", "origin", sshOwned);
  f.git("remote", "set-url", "--push", "origin", sshOwned);
  f.git(
    "config",
    "url.https://github.com/other/other.git.pushInsteadOf",
    OWNED_REPOSITORY,
  );
  f.install();
  assert.equal(f.cli("--check").status, 0);
  assert.equal(
    f.git("remote", "get-url", "--push", "--all", "origin"),
    OWNED_REPOSITORY,
  );
});

test("check rejects a valueless mirror flag instead of treating it as absent", (t) => {
  const f = fixture(t);
  f.install();
  f.git("config", "remote.origin.mirror", "false");
  appendFileSync(f.configPath, '\n[remote "origin"]\n\tmirror\n');
  assert.equal(f.cli("--check").status, 1);
});

test("installer rejects a rewrite of the proposed origin push URL before any writes", (t) => {
  const f = fixture(t);
  f.git(
    "remote",
    "set-url",
    "origin",
    "git@github.com:tngflx/ccswitchmultirouter.git",
  );
  f.git(
    "remote",
    "set-url",
    "--push",
    "origin",
    "git@github.com:tngflx/ccswitchmultirouter.git",
  );
  f.git(
    "config",
    "url.https://github.com/other/other.git.insteadOf",
    OWNED_REPOSITORY,
  );
  const before = readFileSync(f.configPath);
  const result = f.cli("--install");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /proposed origin push URL|no push is authorized/i,
  );
  assert.deepEqual(readFileSync(f.configPath), before);
  assert.equal(existsSync(f.hook), false);
});

test("installer rejects inherited upstream push URLs before creating a hook", (t) => {
  const f = fixture(t);
  const included = path.join(f.root, "inherited.gitconfig");
  writeFileSync(
    included,
    '[remote "upstream"]\n\tpushurl = https://github.com/other/other.git\n',
  );
  f.git("config", "--local", "include.path", included);
  const before = readFileSync(f.configPath);
  const result = f.cli("--install");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Inherited Git configuration/i);
  assert.deepEqual(readFileSync(f.configPath), before);
  assert.equal(existsSync(f.hook), false);
});

test("installer rejects an empty core.hooksPath instead of resolving outside .git", (t) => {
  const f = fixture(t);
  f.git("config", "core.hooksPath", "");
  const before = readFileSync(f.configPath);
  const result = f.cli("--install");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /core\.hooksPath/i);
  assert.deepEqual(readFileSync(f.configPath), before);
  assert.equal(existsSync(f.hook), false);
});

test("installer refuses a shared external hooks directory symlink", (t) => {
  const f = fixture(t);
  const gitHooks = path.join(f.cwd, ".git", "hooks");
  const originalHooks = path.join(f.cwd, ".git", "hooks-real");
  const shared = path.join(f.root, "shared hooks");
  mkdirSync(shared);
  renameSync(gitHooks, originalHooks);
  try {
    symlinkSync(
      shared,
      gitHooks,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    renameSync(originalHooks, gitHooks);
    t.skip("symlink/junction creation is unavailable: " + error.message);
    return;
  }
  const before = readFileSync(f.configPath);
  const result = f.cli("--install");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /hooks directory resolves outside|external hook/i,
  );
  assert.deepEqual(readFileSync(f.configPath), before);
  assert.equal(existsSync(path.join(shared, "pre-push")), false);
});

test("installer refuses a repointed origin without rewriting config or creating hooks", (t) => {
  const f = fixture(t);
  f.git(
    "remote",
    "set-url",
    "origin",
    "https://github.com/BigStrongSun/ccswitchmulti.git",
  );
  const before = readFileSync(f.configPath);
  assert.equal(f.cli("--install").status, 1);
  assert.deepEqual(readFileSync(f.configPath), before);
  assert.equal(existsSync(f.hook), false);
});

test("installer preserves an existing pre-push hook and all config on refusal", (t) => {
  const f = fixture(t);
  writeFileSync(f.hook, "#!/bin/sh\nexit 23\n");
  const before = readFileSync(f.configPath);
  const result = f.cli("--install");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /existing pre-push hook/);
  assert.equal(readFileSync(f.hook, "utf8"), "#!/bin/sh\nexit 23\n");
  assert.deepEqual(readFileSync(f.configPath), before);
});

test("installer preserves a configured hooksPath, including an external shared hook", (t) => {
  const f = fixture(t);
  const shared = path.join(f.root, "shared hooks");
  mkdirSync(shared);
  const customHook = path.join(shared, "pre-push");
  writeFileSync(customHook, "#!/bin/sh\nexit 19\n");
  f.git("config", "core.hooksPath", shared);
  const before = readFileSync(f.configPath);
  assert.equal(f.cli("--install").status, 1);
  assert.equal(readFileSync(customHook, "utf8"), "#!/bin/sh\nexit 19\n");
  assert.deepEqual(readFileSync(f.configPath), before);
});

test("shell launcher quotes the installed Node executable without relying on VSCode PATH", () => {
  const hook = hookContent("C:\\Node path's & stuff\\node.exe");
  assert.match(hook, /'C:\/Node path'"'"'s & stuff\/node\.exe'/);
  assert.match(hook, /"\$root\/scripts\/git-remote-safety\.mjs" --hook "\$@"/);
});

test("hook permits a same-name fast-forward branch update", (t) => {
  const f = fixture(t);
  f.install();
  const oid = f.git("rev-parse", "HEAD");
  const zero = "0".repeat(40);
  const result = f.cliWithInput(
    `HEAD ${oid} refs/heads/main ${zero}\n`,
    "--hook",
    "origin",
    OWNED_REPOSITORY,
  );
  assert.equal(result.status, 0, result.stderr);
});

test("hook rejects cross-branch, tag, deletion, and non-fast-forward updates", (t) => {
  const f = fixture(t);
  f.install();
  const first = f.git("rev-parse", "HEAD");
  f.git("commit", "--allow-empty", "-m", "second");
  const second = f.git("rev-parse", "HEAD");
  const zero = "0".repeat(40);
  const cases = [
    [
      `refs/heads/other ${second} refs/heads/main ${zero}\n`,
      /branch names must match/,
    ],
    [`refs/tags/v1 ${second} refs/heads/main ${zero}\n`, /tags/],
    [`(delete) ${zero} refs/heads/main ${second}\n`, /deletions/],
    [
      `refs/heads/main ${first} refs/heads/main ${second}\n`,
      /not a fast-forward/,
    ],
  ];
  for (const [input, message] of cases) {
    const result = f.cliWithInput(input, "--hook", "origin", OWNED_REPOSITORY);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
  }
});

test("installed hook launches Node from a quoted path", (t) => {
  const f = fixture(t);
  const nodeDir = path.join(f.root, "node path's & characters");
  mkdirSync(nodeDir);
  const nodeCopy = path.join(
    nodeDir,
    process.platform === "win32" ? "node.exe" : "node",
  );
  copyFileSync(process.execPath, nodeCopy);
  if (process.platform !== "win32") chmodSync(nodeCopy, 0o755);
  const install = spawnSync(nodeCopy, [f.script, "--install"], {
    cwd: f.cwd,
    encoding: "utf8",
    input: "",
    windowsHide: true,
    timeout: 15000,
  });
  assert.equal(install.status, 0, install.stderr);
  const oid = f.git("rev-parse", "HEAD");
  const result = f.run(
    ["hook", "run", "pre-push", "--", "origin", OWNED_REPOSITORY],
    { input: `HEAD ${oid} refs/heads/main ${"0".repeat(40)}\n` },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("real Git push to a wrong local destination is blocked before any refs change", (t) => {
  const f = fixture(t);
  f.git("init", "--bare", f.bare);
  f.install();
  // Repoint even origin after installation, as a GUI or a mistaken tool could.
  f.git("remote", "set-url", "--push", "origin", f.bare);
  const result = f.run(["push", "origin", "main:main"]);
  assert.notEqual(
    result.status,
    0,
    "The wrong repository must not receive a push",
  );
  assert.match(result.stderr, /Push blocked/);
  assert.equal(f.git("--git-dir", f.bare, "for-each-ref"), "");
});

test("real explicit URL push cannot bypass the configured remote's guard", (t) => {
  const f = fixture(t);
  f.git("init", "--bare", f.bare);
  f.install();
  const result = f.run(["push", f.bare, "main:main"]);
  assert.notEqual(
    result.status,
    0,
    "An explicit unowned URL must not bypass origin policy",
  );
  assert.match(result.stderr, /Push blocked/);
  assert.equal(f.git("--git-dir", f.bare, "for-each-ref"), "");
});

test("real Git hook permits the owned target check without a remote connection", (t) => {
  const f = fixture(t);
  f.install();
  // Invoke the installed shell through Git itself, with no remote connection.
  const result = f.run(
    ["hook", "run", "pre-push", "--", "origin", OWNED_REPOSITORY],
    { input: "" },
  );
  assert.equal(result.status, 0, result.stderr);
  const denied = f.run(
    [
      "hook",
      "run",
      "pre-push",
      "--",
      "origin",
      "https://github.com/other/other.git",
    ],
    { input: "" },
  );
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /Push blocked/);
});
