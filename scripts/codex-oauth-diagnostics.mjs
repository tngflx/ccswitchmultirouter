import { assertUnlinkedDirectories } from "./release-build-config.mjs";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUTPUT_ROOT = path.join(
  SCRIPT_DIR,
  "logs",
  "codex-oauth-diagnostics",
);
export const DEFAULT_LOG_TAIL_LINES = 800;
export const DEFAULT_FOLLOW_SECONDS = 90;
export const MIN_FOLLOW_SECONDS = 0;
export const MAX_LOG_TAIL_LINES = 10_000;
export const MAX_SINCE_MINUTES = 24 * 60;
export const MAX_FOLLOW_SECONDS = 60 * 60;
// Leave room for timestamped evidence files on Windows.
export const MAX_OUTPUT_ROOT_LENGTH = 240;
export const MAX_LOG_BYTES = 16 * 1024 * 1024;
export const MAX_AUTH_BYTES = 1024 * 1024;
export const MAX_CONFIG_BYTES = 1024 * 1024;

const VALUE_OPTIONS = new Map([
  ["--output-root", "outputRoot"],
  ["-outputroot", "outputRoot"],
  ["--log-tail-lines", "logTailLines"],
  ["-logtaillines", "logTailLines"],
  ["--trace", "trace"],
  ["-trace", "trace"],
  ["--since-minutes", "sinceMinutes"],
  ["-sinceminutes", "sinceMinutes"],
  ["--follow-seconds", "followSeconds"],
  ["-followseconds", "followSeconds"],
]);
const SWITCH_OPTIONS = new Map([
  ["--follow", "follow"],
  ["-follow", "follow"],
  ["--help", "help"],
  ["-help", "help"],
  ["-?", "help"],
]);
const SENSITIVE_NAME =
  /(token|secret|password|passwd|credential|api[_-]?key|authorization|authentication|bearer|cookie|session_token|refresh|access|account[_-]?id|chatgpt[-_]?account)/iu;
const SENSITIVE_VALUE = /^(?:bearer\s+|sk-[A-Za-z0-9])/iu;
const CAPACITY_PATTERN =
  /capacity|Selected_model_is_at_capacity|Selected model is at capacity/iu;

function safeString(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`A valid ${label} is required.`);
  }
  return value;
}

function parseInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${label} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return parsed;
}

function normalizeBoundedDirectory(value, label) {
  const supplied = safeString(value, label);
  if (supplied.length > MAX_OUTPUT_ROOT_LENGTH) {
    throw new Error(`The ${label} path is too long.`);
  }
  const resolved = path.resolve(supplied);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`The ${label} must not be a filesystem root.`);
  }
  if (resolved.length > MAX_OUTPUT_ROOT_LENGTH) {
    throw new Error(`The ${label} path is too long.`);
  }
  return resolved;
}

export function parseCodexOAuthDiagnosticsArguments(argv = []) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const rawArgument = argv[index];
    const equalsIndex = rawArgument.indexOf("=");
    const argument = (
      equalsIndex === -1 ? rawArgument : rawArgument.slice(0, equalsIndex)
    ).toLowerCase();
    const key = VALUE_OPTIONS.get(argument) ?? SWITCH_OPTIONS.get(argument);
    if (!key) throw new Error("Unknown Codex OAuth diagnostics option.");
    if (Object.hasOwn(result, key)) {
      throw new Error("A Codex OAuth diagnostics option was specified twice.");
    }
    if (SWITCH_OPTIONS.has(argument)) {
      result[key] = true;
      continue;
    }
    let value =
      equalsIndex === -1 ? undefined : rawArgument.slice(equalsIndex + 1);
    if (value === undefined) {
      if (index + 1 >= argv.length) {
        throw new Error("A Codex OAuth diagnostics option requires a value.");
      }
      value = argv[++index];
    }
    result[key] = value;
  }
  return result;
}

export function normalizeCodexOAuthDiagnosticsOptions(options = {}) {
  const requestedOutputRoot = options.outputRoot;
  const outputRoot =
    typeof requestedOutputRoot === "string" && requestedOutputRoot.trim() !== ""
      ? normalizeBoundedDirectory(requestedOutputRoot, "output root")
      : DEFAULT_OUTPUT_ROOT;
  const logTailLines = parseInteger(
    options.logTailLines ?? DEFAULT_LOG_TAIL_LINES,
    "LogTailLines",
    1,
    MAX_LOG_TAIL_LINES,
  );
  const sinceMinutes = parseInteger(
    options.sinceMinutes ?? 0,
    "SinceMinutes",
    0,
    MAX_SINCE_MINUTES,
  );
  const followSeconds = parseInteger(
    options.followSeconds ?? DEFAULT_FOLLOW_SECONDS,
    "FollowSeconds",
    MIN_FOLLOW_SECONDS,
    MAX_FOLLOW_SECONDS,
  );
  let trace = options.trace ?? "";
  if (typeof trace !== "string" || /[\0\r\n]/u.test(trace)) {
    throw new Error("Trace must be a single line.");
  }
  trace = trace.trim();
  return Object.freeze({
    outputRoot,
    logTailLines,
    trace,
    sinceMinutes,
    follow: Boolean(options.follow),
    followSeconds,
  });
}

export function isSensitiveName(name) {
  return (
    typeof name === "string" && name.trim() !== "" && SENSITIVE_NAME.test(name)
  );
}

// These diagnostic artifacts are intended for sharing. Treat header containers
// as sensitive even when a custom header uses a name without a credential hint.
const SENSITIVE_CONTAINER = /(?:^|[._-])(?:headers?|credentials?)(?:$|[._-])/iu;
const REDACTED = "[redacted]";

export function redactDiagnosticText(value, { redactions = [] } = {}) {
  let text = String(value);
  // Sensitive config/auth values can be echoed in an upstream error without a
  // field name. Keep them only in this invocation's memory, never in artifacts.
  for (const secret of [...redactions]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join(REDACTED);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) text = text.split(encoded).join(REDACTED);
  }
  text = text
    .replace(
      /\b(?:Bearer|Basic)\s+[^\s"',;<>]+/giu,
      (match) => `${match.split(/\s/u)[0]} ${REDACTED}`,
    )
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, REDACTED)
    .replace(/https?:\/\/[^\s"'<>]+/giu, (candidate) => {
      try {
        const url = new URL(candidate);
        if (url.username || url.password) {
          url.username = REDACTED;
          url.password = "";
        }
        for (const key of [...url.searchParams.keys()]) {
          if (isSensitiveName(key)) url.searchParams.set(key, REDACTED);
        }
        return url.toString();
      } catch {
        return "[omitted-url]";
      }
    });
  return redactSensitiveAssignments(text);
}

function sensitiveValueEnd(text, start) {
  const first = text[start];
  if (first === '"' || first === "'") {
    let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      if (!escaped && text[index] === first) return index + 1;
      escaped = !escaped && text[index] === "\\";
    }
    return text.length;
  }
  if (first === "{" || first === "[") {
    const stack = [first];
    let quote;
    let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const current = text[index];
      if (quote) {
        if (!escaped && current === quote) quote = undefined;
        escaped = !escaped && current === "\\";
      } else if (current === '"' || current === "'") {
        quote = current;
        escaped = false;
      } else if (current === "{" || current === "[") stack.push(current);
      else if (current === "}" || current === "]") {
        const expected = current === "}" ? "{" : "[";
        if (stack.pop() !== expected) return text.length;
        if (!stack.length) return index + 1;
      }
    }
    // An incomplete header/credential container cannot be shared safely.
    return text.length;
  }
  let end = start;
  while (end < text.length && !/[\s&,;}]/u.test(text[end])) end += 1;
  return end;
}

function redactSensitiveAssignments(text) {
  // Parse quoted and nested values as a unit instead of using a regex to copy a
  // prefix of a credential/header object while accidentally preserving its tail.
  const assignment = /((?:["']?)([\w.-]+)(?:["']?)\s*[:=]\s*)/gu;
  let result = "";
  let cursor = 0;
  for (let match; (match = assignment.exec(text));) {
    if (!isSensitiveName(match[2]) && !SENSITIVE_CONTAINER.test(match[2]))
      continue;
    const valueStart = assignment.lastIndex;
    const valueEnd = sensitiveValueEnd(text, valueStart);
    result += text.slice(cursor, valueStart) + REDACTED;
    cursor = valueEnd;
    assignment.lastIndex = valueEnd;
  }
  return result + text.slice(cursor);
}

function sensitiveSummary(value, onSensitiveValue) {
  const text = String(value);
  if (typeof value === "string" && value) onSensitiveValue?.(value);
  return {
    present: true,
    length: text.length,
    sha256_prefix: createHash("sha256")
      .update(text, "utf8")
      .digest("hex")
      .slice(0, 12),
  };
}

export function protectScalarValue(
  name,
  value,
  { sensitive = false, onSensitiveValue } = {},
) {
  if (value === null || value === undefined) return value ?? null;
  if (
    sensitive ||
    isSensitiveName(name) ||
    SENSITIVE_VALUE.test(String(value))
  ) {
    return sensitiveSummary(value, onSensitiveValue);
  }
  return typeof value === "string" ? redactDiagnosticText(value) : value;
}

export function protectObjectTree(name, value, options = {}) {
  if (value === null || value === undefined) return value ?? null;
  const sensitive = Boolean(
    options.sensitive ||
    isSensitiveName(name) ||
    SENSITIVE_CONTAINER.test(name),
  );
  const nestedOptions = { ...options, sensitive };
  if (Array.isArray(value))
    return value.map((item) => protectObjectTree(name, item, nestedOptions));
  if (value instanceof Date)
    return sensitive
      ? sensitiveSummary(value, options.onSensitiveValue)
      : value;
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        protectObjectTree(key, item, nestedOptions),
      ]),
    );
  }
  return protectScalarValue(name, value, nestedOptions);
}

function protectConfigTree(name, value, options = {}) {
  const sensitive = Boolean(
    options.sensitive ||
    isSensitiveName(name) ||
    SENSITIVE_CONTAINER.test(name),
  );
  if (value instanceof Date) return sensitive ? REDACTED : value;
  if (Array.isArray(value))
    return value.map((item) =>
      protectConfigTree(name, item, { ...options, sensitive }),
    );
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        protectConfigTree(key, item, { ...options, sensitive }),
      ]),
    );
  }
  // This sentinel is not a credential and is useful for detecting proxy takeover.
  if (value === "PROXY_MANAGED") return value;
  if (sensitive || SENSITIVE_VALUE.test(String(value))) {
    const safe = sensitiveSummary(value, options.onSensitiveValue);
    return `<redacted len=${safe.length} sha256=${safe.sha256_prefix}>`;
  }
  return typeof value === "string" ? redactDiagnosticText(value) : value;
}

export function protectConfigText(text, options = {}) {
  try {
    // Parse before projecting so literal/multiline strings, inline tables, quoted
    // keys, and comments cannot bypass redaction. Do not preserve comments.
    return stringifyToml(
      protectConfigTree("config", parseToml(String(text)), options),
    );
  } catch {
    // Parser exceptions can quote source text. Invalid input is omitted wholly.
    return "# Config omitted: unable to parse and sanitize TOML safely.\n";
  }
}

function readBoundedInput(filename, maximumBytes) {
  let descriptor;
  try {
    descriptor = openSync(filename, "r");
    const item = fstatSync(descriptor);
    if (!item.isFile())
      throw new Error("Diagnostic input is not a regular file.");
    if (item.size > maximumBytes) {
      const error = new Error(
        "Diagnostic input exceeds the bounded byte limit.",
      );
      error.code = "CCSM_INPUT_LIMIT";
      throw error;
    }
    const bytes = Buffer.alloc(item.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count <= 0) break;
      offset += count;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, offset),
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function getAuthMetadata(authPath, options = {}) {
  if (!existsSync(authPath)) return { exists: false, path: authPath };
  const common = { exists: true, path: authPath };
  try {
    const item = statSync(authPath);
    common.length = item.size;
    common.last_write_time = item.mtime.toISOString();
    const json = JSON.parse(readBoundedInput(authPath, MAX_AUTH_BYTES));
    return { ...common, metadata: protectObjectTree("auth", json, options) };
  } catch (error) {
    return {
      ...common,
      parse_error:
        error?.code === "CCSM_INPUT_LIMIT"
          ? "Authentication metadata omitted: input exceeds the bounded byte limit."
          : "Authentication metadata omitted: input could not be read or parsed safely.",
    };
  }
}

export function parseRouterLogLine(line, options = {}) {
  const trimmed = redactDiagnosticText(String(line).trim(), options);
  if (!trimmed) return null;
  const eventIndex = trimmed.indexOf(" event=");
  let timestamp = "<unknown>";
  let payload = trimmed;
  if (eventIndex >= 0) {
    timestamp = trimmed.slice(0, eventIndex);
    payload = trimmed.slice(eventIndex + 1);
  }
  const record = { timestamp, raw: trimmed };
  for (const part of payload.split(/\s+/u)) {
    const separator = part.indexOf("=");
    if (separator > 0) {
      Object.defineProperty(record, part.slice(0, separator), {
        value: part.slice(separator + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return record;
}

function readBoundedText(filename, maximumBytes = MAX_LOG_BYTES) {
  const descriptor = openSync(filename, "r");
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, maximumBytes);
    const position = Math.max(0, size - length);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        length - offset,
        position + offset,
      );
      if (count <= 0) break;
      offset += count;
    }
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

export function selectRouterEvents(
  logPath,
  tailLines,
  traceFilter,
  sinceMinutesFilter,
  { now = new Date(), redactions = [] } = {},
) {
  if (!existsSync(logPath)) return [];
  const parsedNow = now instanceof Date ? now : new Date(now);
  const cutoff = parsedNow.getTime() - sinceMinutesFilter * 60 * 1000;
  const lines = readBoundedText(logPath).split(/\r?\n/u).slice(-tailLines);
  const events = [];
  for (const line of lines) {
    const event = parseRouterLogLine(line, { redactions });
    if (!event) continue;
    if (traceFilter && event.trace !== traceFilter) continue;
    if (sinceMinutesFilter > 0 && event.timestamp !== "<unknown>") {
      const timestamp = Date.parse(event.timestamp);
      if (Number.isFinite(timestamp) && timestamp < cutoff) continue;
    }
    events.push(event);
  }
  return events;
}

function writeJsonFile(filename, value) {
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}${os.EOL}`, "utf8");
}

function createDiagnosticOutputDir(root, now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  assertUnlinkedDirectories(root);
  mkdirSync(root, { recursive: true });
  assertUnlinkedDirectories(root);
  return mkdtempSync(path.join(root, `${stamp}-`));
}

function userProfile(environment = process.env) {
  return environment.USERPROFILE || environment.HOME || os.homedir();
}

export async function runCodexOAuthDiagnostics(
  options = {},
  {
    environment = process.env,
    now = new Date(),
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    nowMs = () => Date.now(),
  } = {},
) {
  const normalized = normalizeCodexOAuthDiagnosticsOptions(options);
  const current = now instanceof Date ? now : new Date(now);
  const outputDir = createDiagnosticOutputDir(normalized.outputRoot, current);
  const profile = userProfile(environment);
  const codexDir = path.join(profile, ".codex");
  const ccSwitchDir = path.join(profile, ".cc-switch");
  const configPath = path.join(codexDir, "config.toml");
  const authPath = path.join(codexDir, "auth.json");
  const routerLogPath = path.join(ccSwitchDir, "logs", "codex-router.log");

  const redactions = new Set();
  const onSensitiveValue = (value) => redactions.add(value);
  if (existsSync(configPath)) {
    let safeConfig;
    try {
      safeConfig = protectConfigText(
        readBoundedInput(configPath, MAX_CONFIG_BYTES),
        { onSensitiveValue },
      );
    } catch {
      safeConfig =
        "# Config omitted: input could not be read within the bounded byte limit.\n";
    }
    writeFileSync(
      path.join(outputDir, "config.sanitized.toml"),
      safeConfig,
      "utf8",
    );
  }
  writeJsonFile(
    path.join(outputDir, "auth.metadata.json"),
    getAuthMetadata(authPath, { onSensitiveValue }),
  );
  const events = selectRouterEvents(
    routerLogPath,
    normalized.logTailLines,
    normalized.trace,
    normalized.sinceMinutes,
    { now: current, redactions },
  );
  writeJsonFile(path.join(outputDir, "router-events.json"), events);
  writeFileSync(
    path.join(outputDir, "router-events.raw.log"),
    events.map((event) => event.raw).join(os.EOL) +
      (events.length ? os.EOL : ""),
    "utf8",
  );
  const capacityEvents = events.filter(
    (event) =>
      CAPACITY_PATTERN.test(event.raw) ||
      (event.status && !/^2/u.test(event.status)),
  );
  writeJsonFile(
    path.join(outputDir, "router-events.capacity-or-error.json"),
    capacityEvents,
  );
  const summary = {
    generated_at: current.toISOString(),
    output_dir: outputDir,
    config_path: configPath,
    auth_path: authPath,
    router_log_path: routerLogPath,
    router_event_count: events.length,
    capacity_or_error_count: capacityEvents.length,
    trace_filter: redactDiagnosticText(normalized.trace, { redactions }),
    tail_lines: normalized.logTailLines,
    since_minutes: normalized.sinceMinutes,
    follow_enabled: normalized.follow,
  };
  writeJsonFile(path.join(outputDir, "summary.json"), summary);

  const lines = [
    `Codex OAuth diagnostics written to: ${outputDir}`,
    `Router events: ${events.length}; capacity/error candidates: ${capacityEvents.length}`,
  ];
  if (normalized.follow) {
    lines.push(
      `Following router log for ${normalized.followSeconds} seconds. Press Ctrl+C to stop earlier.`,
    );
    const deadline = nowMs() + normalized.followSeconds * 1000;
    while (nowMs() < deadline) {
      if (existsSync(routerLogPath)) {
        const latest = readBoundedText(routerLogPath)
          .split(/\r?\n/u)
          .slice(-20)
          .map((line) => redactDiagnosticText(line, { redactions }))
          .join(os.EOL);
        writeFileSync(
          path.join(outputDir, "router-follow-latest.raw.log"),
          latest + (latest ? os.EOL : ""),
          "utf8",
        );
      }
      await sleep(2_000);
    }
  }
  return { outputDir, events, capacityEvents, summary, lines };
}

export function formatCodexOAuthDiagnosticsHelp() {
  return `Usage: node scripts/codex-oauth-diagnostics.mjs [options]

Collect sanitized Codex OAuth/config/router evidence without contacting providers or restarting a service.

  --output-root PATH       evidence root (default: scripts/logs/codex-oauth-diagnostics)
  --log-tail-lines NUMBER  router log tail size from 1 to ${MAX_LOG_TAIL_LINES} (default: ${DEFAULT_LOG_TAIL_LINES})
  --trace VALUE            filter one trace value
  --since-minutes NUMBER   timestamp cutoff from 0 to ${MAX_SINCE_MINUTES} (default: 0)
  --follow                 refresh latest router lines after the snapshot
  --follow-seconds NUMBER  follow duration from ${MIN_FOLLOW_SECONDS} to ${MAX_FOLLOW_SECONDS} (default: ${DEFAULT_FOLLOW_SECONDS})
  --help

PowerShell-style -OutputRoot/-LogTailLines/-Trace/-SinceMinutes/-Follow/-FollowSeconds aliases remain accepted.`;
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCodexOAuthDiagnosticsArguments(argv);
  if (parsed.help) {
    if (Object.keys(parsed).length !== 1) {
      throw new Error("--help cannot be combined with other options.");
    }
    console.log(formatCodexOAuthDiagnosticsHelp());
    return;
  }
  const result = await runCodexOAuthDiagnostics(parsed);
  for (const line of result.lines) console.log(line);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
