import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const resources = new URL(
  "../src-tauri/src/resources/codex_desktop/",
  import.meta.url,
);
const fragments = [
  ["CATALOG_PAYLOAD_SELECTION", "catalog_payload_selection.js"],
  ["MODEL_PICKER_RELEASE", "model_picker_release.js"],
  ["QUERY_CACHE_LIFECYCLE", "model_picker_cache_lifecycle.js"],
  ["MODEL_PATCH", "model_picker_core.js"],
  ["GUARDIAN_V2_PATCH", "guardian_v2_compatibility.js"],
  ["REQUEST_NORMALIZATION", "app_server_request_normalization.js"],
  ["HISTORY_LINEAGE_HYDRATION", "history_lineage_hydration.js"],
  ["MODULE_CLIENT_DISCOVERY", "client_discovery.js"],
  ["WEBPACK_DISCOVERY", "webpack_discovery.js"],
  ["NATIVE_REASONING_VISIBILITY", "native_reasoning_visibility.js"],
  ["MODEL_PICKER_DIAGNOSTICS", "model_picker_diagnostics.js"],
  ["REQUEST_HEALTH_WARNING", "request_health_warning.js"],
  ["SUMMARY_HANDOFF", "summary_handoff.js"],
  ["CODEX_CONTINUATION", "continuation.js"],
  ["APP_SERVER_MODEL_LIST_SCOPE", "app_server_model_list_scope.js"],
];

// Read the maintained Rust prompt's literal pieces so this verification path
// cannot silently install a different summary workflow or fingerprint.
const rustString = (value) => JSON.parse(`"${value}"`);
export const loadCodexRendererSourceRuntime = async () => {
  const [renderer, rust, terminalPolicy, ...sources] = await Promise.all([
    readFile(new URL("renderer_runtime.js", resources), "utf8"),
    readFile(
      new URL("../src-tauri/src/codex_desktop.rs", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../src-tauri/src/proxy/providers/terminal_error_policy.json",
        import.meta.url,
      ),
      "utf8",
    ),
    ...fragments.map(([, file]) => readFile(new URL(file, resources), "utf8")),
  ]);
  const constants = new Map();
  for (const name of [
    "MANUAL_SUMMARY_REQUEST_MARKER",
    "MANUAL_SUMMARY_REQUEST_INSTRUCTION",
  ])
    constants.set(
      name,
      rustString(
        rust.match(
          new RegExp(`${name}: &str =\\s*"((?:\\\\.|[^"\\\\])*)";`),
        )?.[1] || "",
      ),
    );
  const promptBlock = rust.match(
    /pub\(crate\) fn manual_summary_request_prompt\(\) -> String \{\s*\[([\s\S]*?)\]\s*\.join\(" "\)/,
  )?.[1];
  assert.ok(promptBlock, "Rust summary prompt not found");
  const prompt = promptBlock
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/,$/, ""))
    .filter(Boolean)
    .map((line) =>
      constants.has(line) ? constants.get(line) : JSON.parse(line),
    )
    .join(" ");
  assert.ok(
    [...constants.values()].every(Boolean),
    "Rust summary constants not found",
  );
  JSON.parse(terminalPolicy);
  const assemble = (
    catalogPayload,
    catalogReleased,
    suppressed,
    fingerprint,
  ) => {
    let result = renderer;
    fragments.forEach(([slot], index) => {
      let source = sources[index];
      if (slot === "REQUEST_HEALTH_WARNING")
        source = source.replaceAll(
          "__CCSWITCH_REQUEST_HEALTH_SUPPRESSED__",
          String(suppressed),
        );
      if (slot === "SUMMARY_HANDOFF")
        source = source.replaceAll(
          "__CCSWITCH_MANUAL_SUMMARY_PROMPT__",
          JSON.stringify(prompt),
        );
      if (slot === "CODEX_CONTINUATION")
        source = source.replaceAll(
          "__CCSWITCH_TERMINAL_ERROR_POLICY__",
          terminalPolicy,
        );
      result = result.replaceAll(`/*__CCSWITCH_${slot}_CORE__*/`, () => source);
    });
    return result
      .replaceAll("__CCSWITCH_CATALOG_RELEASED__", String(catalogReleased))
      .replaceAll(
        "__CCSWITCH_PATCH_KEY__",
        JSON.stringify("__ccSwitchCodexAppCompatibilityV9"),
      )
      .replaceAll(
        "__CCSWITCH_RENDERER_RUNTIME_FINGERPRINT__",
        JSON.stringify(fingerprint),
      )
      .replaceAll("__CCSWITCH_CATALOG_PAYLOAD__", () => catalogPayload);
  };
  const template = assemble(
    '{"__ccswitch_catalog_slot__":true}',
    false,
    false,
    "__ccswitch_runtime_fingerprint_slot__",
  );
  const fingerprint = `sha256-${createHash("sha256").update("ccswitch-codex-renderer-runtime-fingerprint-v2\0").update(template).digest("hex")}`;
  return {
    fingerprint,
    assemble: (catalogPayload, catalogReleased, suppressed) =>
      assemble(catalogPayload, catalogReleased, suppressed, fingerprint),
    template,
  };
};
