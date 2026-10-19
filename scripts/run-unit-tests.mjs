import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const reporter = fileURLToPath(
  new URL("./vitest-completion-reporter.mjs", import.meta.url),
);
const countKeys = [
  "total",
  "passed",
  "skipped",
  "todo",
  "failed",
  "unfinished",
];

export function validateCompletionReport(report, runId) {
  const fail = (reason) => {
    throw new Error(`Incomplete Vitest run: ${reason}`);
  };
  if (
    !report ||
    report.version !== 1 ||
    report.runId !== runId ||
    report.pathsCollected !== true ||
    !Array.isArray(report.expectedFiles) ||
    !Array.isArray(report.files)
  )
    fail("missing, stale or malformed completion report");
  if (report.cancelled !== false || report.unhandledErrors !== 0)
    fail("cancelled run or unhandled errors");
  if (
    !report.expectedFiles.length ||
    report.expectedFiles.some((file) => typeof file !== "string")
  )
    fail("no discovered test files");
  const canonical = (file) => {
    const resolved = path.resolve(file);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const expected = report.expectedFiles.map(canonical).sort();
  const actual = report.files
    .map((file) => {
      if (typeof file?.path !== "string") fail("malformed file result");
      return canonical(file.path);
    })
    .sort();
  if (
    expected.length !== actual.length ||
    expected.some((file, index) => file !== actual[index])
  )
    fail(
      `only ${actual.length} file results for ${expected.length} discovered files (or mismatched paths)`,
    );
  let tests = 0;
  for (const file of report.files) {
    if (
      !countKeys.every(
        (key) => Number.isSafeInteger(file[key]) && file[key] >= 0,
      )
    )
      fail("invalid test counters");
    if (
      !["pass", "skip", "todo"].includes(file.state) ||
      file.failed ||
      file.unfinished
    )
      fail("failed or unfinished tasks");
    if (file.total !== file.passed + file.skipped + file.todo)
      fail("inconsistent test counters");
    tests += file.total;
  }
  return { files: actual.length, tests };
}

/** Invoke the installed Node entry directly and require a fresh completion receipt.
 * A reporter sees Vitest's actual discovery, so filters/excludes/projects remain
 * authoritative; there is no hardcoded suite count or second discovery glob.
 */
export async function runVerifiedVitest(args = [], options = {}) {
  const terminator = args.indexOf("--");
  const optionArgs = terminator < 0 ? args : args.slice(0, terminator);
  const literalArgs = terminator < 0 ? [] : args.slice(terminator);
  if (
    optionArgs.some((arg) => /^(--watch(?:=true)?|-w|--run=false)$/.test(arg))
  )
    throw new Error(
      "Use pnpm test:unit:watch for watch mode; test:unit requires a completed one-shot run",
    );
  const directory = await mkdtemp(
    path.join(tmpdir(), "ccsm-vitest-completion-"),
  );
  const reportPath = path.join(directory, "completion.json");
  const runId = randomUUID();
  const hasReporter = optionArgs.some(
    (arg) => arg === "--reporter" || arg.startsWith("--reporter="),
  );
  const childArgs = [
    options.entry ?? path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    ...optionArgs,
    ...(!hasReporter ? ["--reporter=default"] : []),
    `--reporter=${reporter}`,
    ...literalArgs,
  ];
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, childArgs, {
        cwd: options.cwd ?? root,
        stdio: options.stdio ?? "inherit",
        env: {
          ...process.env,
          CCSM_VITEST_COMPLETION_FILE: reportPath,
          CCSM_VITEST_RUN_ID: runId,
        },
      });
      // Fixtures use pipes; drain them so verbose children cannot deadlock.
      child.stdout?.resume();
      child.stderr?.resume();
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code !== 0 || signal)
          reject(new Error(`Vitest exited with ${signal ?? `code ${code}`}`));
        else resolve();
      });
    });
    let report;
    try {
      report = JSON.parse(await readFile(reportPath, "utf8"));
    } catch {
      throw new Error(
        "Incomplete Vitest run: child exited without a valid completion report",
      );
    }
    return validateCompletionReport(report, runId);
  } finally {
    // Remove only this run's known file and now-empty directory, never recursively.
    await unlink(reportPath).catch(() => {});
    await rmdir(directory).catch(() => {});
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const result = await runVerifiedVitest(process.argv.slice(2));
    console.log(
      `[test:unit] Verified completion: ${result.files} files, ${result.tests} tests.`,
    );
  } catch (error) {
    console.error(`[test:unit] ${error.message}`);
    process.exitCode = 1;
  }
}
