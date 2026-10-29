import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL("./check-upstream-updates.ps1", import.meta.url),
);

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccsm-upstream-remote-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  const globalConfig = path.join(root, "empty.gitconfig");
  writeFileSync(globalConfig, "");
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    // Every fixture is local. Accidental HTTP/SSH requests fail before network.
    GIT_ALLOW_PROTOCOL: "file",
  };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_TRACE2_EVENT",
  ])
    delete env[key];
  const git = (args, cwd = repo) => {
    const result = spawnSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "--initial-branch=main"]);
  git(["config", "user.name", "Upstream fixture"]);
  git(["config", "user.email", "upstream-fixture@example.invalid"]);
  git([
    "-c",
    "core.hooksPath=.disabled-hooks",
    "commit",
    "--allow-empty",
    "-m",
    "local fixture",
  ]);
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    rmSync(root, { recursive: true, force: true });
  });
  const tracePath = path.join(root, "git-trace.jsonl");
  return {
    root,
    repo,
    git,
    config: () => readFileSync(path.join(repo, ".git", "config")),
    globalConfig: () => readFileSync(globalConfig),
    trace: () => (existsSync(tracePath) ? readFileSync(tracePath, "utf8") : ""),
    run: (...args) => {
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          ...args,
        ],
        {
          cwd: repo,
          env: { ...env, GIT_TRACE2_EVENT: tracePath },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      assert.equal(
        result.error,
        undefined,
        "PowerShell 7 (pwsh) is required for this regression suite",
      );
      return { ...result, output: result.stdout + result.stderr };
    },
    createUpstream: () => {
      const source = path.join(root, "source");
      const bare = path.join(root, "upstream.git");
      mkdirSync(source);
      git(["init", "--initial-branch=main"], source);
      git(["config", "user.name", "Upstream fixture"], source);
      git(["config", "user.email", "upstream-fixture@example.invalid"], source);
      git(
        [
          "-c",
          "core.hooksPath=.disabled-hooks",
          "commit",
          "--allow-empty",
          "-m",
          "upstream fixture",
        ],
        source,
      );
      const main = git(["rev-parse", "HEAD"], source);
      git(["switch", "-c", "preview"], source);
      git(
        [
          "-c",
          "core.hooksPath=.disabled-hooks",
          "commit",
          "--allow-empty",
          "-m",
          "preview fixture",
        ],
        source,
      );
      const preview = git(["rev-parse", "HEAD"], source);
      git(["init", "--bare", "--initial-branch=main", bare]);
      git(["push", bare, "main", "preview"], source);
      return { bare, main, preview };
    },
  };
}

for (const name of ["origin", "Origin", "ORIGIN"]) {
  test(`upstream checker rejects protected remote ${name} before config or fetch`, (t) => {
    const f = fixture(t);
    f.git(["remote", "add", "origin", path.join(f.root, "your-fork.git")]);
    const before = f.config();
    const result = f.run(
      "-RemoteName",
      name,
      "-UpstreamUrl",
      path.join(f.root, "missing-upstream.git"),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.output, /origin.*reserved|reserved.*origin/i);
    assert.deepEqual(f.config(), before);
    assert.equal(
      f.trace(),
      "",
      "reserved remote must fail before invoking Git",
    );
  });
}

test("mismatching existing upstream fails closed without rewriting or exposing credentials", (t) => {
  const f = fixture(t);
  const sensitiveUrl =
    "https://fixture-user:fixture-sensitive-token@example.invalid/private.git";
  f.git(["remote", "add", "review-upstream", sensitiveUrl]);
  const before = f.config();
  const result = f.run(
    "-RemoteName",
    "review-upstream",
    "-UpstreamUrl",
    path.join(f.root, "missing-upstream.git"),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.output, /URL.*mismatch|does not match/i);
  assert.doesNotMatch(
    result.output,
    /fixture-user|fixture-sensitive-token|private\.git/,
  );
  assert.deepEqual(f.config(), before);
  assert.doesNotMatch(f.trace(), /"argv":\["git(?:\.exe)?","fetch"/);
});

test("ambiguous existing remote URLs fail without mutation or fetch", (t) => {
  const f = fixture(t);
  const expected = path.join(f.root, "expected-upstream.git");
  f.git(["remote", "add", "review-upstream", expected]);
  f.git([
    "config",
    "--add",
    "remote.review-upstream.url",
    path.join(f.root, "other-upstream.git"),
  ]);
  const before = f.config();
  const result = f.run(
    "-RemoteName",
    "review-upstream",
    "-UpstreamUrl",
    expected,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.output, /URL.*mismatch|does not match/i);
  assert.deepEqual(f.config(), before);
  assert.doesNotMatch(f.trace(), /"argv":\["git(?:\.exe)?","fetch"/);
});

test("new upstream remote becomes fetch-only before even a failed fetch", (t) => {
  const f = fixture(t);
  const missing = path.join(f.root, "missing-upstream.git");
  const result = f.run(
    "-RemoteName",
    "review-upstream",
    "-UpstreamUrl",
    missing,
  );
  assert.notEqual(result.status, 0);
  assert.equal(f.git(["remote", "get-url", "review-upstream"]), missing);
  assert.equal(
    f.git(["remote", "get-url", "--push", "--all", "review-upstream"]),
    "https://example.invalid/UPSTREAM_PUSH_DISABLED.git",
  );
});

test("new default upstream fetches main locally and disables upstream pushes", (t) => {
  const f = fixture(t);
  const upstream = f.createUpstream();
  const result = f.run("-UpstreamUrl", upstream.bare);
  assert.equal(result.status, 0, result.output);
  assert.equal(
    f.git(["rev-parse", "refs/remotes/ccswitchmulti-upstream/main"]),
    upstream.main,
  );
  assert.equal(
    f.git(["remote", "get-url", "--push", "--all", "ccswitchmulti-upstream"]),
    "https://example.invalid/UPSTREAM_PUSH_DISABLED.git",
  );
});

test("correct existing upstream retains config and explicit branch fetch semantics", (t) => {
  const f = fixture(t);
  const upstream = f.createUpstream();
  f.git(["remote", "add", "review-upstream", upstream.bare]);
  f.git([
    "config",
    "remote.review-upstream.fetch",
    "+refs/heads/main:refs/remotes/review-upstream/main",
  ]);
  f.git([
    "config",
    "remote.review-upstream.pushurl",
    "https://example.invalid/UPSTREAM_PUSH_DISABLED.git",
  ]);
  const before = f.config();
  const result = f.run(
    "-RemoteName",
    "review-upstream",
    "-UpstreamUrl",
    upstream.bare,
    "-Branch",
    "preview",
  );
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(f.config(), before);
  assert.equal(
    f.git(["rev-parse", "refs/remotes/review-upstream/preview"]),
    upstream.preview,
  );
  assert.equal(
    f.git([
      "for-each-ref",
      "--format=%(refname)",
      "refs/remotes/review-upstream",
    ]),
    "refs/remotes/review-upstream/preview",
  );
});

const disabledPushUrl = "https://example.invalid/UPSTREAM_PUSH_DISABLED.git";

for (const useExistingRemote of [false, true]) {
  test(`rewritten disabled push URL is rejected without config changes (${useExistingRemote ? "existing" : "new"} remote)`, (t) => {
    const f = fixture(t);
    const upstream = f.createUpstream();
    if (useExistingRemote) {
      f.git(["remote", "add", "review-upstream", upstream.bare]);
      f.git(["config", "remote.review-upstream.pushurl", disabledPushUrl]);
    }
    f.git([
      "config",
      "--global",
      `url.${upstream.bare}.insteadOf`,
      disabledPushUrl,
    ]);
    const localBefore = f.config();
    const globalBefore = f.globalConfig();
    const result = f.run(
      "-RemoteName",
      "review-upstream",
      "-UpstreamUrl",
      upstream.bare,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.output, /fetch-only|push.*disabled/i);
    assert.deepEqual(f.config(), localBefore);
    assert.deepEqual(f.globalConfig(), globalBefore);
    assert.doesNotMatch(f.trace(), /"argv":\["git(?:\.exe)?","fetch"/);
  });
}

test("matching upstream with no disabled push destination is rejected without mutation", (t) => {
  const f = fixture(t);
  const upstream = f.createUpstream();
  f.git(["remote", "add", "review-upstream", upstream.bare]);
  const before = f.config();
  const result = f.run(
    "-RemoteName",
    "review-upstream",
    "-UpstreamUrl",
    upstream.bare,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.output, /fetch-only|push.*disabled/i);
  assert.deepEqual(f.config(), before);
  assert.doesNotMatch(f.trace(), /"argv":\["git(?:\.exe)?","fetch"/);
});

test("inherited writable upstream push URL is rejected without changing either config", (t) => {
  const f = fixture(t);
  const upstream = f.createUpstream();
  f.git(["config", "--global", "remote.review-upstream.url", upstream.bare]);
  f.git([
    "config",
    "--global",
    "remote.review-upstream.pushurl",
    upstream.bare,
  ]);
  const localBefore = f.config();
  const globalBefore = f.globalConfig();
  const result = f.run(
    "-RemoteName",
    "review-upstream",
    "-UpstreamUrl",
    upstream.bare,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.output, /fetch-only|push.*disabled/i);
  assert.deepEqual(f.config(), localBefore);
  assert.deepEqual(f.globalConfig(), globalBefore);
  assert.doesNotMatch(f.trace(), /"argv":\["git(?:\.exe)?","fetch"/);
});

test("local disabled push URL cannot hide inherited additional writable push destinations", (t) => {
  const f = fixture(t);
  const upstream = f.createUpstream();
  f.git(["remote", "add", "review-upstream", upstream.bare]);
  f.git([
    "config",
    "--global",
    "remote.review-upstream.pushurl",
    upstream.bare,
  ]);
  f.git(["config", "remote.review-upstream.pushurl", disabledPushUrl]);
  const localBefore = f.config();
  const globalBefore = f.globalConfig();
  const result = f.run(
    "-RemoteName",
    "review-upstream",
    "-UpstreamUrl",
    upstream.bare,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.output, /fetch-only|push.*disabled/i);
  assert.deepEqual(f.config(), localBefore);
  assert.deepEqual(f.globalConfig(), globalBefore);
  assert.doesNotMatch(f.trace(), /"argv":\["git(?:\.exe)?","fetch"/);
});

test("explicit disabled push URL remains safe when pushInsteadOf is ignored by Git", (t) => {
  const f = fixture(t);
  const upstream = f.createUpstream();
  f.git([
    "config",
    "--global",
    `url.${upstream.bare}.pushInsteadOf`,
    disabledPushUrl,
  ]);
  const globalBefore = f.globalConfig();
  const result = f.run(
    "-RemoteName",
    "review-upstream",
    "-UpstreamUrl",
    upstream.bare,
  );
  assert.equal(result.status, 0, result.output);
  assert.equal(
    f.git(["remote", "get-url", "--push", "--all", "review-upstream"]),
    disabledPushUrl,
  );
  assert.deepEqual(f.globalConfig(), globalBefore);
});
