import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { parse } from "smol-toml";

const executable = process.argv[2];
if (!executable) throw new Error("Pass the installed Codex executable path.");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const config = parse(
  await readFile(path.join(codexHome, "config.toml"), "utf8"),
);
const provider = config.model_providers?.[config.model_provider];
const base = new URL(provider?.base_url);
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
  throw new Error("The picker audit only contacts the local router.");
}
const catalogPath = path.isAbsolute(config.model_catalog_json)
  ? config.model_catalog_json
  : path.join(codexHome, config.model_catalog_json);
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const ids = (models) =>
  models.map((model) => model.slug || model.model || model.id).filter(Boolean);
const aliases = (models) => ids(models).filter((id) => id.startsWith("ccsm-"));
const catalog = await readJson(catalogPath);
const cache = await readJson(path.join(codexHome, "models_cache.json"));
const expected = aliases(catalog.models);
if (!expected.some((id) => id.startsWith("ccsm-orch/"))) {
  throw new Error(
    "No orchestration profile is published in the managed catalog.",
  );
}
const response = await fetch(`${base.href.replace(/\/$/, "")}/models`, {
  headers: { "User-Agent": "codex-cli/0.1" },
  signal: AbortSignal.timeout(10000),
});
if (!response.ok)
  throw new Error(`Local models endpoint returned ${response.status}.`);
const local = await response.json();

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
  if (message.error)
    waiter.reject(new Error(`Codex RPC ${message.id} failed.`));
  else waiter.resolve(message.result);
});
child.stderr.on("data", () => {});
child.on("error", () => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timeout);
    waiter.reject(new Error("Could not start the installed Codex app-server."));
  }
  pending.clear();
});
const request = (id, method, params) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex RPC ${method} timed out.`));
    }, 30000);
    pending.set(id, { resolve, reject, timeout });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
try {
  await request(1, "initialize", {
    clientInfo: { name: "ccswitch_picker_audit", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(
    `${JSON.stringify({ method: "initialized", params: {} })}\n`,
  );
  const models = [];
  let cursor;
  let id = 2;
  do {
    const result = await request(id++, "model/list", { limit: 100, cursor });
    models.push(...result.data);
    cursor = result.nextCursor;
  } while (cursor);
  const surfaces = {
    managedCatalog: ids(catalog.models),
    codexCache: ids(cache.models),
    ...(Array.isArray(provider.models)
      ? { inlineConfig: ids(provider.models) }
      : {}),
    localModelsEndpoint: ids(local.data),
    installedCodexModelList: models.map((model) => model.model || model.id),
  };
  const missing = Object.fromEntries(
    Object.entries(surfaces).map(([name, inventory]) => [
      name,
      expected.filter((alias) => !inventory.includes(alias)),
    ]),
  );
  console.log(
    JSON.stringify(
      {
      expected,
      inlineConfigMode: Array.isArray(provider.models)
        ? "legacy_inline_models"
        : "catalog_pointer_only",
        missing,
        installedCodexModels: models
          .filter((model) => expected.includes(model.model || model.id))
          .map((model) => ({
            id: model.model || model.id,
            displayName: model.displayName,
            hidden: model.hidden,
          })),
      },
      null,
      2,
    ),
  );
  if (Object.values(missing).some((list) => list.length)) process.exitCode = 1;
} finally {
  lines.close();
  child.stdin.end();
  child.kill();
  for (const waiter of pending.values()) clearTimeout(waiter.timeout);
}
