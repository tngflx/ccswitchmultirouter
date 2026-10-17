import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));

export function verifyCodexCatalog() {
  const checks = [
    ["scripts/check-codex-catalog-readers.mjs"],
    ["--test", "scripts/check-codex-catalog-readers.node-test.mjs"],
    ["--test", "scripts/vitest-discovery.node-test.mjs"],
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "src/lib/codexCatalogSchema.test.ts",
      "src/lib/codexConfigSanitizer.test.ts",
      "src/lib/codexCatalogReconciliation.test.ts",
      "src/lib/codexMultiRouterWizard.test.ts",
      "tests/components/CodexMultiRouterWizard.test.tsx",
      "tests/components/CodexFormFields.test.tsx",
      "tests/components/ProviderForm.codexPreset.test.tsx",
      "tests/hooks/useCodexConfigState.catalog.test.ts",
      "tests/utils/codexSpawnAgentCandidates.test.ts",
      "src/utils/codexSpawnAgentCandidates.test.ts",
      "src/components/codex/CodexRouterWorkspacePage.test.ts",
    ],
  ];
  for (const args of checks) {
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Catalog verification failed: node ${args.join(" ")}`, {
        cause: result.error,
      });
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  verifyCodexCatalog();
}
