import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  compareContract,
  extractContract,
  snapshotPath,
  validateSnapshot,
} from "./check-openai-responses-contract.mjs";

test("reviewed snapshot is valid offline", async () => {
  validateSnapshot(JSON.parse(await readFile(snapshotPath, "utf8")));
});

test("declaration drift is detected without depending on prose", () => {
  const fields = Array.from(
    { length: 20 },
    (_, index) => `- \`field${index}: optional string\``,
  ).join("\n");
  const markdown = `### Body Parameters\n${fields}
- \`input: optional string or array\`
      - \`type: "message"\`
      - \`type: "additional_tools"\`
      - \`input: string\`
      - \`type: "custom_tool_call"\`
- \`instructions: optional string\`
- \`tools: optional array\`
    - \`type: "web_search" or "web_search_preview"\`
- \`top_logprobs: optional number\`
### Returns\n`;
  const snapshot = extractContract(markdown);
  assert.deepEqual(snapshot.input_types, [
    "additional_tools",
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
