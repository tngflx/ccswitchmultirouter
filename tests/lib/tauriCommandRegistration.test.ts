import fs from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

function collectTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectTypeScriptFiles(entryPath);
    }
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

function collectLiteralInvocations(): Set<string> {
  const commands = new Set<string>();
  for (const filePath of collectTypeScriptFiles(path.resolve("src"))) {
    const sourceText = fs.readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(sourceFile) === "invoke" &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        commands.add(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return commands;
}

function collectRegisteredCommands(): string[] {
  const source = fs.readFileSync(path.resolve("src-tauri/src/lib.rs"), "utf8");
  const marker = "tauri::generate_handler![";
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  let cursor = start + marker.length;
  let depth = 1;
  while (cursor < source.length && depth > 0) {
    if (source[cursor] === "[") depth += 1;
    if (source[cursor] === "]") depth -= 1;
    cursor += 1;
  }
  expect(depth).toBe(0);

  const handlerBody = source.slice(start + marker.length, cursor - 1);
  return [...handlerBody.matchAll(/(?:^|,)\s*(?:\w+::)*(\w+)\s*(?=,|$)/gm)].map(
    (match) => match[1],
  );
}

describe("Tauri command registration", () => {
  it("registers every literal frontend invocation exactly once", () => {
    const invoked = collectLiteralInvocations();
    const registered = collectRegisteredCommands();
    const registrationCounts = new Map<string, number>();
    for (const command of registered) {
      registrationCounts.set(command, (registrationCounts.get(command) ?? 0) + 1);
    }

    expect([...invoked].filter((command) => !registrationCounts.has(command))).toEqual(
      [],
    );
    expect(
      [...registrationCounts].filter(([, count]) => count > 1),
    ).toEqual([]);
  });
});
