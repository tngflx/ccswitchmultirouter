import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as checker from "./check-openai-responses-contract.mjs";

const {
  compareContract,
  extractContract,
  main,
  snapshotPath,
  validateSnapshot,
} = checker;

function referenceMarkdown() {
  const fields = Array.from(
    { length: 20 },
    (_, index) => `- \`field${index}: optional string\``,
  ).join("\n");
  return `### Body Parameters\n${fields}
- \`input: optional string or array\`
      - \`type: "message"\`
      - \`type: "additional_tools"\`
      - \`type: "compaction_trigger"\`
      - \`input: string\`
      - \`type: "custom_tool_call"\`
- \`instructions: optional string\`
- \`tool_choice: optional ToolChoiceOptions or ToolChoiceAllowed or ToolChoiceTypes\`
  - \`ToolChoiceOptions = "none" or "auto" or "required"\`
    - \`"none"\`
    - \`"auto"\`
    - \`"required"\`
  - \`ToolChoiceAllowed object { mode, tools, type }\`
    - \`mode: "auto" or "required"\`
      - \`"auto"\`
      - \`"required"\`
    - \`tools: array of map[unknown]\`
    - \`type: "allowed_tools"\`
      - \`"allowed_tools"\`
  - \`ToolChoiceTypes object { type }\`
    - \`type: "file_search" or "computer" or 2 more\`
      - \`"file_search"\`
      - \`"computer"\`
      - \`"computer_use"\`
      - \`"web_search_preview"\`
    - \`description: optional string\`
      - \`"not_a_type"\`
  - \`ToolChoiceFunction object { name, type }\`
    - \`name: string\`
    - \`type: "function"\`
      - \`"not_an_additional_type"\`
- \`tools: optional array\`
    - \`type: "web_search" or "web_search_preview"\`
- \`top_logprobs: optional number\`
### Returns\n`;
}

function fixtureSnapshot() {
  return {
    version: 1,
    source:
      "https://developers.openai.com/api/reference/resources/responses/methods/create.md",
    ...extractContract(referenceMarkdown()),
    field_types: {
      input: ["string", "array"],
      tools: ["array", "null"],
      tool_choice: ["string", "object", "null"],
    },
    compatibility_nulls: ["tools", "tool_choice"],
    invariants: Array.from({ length: 3 }, (_, index) => ({
      code: `invariant${index}`,
      evidence: `evidence${index}`,
    })),
  };
}

test("reviewed snapshot is valid offline", async () => {
  validateSnapshot(JSON.parse(await readFile(snapshotPath, "utf8")));
});

test("truncated reference without a Returns boundary fails closed", () => {
  assert.throws(
    () => extractContract(referenceMarkdown().replace("### Returns", "")),
    /incomplete|returns|boundary/i,
  );
});

test("declaration drift is detected without depending on prose", () => {
  const markdown = referenceMarkdown();
  const snapshot = extractContract(markdown);
  assert.deepEqual(snapshot.input_types, [
    "additional_tools",
    "compaction_trigger",
    "custom_tool_call",
    "message",
  ]);
  assert.deepEqual(snapshot.tool_types, ["web_search", "web_search_preview"]);
  assert.deepEqual(
    compareContract(
      snapshot,
      extractContract(
        markdown.replace("optional number", "optional number or null"),
      ),
    ),
    ["declarations_sha256", "top_level_signatures"],
  );
  assert.deepEqual(
    compareContract(
      snapshot,
      extractContract(
        markdown.replace("### Returns", "New prose\n### Returns"),
      ),
    ),
    [],
  );
  assert.deepEqual(
    compareContract(
      snapshot,
      extractContract(
        markdown.replace(
          "      - `input: string`",
          "        - `input: string`",
        ),
      ),
    ),
    ["declarations_sha256"],
  );
  assert.throws(
    () => extractContract("<html>no schema</html>"),
    /body parameters/,
  );
});

test("extraction retains normalized public declarations with a round-trip digest", () => {
  const extracted = extractContract(
    referenceMarkdown().replace("optional number", "optional  number"),
  );
  assert.ok(Array.isArray(extracted.declarations));
  assert.ok(extracted.declarations.includes("0:top_logprobs: optional number"));
  assert.ok(extracted.declarations.includes('6:"computer_use"'));
  assert.equal(
    extracted.declarations_sha256,
    createHash("sha256")
      .update(extracted.declarations.join("\n"))
      .digest("hex"),
  );
  assert.deepEqual(
    compareContract(
      extractContract(referenceMarkdown()),
      extractContract(referenceMarkdown().replace(/\n/g, "\r\n")),
    ),
    [],
  );
});

test("tool choices are extracted separately from declarations and mode values", () => {
  const extracted = extractContract(
    referenceMarkdown().replace(
      '`type: "web_search" or "web_search_preview"`',
      '`type: "web_search" or "namespace" or "tool_search"`',
    ),
  );
  assert.deepEqual(extracted.tool_choice_types, [
    "allowed_tools",
    "computer",
    "computer_use",
    "file_search",
    "function",
    "web_search_preview",
  ]);
  assert.deepEqual(extracted.tool_types, [
    "namespace",
    "tool_search",
    "web_search",
  ]);
  assert.deepEqual(
    compareContract(
      extracted,
      extractContract(
        referenceMarkdown().replace('`"computer_use"`', '`"computer_future"`'),
      ),
    ),
    ["declarations_sha256", "tool_types", "tool_choice_types"],
  );
});

test("missing or incomplete tool choice sections fail closed", () => {
  const markdown = referenceMarkdown();
  assert.throws(
    () =>
      extractContract(
        markdown.replace(/- `tool_choice:[\s\S]*?(?=- `tools:)/, ""),
      ),
    /tool.choice|choice section/,
  );
  assert.throws(
    () =>
      extractContract(
        markdown.replace(
          /(- `tool_choice:[^\n]*\n)[\s\S]*?(?=- `tools:)/,
          "$1",
        ),
      ),
    /tool.choice|choice section/,
  );
});

test("declaration changes preserve duplicate occurrence counts", () => {
  assert.equal(typeof checker.declarationChanges, "function");
  assert.deepEqual(
    checker.declarationChanges(
      { declarations: ["0:shared", "2:repeat", "2:repeat", "4:removed"] },
      { declarations: ["2:repeat", "0:shared", "6:added", "6:added"] },
    ),
    {
      added: ["6:added", "6:added"],
      removed: ["2:repeat", "4:removed"],
    },
  );
  assert.deepEqual(
    checker.declarationChanges(
      { declarations: ["0:a", "0:b"] },
      { declarations: ["0:b", "0:a"] },
    ),
    { added: [], removed: [] },
  );
  assert.throws(
    () => checker.declarationChanges({}, { declarations: ["0:new"] }),
    /baseline.*unavailable|unavailable.*baseline/i,
  );
});

test("CLI declaration reports retain totals and bound public line samples", (t) => {
  const output = [];
  t.mock.method(console, "log", (line) => output.push(line));
  const current = {
    declarations: Array.from(
      { length: 20 },
      (_, index) => `4:public_field${index}: ${"x".repeat(800)}`,
    ),
  };
  checker.reportDeclarationChanges({ declarations: [] }, current);
  assert.equal(output[0], "Public declaration changes: 20 added, 0 removed");
  assert.equal(output.filter((line) => line.startsWith("  + 4:")).length, 12);
  assert.ok(output.some((line) => line.includes("8 additional")));
  assert.ok(output.every((line) => line.length < 350));
  assert.ok(output.some((line) => line.endsWith("[truncated]")));

  output.length = 0;
  checker.reportDeclarationChanges(
    {
      declarations: ["0:a", "0:b"],
      declarations_sha256: "old",
    },
    {
      declarations: ["0:b", "0:a"],
      declarations_sha256: "new",
    },
  );
  assert.ok(output.some((line) => line.includes("order changed")));

  output.length = 0;
  checker.reportDeclarationChanges({}, current);
  assert.equal(output.length, 1);
  assert.match(output[0], /baseline is unavailable/);
  assert.doesNotMatch(output[0], /20 added/);
});

test("snapshot validation rejects missing, malformed, or mismatched baselines", () => {
  const valid = fixtureSnapshot();
  validateSnapshot(valid);
  for (const declarations of [
    undefined,
    [],
    [42],
    ["0:first\n0:second"],
    ["-1:invalid"],
    ["0:unnormalized  whitespace"],
  ]) {
    assert.throws(
      () => validateSnapshot({ ...valid, declarations }),
      /declaration/i,
    );
  }
  assert.throws(
    () =>
      validateSnapshot({
        ...valid,
        declarations_sha256: "0".repeat(64),
      }),
    /declaration.*digest|digest.*declaration/i,
  );
  for (const tool_choice_types of [
    undefined,
    [],
    [42],
    ["function", "function"],
    ["function", "allowed_tools"],
    ["allowed_tools", "none"],
  ]) {
    assert.throws(
      () => validateSnapshot({ ...valid, tool_choice_types }),
      /tool.choice/i,
    );
  }
});

test("refresh continues to require the explicit reviewed-changes flag", async () => {
  for (const args of [
    ["--refresh"],
    ["--accept-reviewed-changes"],
    ["--refresh", "--accept-reviewed-changes", "--unknown"],
  ]) {
    await assert.rejects(main(args), /after reviewing/);
  }
});

test("renderer builds fail on a corrupt contract before catalog/Vite and retain all gates on success", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cc-switch-contract-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "contracts"));
  await mkdir(path.join(root, "node_modules", "vite", "bin"), {
    recursive: true,
  });
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  for (const name of [
    "build-renderer.mjs",
    "check-openai-responses-contract.mjs",
  ]) {
    await writeFile(
      path.join(root, "scripts", name),
      await readFile(new URL(name, import.meta.url)),
    );
  }
  await writeFile(
    path.join(root, "scripts", "verify-codex-catalog.mjs"),
    'export function verifyCodexCatalog(){console.log("CATALOG_GATE")}',
  );
  await writeFile(
    path.join(root, "node_modules", "vite", "bin", "vite.js"),
    'console.log("VITE_BUILD")',
  );
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const fixturePath = path.join(root, "contracts", "openai-responses.v1.json");
  await writeFile(
    fixturePath,
    JSON.stringify({ ...snapshot, declarations_sha256: "0".repeat(64) }),
  );
  const run = () =>
    spawnSync(
      process.execPath,
      [path.join(root, "scripts", "build-renderer.mjs")],
      { cwd: root, encoding: "utf8" },
    );
  const failed = run();
  assert.notEqual(
    failed.status,
    0,
    "invalid embedded contract must fail the build",
  );
  assert.match(failed.stderr, /declaration.*digest|digest.*declaration/i);
  assert.doesNotMatch(failed.stdout, /CATALOG_GATE|VITE_BUILD/);
  await writeFile(fixturePath, JSON.stringify(snapshot));
  const passed = run();
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(
    passed.stdout,
    /offline checks passed[\s\S]*CATALOG_GATE[\s\S]*VITE_BUILD/,
  );
});

test("live CLI check passes matching public declarations and rejects a changed declaration", async (t) => {
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const declarations = snapshot.declarations
    .map((line) => {
      const colon = line.indexOf(":");
      return `${" ".repeat(Number(line.slice(0, colon)))}- \`${line.slice(colon + 1)}\``;
    })
    .join("\n");
  const evidence = snapshot.invariants.map((item) => item.evidence).join("\n");
  let markdown = `### Body Parameters\n${declarations}\n### Returns\n${evidence}`;
  t.mock.method(globalThis, "fetch", async () => new Response(markdown));
  t.mock.method(console, "log", () => {});
  await main(["--live"]);
  // Reconstructed markdown uses leading indentation, not the stored depth prefix.
  markdown = markdown.replace(
    "          - `url: optional string or null`",
    "          - `url: string`",
  );
  await assert.rejects(main(["--live"]), /declarations changed/);
});
