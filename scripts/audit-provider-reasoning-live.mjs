import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { parse } from "smol-toml";

// Explicit live-provider audit. It never writes provider state, credentials,
// raw responses, or generated client configuration.
const root = process.cwd();
const followup = process.argv.includes("--followup");
const outputPath = path.join(
  root,
  followup
    ? "docs/audits/2026-11-13-provider-reasoning-followup.json"
    : "docs/audits/2026-11-13-provider-reasoning-live.json",
);
const execute = process.argv.includes("--execute");
const concurrency = followup ? 1 : 2;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function expandHome(value) {
  const trimmed = nonEmptyString(value);
  if (!trimmed) return undefined;
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~\\") || trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function appDataCandidates() {
  const identifier = "com.ccswitchmulti.desktop";
  const candidates = [];
  if (process.platform === "win32") {
    const base =
      nonEmptyString(process.env.APPDATA) ||
      path.join(os.homedir(), "AppData", "Roaming");
    candidates.push(path.join(base, identifier));
  } else if (process.platform === "darwin") {
    candidates.push(
      path.join(os.homedir(), "Library", "Application Support", identifier),
    );
  } else {
    const base =
      nonEmptyString(process.env.XDG_DATA_HOME) ||
      path.join(os.homedir(), ".local", "share");
    candidates.push(path.join(base, identifier));
  }
  return [...new Set(candidates.map(expandHome).filter(Boolean))];
}

async function readAppConfigDirOverride() {
  for (const appDataDir of appDataCandidates()) {
    try {
      const store = JSON.parse(
        await readFile(path.join(appDataDir, "app_paths.json"), "utf8"),
      );
      const configured = expandHome(store?.app_config_dir_override);
      if (configured && (await stat(configured)).isDirectory())
        return configured;
    } catch {
      // An unavailable or malformed store is equivalent to no override. Do
      // not expose its path or parser details in audit diagnostics.
    }
  }
  return undefined;
}

async function databaseDirectory() {
  const configuredDir = await readAppConfigDirOverride();
  if (configuredDir) return configuredDir;
  const testHome = nonEmptyString(process.env.CC_SWITCH_TEST_HOME);
  const defaultDir = path.join(testHome || os.homedir(), ".cc-switch");
  if (process.platform === "win32" && !testHome) {
    try {
      await stat(path.join(defaultDir, "cc-switch.db"));
    } catch {
      const legacyHome = nonEmptyString(process.env.HOME);
      if (legacyHome) {
        const legacyDir = path.join(legacyHome, ".cc-switch");
        try {
          if ((await stat(path.join(legacyDir, "cc-switch.db"))).isFile())
            return legacyDir;
        } catch {}
      }
    }
  }
  return defaultDir;
}

const databasePath = path.join(await databaseDirectory(), "cc-switch.db");
const python = spawnSync(
  "python",
  [
    "-c",
    "import sqlite3,json,sys,pathlib; c=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True); print(json.dumps([dict(zip(('id','name','settings'),r)) for r in c.execute(\"select id,name,settings_config from providers where app_type='codex' and name in ('OpenRouter','Sublyx')\")])); c.close()",
    databasePath,
  ],
  { windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
);
if (python.status !== 0 || python.error) {
  throw new Error("Could not read configured providers.");
}
let storedProviders;
try {
  storedProviders = JSON.parse(python.stdout);
} catch {
  throw new Error("Could not parse configured providers.");
}

// Use the repository's authority helper, including canonical-empty semantics.
const authoritySource = await readFile(
  path.join(root, "src/lib/codexCatalogSchema.ts"),
  "utf8",
);
const contract = JSON.parse(
  await readFile(
    path.join(root, "src/config/codexCatalogContract.json"),
    "utf8",
  ),
);
const compiled = ts.transpileModule(authoritySource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const authorityModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  (name) => {
    if (name === "@/config/codexCatalogContract.json") return contract;
    throw new Error("Unexpected catalog helper dependency.");
  },
  authorityModule,
  authorityModule.exports,
);
const { readCodexCatalogSettings } = authorityModule.exports;
const providers = storedProviders.map((stored) => {
  let settings;
  try {
    settings = JSON.parse(stored.settings);
  } catch {
    throw new Error("A scoped provider has invalid stored settings.");
  }
  let config = {};
  if (typeof settings.config === "string" && settings.config.trim()) {
    try {
      config = parse(
        settings.config.replace(/[“”„‟＂]/g, '"').replace(/[‘’＇]/g, "'"),
      );
    } catch {
      throw new Error("A scoped provider has invalid TOML settings.");
    }
  }
  const selected = config.model_providers?.[config.model_provider] || {};
  const endpointFrom = (value) =>
    nonEmptyString(value?.base_url) ||
    nonEmptyString(value?.baseURL) ||
    nonEmptyString(value?.baseUrl);
  const configuredBase =
    endpointFrom(settings) ||
    (!config.model_provider || config.model_provider === "openai"
      ? nonEmptyString(config.openai_base_url)
      : undefined) ||
    endpointFrom(selected) ||
    endpointFrom(config);
  let base;
  try {
    base = new URL(configuredBase);
  } catch {
    throw new Error("A scoped provider has an invalid endpoint.");
  }
  const expectedHost =
    stored.name === "OpenRouter" ? "openrouter.ai" : "api.sublyx.org";
  if (
    base.protocol !== "https:" ||
    base.hostname !== expectedHost ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error("Configured provider endpoint is outside audit scope.");
  }
  const key = settings.auth?.OPENAI_API_KEY;
  if (typeof key !== "string" || !key.trim())
    throw new Error("A scoped provider is missing its API credential.");
  const catalog = readCodexCatalogSettings(settings);
  if (!catalog) throw new Error("A scoped provider has no valid catalog.");
  return {
    name: stored.name,
    base: base.href.replace(/\/$/, ""),
    key,
    models: catalog.models.filter(
      (row) => row && typeof row === "object" && row.enabled !== false,
    ),
  };
});
if (providers.length !== 2) throw new Error("Expected exactly two providers.");
const knownEfforts = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const safeCode = (value) =>
  typeof value === "string" &&
  /^[a-zA-Z0-9_.:-]{1,64}$/.test(value) &&
  !providers.some((provider) => value.includes(provider.key))
    ? value
    : undefined;

async function request(provider, endpoint, body) {
  const started = performance.now();
  try {
    const response = await fetch(provider.base + endpoint, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${provider.key}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        "User-Agent": "ccswitchmulti-reasoning-audit/1",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      return {
        status: response.status,
        elapsedMs: Math.round(performance.now() - started),
        failure: "non_json_response",
      };
    }
    return {
      status: response.status,
      elapsedMs: Math.round(performance.now() - started),
      parsed,
    };
  } catch (error) {
    return {
      elapsedMs: Math.round(performance.now() - started),
      failure:
        error.name === "TimeoutError"
          ? "timeout"
          : "transport_or_redirect_error",
    };
  }
}

const metadata = [];
const tasks = [];
for (const provider of providers) {
  const fetched = await request(provider, "/models");
  const upstreamRows = fetched.parsed?.data;
  if (fetched.status !== 200 || !Array.isArray(upstreamRows))
    throw new Error("A scoped provider's model metadata is unavailable.");
  const upstreamById = new Map(
    Array.isArray(upstreamRows) ? upstreamRows.map((row) => [row.id, row]) : [],
  );
  metadata.push({
    provider: provider.name,
    endpoint: provider.base,
    status: fetched.status,
    failure: fetched.failure,
    upstreamModelCount: upstreamById.size,
    enabledModelCount: provider.models.length,
  });
  for (const row of provider.models) {
    const model =
      row.upstreamModel || row.upstream_model || row.model || row.id;
    if (typeof model !== "string" || !model.trim())
      throw new Error("Included catalog row has no wire model identity.");
    const upstream = upstreamById.get(model);
    const declared = upstream?.reasoning?.supported_efforts;
    const hasDeclaredEfforts = Array.isArray(declared) && declared.length > 0;
    const efforts = followup
      ? provider.name === "Sublyx"
        ? [
            "low",
            "medium",
            "high",
            ...(model === "gpt-6" ? ["xhigh", "max"] : []),
          ]
        : hasDeclaredEfforts
          ? []
          : [
              "max",
              "ultramax",
              ...(model.includes("gemma") && model.endsWith(":free")
                ? [null]
                : []),
            ]
      : provider.name === "Sublyx"
        ? ["xhigh", "max", "ultramax"]
        : hasDeclaredEfforts
          ? declared.filter((effort) => knownEfforts.has(effort))
          : [null];
    for (const effort of [...new Set(efforts)]) {
      tasks.push({
        provider,
        model,
        effort,
        endpoint:
          provider.name === "OpenRouter" ? "/chat/completions" : "/responses",
        advertised: upstream !== undefined,
        declaredEfforts: Array.isArray(declared)
          ? declared.filter((effort) => knownEfforts.has(effort))
          : null,
      });
    }
  }
}
console.log(
  JSON.stringify({
    mode: execute ? "execute" : "plan",
    scope: followup ? "remaining-effort-coverage" : "initial-matrix",
    metadataRequests: "GET /models executes in both plan and execute modes",
    providers: metadata,
    requestCount: tasks.length,
    concurrency,
    maxOutputTokensPerRequest: 16,
    excludedModels: "skipped",
  }),
);
if (!execute) process.exit(0);

const results = [];
let cursor = 0;
function classifyResult(response, task, value) {
  if (response.status >= 200 && response.status < 300 && !value?.error) {
    return task.effort && value?.reasoning?.effort === task.effort
      ? "accepted-with-echo"
      : "accepted-without-echo";
  }
  const error = value?.error;
  const message = typeof error?.message === "string" ? error.message : "";
  const referencesEffort = [error?.param, message].some(
    (text) =>
      typeof text === "string" &&
      /\breasoning effort\b/.test(
        text.toLowerCase().replace(/[^a-z0-9]+/g, " "),
      ),
  );
  // OpenRouter may use a numeric 400 code for enum validation. Inspect the
  // parameter/message only in memory: a generic 400 or unrelated invalid
  // option is not evidence that the requested effort was rejected.
  const explicitEffortEnumRejection =
    response.status === 400 &&
    Boolean(task.effort) &&
    referencesEffort &&
    /\b(?:invalid|unsupported)\s+(?:option|value|enum)\b|\bexpected\s+one\s+of\b/i.test(
      message,
    );
  if (
    explicitEffortEnumRejection ||
    (response.status >= 400 &&
      response.status < 500 &&
      response.status !== 429 &&
      [
        "invalid_value",
        "invalid_parameter",
        "invalid_request_error",
        "unsupported_value",
      ].includes(error?.code || error?.type))
  )
    return "invalid-rejected";
  return "transient-or-inconclusive";
}

async function worker() {
  while (cursor < tasks.length) {
    const task = tasks[cursor++];
    const common = {
      model: task.model,
      ...(task.effort ? { reasoning: { effort: task.effort } } : {}),
    };
    const body =
      task.provider.name === "OpenRouter"
        ? {
            ...common,
            messages: [{ role: "user", content: "Reply with OK." }],
            max_tokens: 16,
          }
        : { ...common, input: "Reply with OK.", max_output_tokens: 16 };
    const response = await request(task.provider, task.endpoint, body);
    const value = response.parsed;
    const error = value?.error;
    const usage = value?.usage;
    const result = {
      provider: task.provider.name,
      model: task.model,
      endpoint: task.endpoint,
      requestedEffort: task.effort,
      expectation:
        task.effort === "ultramax"
          ? "reject_invalid_effort"
          : followup && task.provider.name === "OpenRouter" && task.effort
            ? "observe_unadvertised_effort"
            : "accept",
      classification: classifyResult(response, task, value),
      advertised: task.advertised,
      declaredEfforts: task.declaredEfforts,
      status: response.status,
      elapsedMs: response.elapsedMs,
      failure: response.failure,
      errorType: safeCode(error?.type),
      errorCode: safeCode(error?.code),
      responseStatus: safeCode(value?.status),
      echoedEffort: knownEfforts.has(value?.reasoning?.effort)
        ? value.reasoning.effort
        : value?.reasoning?.effort === "ultramax"
          ? "ultramax"
          : undefined,
      finishReason: safeCode(value?.choices?.[0]?.finish_reason),
      reasoningOutputPresent:
        Boolean(value?.choices?.[0]?.message?.reasoning) ||
        Boolean(value?.choices?.[0]?.message?.reasoning_content) ||
        (Array.isArray(value?.output) &&
          value.output.some((output) => output?.type === "reasoning")),
      reasoningTokens:
        usage?.output_tokens_details?.reasoning_tokens ??
        usage?.completion_tokens_details?.reasoning_tokens,
      totalTokens: usage?.total_tokens,
    };
    results.push(result);
    console.log(JSON.stringify(result));
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          date: "2026-11-13",
          scope: "Configured included OpenRouter and Sublyx models only",
          limitations: [
            "Direct provider API validation; does not prove installed CCSM transform or picker behavior.",
            "HTTP acceptance and effort echo do not prove a quantitative reasoning quality difference.",
            "Sixteen output tokens can cause a valid response to end at its token limit.",
            "Accepted unadvertised efforts remain unconfirmed when the provider omits an echo or also accepts the invalid negative control.",
          ],
          providers: metadata,
          plannedRequestCount: tasks.length,
          concurrency,
          completedRequestCount: results.length,
          results,
        },
        null,
        2,
      ) + "\n",
    );
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
