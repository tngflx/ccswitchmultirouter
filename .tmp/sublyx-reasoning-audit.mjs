import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import ts from "typescript";
import { parse } from "smol-toml";

const root = process.cwd();
const contract = JSON.parse(
  await readFile(path.join(root, "src/config/codexCatalogContract.json"), "utf8"),
);
const schemaSource = await readFile(
  path.join(root, "src/lib/codexCatalogSchema.ts"),
  "utf8",
);
const schemaModule = { exports: {} };
const compiled = ts.transpileModule(schemaSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
new Function("require", "module", "exports", compiled)(
  (name) => {
    if (name === "@/config/codexCatalogContract.json") return contract;
    throw new Error("Unexpected catalog schema dependency");
  },
  schemaModule,
  schemaModule.exports,
);
const { readCodexCatalogSettings } = schemaModule.exports;
const home = os.homedir();
const configDir = path.join(home, ".cc-switch");
const db = new DatabaseSync(path.join(configDir, "cc-switch.db"), {
  readOnly: true,
});
const rows = db
  .prepare(
    "SELECT id, name, settings_config, meta, is_current FROM providers WHERE app_type = ?",
  )
  .all("codex");
const reasoning = (value) =>
  value && {
    supportedEfforts: value.supportedEfforts,
    defaultEffort: value.defaultEffort,
    supportStatus: value.supportStatus,
    controlKind: value.controlKind,
    source: value.source,
    upstreamFormat: value.upstream?.format,
    upstreamParameter: value.upstream?.parameter,
    effortMap: value.upstream?.effortMap,
    codexUltraOrchestration: value.codexUltraOrchestration,
  };
const providers = rows.map((row) => ({
  ...row,
  settings: JSON.parse(row.settings_config),
  meta: JSON.parse(row.meta || "{}"),
}));
const targets = providers.filter((provider) =>
  /sublyx/i.test(`${provider.name} ${provider.settings.config || ""}`),
);
if (process.argv.includes("--provider-metadata")) {
  for (const provider of targets.filter((row) => /sublyx/i.test(row.name))) {
    const settings = provider.settings;
    const toml = settings.config ? parse(settings.config) : {};
    const definition = toml.model_providers?.[toml.model_provider] ?? {};
    const base = new URL(
      settings.base_url ?? settings.baseURL ?? settings.baseUrl ?? definition.base_url,
    );
    if (
      !base.hostname.includes("sublyx") ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      throw new Error("Provider metadata audit requires the configured Sublyx origin");
    }
    const modelsUrl = new URL(`${base.href.replace(/\/$/, "")}/models`);
    const apiKey = settings.auth?.OPENAI_API_KEY;
    try {
      const response = await fetch(modelsUrl, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      console.log(JSON.stringify({ providerMetadataStatus: response.status }));
      if (!response.ok) continue;
      const payload = await response.json();
      console.log(
        JSON.stringify(
          {
            providerMetadata: (payload.data ?? payload.models ?? []).map((row) => ({
              id: row.id ?? row.slug,
              metadataKeys: Object.keys(row).sort(),
              levels:
                row.supported_reasoning_levels ??
                row.supported_reasoning_efforts ??
                row.supportedReasoningEfforts,
              defaultLevel:
                row.default_reasoning_level ?? row.defaultReasoningEffort,
              reasoning: reasoning(row.reasoning),
            })),
          },
          null,
          2,
        ),
      );
    } catch {
      console.log(JSON.stringify({ providerMetadataAvailable: false }));
    }
  }
}
const names = new Set();
const report = {
  providerCatalogs: targets.map((provider) => ({
    id: provider.id,
    name: provider.name,
    current: Boolean(provider.is_current),
    apiFormat: provider.meta.apiFormat,
    models: (readCodexCatalogSettings(provider.settings)?.models ?? []).map(
      (row) => {
        names.add(row.model);
        return {
          model: row.model,
          upstreamModel: row.upstreamModel ?? row.upstream_model,
          enabled: row.enabled !== false,
          reasoning: reasoning(row.reasoning),
          codexUltra: row.codexUltra,
        };
      },
    ),
  })),
};
db.close();
const codexHome = path.join(home, ".codex");
const config = parse(
  await readFile(path.join(codexHome, "config.toml"), "utf8"),
);
report.codexConfig = {
  model: config.model,
  reasoningEffort: config.model_reasoning_effort,
  modelProvider: config.model_provider,
  modelCatalog: config.model_catalog_json,
  multiAgent: config.features?.multi_agent,
  subagentVersion:
    providers.find((provider) => provider.is_current)?.settings.codexRouting
      ?.subagentVersion,
};
if (process.argv.includes("--local-catalog")) {
  const baseUrl = config.model_providers?.[config.model_provider]?.base_url;
  const base = new URL(baseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
    throw new Error("Local catalog audit only contacts the configured loopback router");
  }
  try {
    const response = await fetch(`${base.href.replace(/\/$/, "")}/models`, {
      headers: { "User-Agent": "codex-cli/0.1" },
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    report.localCatalogStatus = response.status;
    if (response.ok) {
      const payload = await response.json();
      report.localCatalog = (payload.models ?? payload.data ?? [])
        .filter((row) => /sublyx/i.test(row.slug ?? row.id ?? row.model ?? ""))
        .map((row) => ({
          model: row.slug ?? row.id ?? row.model,
          levels:
            row.supported_reasoning_levels ??
            row.supported_reasoning_efforts ??
            row.supportedReasoningEfforts,
        }));
    }
  } catch {
    report.localCatalogAvailable = false;
  }
}
for (const [key, filename] of [
  ["managedCatalog", config.model_catalog_json],
  ["modelCache", "models_cache.json"],
  ["officialBackup", "models_cache.cc-switch-backup.json"],
]) {
  if (!filename) continue;
  try {
    const fullPath = path.isAbsolute(filename)
      ? filename
      : path.join(codexHome, filename);
    const catalog = JSON.parse(await readFile(fullPath, "utf8"));
    report[key] = (catalog.models ?? [])
      .filter((row) =>
        [row.slug, row.model, row.id].some(
          (id) => id && (names.has(id) || /sublyx/i.test(id)),
        ),
      )
      .map((row) => ({
        model: row.slug ?? row.model ?? row.id,
        levels:
          row.supported_reasoning_levels ??
          row.supported_reasoning_efforts ??
          row.supportedReasoningEfforts,
        defaultLevel:
          row.default_reasoning_level ?? row.defaultReasoningEffort,
        desktopLevels: row.supportedReasoningEfforts,
        reasoning: reasoning(row.reasoning),
      }));
  } catch {
    report[key] = { available: false };
  }
}
console.log(JSON.stringify(report, null, 2));
