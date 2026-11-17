import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/** Deterministic local dependency asset, never fetched by the owner website. */
export async function buildOwnerRemoteAssets({
  check = false,
  root = repoRoot,
} = {}) {
  const packageRoot = path.join(root, "node_modules", "i18next");
  const destination = path.join(
    root,
    "src-tauri",
    "src",
    "resources",
    "owner_remote",
  );
  const [metadata, runtime, license] = await Promise.all([
    readFile(path.join(packageRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(packageRoot, "dist", "umd", "i18next.min.js"), "utf8"),
    readFile(path.join(packageRoot, "LICENSE"), "utf8"),
  ]);
  assert.equal(metadata.name, "i18next");
  assert.match(metadata.version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
  const digest = createHash("sha256").update(runtime).digest("hex");
  assert.ok(!license.includes("*/"), "Unsafe dependency license comment");
  const generated =
    `/*! Generated from the installed i18next ${metadata.version} UMD runtime.\n` +
    ` * Source SHA256: ${digest}\n` +
    " * Regenerate: pnpm remote:assets; license notice follows.\n *\n" +
    license
      .trimEnd()
      .split(/\r?\n/)
      .map((line) => ` * ${line}\n`)
      .join("") +
    " */\n" +
    runtime;
  for (const [name, content] of [
    ["i18next.js", generated],
    ["i18next.LICENSE.txt", license],
  ]) {
    const target = path.join(destination, name);
    if (check) {
      let existing;
      try {
        existing = await readFile(target, "utf8");
      } catch {
        throw new Error(
          "Owner remote assets are missing; run pnpm remote:assets",
        );
      }
      assert.equal(
        existing.replaceAll("\r\n", "\n"),
        content.replaceAll("\r\n", "\n"),
        "Owner remote dependency assets are stale; run pnpm remote:assets",
      );
    } else {
      await writeFile(target, content, "utf8");
    }
  }
  return { version: metadata.version, sha256: digest };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.ok(
    process.argv.slice(2).every((arg) => arg === "--check"),
    "Unknown owner asset option",
  );
  const result = await buildOwnerRemoteAssets({
    check: process.argv.includes("--check"),
  });
  console.log(`Owner remote i18next ${result.version} assets verified`);
}
