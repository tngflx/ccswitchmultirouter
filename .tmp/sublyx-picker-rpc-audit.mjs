import { spawn } from "node:child_process";
import readline from "node:readline";

const executable = process.argv[2];
if (!executable) throw new Error("Pass the running Codex app-server executable.");
const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map();
const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timeout);
  if (message.error) waiter.reject(new Error("Read-only model-list RPC failed"));
  else waiter.resolve(message.result);
});
child.stderr.on("data", () => {});
child.on("error", () => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timeout);
    waiter.reject(new Error("Cannot start read-only Codex model-list audit"));
  }
  pending.clear();
});
const request = (id, method, params) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Read-only ${method} timed out`));
    }, 30000);
    pending.set(id, { resolve, reject, timeout });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
try {
  await request(1, "initialize", {
    clientInfo: { name: "ccswitch_sublyx_reasoning_audit", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  const models = [];
  let cursor;
  let id = 2;
  do {
    const result = await request(id++, "model/list", { limit: 100, cursor });
    models.push(...result.data);
    cursor = result.nextCursor;
  } while (cursor);
  console.log(
    JSON.stringify(
      {
        installedAppServerModels: models
          .filter((model) => /sublyx/i.test(model.model || model.id))
          .map((model) => ({
            id: model.model || model.id,
            hidden: model.hidden,
            supportedReasoningEfforts: model.supportedReasoningEfforts,
            defaultReasoningEffort: model.defaultReasoningEffort,
          })),
      },
      null,
      2,
    ),
  );
} finally {
  lines.close();
  child.stdin.end();
  child.kill();
  for (const waiter of pending.values()) clearTimeout(waiter.timeout);
}
