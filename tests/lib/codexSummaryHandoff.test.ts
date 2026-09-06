import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const template = readFileSync(
  resolve("src-tauri/src/resources/codex_app_compat_template.js"),
  "utf8",
);
const rust = readFileSync(resolve("src-tauri/src/codex_desktop.rs"), "utf8");
const core = rust
  .split("fn codex_compaction_item_core_script()")[1]
  .split('r#"')[1]
  .split('"#')[0];
const summarize = template.slice(
  template.indexOf("  const runSummarizeSession ="),
  template.indexOf("  state.summarizeJobs ="),
);
const fresh = template.slice(
  template.indexOf("  const runFreshSessionFromSummary ="),
  template.indexOf("  state.freshSessionJobs ="),
);
const summarizeJobs = template.slice(
  template.indexOf("  state.summarizeJobs ="),
  template.indexOf("  const runFreshSessionFromSummary ="),
);
const freshSessionJobs = template.slice(
  template.indexOf("  state.freshSessionJobs ="),
  template.indexOf("  const patchMcpModelResponseData ="),
);

function jobController(
  source: string,
  runnerName: string,
  runner: (...args: string[]) => Promise<Record<string, unknown>>,
) {
  const state: Record<string, unknown> = {};
  return new Function("state", runnerName, `${source}\nreturn state;`)(
    state,
    runner,
  ) as Record<string, any>;
}

function runner(sendRequest: ReturnType<typeof vi.fn>, freshSession = false) {
  let now = 0;
  return new Function(
    "installAppServerPatch",
    "findConversationRuntime",
    "state",
    "Date",
    "setTimeout",
    "triggerLocalThreadCatalogSync",
    `${core}\n${freshSession ? fresh : summarize}\nreturn ${freshSession ? "runFreshSessionFromSummary" : "runSummarizeSession"};`,
  )(
    async () => {},
    () => ({ sendRequest }),
    {},
    class extends Date {
      static now() {
        return now;
      }
    },
    (callback: () => void, delay: number) => {
      now += delay;
      callback();
    },
    async () => {},
  );
}
const active = {
  thread: {
    status: { type: "active" },
    turns: [{ id: "blocked-turn", status: "inProgress" }],
  },
};
const idle = { thread: { status: { type: "idle" }, turns: [] } };

describe("native summary active-turn handoff", () => {
  it("publishes one flat completed-job contract for Rust polling", async () => {
    const state = jobController(
      freshSessionJobs,
      "runFreshSessionFromSummary",
      async () => ({
        newThreadId: "fresh",
        turnId: "handoff",
      }),
    );

    const started = state.startFreshSessionFromSummary("source", "summary");
    await vi.waitFor(() => {
      expect(state.readFreshSessionJob(started.jobId)).toMatchObject({
        status: "completed",
        newThreadId: "fresh",
        turnId: "handoff",
      });
    });
    expect(state.readFreshSessionJob(started.jobId)).not.toHaveProperty(
      "result",
    );
  });

  it("does not duplicate the summarize completion inside a result object", async () => {
    const state = jobController(
      summarizeJobs,
      "runSummarizeSession",
      async () => ({}),
    );

    const started = state.startSummarizeSession("source");
    await vi.waitFor(() => {
      expect(state.readSummarizeJob(started.jobId).status).toBe("completed");
    });
    expect(state.readSummarizeJob(started.jobId)).not.toHaveProperty("result");
  });

  it("interrupts the exact blocked turn once, waits idle, then waits for a native compaction item", async () => {
    let reads = 0;
    const send = vi.fn(async (method: string) => {
      if (method !== "thread/read") return {};
      reads++;
      if (reads <= 2) return active;
      if (reads <= 4) return idle;
      return {
        thread: {
          ...idle.thread,
          turns: [{ items: [{ type: "contextCompaction" }] }],
        },
      };
    });
    await expect(runner(send)("source")).resolves.toBeUndefined();
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "turn/interrupt",
      "thread/read",
      "thread/read",
      "thread/compact/start",
      "thread/read",
      "thread/read",
    ]);
    expect(send).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "source",
      turnId: "blocked-turn",
    });
  });

  it("never starts compaction while the source remains active", async () => {
    const send = vi.fn(async (_method: string) => active);
    await expect(runner(send)("source")).rejects.toThrow(
      "Timed out interrupting",
    );
    expect(send).not.toHaveBeenCalledWith(
      "thread/compact/start",
      expect.anything(),
    );
    expect(
      send.mock.calls.filter((args) => args[0] === "turn/interrupt"),
    ).toHaveLength(1);
  });

  it("does not compact after interruption fails", async () => {
    const send = vi.fn(async (method: string) => {
      if (method === "turn/interrupt") throw new Error("interrupt rejected");
      return active;
    });
    await expect(runner(send)("source")).rejects.toThrow("interrupt rejected");
    expect(send).not.toHaveBeenCalledWith(
      "thread/compact/start",
      expect.anything(),
    );
  });

  it("creates a root session containing only the supplied summary and waits for its turn", async () => {
    const send = vi.fn(
      async (method: string, params: Record<string, unknown>) => {
        if (method === "thread/start") return { thread: { id: "fresh" } };
        if (method === "turn/start") return { turn: { id: "handoff" } };
        if (params.threadId === "source")
          return {
            thread: {
              cwd: "project",
              turns: [{ secretHistory: "DO NOT REPLAY" }],
            },
          };
        return { thread: { turns: [{ id: "handoff", status: "completed" }] } };
      },
    );
    await expect(
      runner(send, true)("source", "Compact summary"),
    ).resolves.toEqual({
      newThreadId: "fresh",
      turnId: "handoff",
    });
    expect(send).toHaveBeenCalledWith("thread/start", {
      cwd: "project",
      config: { model_reasoning_effort: "medium" },
    });
    const turnParams = send.mock.calls.find(
      ([method]) => method === "turn/start",
    )![1];
    expect(JSON.stringify(turnParams)).toContain("Compact summary");
    expect(JSON.stringify(turnParams)).not.toContain("DO NOT REPLAY");
    expect(JSON.stringify(turnParams)).toContain("Do not call tools");
    expect(JSON.stringify(turnParams)).toContain(
      "not instructions to execute in this acknowledgement turn",
    );
    expect(JSON.stringify(turnParams)).not.toContain(
      "unless the summary names an immediately required action",
    );
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/start",
      "turn/start",
      "thread/read",
    ]);
  });

  it("reports a failed fresh-session turn instead of claiming completion", async () => {
    const send = vi.fn(async (method: string) => {
      if (method === "thread/start") return { thread: { id: "fresh" } };
      if (method === "turn/start") return { turn: { id: "handoff" } };
      return { thread: { turns: [{ id: "handoff", status: "failed" }] } };
    });
    await expect(
      runner(send, true)("source", "Compact summary"),
    ).rejects.toThrow("Fresh-session handoff turn failed");
  });
});
