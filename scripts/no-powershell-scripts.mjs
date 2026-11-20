import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const POWERSHELL_FILE = /\.(?:ps1|psm1|psd1)$/iu;
const INVENTORY_MAX_BUFFER = 16 * 1024 * 1024;

export function assertNoPowerShellScriptPaths(paths) {
  const forbidden = paths.filter((name) => POWERSHELL_FILE.test(name));
  if (forbidden.length)
    throw new Error(
      `Repository PowerShell script files are forbidden: ${forbidden.join(", ")}. Use Rust or JavaScript.`,
    );
}

function repositoryFiles(repoRoot) {
  let output;
  try {
    // Includes new source files too; dependency-generated, ignored launch shims
    // are not repository code and must not be deleted or rewritten by the gate.
    output = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: INVENTORY_MAX_BUFFER,
      },
    );
  } catch {
    throw new Error("Cannot validate the repository script inventory.");
  }
  return output
    .split("\0")
    .filter((name) => name && existsSync(path.join(repoRoot, name)));
}

export function checkRepositoryScriptPolicy({
  repoRoot = ROOT,
  listFiles = repositoryFiles,
  readText = (name) => readFileSync(path.join(repoRoot, name), "utf8"),
} = {}) {
  const files = [...new Set(listFiles(repoRoot))];
  assertNoPowerShellScriptPaths(files);
  for (const filename of files) {
    if (!(
      filename === "package.json" ||
      /^\.github\/workflows\/.*\.ya?ml$/iu.test(filename) ||
      /^src-tauri\/wix\/.*\.wxs$/iu.test(filename)
    ))
      continue;
    const source = readText(filename);
    if (
      /\.ps(?:1|m1|d1)\b/iu.test(source) ||
      /(?:pwsh|powershell)(?:\.exe)?\b[^\r\n]*\s-File\b/iu.test(source)
    )
      throw new Error(
        `PowerShell script entrypoint is forbidden in ${filename}. Use Rust or JavaScript.`,
      );
  }
  return { files: files.length };
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    checkRepositoryScriptPolicy();
    console.log(
      "Repository script policy passed: no PowerShell script files or bundle entrypoints.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
