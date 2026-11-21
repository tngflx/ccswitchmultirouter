import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const BUILD_APPROVAL_FLAG = "--confirm-build";
export const BUILD_APPROVAL_ENV = "CCSWITCH_BUILD_APPROVED";
export const BUILD_APPROVAL_SCOPE_ENV = "CCSWITCH_BUILD_APPROVAL_SCOPE";

export function createBuildApprovalScope(environment = process.env) {
  const token = randomUUID();
  const scopePath = path.join(
    os.tmpdir(),
    `ccswitch-build-approval-${randomUUID()}.json`,
  );
  writeFileSync(scopePath, JSON.stringify({ token }), {
    encoding: "utf8",
    flag: "wx",
  });
  let cleaned = false;
  return {
    environment: {
      ...environment,
      [BUILD_APPROVAL_ENV]: token,
      [BUILD_APPROVAL_SCOPE_ENV]: scopePath,
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(scopePath, { force: true });
    },
  };
}

function hasScopedEnvironmentApproval(environment) {
  const token = environment[BUILD_APPROVAL_ENV];
  const scopePath = environment[BUILD_APPROVAL_SCOPE_ENV];
  if (!token || !scopePath || !existsSync(scopePath)) return false;
  try {
    return JSON.parse(readFileSync(scopePath, "utf8")).token === token;
  } catch {
    return false;
  }
}

export function hasBuildApproval(
  args = [],
  environment = process.env,
  { allowEnvironmentApproval = false } = {},
) {
  return (
    args.includes(BUILD_APPROVAL_FLAG) ||
    (allowEnvironmentApproval && hasScopedEnvironmentApproval(environment))
  );
}

export function requireBuildApproval({
  args = [],
  environment = process.env,
  operation = "build",
  allowEnvironmentApproval = false,
} = {}) {
  if (!hasBuildApproval(args, environment, { allowEnvironmentApproval })) {
    throw new Error(
      `Refusing ${operation} without explicit user approval. Re-run with ${BUILD_APPROVAL_FLAG}.`,
    );
  }
}

export function removeBuildApprovalFlag(args = []) {
  return args.filter((argument) => argument !== BUILD_APPROVAL_FLAG);
}
