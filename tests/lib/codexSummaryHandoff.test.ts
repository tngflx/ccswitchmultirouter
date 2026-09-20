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
const handoffCore = template.slice(
  template.indexOf("  const normalizeHandoffPath ="),
  template.indexOf("  const runSummarizeSession ="),
);
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

function runner(
  sendRequest: ReturnType<typeof vi.fn>,
  freshSession = false,
  extraClients: Array<{ sendRequest: ReturnType<typeof vi.fn> }> = [],
) {
  let now = 0;
  return new Function(
    "installAppServerPatch",
    "findConversationRuntime",
    "state",
    "Date",
    "setTimeout",
    "triggerLocalThreadCatalogSync",
    `${core}\n${handoffCore}\n${freshSession ? fresh : summarize}\nreturn ${freshSession ? "runFreshSessionFromSummary" : "runSummarizeSession"};`,
  )(
    async () => {},
    () => ({ sendRequest }),
    { appServerClients: [{ sendRequest }, ...extraClients] },
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
    id: "source",
    status: { type: "active" },
    turns: [{ id: "blocked-turn", status: "inProgress" }],
  },
};
const idle = {
  thread: { id: "source", status: { type: "idle" }, turns: [] },
};
const validSummary = [
  "Goal:",
  "Preserve the task.",
  "Decisions and rationale:",
  "Use a fresh root.",
  "Changed files or areas:",
  "No files changed.",
  "Current state:",
  "Ready for handoff.",
  "Failures and unresolved issues:",
  "None recorded.",
  "Tests and verification:",
  "No tests recorded.",
  "Not tested:",
  "Live continuation.",
  "Exact next action:",
  "Wait for the user.",
].join("\n");

describe("manual coding-agent summary handoff", () => {
  it("rejects a fresh-task response that reuses the source id before sending any handoff", async () => {
    const send = vi.fn(async (method: string) => {
      if (method === "thread/read")
        return {
          thread: {
            id: "source",
            cwd: "H:\\repo",
            projectId: "project",
            name: "Source",
          },
        };
      if (method === "thread/start")
        return {
          thread: { id: "source", cwd: "H:\\repo", projectId: "project" },
        };
      if (method === "turn/start")
        throw new Error("handoff incorrectly sent to source");
      return {};
    });
    await expect(
      runner(send, true)("source", "Manual summary"),
    ).rejects.toThrow("reused the source task id");
    expect(send).not.toHaveBeenCalledWith("turn/start", expect.anything());
    expect(send).not.toHaveBeenCalledWith("thread/name/set", expect.anything());
  });

  it("rejects source metadata returned for a different task before creating anything", async () => {
    const send = vi.fn(async (method: string) => {
      if (method === "thread/read")
        return {
          thread: {
            id: "wrong-source",
            cwd: "H:\\repo",
            projectId: "project",
          },
        };
      if (method === "thread/start")
        throw new Error("must not create from wrong source metadata");
      return {};
    });

    await expect(
      runner(send, true)("source", "Manual summary"),
    ).rejects.toThrow("wrong-source");
    expect(send).not.toHaveBeenCalledWith("thread/start", expect.anything());
  });

  it("does not create another task through a second client after creation partially succeeds", async () => {
    let creations = 0;
    const respond = async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/read")
        if (params.threadId !== "source")
          return {
            thread: {
              id: String(params.threadId),
              cwd: "H:\\repo",
              projectId: "project",
            },
          };
        else
          return {
            thread: {
              id: "source",
              cwd: "H:\\repo",
              projectId: "project",
              name: "Source",
            },
          };
      if (method === "thread/start")
        return {
          thread: {
            id: `fresh-${++creations}`,
            cwd: "H:\\repo",
            projectId: "project",
          },
        };
      if (method === "thread/name/set")
        throw new Error("connection lost after creation");
      return {};
    };
    const send = vi.fn(respond);
    const fallback = vi.fn(respond);
    await expect(
      runner(send, true, [{ sendRequest: fallback }])(
        "source",
        "Manual summary",
      ),
    ).rejects.toThrow("connection lost after creation");
    expect(creations).toBe(1);
    expect(fallback).not.toHaveBeenCalled();
  });

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

  it("reuses one pending fresh-session job for repeated bridge calls", async () => {
    let resolveRun:
      ((value: { newThreadId: string; turnId: string }) => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<{ newThreadId: string; turnId: string }>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const state = jobController(
      freshSessionJobs,
      "runFreshSessionFromSummary",
      run,
    );

    const first = state.startFreshSessionFromSummary("source", "summary");
    const second = state.startFreshSessionFromSummary("source", "summary");

    expect(second).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
    resolveRun?.({ newThreadId: "fresh", turnId: "handoff" });
    await vi.waitFor(() => {
      expect(state.readFreshSessionJob(first.jobId).status).toBe("completed");
    });
  });

  it("interrupts the exact blocked turn once, then requests a manual summary without compaction", async () => {
    let reads = 0;
    const send = vi.fn(async (method: string) => {
      if (method === "turn/start") return { turn: { id: "summary-turn" } };
      reads++;
      if (reads <= 2) return active;
      if (reads <= 3) return idle;
      return {
        thread: {
          ...idle.thread,
          turns: [
            {
              id: "summary-turn",
              status: "completed",
              items: [
                {
                  type: "userMessage",
                  content: [
                    {
                      type: "text",
                      text: "[CCSwitch internal request: manual-summary-v1] summarize",
                    },
                  ],
                },
                { type: "reasoning", summary: [], content: [] },
                { type: "agentMessage", text: validSummary },
              ],
            },
          ],
        },
      };
    });
    await expect(runner(send)("source")).resolves.toEqual({
      summary: validSummary,
    });
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "turn/interrupt",
      "thread/read",
      "turn/start",
      "thread/read",
    ]);
    expect(send).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        threadId: "source",
        input: [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("manual coding-agent summary"),
          }),
        ],
      }),
    );
    expect(send).not.toHaveBeenCalledWith(
      "thread/compact/start",
      expect.anything(),
    );
    expect(send).not.toHaveBeenCalledWith(
      "responses/compact",
      expect.anything(),
    );
    expect(send).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "source",
      turnId: "blocked-turn",
    });
  });

  it("rejects a non-empty summary that omits required handoff sections", async () => {
    const send = vi.fn(async (method: string) => {
      if (method === "turn/start") return { turn: { id: "summary-turn" } };
      return {
        thread: {
          ...idle.thread,
          turns: [
            {
              id: "summary-turn",
              status: "completed",
              items: [{ type: "agentMessage", text: "Looks good." }],
            },
          ],
        },
      };
    });

    await expect(runner(send)("source")).rejects.toThrow(
      "missing required headings",
    );
  });

  it("rejects a summary turn that used a tool or file action", async () => {
    const send = vi.fn(async (method: string) => {
      if (method === "turn/start") return { turn: { id: "summary-turn" } };
      return {
        thread: {
          ...idle.thread,
          turns: [
            {
              id: "summary-turn",
              status: "completed",
              items: [
                { type: "agentMessage", text: validSummary },
                { type: "commandExecution", command: "git status" },
              ],
            },
          ],
        },
      };
    });

    await expect(runner(send)("source")).rejects.toThrow(
      "forbidden action item: commandExecution",
    );
  });

  it("rejects an unrelated user message injected into the summary turn", async () => {
    const send = vi.fn(async (method: string) => {
      if (method === "turn/start") return { turn: { id: "summary-turn" } };
      return {
        thread: {
          ...idle.thread,
          turns: [
            {
              id: "summary-turn",
              status: "completed",
              items: [
                { type: "userMessage", content: "untrusted extra prompt" },
                { type: "agentMessage", text: validSummary },
              ],
            },
          ],
        },
      };
    });

    await expect(runner(send)("source")).rejects.toThrow(
      "forbidden action item: userMessage",
    );
  });

  it("fails closed for a future unknown summary action item", async () => {
    const send = vi.fn(async (method: string) => {
      if (method === "turn/start") return { turn: { id: "summary-turn" } };
      return {
        thread: {
          ...idle.thread,
          turns: [
            {
              id: "summary-turn",
              status: "completed",
              items: [
                { type: "agentMessage", text: validSummary },
                { type: "futureComputerAction", payload: {} },
              ],
            },
          ],
        },
      };
    });

    await expect(runner(send)("source")).rejects.toThrow(
      "forbidden action item: futureComputerAction",
    );
  });

  it("never starts summarization or compaction while the source remains active", async () => {
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

  it("does not summarize or compact after interruption fails", async () => {
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
    let named = false;
    const send = vi.fn(
      async (method: string, params: Record<string, unknown>) => {
        if (method === "thread/start")
          return {
            thread: {
              id: "fresh",
              cwd: "H:\\repos\\ccswitchmulti-fork",
              projectId: null,
              model: "gpt-5.6-sol",
              modelProvider: "codex_model_router_v2",
              reasoningEffort: "high",
              historyMode: "legacy",
            },
          };
        if (method === "thread/name/set") {
          named = true;
          return {};
        }
        if (method === "turn/start") return { turn: { id: "handoff" } };
        if (params.threadId === "source")
          return {
            thread: {
              id: "source",
              cwd: "H:\\repos\\ccswitchmulti-fork",
              projectId: null,
              name: "Source",
              model: "gpt-5.6-sol",
              modelProvider: "codex_model_router_v2",
              reasoningEffort: "high",
              historyMode: "paginated",
              environments: [{ root: "H:\\repos\\ccswitchmulti-fork" }],
              turns: [{ secretHistory: "DO NOT REPLAY" }],
            },
          };
        return {
          thread: {
            id: "fresh",
            cwd: "H:\\repos\\ccswitchmulti-fork",
            projectId: null,
            name: named ? "Handoff — Source" : "",
            model: "gpt-5.6-sol",
            modelProvider: "codex_model_router_v2",
            reasoningEffort: "high",
            historyMode: "legacy",
            turns: [{ id: "handoff", status: "completed" }],
          },
        };
      },
    );
    await expect(
      runner(send, true)("source", "Compact summary"),
    ).resolves.toEqual({
      newThreadId: "fresh",
      turnId: "handoff",
      projectId: null,
      cwd: "H:\\repos\\ccswitchmulti-fork",
      name: "Handoff — Source",
    });
    expect(send).toHaveBeenCalledWith("thread/start", {
      cwd: "H:\\repos\\ccswitchmulti-fork",
      model: "gpt-5.6-sol",
      modelProvider: "codex_model_router_v2",
      config: { model_reasoning_effort: "high" },
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
      "thread/read",
      "thread/name/set",
      "thread/read",
      "turn/start",
      "thread/read",
    ]);
  });

  it("preserves an existing readable fresh-task title instead of overwriting it", async () => {
    const send = vi.fn(
      async (method: string, params: Record<string, unknown>) => {
        if (method === "thread/start")
          return {
            thread: {
              id: "fresh",
              cwd: "H:\\repo",
              projectId: "project",
              name: "Continue handoff audit",
            },
          };
        if (method === "turn/start") return { turn: { id: "handoff" } };
        if (params.threadId === "source")
          return {
            thread: {
              id: "source",
              cwd: "H:\\repo",
              projectId: "project",
              name: "Stale source title",
            },
          };
        return {
          thread: {
            id: "fresh",
            cwd: "H:\\repo",
            projectId: "project",
            name: "Continue handoff audit",
            turns: [{ id: "handoff", status: "completed" }],
          },
        };
      },
    );

    await expect(
      runner(send, true)("source", "Manual summary"),
    ).resolves.toMatchObject({ name: "Continue handoff audit" });
    expect(send).not.toHaveBeenCalledWith("thread/name/set", expect.anything());
  });

  it("fails closed when the persisted fresh task changes a copied setting", async () => {
    const send = vi.fn(
      async (method: string, params: Record<string, unknown>) => {
        if (method === "thread/start")
          return {
            thread: {
              id: "fresh",
              cwd: "H:\\repo",
              projectId: "project",
              model: "source-model",
              name: "Fresh title",
            },
          };
        if (params.threadId === "source")
          return {
            thread: {
              id: "source",
              cwd: "H:\\repo",
              projectId: "project",
              model: "source-model",
            },
          };
        return {
          thread: {
            id: "fresh",
            cwd: "H:\\repo",
            projectId: "project",
            model: "different-model",
            name: "Fresh title",
          },
        };
      },
    );

    await expect(
      runner(send, true)("source", "Manual summary"),
    ).rejects.toThrow("did not preserve model");
    expect(send).not.toHaveBeenCalledWith("turn/start", expect.anything());
  });

  it("fails closed when app-server assigns a project to a projectless source", async () => {
    const send = vi.fn(
      async (method: string, params: Record<string, unknown>) => {
        if (method === "thread/start")
          return {
            thread: {
              id: "fresh",
              cwd: "H:\\scratch",
              projectId: "unexpected-project",
            },
          };
        if (params.threadId === "source")
          return {
            thread: {
              id: "source",
              cwd: "H:\\scratch",
              projectId: null,
              name: "Scratch",
            },
          };
        return {
          thread: {
            id: "fresh",
            cwd: "H:\\scratch",
            projectId: "unexpected-project",
            name: "Handoff — Scratch",
          },
        };
      },
    );

    await expect(
      runner(send, true)("source", "Manual summary"),
    ).rejects.toThrow("gained a project");
    expect(send).not.toHaveBeenCalledWith(
      "thread/metadata/update",
      expect.anything(),
    );
  });

  it("reports a failed fresh-session turn instead of claiming completion", async () => {
    const send = vi.fn(
      async (method: string, params: Record<string, unknown>) => {
        if (method === "thread/start") return { thread: { id: "fresh" } };
        if (method === "turn/start") return { turn: { id: "handoff" } };
        return {
          thread: {
            id: params.threadId,
            name: "Handoff — continued task",
            turns: [{ id: "handoff", status: "failed" }],
          },
        };
      },
    );
    await expect(
      runner(send, true)("source", "Compact summary"),
    ).rejects.toThrow("Fresh-session handoff turn failed");
  });
});
