const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const sourcePath = path.join(
  root,
  "src/components/providers/forms/codexCatalogVersionPruning.ts",
);
const source = fs.readFileSync(sourcePath, "utf8");
const loaded = new Module(sourcePath, module);
loaded._compile(
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
  sourcePath,
);
const { pruneOutdatedCodexCatalogModels: prune } = loaded.exports;
const output = path.resolve(
  process.argv[2] || path.join(os.tmpdir(), "catalog-retention-live-report"),
);

async function main() {
  const reports = [];
  for (const [provider, url] of [
    ["OpenRouter", "https://openrouter.ai/api/v1/models"],
    ["OpenCode Zen", "https://opencode.ai/zen/v1/models"],
    ["OpenCode Go", "https://opencode.ai/zen/go/v1/models"],
  ]) {
    const report = { provider, url, fetchedAt: new Date().toISOString() };
    reports.push(report);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
      assert(response.ok, `HTTP ${response.status}`);
      report.raw = await response.json();
      assert(Array.isArray(report.raw.data), "Missing catalog data array");
      const rows = report.raw.data.map(({ id }) => {
        assert.equal(typeof id, "string", "Missing model ID");
        return Object.freeze({ model: id });
      });
      const result = prune(rows);
      report.total = rows.length;
      report.kept = result.kept.length;
      report.removed = result.pruned.length;
      report.unclassified = result.decisions
        .filter((d) => !d.release)
        .map((d) => d.model.model);
      report.decisions = result.decisions;
      report.families = [];
      const names = (items) => items.map((r) => r.model).sort();
      assert.deepEqual(
        names(prune(result.kept).kept),
        names(result.kept),
        "Not idempotent",
      );
      assert.deepEqual(
        names(prune([...rows].reverse()).kept),
        names(result.kept),
        "Order-dependent selection",
      );
      assert.equal(result.kept.length + result.pruned.length, rows.length);
      assert(
        result.decisions.every((d) => d.release || d.keep),
        "Removed unknown model",
      );
      for (const family of new Set(
        result.decisions.flatMap((d) => (d.release ? [d.release.family] : [])),
      )) {
        const entries = result.decisions.filter(
          (d) => d.release?.family === family,
        );
        const available = new Set(entries.map((d) => d.release.identity)).size;
        const kept = new Set(
          entries.filter((d) => d.keep).map((d) => d.release.identity),
        ).size;
        assert(
          kept >= Math.min(4, available),
          `Minimum violated: ${family}: ${kept}/${available}`,
        );
        report.families.push({
          family: JSON.parse(family)[2],
          available,
          distinctKept: kept,
          entries,
        });
      }
      // Independent acceptance examples from the original failed live audit.
      for (const pattern of [
        /(?:^|\/)gpt-5\.6-(?:sol|luna|terra)(?=$|:|-)/,
        /(?:^|\/)glm-5\.[23](?=$|:|-)/,
        /(?:^|\/)grok-4\.[56]$/,
        /(?:^|\/)muse-spark-1\.[23](?=$|:|-)/,
        /(?:^|\/)claude-fable-5(?:[.-]1)?(?=$|:)/,
        /(?:^|\/)qwen3-(?:coder|vl)(?=$|-)/,
        /(?:^|\/)gpt-5\.4-image-2$/,
        /(?:^|\/)gemini-3\.1-pro(?:-preview)?$/,
      ]) {
        for (const row of rows.filter((r) => pattern.test(r.model))) {
          assert(
            result.kept.includes(row),
            `Required example removed: ${row.model}`,
          );
        }
      }
      report.checks =
        "PASS: family minimum, input-order independence, idempotence, partition, unknown retention, original-audit examples";
      console.log(
        JSON.stringify({
          provider,
          total: report.total,
          kept: report.kept,
          removed: report.removed,
          unclassified: report.unclassified.length,
          checks: report.checks,
        }),
      );
    } catch (error) {
      report.error = String(error);
      process.exitCode = 1;
      console.error(provider, report.error);
    }
  }
  const artifact = {
    sourcePath,
    sourceSha256: crypto.createHash("sha256").update(source).digest("hex"),
    source,
    reports,
  };
  fs.writeFileSync(output + ".json", JSON.stringify(artifact, null, 2));
  const lines = [
    "# Live catalog retention audit",
    "",
    `Source SHA-256: ${artifact.sourceSha256}`,
    "",
    "Policy: two releases per recognized branch; at least four distinct models per family when available. Batch/free/contributor offerings, equivalent versions and mapped aliases do not fill the minimum. Older comparable snapshots may be removed. Unknown names are retained without a latest-version claim. Catalog discovery only; no inference calls or credentials used.",
    "",
  ];
  for (const report of reports) {
    lines.push(
      `## ${report.provider}`,
      "",
      `Endpoint: ${report.url}`,
      "",
      `Fetched: ${report.fetchedAt}`,
      "",
    );
    if (report.error) lines.push(`FAILED: ${report.error}`, "");
    if (!report.decisions) continue;
    lines.push(
      `Total ${report.total}; kept ${report.kept}; removed ${report.removed}; unclassified ${report.unclassified.length}.`,
      "",
      report.checks || "Checks failed; see error above.",
      "",
    );
    for (const group of report.families) {
      lines.push(
        `### ${group.family}`,
        "",
        `Distinct models kept: ${group.distinctKept} / ${group.available} available.${group.available < 4 ? " Endpoint has fewer than four distinct recognized choices." : ""}`,
        "",
        "| Model ID | Outcome | Reason |",
        "| --- | --- | --- |",
      );
      for (const d of group.entries)
        lines.push(
          `| ${d.model.model} | ${d.keep ? "KEEP" : "REMOVE"} | ${d.reason} |`,
        );
      lines.push("");
    }
    lines.push(
      "### Unclassified (retained)",
      "",
      ...report.unclassified.map((id) => `- ${id}`),
      "",
    );
  }
  fs.writeFileSync(output + ".md", lines.join("\n"));
  console.log(`Reports: ${output}.md and ${output}.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
