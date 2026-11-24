import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  loadCodexRendererSourceRuntime,
  readRustRendererFragments,
} from "./codex-renderer-source-runtime.mjs";

test("renderer assembly includes the owned remote view foundation in its fingerprint", async () => {
  const runtime = await loadCodexRendererSourceRuntime();
  const assembled = runtime.assemble(
    JSON.stringify({ modelProvider: "fixture-local", models: [] }),
    false,
    false,
  );
  assert.ok(
    /state\.readCodexOwnerRemoteView\s*=/.test(assembled),
    "owner view source must be assembled",
  );
  assert.doesNotMatch(assembled, /\/\*__CCSWITCH_\w+_CORE__\*\//);
  const source = await readFile(
    new URL(
      "../src-tauri/src/resources/codex_desktop/owner_remote_view.js",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(runtime.template.includes(source.trim()));
  assert.ok(assembled.includes(source.trim()));
  assert.match(runtime.fingerprint, /^sha256-[a-f0-9]{64}$/);
});

test("renderer assembly fingerprints the native usage-limit observer after its dependencies", async () => {
  const runtime = await loadCodexRendererSourceRuntime();
  const source = await readFile(
    new URL(
      "../src-tauri/src/resources/codex_desktop/native_usage_limit_observer.js",
      import.meta.url,
    ),
    "utf8",
  );
  const observer = runtime.template.indexOf(source.trim());
  assert.ok(observer > -1, "native usage-limit observer must be fingerprinted");
  for (const dependency of [
    "const classifyCodexUsageLimitContinuationThread =",
    "state.readCodexOwnerRemoteView =",
  ]) {
    const index = runtime.template.indexOf(dependency);
    assert.ok(index > -1 && index < observer);
  }
  assert.doesNotThrow(() => new Function(runtime.template));
});

const assemblyFixture = `
fn direct_core_script() -> &'static str {
    include_str!("resources/codex_desktop/direct.js")
}
fn assemble_codex_renderer_runtime_script() -> String {
    let first = direct_core_script();
    let second = include_str!("resources/codex_desktop/second.js");
    include_str!("resources/codex_desktop/renderer_runtime.js")
        .replace("/*__CCSWITCH_SECOND_CORE__*/", second)
        .replace("/*__CCSWITCH_FIRST_CORE__*/", first)
}
`;
const assemblyRenderer =
  "/*__CCSWITCH_FIRST_CORE__*/\n/*__CCSWITCH_SECOND_CORE__*/";

test("audit assembly follows Rust resources and replacement order, not a second manifest", () => {
  assert.deepEqual(
    readRustRendererFragments(assemblyFixture, assemblyRenderer),
    [
      ["SECOND", "second.js"],
      ["FIRST", "direct.js"],
    ],
  );
  assert.deepEqual(
    readRustRendererFragments(
      assemblyFixture.replace("second.js", "updated-second.js"),
      assemblyRenderer,
    )[0],
    ["SECOND", "updated-second.js"],
  );
});

test("audit fails closed on missing, duplicate, or unresolved Rust fragment wiring", () => {
  assert.throws(
    () =>
      readRustRendererFragments(
        assemblyFixture.replace(
          '.replace("/*__CCSWITCH_SECOND_CORE__*/", second)',
          "",
        ),
        assemblyRenderer,
      ),
    /cover every resource slot exactly once/,
  );
  assert.throws(
    () =>
      readRustRendererFragments(
        assemblyFixture.replace("second)", "unknown)"),
        assemblyRenderer,
      ),
    /slot resource not found/,
  );
  assert.throws(
    () =>
      readRustRendererFragments(
        assemblyFixture,
        assemblyRenderer + "/*__CCSWITCH_FIRST_CORE__*/",
      ),
    /Duplicate renderer slots/,
  );
});
