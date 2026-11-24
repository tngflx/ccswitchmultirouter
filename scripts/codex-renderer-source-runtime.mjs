import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const resources = new URL(
  "../src-tauri/src/resources/codex_desktop/",
  import.meta.url,
);
// The Rust injector is the assembly authority. Derive the audit's slots,
// order and resources from its declarations instead of maintaining another list.
// Fail closed on an unfamiliar assembly shape so an audit cannot silently test
// a different renderer from the program the desktop actually injects.
export const readRustRendererFragments = (rust, renderer) => {
  const assembly = rust.match(
    /fn assemble_codex_renderer_runtime_script\([\s\S]*?\n}\r?\n/,
  )?.[0];
  assert.ok(assembly, "Rust renderer assembly not found");
  const bindings = new Map();
  for (const match of assembly.matchAll(
    /let (\w+)\s*=\s*(?:include_str!\("resources\/codex_desktop\/([^"]+)"\)|([\w]+)\([^;]*?\));/g,
  )) {
    let file = match[2];
    if (!file) {
      const helper = rust.match(new RegExp(`fn ${match[3]}\\([^]*?\\n}`))?.[0];
      file = helper?.match(
        /include_str!\("resources\/codex_desktop\/([^"]+)"\)/,
      )?.[1];
    }
    assert.ok(file, `Rust renderer resource not found: ${match[1]}`);
    bindings.set(match[1], file);
  }
  const fragments = [
    ...assembly.matchAll(
      /\.replace\(\s*"\/\*__CCSWITCH_(\w+)_CORE__\*\/",\s*&?(\w+),?\s*\)/g,
    ),
  ].map((match) => {
    const file = bindings.get(match[2]);
    assert.ok(file, `Rust renderer slot resource not found: ${match[1]}`);
    return [match[1], file];
  });
  const slots = [...renderer.matchAll(/\/\*__CCSWITCH_(\w+)_CORE__\*\//g)].map(
    (match) => match[1],
  );
  assert.equal(new Set(slots).size, slots.length, "Duplicate renderer slots");
  assert.equal(
    new Set(fragments.map(([slot]) => slot)).size,
    fragments.length,
    "Duplicate Rust renderer replacements",
  );
  assert.deepEqual(
    fragments.map(([slot]) => slot).sort(),
    [...slots].sort(),
    "Rust renderer replacements must cover every resource slot exactly once",
  );
  return fragments;
};

// Read the maintained Rust prompt's literal pieces so this verification path
// cannot silently install a different summary workflow or fingerprint.
const rustString = (value) => JSON.parse(`"${value}"`);
export const loadCodexRendererSourceRuntime = async () => {
  const [renderer, rust, terminalPolicy] = await Promise.all([
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
  ]);
  const fragments = readRustRendererFragments(rust, renderer);
  const sources = await Promise.all(
    fragments.map(([, file]) => readFile(new URL(file, resources), "utf8")),
  );
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
    recoveryOnly = false,
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
      .replaceAll("__CCSWITCH_RECOVERY_ONLY__", String(recoveryOnly))
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
    assemble: (catalogPayload, catalogReleased, suppressed, recoveryOnly) =>
      assemble(
        catalogPayload,
        catalogReleased,
        suppressed,
        fingerprint,
        recoveryOnly,
      ),
    template,
  };
};
