import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (name) => readFileSync(fileURLToPath(new URL(name, root)), "utf8");
const desktop = read("src-tauri/src/codex_desktop.rs");
const guardian = read("src-tauri/src/codex_guardian.rs");
const commands = read("src-tauri/src/commands/proxy.rs");
const section = (source, start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
};

test("native process queries allow at least the monitor's eight-second budget", () => {
  const timeout = desktop.match(
    /pub\(crate\) const CODEX_NATIVE_QUERY_TIMEOUT: Duration = Duration::from_secs\((\d+)\);/,
  );
  assert.ok(timeout, "native queries must share an explicit timeout");
  assert.ok(Number(timeout[1]) >= 8);
});

test("native main-process and listener authorities use the existing bounded runner", () => {
  const main = section(
    desktop,
    "pub(crate) fn detect_running_codex_main_process()",
    "/// List only verified Codex Desktop shells.",
  );
  const listener = section(
    desktop,
    "fn codex_debug_endpoint_has_verified_desktop_listener(debug_port: u16, endpoint: IpAddr) -> bool {",
    '#[cfg(any(target_os = "macos", target_os = "linux"))]',
  );
  for (const source of [main, listener]) {
    assert.doesNotMatch(source, /\.output\(\)/);
    assert.match(source, /command_output_with_timeout/);
    assert.match(source, /CODEX_NATIVE_QUERY_TIMEOUT/);
  }
});

test("the shared native process snapshot cannot outlive the same child deadline", () => {
  const snapshot = section(
    commands,
    "pub(crate) fn query_codex_processes()",
    '#[cfg(not(target_os = "windows"))]',
  );
  assert.doesNotMatch(snapshot, /\.output\(\)/);
  assert.match(snapshot, /command_output_with_timeout/);
  assert.match(snapshot, /CODEX_NATIVE_QUERY_TIMEOUT/);
  assert.match(snapshot, /is_official_codex_desktop_shell/);
  assert.match(snapshot, /is_codex_app_server/);
});

test("async guardian and picker discovery await off-worker native checks", () => {
  const guardianCycle = section(
    guardian,
    "async fn run_guardian_cycle(",
    "fn picker_readiness_signature(",
  );
  assert.match(
    guardianCycle,
    /detect_running_codex_main_process_async\(\)\.await/,
  );
  assert.match(
    guardianCycle,
    /pick_codex_page_targets_async\(&targets, \*port\)\.await/,
  );
  const scheduling = section(
    desktop,
    "async fn run_codex_native_query<",
    "pub(crate) async fn list_cdp_targets(",
  );
  assert.match(
    scheduling,
    /tokio::task::spawn_blocking\(query\)\.await\.ok\(\)/,
  );
  const discovery = section(
    desktop,
    "pub(crate) async fn list_cdp_targets(",
    "#[cfg(test)]\nfn cdp_websocket_url_is_local",
  );
  assert.match(discovery, /run_codex_native_query\(move \|\|/);
  assert.match(discovery, /if !verify_listener\(endpoint\)\.await/);
});
