import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const CONTROL_FILE_NAME = "codex-error-capture.json";
export const DEFAULT_MINUTES = 10;
export const DEFAULT_MAX_EVENTS = 6;
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 30;
export const MIN_MAX_EVENTS = 1;
export const MAX_MAX_EVENTS = 20;
export const MAX_CONTROL_BYTES = 4096;
// Leave room for control/log descendants on Windows and avoid unbounded path input.
export const MAX_CONFIG_PATH_LENGTH = 240;

const RUNTIME_SUPPORT =
  "Requires a CCSM build containing codex_error_capture; control file alone is not runtime verification.";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const VALUE_OPTIONS = new Map([
  ["--action", "action"],
  ["-action", "action"],
  ["--session-id", "sessionId"],
  ["--sessionid", "sessionId"],
  ["-session-id", "sessionId"],
  ["-sessionid", "sessionId"],
  ["--minutes", "minutes"],
  ["-minutes", "minutes"],
  ["--max-events", "maxEvents"],
  ["--maxevents", "maxEvents"],
  ["-max-events", "maxEvents"],
  ["-maxevents", "maxEvents"],
  ["--config-dir", "configDir"],
  ["--configdir", "configDir"],
  ["-config-dir", "configDir"],
  ["-configdir", "configDir"],
]);
const SWITCH_OPTIONS = new Map([
  ["--help", "help"],
  ["-help", "help"],
  ["-?", "help"],
]);

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

function parseBoundedInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${label} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return parsed;
}

export function isCanonicalUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function parseCodexErrorCaptureArguments(argv = []) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const rawArgument = argv[index];
    const equalsIndex = rawArgument.indexOf("=");
    const argument = (
      equalsIndex === -1 ? rawArgument : rawArgument.slice(0, equalsIndex)
    ).toLowerCase();
    const key = VALUE_OPTIONS.get(argument) ?? SWITCH_OPTIONS.get(argument);
    if (!key) throw new Error("Unknown Codex error capture option.");
    if (Object.hasOwn(result, key)) {
      throw new Error("A Codex error capture option was specified twice.");
    }
    if (SWITCH_OPTIONS.has(argument)) {
      result[key] = true;
      continue;
    }
    let value =
      equalsIndex === -1 ? undefined : rawArgument.slice(equalsIndex + 1);
    if (value === undefined) {
      if (index + 1 >= argv.length) {
        throw new Error("A Codex error capture option requires a value.");
      }
      value = argv[++index];
    }
    result[key] = value;
  }
  return result;
}

/**
 * Resolve the config directory once and keep all files written by this tool
 * below that directory. Relative paths retain PowerShell compatibility, while
 * filesystem roots and control characters are refused as an unsafe boundary.
 */
export function normalizeBoundedConfigDir(
  value,
  { homeDir = os.homedir() } = {},
) {
  const supplied = value ?? path.join(homeDir, ".cc-switch");
  safeString(supplied, "config directory");
  if (supplied.length > MAX_CONFIG_PATH_LENGTH) {
    throw new Error("The config directory path is too long.");
  }
  const resolved = path.resolve(supplied);
  if (resolved === path.parse(resolved).root) {
    throw new Error("The config directory must not be a filesystem root.");
  }
  if (resolved.length > MAX_CONFIG_PATH_LENGTH) {
    throw new Error("The config directory path is too long.");
  }
  return resolved;
}

export function normalizeCodexErrorCaptureOptions(
  options = {},
  { homeDir = os.homedir() } = {},
) {
  const action = String(options.action ?? "status").toLowerCase();
  if (!new Set(["enable", "disable", "status"]).has(action)) {
    throw new Error("Action must be enable, disable, or status.");
  }
  const configDir = normalizeBoundedConfigDir(options.configDir, { homeDir });
  const minutes = parseBoundedInteger(
    options.minutes ?? DEFAULT_MINUTES,
    "Minutes",
    MIN_MINUTES,
    MAX_MINUTES,
  );
  const maxEvents = parseBoundedInteger(
    options.maxEvents ?? DEFAULT_MAX_EVENTS,
    "MaxEvents",
    MIN_MAX_EVENTS,
    MAX_MAX_EVENTS,
  );
  let sessionId;
  if (options.sessionId !== undefined && options.sessionId !== null) {
    safeString(options.sessionId, "session ID");
    if (!isCanonicalUuid(options.sessionId)) {
      throw new Error("SessionId must be a canonical task UUID.");
    }
    sessionId = options.sessionId.toLowerCase();
  }
  if (action === "enable" && !sessionId) {
    throw new Error("SessionId must be a canonical task UUID.");
  }
  return Object.freeze({
    action,
    configDir,
    minutes,
    maxEvents,
    sessionId,
  });
}

function controlPath(configDir) {
  return path.join(configDir, CONTROL_FILE_NAME);
}

function outputDirectory(configDir, captureId) {
  return path.join(configDir, "logs", "codex-error-captures", captureId);
}

function assertControlShape(control) {
  if (!control || typeof control !== "object" || Array.isArray(control)) {
    throw new Error("The Codex error capture control file is malformed.");
  }
  const keys = Object.keys(control).sort();
  if (
    keys.join("\0") !==
    ["capture_id", "expires_at", "max_events", "session_id"].join("\0")
  ) {
    throw new Error("The Codex error capture control file is malformed.");
  }
  if (
    !isCanonicalUuid(control.capture_id) ||
    !isCanonicalUuid(control.session_id)
  ) {
    throw new Error("The Codex error capture control file is malformed.");
  }
  if (!Number.isSafeInteger(control.expires_at) || control.expires_at < 0) {
    throw new Error("The Codex error capture control file is malformed.");
  }
  if (
    !Number.isSafeInteger(control.max_events) ||
    control.max_events < MIN_MAX_EVENTS ||
    control.max_events > MAX_MAX_EVENTS
  ) {
    throw new Error("The Codex error capture control file is malformed.");
  }
  return control;
}

export function readCodexErrorCaptureControl(configDir) {
  const filename = controlPath(configDir);
  if (!existsSync(filename)) return null;
  let content;
  try {
    content = readFileSync(filename);
  } catch {
    throw new Error("Unable to read the Codex error capture control file.");
  }
  if (content.length > MAX_CONTROL_BYTES) {
    throw new Error("The Codex error capture control file is malformed.");
  }
  try {
    return assertControlShape(JSON.parse(content.toString("utf8")));
  } catch (error) {
    if (error instanceof Error && error.message.includes("malformed"))
      throw error;
    throw new Error("The Codex error capture control file is malformed.");
  }
}

function unixSeconds(now) {
  const value = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(value))
    throw new Error("A finite clock value is required.");
  return Math.floor(value / 1000);
}

export function executeCodexErrorCapture(
  options = {},
  { now = Date.now(), makeUuid = randomUUID, homeDir = os.homedir() } = {},
) {
  const normalized = normalizeCodexErrorCaptureOptions(options, { homeDir });
  const pathToControl = controlPath(normalized.configDir);
  if (normalized.action === "disable") {
    rmSync(pathToControl, { force: true });
    return {
      lines: ["Capture disabled; existing diagnostic files retained."],
      action: normalized.action,
      configDir: normalized.configDir,
      controlPath: pathToControl,
    };
  }
  if (normalized.action === "status") {
    const control = readCodexErrorCaptureControl(normalized.configDir);
    if (!control) {
      return {
        lines: ["Capture disabled."],
        action: normalized.action,
        configDir: normalized.configDir,
        controlPath: pathToControl,
        status: null,
      };
    }
    const nowSeconds = unixSeconds(now);
    const status = {
      SessionId: control.session_id,
      CaptureId: control.capture_id,
      ExpiresAt: new Date(control.expires_at * 1000).toISOString(),
      Expired: nowSeconds >= control.expires_at,
      MaxEvents: control.max_events,
      OutputDir: outputDirectory(normalized.configDir, control.capture_id),
      RuntimeSupport: RUNTIME_SUPPORT,
    };
    return {
      lines: [JSON.stringify(status, null, 2)],
      action: normalized.action,
      configDir: normalized.configDir,
      controlPath: pathToControl,
      status,
    };
  }
  const captureId = makeUuid();
  if (!isCanonicalUuid(captureId)) {
    throw new Error("The capture ID generator returned an invalid UUID.");
  }
  const control = {
    capture_id: captureId.toLowerCase(),
    session_id: normalized.sessionId,
    expires_at: unixSeconds(now) + normalized.minutes * 60,
    max_events: normalized.maxEvents,
  };
  const serialized = JSON.stringify(control);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONTROL_BYTES) {
    throw new Error("The Codex error capture control file is too large.");
  }
  mkdirSync(normalized.configDir, { recursive: true });
  writeFileSync(pathToControl, serialized, { encoding: "utf8", mode: 0o600 });
  const outputDir = outputDirectory(normalized.configDir, control.capture_id);
  return {
    lines: [
      `Capture control enabled for ${control.session_id}. Requires the diagnostic build; no service was restarted.`,
      outputDir,
    ],
    action: normalized.action,
    configDir: normalized.configDir,
    controlPath: pathToControl,
    control,
    outputDir,
  };
}

export function formatCodexErrorCaptureHelp() {
  return `Usage: node scripts/codex-error-capture.mjs [options]

Enable, disable, or inspect the bounded Codex error capture control file. This script never restarts a service.

  --action ACTION       enable, disable, or status (default: status)
  --session-id UUID     canonical task UUID (required for enable)
  --minutes NUMBER      expiry window from 1 to 30 (default: ${DEFAULT_MINUTES})
  --max-events NUMBER   maximum records from 1 to 20 (default: ${DEFAULT_MAX_EVENTS})
  --config-dir PATH     config directory (default: $HOME/.cc-switch)
  --help

PowerShell-style -Action/-SessionId/-Minutes/-MaxEvents/-ConfigDir aliases remain accepted.`;
}

export function main(argv = process.argv.slice(2)) {
  const parsed = parseCodexErrorCaptureArguments(argv);
  if (parsed.help) {
    if (Object.keys(parsed).length !== 1) {
      throw new Error("--help cannot be combined with other options.");
    }
    console.log(formatCodexErrorCaptureHelp());
    return;
  }
  const result = executeCodexErrorCapture(parsed);
  for (const line of result.lines) console.log(line);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
