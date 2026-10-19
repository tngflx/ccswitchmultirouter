import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyCodexCatalog } from "./verify-codex-catalog.mjs";
import { main as verifyResponsesContract } from "./check-openai-responses-contract.mjs";

// Validate the embedded baseline offline; builds must not depend on live docs.
await verifyResponsesContract([]);
verifyCodexCatalog();
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)),
    "build",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
