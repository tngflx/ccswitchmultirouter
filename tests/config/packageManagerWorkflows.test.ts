import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  packageManager: string;
};
const pnpmVersion = manifest.packageManager.match(
  /^pnpm@(\d+\.\d+\.\d+)$/,
)?.[1];

describe("GitHub workflow package-manager ownership", () => {
  it("declares an exact pnpm version in the manifest", () => {
    expect(pnpmVersion).toBeDefined();
  });

  it.each([
    "release.yml",
    "supplemental-linux-release.yml",
    "supplemental-macos-release.yml",
  ])("%s consumes the manifest version without a competing pin", (workflow) => {
    const text = readFileSync(`.github/workflows/${workflow}`, "utf8");
    const steps = text
      .split(/^\s{6}-\s+/m)
      .filter((step) => /uses:\s*pnpm\/action-setup@/.test(step));
    expect(steps.length).toBeGreaterThan(0);

    for (const step of steps) {
      const pin = step.match(
        /^\s{10}version:\s*["']?([^"'\s]+)["']?\s*$/m,
      )?.[1];
      if (pin !== undefined) {
        expect(pin).toBe(pnpmVersion);
      }
    }
  });

  it("uses Corepack's manifest-based install in frontend CI", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toMatch(/^\s+corepack install\s*$/m);
    expect(ci).not.toMatch(/pnpm@10\.12\.3/);
  });
});
