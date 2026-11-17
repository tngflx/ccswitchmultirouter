import assert from "node:assert/strict";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  symlinkSync,
  openSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";

import {
  DEFAULT_LOG_TAIL_LINES,
  getAuthMetadata,
  normalizeCodexOAuthDiagnosticsOptions,
  parseCodexOAuthDiagnosticsArguments,
  parseRouterLogLine,
  protectConfigText,
  redactDiagnosticText,
  protectObjectTree,
  runCodexOAuthDiagnostics,
  selectRouterEvents,
} from "./codex-oauth-diagnostics.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccsm-codex-oauth-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("OAuth diagnostics parser accepts JavaScript and PowerShell aliases", () => {
  assert.deepEqual(
    parseCodexOAuthDiagnosticsArguments([
      "-OutputRoot",
      "fixture",
      "-LogTailLines",
      "1200",
      "-Trace",
      "trace-1",
      "-SinceMinutes",
      "60",
      "-Follow",
      "-FollowSeconds",
      "12",
    ]),
    {
      outputRoot: "fixture",
      logTailLines: "1200",
      trace: "trace-1",
      sinceMinutes: "60",
      follow: true,
      followSeconds: "12",
    },
  );
  assert.throws(
    () => parseCodexOAuthDiagnosticsArguments(["--unknown"]),
    /Unknown Codex OAuth diagnostics option/,
  );
  assert.throws(
    () => parseCodexOAuthDiagnosticsArguments(["--follow", "--follow"]),
    /specified twice/,
  );
});

test("redaction preserves non-sensitive structure and hides token-like values", () => {
  const config = protectConfigText(
    'api_key = "secret-value"\nname = "OpenAI"\npassword = "PROXY_MANAGED"',
  );
  assert.match(config, /api_key = "<redacted len=12 sha256=[0-9a-f]{12}>"/);
  assert.match(config, /name = "OpenAI"/);
  assert.match(config, /password = "PROXY_MANAGED"/);
  const protectedTree = protectObjectTree("auth", {
    access_token: "top-secret",
    nested: [{ account_id: "acct-secret" }, { label: "safe" }],
    enabled: true,
  });
  assert.equal(protectedTree.access_token.present, true);
  assert.equal(protectedTree.nested[0].account_id.present, true);
  assert.equal(protectedTree.nested[1].label, "safe");
  assert.equal(JSON.stringify(protectedTree).includes("top-secret"), false);
});

test("router parsing and filters retain trace/status/capacity evidence", () => {
  const first = parseRouterLogLine(
    "2026-11-16T01:00:00Z event=upstream trace=keep status=200 model=gpt-5",
  );
  assert.deepEqual(first, {
    timestamp: "2026-11-16T01:00:00Z",
    raw: "2026-11-16T01:00:00Z event=upstream trace=keep status=200 model=gpt-5",
    event: "upstream",
    trace: "keep",
    status: "200",
    model: "gpt-5",
  });
  const f = fixture();
  try {
    const log = path.join(f.root, "codex-router.log");
    writeFileSync(
      log,
      [
        "2026-11-16T00:00:00Z event=upstream trace=drop status=500",
        "2026-11-16T01:00:00Z event=upstream trace=keep status=200",
        "2026-11-16T01:05:00Z event=upstream trace=keep status=503 Selected_model_is_at_capacity",
      ].join("\n"),
    );
    const events = selectRouterEvents(log, 10, "keep", 60, {
      now: new Date("2026-11-16T02:00:00Z"),
    });
    assert.equal(events.length, 2);
    assert.equal(events[1].status, "503");
  } finally {
    f.cleanup();
  }
});

test("diagnostics writes sanitized evidence and summary from bounded local fixtures", async () => {
  const f = fixture();
  try {
    const profile = path.join(f.root, "profile");
    const outputRoot = path.join(f.root, "evidence");
    const codexDir = path.join(profile, ".codex");
    const logsDir = path.join(profile, ".cc-switch", "logs");
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(codexDir, "config.toml"),
      'api_key = "secret-value"\nmodel_provider = "OpenAI"\n',
    );
    writeFileSync(
      path.join(codexDir, "auth.json"),
      JSON.stringify({
        access_token: "secret-value",
        account_id: "acct-123",
        label: "ok",
      }),
    );
    writeFileSync(
      path.join(logsDir, "codex-router.log"),
      "2026-11-16T01:05:00Z event=upstream trace=keep status=503 Selected model is at capacity\n",
    );
    const result = await runCodexOAuthDiagnostics(
      {
        outputRoot,
        logTailLines: 10,
        trace: "keep",
        sinceMinutes: 0,
      },
      {
        environment: { USERPROFILE: profile },
        now: new Date("2026-11-16T02:00:00Z"),
      },
    );
    assert.equal(result.events.length, 1);
    assert.equal(result.capacityEvents.length, 1);
    const config = readFileSync(
      path.join(result.outputDir, "config.sanitized.toml"),
      "utf8",
    );
    assert.equal(config.includes("secret-value"), false);
    const auth = JSON.parse(
      readFileSync(path.join(result.outputDir, "auth.metadata.json"), "utf8"),
    );
    assert.equal(JSON.stringify(auth).includes("secret-value"), false);
    const summary = JSON.parse(
      readFileSync(path.join(result.outputDir, "summary.json"), "utf8"),
    );
    assert.equal(summary.router_event_count, 1);
    assert.equal(summary.capacity_or_error_count, 1);
    assert.equal(summary.follow_enabled, false);
  } finally {
    f.cleanup();
  }
});

test("follow mode accepts a zero-second bounded probe without waiting", async () => {
  const f = fixture();
  try {
    const result = await runCodexOAuthDiagnostics(
      {
        outputRoot: path.join(f.root, "evidence"),
        follow: true,
        followSeconds: 0,
      },
      {
        environment: { USERPROFILE: path.join(f.root, "profile") },
        nowMs: () => 0,
      },
    );
    assert.equal(result.summary.follow_enabled, true);
    assert.match(result.lines[2], /Following router log for 0 seconds/);
  } finally {
    f.cleanup();
  }
});

test("missing auth remains a structured non-error result and defaults stay bounded", () => {
  const options = normalizeCodexOAuthDiagnosticsOptions({});
  assert.equal(options.logTailLines, DEFAULT_LOG_TAIL_LINES);
  assert.equal(options.sinceMinutes, 0);
  const f = fixture();
  try {
    const metadata = getAuthMetadata(path.join(f.root, "missing.json"));
    assert.deepEqual(metadata, {
      exists: false,
      path: path.join(f.root, "missing.json"),
    });
  } finally {
    f.cleanup();
  }
});

test("malformed auth diagnostics never serialize JSON parser source excerpts", () => {
  const f = fixture();
  try {
    const auth = path.join(f.root, "auth.json");
    const marker = "fxsafe";
    writeFileSync(auth, marker);
    const metadata = getAuthMetadata(auth);
    assert.equal(metadata.exists, true);
    assert.equal(typeof metadata.parse_error, "string");
    assert.equal(JSON.stringify(metadata).includes(marker), false);
  } finally {
    f.cleanup();
  }
});

test("TOML redaction handles literals, comments, multiline values, and header containers", () => {
  const marker = "fixture-redacted-config";
  const source = [
    `api_key = '${marker}'`,
    `password = "${marker}" # sensitive inline comment ${marker}`,
    `client_secret = """${marker}\nsecond-line"""`,
    `base_url = "https://user:${marker}@example.invalid/v1?api_key=${marker}"`,
    `model = "gpt-fixture"`,
    `enabled = true`,
    `[model_providers.fixture]`,
    `http_headers = { Authorization = "Bearer ${marker}", "X-Custom-Credential" = "${marker}" }`,
    `[model_providers.other.http_headers]`,
    `"X-Unnamed" = '${marker}'`,
  ].join("\n");
  const protectedText = protectConfigText(source);
  assert.equal(protectedText.includes(marker), false);
  const parsed = parseToml(protectedText);
  assert.equal(parsed.model, "gpt-fixture");
  assert.equal(parsed.enabled, true);
  assert.equal(typeof parsed.api_key, "string");
  assert.match(parsed.api_key, /redacted/);
  assert.match(
    parsed.model_providers.other.http_headers["X-Unnamed"],
    /redacted/,
  );
});

test("malformed TOML is omitted instead of copying source or exception details", () => {
  const marker = "fixture-redacted-malformed-config";
  const protectedText = protectConfigText(`api_key = "${marker}`);
  assert.equal(protectedText.includes(marker), false);
  assert.deepEqual(Object.keys(parseToml(protectedText)), []);
});

test("router evidence and follow snapshots redact credentials while retaining status and trace", async () => {
  const f = fixture();
  try {
    const profile = path.join(f.root, "profile");
    const codexDir = path.join(profile, ".codex");
    const logsDir = path.join(profile, ".cc-switch", "logs");
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });
    const marker = "fixture-redacted-router";
    writeFileSync(path.join(codexDir, "config.toml"), `api_key = '${marker}'`);
    writeFileSync(
      path.join(codexDir, "auth.json"),
      JSON.stringify({ access_token: marker }),
    );
    const lines = [
      `2026-11-16T01:05:00Z event=upstream trace=keep status=503 authorization="Bearer ${marker}" api_key=${marker} error=echo_${marker}`,
      `2026-11-16T01:06:00Z event=upstream trace=keep status=503 endpoint=https://user:${marker}@example.invalid/v1?token=${marker}`,
    ];
    writeFileSync(path.join(logsDir, "codex-router.log"), lines.join("\n"));
    let clock = 0;
    const result = await runCodexOAuthDiagnostics(
      {
        outputRoot: path.join(f.root, "evidence"),
        trace: "keep",
        follow: true,
        followSeconds: 1,
      },
      {
        environment: { USERPROFILE: profile },
        now: new Date("2026-11-16T02:00:00Z"),
        nowMs: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      },
    );
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].trace, "keep");
    assert.equal(result.events[0].status, "503");
    assert.equal(JSON.stringify(result).includes(marker), false);
    for (const filename of [
      "router-events.json",
      "router-events.raw.log",
      "router-events.capacity-or-error.json",
      "router-follow-latest.raw.log",
    ]) {
      assert.equal(
        readFileSync(path.join(result.outputDir, filename), "utf8").includes(
          marker,
        ),
        false,
        filename,
      );
    }
  } finally {
    f.cleanup();
  }
});

test("auth and config reads refuse oversized inputs before parsing or copying", async () => {
  const f = fixture();
  try {
    const profile = path.join(f.root, "profile");
    const codexDir = path.join(profile, ".codex");
    mkdirSync(codexDir, { recursive: true });
    for (const name of ["auth.json", "config.toml"]) {
      const descriptor = openSync(path.join(codexDir, name), "w");
      try {
        ftruncateSync(descriptor, 2 * 1024 * 1024);
      } finally {
        closeSync(descriptor);
      }
    }
    const metadata = getAuthMetadata(path.join(codexDir, "auth.json"));
    assert.match(metadata.parse_error, /limit|large|bounded/i);
    const result = await runCodexOAuthDiagnostics(
      { outputRoot: path.join(f.root, "evidence") },
      { environment: { USERPROFILE: profile } },
    );
    const configEvidence = readFileSync(
      path.join(result.outputDir, "config.sanitized.toml"),
      "utf8",
    );
    assert.ok(configEvidence.length < 1024);
    assert.match(configEvidence, /omitted|limit|large|bounded/i);
  } finally {
    f.cleanup();
  }
});

test("raw evidence redacts opaque header containers and standalone credential formats", () => {
  const marker = "fixture-redacted-raw";
  for (const raw of [
    `event=fixture trace=keep status=503 headers={"X-Custom": "${marker}", "Other": ["${marker}"]}`,
    `event=fixture trace=keep status=503 credentials={"nested": {"label": "${marker}"}}`,
    `event=fixture trace=keep status=503 authorization: Bearer ${marker}`,
    `event=fixture trace=keep status=503 api_key='${marker}'`,
  ]) {
    const safe = redactDiagnosticText(raw);
    assert.equal(safe.includes(marker), false);
    assert.match(safe, /status=503/);
    assert.match(safe, /trace=keep/);
  }
});

test("concurrent diagnostics within the same second keep separate evidence directories", async () => {
  const f = fixture();
  try {
    const environment = { USERPROFILE: path.join(f.root, "profile") };
    const options = { outputRoot: path.join(f.root, "evidence") };
    const now = new Date("2026-11-17T01:00:00Z");
    const first = await runCodexOAuthDiagnostics(options, { environment, now });
    const second = await runCodexOAuthDiagnostics(options, {
      environment,
      now,
    });
    assert.notEqual(first.outputDir, second.outputDir);
    assert.equal(
      readFileSync(path.join(first.outputDir, "summary.json"), "utf8").includes(
        first.outputDir.replaceAll("\\", "\\\\"),
      ),
      true,
    );
  } finally {
    f.cleanup();
  }
});

test("diagnostic output refuses ancestor junctions instead of writing into foreign directories", async () => {
  const f = fixture();
  try {
    const foreign = path.join(f.root, "foreign");
    mkdirSync(foreign);
    const linked = path.join(f.root, "linked");
    symlinkSync(
      foreign,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      runCodexOAuthDiagnostics(
        { outputRoot: path.join(linked, "evidence") },
        { environment: { USERPROFILE: f.root } },
      ),
      /link|junction|reparse/u,
    );
  } finally {
    f.cleanup();
  }
});
