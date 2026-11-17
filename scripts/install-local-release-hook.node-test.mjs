import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  rmdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  installLocalReleaseHook,
  newPostCommitHookContent,
  parseReleaseHookOptions,
} from "./install-local-release-hook.mjs";

test("hook parser accepts synchronous aliases", () => {
  assert.deepEqual(parseReleaseHookOptions(["-Synchronous"]), {
    synchronous: true,
    help: false,
  });
  assert.deepEqual(parseReleaseHookOptions(["--help"]), {
    synchronous: false,
    help: true,
  });
  assert.throws(
    () => parseReleaseHookOptions(["--bad"]),
    /Unknown release hook option/,
  );
});

test("generated hook launches the JavaScript release pipeline without PowerShell", () => {
  const background = newPostCommitHookContent();
  assert.match(background, /command -v node/);
  assert.match(background, /local-release-pipeline\.mjs/);
  assert.match(background, /--reason post-commit/);
  assert.match(background, /2>&1 &$/m);
  assert.doesNotMatch(background, /\.ps1|pwsh/);
  const synchronous = newPostCommitHookContent({ synchronous: true });
  assert.doesNotMatch(synchronous, /2>&1 &$/m);
});

test("install writes a Git Bash compatible post-commit hook", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccsm-hook-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hooks = path.join(root, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const result = installLocalReleaseHook(root, {
    synchronous: true,
    run: (_executable, args) =>
      args.includes("config")
        ? { status: 1, stdout: "" }
        : { status: 0, stdout: ".git\n" },
  });
  assert.equal(result.hookPath, path.join(hooks, "post-commit"));
  assert.equal(existsSync(result.hookPath), true);
  const content = readFileSync(result.hookPath, "ascii");
  assert.match(
    content,
    /node \"\$repo_root\/scripts\/local-release-pipeline\.mjs\"/,
  );
  assert.doesNotMatch(content, /\.ps1|pwsh/);
});

function guardedHookFixture(
  t,
  { configuredHooksPath, hooksLink = false } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccsm-hook-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gitDir = path.join(root, ".git");
  const hooks = path.join(gitDir, "hooks");
  mkdirSync(hooks, { recursive: true });
  const run = (_executable, args) => {
    if (args.includes("config"))
      return configuredHooksPath === undefined
        ? { status: 1, stdout: "" }
        : { status: 0, stdout: configuredHooksPath + "\n" };
    if (args.includes("--git-common-dir"))
      return { status: 0, stdout: gitDir + "\n" };
    return { status: 0, stdout: hooks + "\n" };
  };
  return { root, gitDir, hooks, run };
}

test("refuses an existing foreign hook without changing its contents", (t) => {
  const f = guardedHookFixture(t);
  const hook = path.join(f.hooks, "post-commit");
  writeFileSync(hook, "#!/bin/sh\necho user-owned\n");
  assert.throws(
    () => installLocalReleaseHook(f.root, { run: f.run }),
    /existing.*preserved|already exists/iu,
  );
  assert.equal(readFileSync(hook, "utf8"), "#!/bin/sh\necho user-owned\n");
});

for (const configuredHooksPath of ["", "../external-hooks"]) {
  test(
    "refuses configured hooksPath without writing to it: " +
      JSON.stringify(configuredHooksPath),
    (t) => {
      const f = guardedHookFixture(t, { configuredHooksPath });
      assert.throws(
        () => installLocalReleaseHook(f.root, { run: f.run }),
        /hooksPath/iu,
      );
      assert.equal(existsSync(path.join(f.hooks, "post-commit")), false);
    },
  );
}

test("idempotent hook installation preserves a matching hook", (t) => {
  const f = guardedHookFixture(t);
  const one = installLocalReleaseHook(f.root, { run: f.run });
  const content = readFileSync(one.hookPath, "utf8");
  const two = installLocalReleaseHook(f.root, { run: f.run });
  assert.equal(two.unchanged, true);
  assert.equal(readFileSync(one.hookPath, "utf8"), content);
});

test("refuses a linked hooks directory and preserves its foreign target", (t) => {
  const f = guardedHookFixture(t);
  const foreign = path.join(f.root, "foreign");
  mkdirSync(foreign);
  rmdirSync(f.hooks);
  symlinkSync(
    foreign,
    f.hooks,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => installLocalReleaseHook(f.root, { run: f.run }),
    /link|junction|reparse/iu,
  );
  assert.equal(existsSync(path.join(foreign, "post-commit")), false);
});

test("refuses a linked post-commit file instead of overwriting its target", (t) => {
  const f = guardedHookFixture(t);
  const foreign = path.join(f.root, "keep.txt");
  writeFileSync(foreign, "user-owned");
  try {
    symlinkSync(foreign, path.join(f.hooks, "post-commit"));
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM")
      return t.skip("file symlink privilege unavailable");
    throw error;
  }
  assert.throws(
    () => installLocalReleaseHook(f.root, { run: f.run }),
    /link|junction|reparse|preserved/iu,
  );
  assert.equal(readFileSync(foreign, "utf8"), "user-owned");
});
