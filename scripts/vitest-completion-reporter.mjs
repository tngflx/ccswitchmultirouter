import { writeFile } from "node:fs/promises";

/** Deliberately stores only counts/paths, never assertion payloads or error text. */
export function summarizeFile(file) {
  const summary = {
    path: file.filepath,
    state: file.result?.state ?? file.mode ?? "incomplete",
    total: 0,
    passed: 0,
    skipped: 0,
    todo: 0,
    failed: 0,
    unfinished: 0,
  };
  let incompleteSuite = false;
  let failedSuite = false;
  function visit(task, inheritedMode) {
    const mode =
      inheritedMode ??
      (task.mode === "skip" || task.mode === "todo" ? task.mode : undefined);
    if (task.type === "test" || task.type === "custom") {
      summary.total++;
      if (mode === "todo") summary.todo++;
      else if (mode === "skip" || task.result?.state === "skip")
        summary.skipped++;
      else if (task.result?.state === "pass") summary.passed++;
      else if (task.result?.state === "fail") summary.failed++;
      else summary.unfinished++;
    } else {
      if (!mode) {
        if (task.result?.state === "fail") failedSuite = true;
        else if (task.result?.state !== "pass") incompleteSuite = true;
      }
      for (const child of task.tasks ?? []) visit(child, mode);
    }
  }
  visit(file);
  if (failedSuite) summary.state = "fail";
  else if (incompleteSuite) summary.state = "incomplete";
  return summary;
}

export default class CompletionReporter {
  constructor(options = {}) {
    this.reportPath =
      options.reportPath ?? process.env.CCSM_VITEST_COMPLETION_FILE;
    this.runId = options.runId ?? process.env.CCSM_VITEST_RUN_ID;
    this.pathsCollected = false;
    this.expectedFiles = [];
  }
  onInit(ctx) {
    this.ctx = ctx;
  }
  onPathsCollected(paths) {
    this.pathsCollected = Array.isArray(paths);
    this.expectedFiles = paths ?? [];
  }
  async onFinished(files = [], errors = []) {
    if (!this.reportPath || !this.runId)
      throw new Error("Verified test runner completion destination is missing");
    await writeFile(
      this.reportPath,
      JSON.stringify({
        version: 1,
        runId: this.runId,
        pathsCollected: this.pathsCollected,
        expectedFiles: this.expectedFiles,
        files: files.map(summarizeFile),
        unhandledErrors: Math.max(
          errors.length,
          this.ctx?.state.getUnhandledErrors().length ?? 0,
        ),
        cancelled: Boolean(this.ctx?.isCancelling),
      }),
      "utf8",
    );
  }
}
