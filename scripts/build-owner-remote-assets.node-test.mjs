import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildOwnerRemoteAssets } from "./build-owner-remote-assets.mjs";

async function fixture(t) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(tempRoot, "ccsm-owner-assets-"));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(tempRoot + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const packageRoot = path.join(root, "node_modules", "i18next");
  const destination = path.join(
    root,
    "src-tauri",
    "src",
    "resources",
    "owner_remote",
  );
  await mkdir(path.join(packageRoot, "dist", "umd"), { recursive: true });
  await mkdir(destination, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "i18next", version: "1.2.3" }),
  );
  await writeFile(
    path.join(packageRoot, "dist", "umd", "i18next.min.js"),
    "/* isolated dependency fixture */\n",
  );
  await writeFile(
    path.join(packageRoot, "LICENSE"),
    "Isolated license fixture\n",
  );
  return { root, packageRoot, destination };
}

test("owner website dependency is local deterministic and licensed", async (t) => {
  const { root, destination } = await fixture(t);
  const result = await buildOwnerRemoteAssets({ root });
  assert.equal(result.version, "1.2.3");
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  const first = await readFile(path.join(destination, "i18next.js"), "utf8");
  assert.ok(
    first.includes("Isolated license fixture"),
    "the served runtime must carry its license notice",
  );
  await buildOwnerRemoteAssets({ root });
  assert.equal(
    await readFile(path.join(destination, "i18next.js"), "utf8"),
    first,
  );
  assert.equal(
    await readFile(path.join(destination, "i18next.LICENSE.txt"), "utf8"),
    "Isolated license fixture\n",
  );
  await buildOwnerRemoteAssets({ root, check: true });
});

test("stale generated runtime fails the release check without overwriting it", async (t) => {
  const { root, packageRoot, destination } = await fixture(t);
  await buildOwnerRemoteAssets({ root });
  const target = path.join(destination, "i18next.js");
  const before = await readFile(target, "utf8");
  await writeFile(
    path.join(packageRoot, "dist", "umd", "i18next.min.js"),
    "/* new dependency fixture */\n",
  );
  await assert.rejects(
    buildOwnerRemoteAssets({ root, check: true }),
    /assets are stale/,
  );
  assert.equal(await readFile(target, "utf8"), before);
});

test("missing runtime never silently fetches a website dependency", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(
    buildOwnerRemoteAssets({ root, check: true }),
    /assets are missing/,
  );
});

test("repository website runtime matches the installed pinned dependency", async () => {
  await buildOwnerRemoteAssets({ check: true });
});
