import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const schemaPath = "src/lib/codexCatalogSchema.ts";
const rustCatalogPath = "src-tauri/src/codex_multirouter/catalog.rs";

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return propertyName(node.expression);
  return undefined;
}

function isWriteOnly(node) {
  let reference = node;
  while (ts.isParenthesizedExpression(reference.parent)) {
    reference = reference.parent;
  }
  const parent = reference.parent;
  return (
    ts.isDeleteExpression(parent) ||
    (ts.isBinaryExpression(parent) &&
      parent.left === reference &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
  );
}

export function inspectTypeScript(text, filename) {
  if (filename === schemaPath || /\.(?:test|spec)\.[cm]?tsx?$/.test(filename)) {
    return [];
  }
  const source = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations = [];
  function visit(node) {
    const legacyAccess =
      (ts.isPropertyAccessExpression(node) &&
        propertyName(node.name) === "model_catalog") ||
      (ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        propertyName(node.argumentExpression) === "model_catalog");
    const legacyBinding =
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent) &&
      propertyName(node.propertyName ?? node.name) === "model_catalog";
    if ((legacyAccess && !isWriteOnly(node)) || legacyBinding) {
      const { line } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      violations.push(
        `${filename}:${line + 1}: legacy catalog read must use readCodexCatalogSettings`,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}

// Tokenize only the Rust syntax needed for literal-key reads. Comments and
// string contents cannot accidentally become method calls or cfg attributes.
function rustTokens(text) {
  const tokens = [];
  let offset = 0;
  while (offset < text.length) {
    const start = offset;
    if (/\s/.test(text[offset])) {
      offset++;
    } else if (text.startsWith("//", offset)) {
      const end = text.indexOf("\n", offset);
      offset = end < 0 ? text.length : end;
    } else if (text.startsWith("/*", offset)) {
      offset += 2;
      let depth = 1;
      while (offset < text.length && depth) {
        if (text.startsWith("/*", offset)) {
          depth++;
          offset += 2;
        } else if (text.startsWith("*/", offset)) {
          depth--;
          offset += 2;
        } else offset++;
      }
    } else {
      const character =
        /^'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^'\\\r\n])'/.exec(
          text.slice(offset),
        );
      if (character) {
        tokens.push({ value: character[0], string: true, offset: start });
        offset += character[0].length;
        continue;
      }
      const raw = /^(?:br|r)(#*)"/.exec(text.slice(offset));
      if (raw) {
        const contentStart = offset + raw[0].length;
        const closing = `"${raw[1]}`;
        const end = text.indexOf(closing, contentStart);
        tokens.push({
          value: text.slice(contentStart, end < 0 ? text.length : end),
          string: true,
          offset: start,
        });
        offset = end < 0 ? text.length : end + closing.length;
      } else if (text[offset] === '"') {
        offset++;
        while (offset < text.length && text[offset] !== '"') {
          offset += text[offset] === "\\" ? 2 : 1;
        }
        offset = Math.min(text.length, offset + 1);
        const literal = text.slice(start, offset);
        let value;
        try {
          value = JSON.parse(literal);
        } catch {
          value = literal.slice(1, -1);
        }
        tokens.push({ value, string: true, offset: start });
      } else {
        const word = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(text.slice(offset));
        const value = word?.[0] ?? text[offset];
        offset += value.length;
        tokens.push({ value, string: false, offset: start });
      }
    }
  }
  return tokens;
}

function rustMethodBeforeArgument(tokens, index) {
  if (tokens[index - 1]?.value !== "(") return undefined;
  let methodIndex = index - 2;
  if (tokens[methodIndex]?.value === ">") {
    let depth = 1;
    while (methodIndex > 0 && depth) {
      methodIndex--;
      if (tokens[methodIndex].value === ">") depth++;
      if (tokens[methodIndex].value === "<") depth--;
    }
    // Skip < and the :: before Rust turbofish type arguments.
    methodIndex -= 3;
  }
  return tokens[methodIndex - 1]?.value === "."
    ? tokens[methodIndex]?.value
    : undefined;
}

export function inspectRust(text, filename) {
  if (filename === rustCatalogPath) return [];
  const tokens = rustTokens(text);
  const violations = [];
  for (let index = 0; index < tokens.length; index++) {
    const sequence = tokens.slice(index, index + 7);
    if (
      sequence.every((token) => !token.string) &&
      sequence.map((token) => token.value).join(" ") === "# [ cfg ( test ) ]"
    ) {
      while (index < tokens.length && tokens[index].value !== "{") index++;
      let depth = 1;
      while (++index < tokens.length && depth) {
        if (tokens[index].string) continue;
        if (tokens[index].value === "{") depth++;
        if (tokens[index].value === "}") depth--;
      }
      index--;
      continue;
    }
    const token = tokens[index];
    if (!token.string) continue;
    const method = rustMethodBeforeArgument(tokens, index);
    const previous = tokens[index - 1]?.value;
    const methodRead =
      token.value === "model_catalog" && ["get", "get_mut"].includes(method);
    const pointerRead =
      (token.value === "/model_catalog" ||
        token.value.startsWith("/model_catalog/")) &&
      ["pointer", "pointer_mut"].includes(method);
    const indexRead =
      token.value === "model_catalog" &&
      previous === "[" &&
      !(tokens[index + 1]?.value === "]" && tokens[index + 2]?.value === "=");
    if (methodRead || pointerRead || indexRead) {
      const line = text.slice(0, token.offset).split("\n").length;
      violations.push(
        `${filename}:${line}: legacy catalog read must use the shared Rust catalog reader`,
      );
    }
  }
  return violations;
}

export function checkCatalogReaders(root) {
  const violations = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", "target", ".git"].includes(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!/\.(?:ts|tsx|rs)$/.test(entry.name)) continue;
      const text = fs.readFileSync(fullPath, "utf8");
      const relative = path.relative(root, fullPath).replaceAll(path.sep, "/");
      violations.push(
        ...(entry.name.endsWith(".rs")
          ? inspectRust(text, relative)
          : inspectTypeScript(text, relative)),
      );
    }
  }
  walk(path.join(root, "src"));
  walk(path.join(root, "src-tauri", "src"));
  return violations;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const violations = checkCatalogReaders(process.cwd());
  if (violations.length) {
    console.error("Codex catalog reader guard failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else console.log("Codex catalog reader guard passed.");
}
