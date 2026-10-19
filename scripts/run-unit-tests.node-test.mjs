import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runVerifiedVitest,
  validateCompletionReport,
} from "./run-unit-tests.mjs";
import CompletionReporter, {
  summarizeFile,
} from "./vitest-completion-reporter.mjs";

function report(overrides = {}) {
  return {
    version: 1,
    runId: "current-run",
    pathsCollected: true,
    expectedFiles: ["a.test.ts"],
    files: [
      {
        path: "a.test.ts",
        state: "pass",
        total: 1,
        passed: 1,
        skipped: 0,
        todo: 0,
        failed: 0,
        unfinished: 0,
      },
    ],
    unhandledErrors: 0,
    cancelled: false,
    ...overrides,
  };
}
test("a complete report passes; missing, stale, failed and incomplete reports do not", () => {
  assert.deepEqual(validateCompletionReport(report(), "current-run"), {
    files: 1,
    tests: 1,
  });
  for (const invalid of [
    null,
    {},
    report({ runId: "old-run" }),
    report({ pathsCollected: false }),
    report({ files: [] }),
    report({ expectedFiles: [] }),
    report({ expectedFiles: ["a.test.ts", "b.test.ts"] }),
    report({ unhandledErrors: 1 }),
    report({ cancelled: true }),
    report({ files: [report().files[0], report().files[0]] }),
    report({ files: [{ ...report().files[0], state: "run" }] }),
    report({ files: [{ ...report().files[0], failed: 1 }] }),
    report({ files: [{ ...report().files[0], unfinished: 1 }] }),
    report({ files: [{ ...report().files[0], total: 2 }] }),
  ]) {
    assert.throws(() => validateCompletionReport(invalid, "current-run"));
  }
});
test("task summarization rejects unfinished runnable tasks and respects intentional skips/todos", () => {
  const file = {
    filepath: "a.test.ts",
    type: "suite",
    mode: "run",
    result: { state: "pass" },
    tasks: [
      { type: "test", mode: "run", result: { state: "pass" } },
      { type: "test", mode: "skip" },
      { type: "test", mode: "todo" },
      { type: "suite", mode: "skip", tasks: [{ type: "test", mode: "run" }] },
    ],
  };
  assert.deepEqual(summarizeFile(file), {
    path: "a.test.ts",
    state: "pass",
    total: 4,
    passed: 1,
    skipped: 2,
    todo: 1,
    failed: 0,
    unfinished: 0,
  });
  file.tasks.push({ type: "test", mode: "run" });
  assert.equal(summarizeFile(file).unfinished, 1);
  file.tasks.push({
    type: "suite",
    mode: "run",
    result: { state: "run" },
    tasks: [],
  });
  assert.notEqual(summarizeFile(file).state, "pass");
});
test("reporter captures actual discovered paths, unhandled errors and cancellation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ccsm-reporter-test-"));
  try {
    const file = path.join(dir, "result.json");
    const reporter = new CompletionReporter({
      reportPath: file,
      runId: "current-run",
    });
    reporter.onInit({
      isCancelling: true,
      state: { getUnhandledErrors: () => [new Error("redacted")] },
    });
    reporter.onPathsCollected(["a.test.ts", "b.test.ts"]);
    await reporter.onFinished(
      [
        {
          filepath: "a.test.ts",
          type: "suite",
          result: { state: "pass" },
          tasks: [],
        },
      ],
      [],
    );
    const result = JSON.parse(await readFile(file, "utf8"));
    assert.equal(result.cancelled, true);
    assert.equal(result.unhandledErrors, 1);
    assert.throws(() => validateCompletionReport(result, "current-run"));
    assert.ok(!(await readFile(file, "utf8")).includes("redacted"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
for (const scenario of [
  "valid",
  "missing",
  "stale",
  "malformed",
  "partial",
  "failed",
  "nonzero",
  "signal",
]) {
  test(`child process ${scenario} cannot produce a false green`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ccsm-runner-test-"));
    try {
      const fixture = path.join(dir, "fake-vitest.mjs");
      const argsFile = path.join(dir, "args.json");
      await writeFile(
        fixture,
        `import fs from "node:fs";
        fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
        const report = ${JSON.stringify(report())};
        report.runId = process.env.CCSM_VITEST_RUN_ID;
        if (${JSON.stringify(scenario)} === "stale") report.runId = "old-run";
        if (${JSON.stringify(scenario)} === "partial") report.expectedFiles.push("b.test.ts");
        if (${JSON.stringify(scenario)} === "failed") report.files[0].failed = 1;
        if (${JSON.stringify(scenario)} !== "missing") fs.writeFileSync(process.env.CCSM_VITEST_COMPLETION_FILE, ${JSON.stringify(scenario)} === "malformed" ? "{" : JSON.stringify(report));
        if (${JSON.stringify(scenario)} === "nonzero") process.exitCode = 7;
        if (${JSON.stringify(scenario)} === "signal") process.kill(process.pid, "SIGTERM");
      `,
      );
      const run = runVerifiedVitest(
        [
          "a.test.ts",
          "--maxWorkers=2",
          "--reporter=json",
          "--outputFile=custom.json",
        ],
        { entry: fixture, stdio: "pipe" },
      );
      if (scenario === "valid") {
        assert.deepEqual(await run, { files: 1, tests: 1 });
      } else {
        await assert.rejects(run);
      }
      const forwarded = JSON.parse(await readFile(argsFile, "utf8"));
      assert.deepEqual(forwarded.slice(0, 5), [
        "run",
        "a.test.ts",
        "--maxWorkers=2",
        "--reporter=json",
        "--outputFile=custom.json",
      ]);
      assert.ok(
        forwarded.some((arg) => arg.includes("vitest-completion-reporter.mjs")),
      );
      assert.ok(!forwarded.includes("--reporter=default"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
test("the argument terminator preserves filters without disabling the completion reporter", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ccsm-terminator-test-"));
  try {
    const fixture = path.join(dir, "fake-vitest.mjs");
    const argsFile = path.join(dir, "args.json");
    await writeFile(
      fixture,
      `import fs from "node:fs";
      fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
      fs.writeFileSync(process.env.CCSM_VITEST_COMPLETION_FILE, JSON.stringify({ ...${JSON.stringify(report())}, runId: process.env.CCSM_VITEST_RUN_ID }));
    `,
    );
    await runVerifiedVitest(["--", "--watch"], {
      entry: fixture,
      stdio: "pipe",
    });
    const forwarded = JSON.parse(await readFile(argsFile, "utf8"));
    assert.deepEqual(forwarded.slice(-2), ["--", "--watch"]);
    assert.ok(
      forwarded.indexOf("--reporter=default") < forwarded.indexOf("--"),
    );
    assert.ok(
      forwarded.findIndex((arg) =>
        arg.includes("vitest-completion-reporter.mjs"),
      ) < forwarded.indexOf("--"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup errors and watch mode are not reported as successful one-shot runs", async () => {
  await assert.rejects(
    runVerifiedVitest([], { entry: "does-not-exist.mjs", stdio: "pipe" }),
  );
  await assert.rejects(runVerifiedVitest(["--watch"]), /test:unit:watch/);
});
