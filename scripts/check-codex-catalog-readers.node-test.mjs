import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  inspectRust,
  inspectTypeScript,
} from "./check-codex-catalog-readers.mjs";

for (const source of [
  "const catalog = settings.modelCatalog ?? settings.model_catalog;",
  "const catalog = settings?.model_catalog?.models;",
  "const choices = settings.modelCatalog?.spawnAgentModels ?? settings.model_catalog?.spawnAgentModels;",
  'const catalog = settings["model_catalog"];',
  'const catalog = settings?.["model_catalog"];',
  "const { model_catalog: catalog } = settings;",
  'const { ["model_catalog"]: catalog } = settings;',
  "const { model_catalog } = settings;",
  `const catalog = settings.modelCatalog ?? ${" ".repeat(500)} settings.model_catalog;`,
  "settings.model_catalog ??= { models: [] };",
]) {
  test(`rejects a TypeScript legacy read: ${source.slice(0, 90)}`, () => {
    assert.ok(inspectTypeScript(source, "src/feature.tsx").length > 0);
  });
}

test("permits TypeScript writes, fixtures, comments, and the authority module", () => {
  const source = `
    delete settings.model_catalog;
    settings.model_catalog = legacyFixture;
    settings["model_catalog"] = legacyFixture;
    const fixture = { model_catalog: { models: [] } };
    // settings.model_catalog.models
    const description = "settings.model_catalog.models";
    const catalog = readCodexCatalogSettings(settings);
  `;
  assert.deepEqual(inspectTypeScript(source, "src/feature.ts"), []);
  assert.deepEqual(
    inspectTypeScript("settings.model_catalog", "src/feature.test.ts"),
    [],
  );
  assert.deepEqual(
    inspectTypeScript(
      "settings.model_catalog",
      "src/lib/codexCatalogSchema.ts",
    ),
    [],
  );
});

for (const source of [
  'let catalog = settings.get("model_catalog");',
  'let catalog = settings.get_mut("model_catalog");',
  'let catalog = settings . get ( /* comment */ "model_catalog" );',
  'let catalog = settings["model_catalog"].clone();',
  'let catalog = settings.get(r#"model_catalog"#);',
  'let catalog = settings.get::<&str>("model_catalog");',
  'let catalog = settings.pointer("/model_catalog/models");',
  'let catalog = settings.pointer_mut("/model_catalog");',
  `let catalog = settings.get("modelCatalog").or_else(|| { ${" ".repeat(500)} settings.get("model_catalog") });`,
]) {
  test(`rejects a Rust legacy read: ${source.slice(0, 90)}`, () => {
    assert.ok(inspectRust(source, "src-tauri/src/feature.rs").length > 0);
  });
}

test("permits Rust writes, fixtures, nested comments, test modules, and the authority module", () => {
  const source = `
    settings.remove("model_catalog");
    settings["model_catalog"] = json!({"models": []});
    let fixture = json!({"model_catalog": {"models": []}});
    /* outer /* nested */ settings.get("model_catalog") */
    // settings.get_mut("model_catalog")
    let description = r#"settings.get("model_catalog")"#;
    #[cfg(test)]
    mod tests {
      fn regression() { assert!(settings.get("model_catalog").is_none()); }
    }
  `;
  assert.deepEqual(inspectRust(source, "src-tauri/src/feature.rs"), []);
  assert.deepEqual(
    inspectRust(
      'settings.get("model_catalog")',
      "src-tauri/src/codex_multirouter/catalog.rs",
    ),
    [],
  );
});

test("continues checking production Rust after a test module", () => {
  const source = `
    #[cfg(test)]
    mod tests { fn fixture() { let value = "{}"; let brace = '{'; } }
    fn production() { settings.get("model_catalog"); }
  `;
  assert.equal(inspectRust(source, "src-tauri/src/feature.rs").length, 1);
});

test("the CLI fails on unsafe readers and passes after using shared readers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccsm-catalog-guard-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "src-tauri", "src"), { recursive: true });
    const frontend = path.join(root, "src", "feature.tsx");
    const backend = path.join(root, "src-tauri", "src", "feature.rs");
    fs.writeFileSync(frontend, "settings.model_catalog?.spawnAgentModels;");
    fs.writeFileSync(backend, 'settings.get_mut("model_catalog");');
    const run = () =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("./check-codex-catalog-readers.mjs", import.meta.url),
          ),
        ],
        { cwd: root, encoding: "utf8" },
      );
    const failed = run();
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /src\/feature\.tsx:1/);
    assert.match(failed.stderr, /src-tauri\/src\/feature\.rs:1/);
    fs.writeFileSync(frontend, "readCodexCatalogSettings(settings);");
    fs.writeFileSync(backend, "read_catalog_mut(settings);");
    const passed = run();
    assert.equal(passed.status, 0);
    assert.match(passed.stdout, /guard passed/);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
