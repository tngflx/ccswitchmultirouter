import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

function jobSource(source, name, nextName) {
  const start = source.indexOf(`  ${name}:`);
  const end = source.indexOf(`  ${nextName}:`, start);
  assert.ok(start >= 0 && end > start, `Missing bounded ${name} CI job`);
  return source.slice(start, end);
}

test("the per-user WiX bundle cannot package or execute elevated-task scripts", () => {
  const template = read("src-tauri/wix/per-user-main.wxs");
  assert.match(template, /InstallScope="perUser"/u);
  assert.match(template, /InstallPrivileges="limited"/u);
  assert.doesNotMatch(template, /\.ps1\b/iu);
  assert.doesNotMatch(
    template,
    /enable_elevated_update_task|(?:Create|Delete|Update)Task(?:Installer|Uninstaller)?\b/u,
  );
  // Keep the unrelated installer behavior; removing script actions must not
  // remove WebView setup, normal application launching, or uninstall shortcuts.
  assert.match(template, /Id="LaunchApplication"/u);
  assert.match(template, /Id="UninstallShortcut"/u);
  assert.match(template, /MicrosoftEdgeWebView2RuntimeInstaller/u);
});

test("the default desktop configuration keeps per-user updates unelevated", () => {
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(config.bundle.windows.wix.template, "wix/per-user-main.wxs");
  assert.equal(config.bundle.windows.wix.enableElevatedUpdateTask, false);
});

test("Git safety CI uses Node and Git without a PowerShell prerequisite", () => {
  const workflow = read(".github/workflows/ci.yml");
  const gitRemotesJob = jobSource(workflow, "git-remotes", "rustfmt");
  assert.match(gitRemotesJob, /uses: actions\/setup-node@/u);
  assert.match(gitRemotesJob, /node-version-file: \.node-version/u);
  assert.match(gitRemotesJob, /node --version/u);
  assert.match(gitRemotesJob, /git --version/u);
  assert.doesNotMatch(
    gitRemotesJob,
    /(?:shell:\s*(?:pwsh|powershell)|\b(?:pwsh|powershell)(?:\.exe)?\s+-|PSVersionTable|Get-Command)/iu,
  );
  assert.match(
    gitRemotesJob,
    /node --test scripts\/git-remote-safety\.node-test\.mjs scripts\/check-upstream-updates\.node-test\.mjs/u,
  );
  assert.match(workflow, /run: npm run test:lifecycle/u);
  assert.match(workflow, /run: npm run test:dev-recovery/u);
});
