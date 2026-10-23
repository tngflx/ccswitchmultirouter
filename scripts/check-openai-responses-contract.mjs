import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const snapshotPath = fileURLToPath(
  new URL("../contracts/openai-responses.v1.json", import.meta.url),
);
const source =
  "https://developers.openai.com/api/reference/resources/responses/methods/create.md";
const maxBytes = 2 * 1024 * 1024;
const maxDeclarationSamples = 12;
const maxDeclarationSampleLength = 320;

export function extractContract(markdown) {
  const bodySection = markdown
    .replace(/\r\n/g, "\n")
    .split("### Body Parameters\n")[1];
  if (!bodySection)
    throw new Error("Official reference body parameters were not found");
  const returns = bodySection.indexOf("### Returns");
  if (returns < 0)
    throw new Error(
      "Official reference is incomplete: Returns boundary is missing",
    );
  const body = bodySection.slice(0, returns);
  const top = [...body.matchAll(/^- `(\w+): ([^\n`]+)`/gm)];
  if (top.length < 20)
    throw new Error("Official reference extraction is incomplete");
  function section(name) {
    const start = top.find((match) => match[1] === name);
    if (!start) return undefined;
    const next = top.find((match) => match.index > start.index);
    return body.slice(start.index, next?.index ?? body.length);
  }
  const input = section("input");
  const tools = section("tools");
  const toolChoice = section("tool_choice");
  if (!toolChoice)
    throw new Error("Official reference tool choice section is missing");
  function literals(section, indent, expandEnums = false) {
    if (!section)
      throw new Error("Official reference tool/input section is missing");
    const values = new Set();
    let expandingType = false;
    for (const line of section.split("\n")) {
      const match = /^( *)- `([^`\n]+)`/.exec(line);
      if (!match) continue;
      const depth = match[1].length;
      const declaration = match[2];
      if (depth <= indent) expandingType = false;
      if (depth === indent && declaration.startsWith("type: ")) {
        for (const literal of declaration.matchAll(/"([^"]+)"/g)) {
          values.add(literal[1]);
        }
        expandingType = expandEnums && /\bor \d+ more\b/.test(declaration);
      } else if (expandingType && depth === indent + 2) {
        const literal = /^"([^"]+)"$/.exec(declaration);
        if (literal) values.add(literal[1]);
      }
    }
    return [...values].sort();
  }
  const toolChoiceTypes = literals(toolChoice, 4, true);
  if (!toolChoiceTypes.length)
    throw new Error("Official reference tool choice extraction is incomplete");
  // Hash typed declarations, not prose, examples, HTML, or page layout.
  const declarations = [...body.matchAll(/^ *- `([^`\n]+)`/gm)].map(
    (match) =>
      `${match[0].indexOf("-")}:${match[1].replace(/\s+/g, " ").trim()}`,
  );
  return {
    declarations_sha256: createHash("sha256")
      .update(declarations.join("\n"))
      .digest("hex"),
    declarations,
    top_level_signatures: Object.fromEntries(
      top.map((match) => [match[1], match[2].replace(/\s+/g, " ").trim()]),
    ),
    input_types: literals(input, 6),
    tool_types: literals(tools, 4),
    tool_choice_types: toolChoiceTypes,
  };
}

export function validateSnapshot(snapshot) {
  if (
    snapshot.version !== 1 ||
    snapshot.source !== source ||
    !/^[a-f0-9]{64}$/.test(snapshot.declarations_sha256)
  ) {
    throw new Error(
      "Invalid Responses contract identity or declaration digest",
    );
  }
  if (
    !Array.isArray(snapshot.declarations) ||
    !snapshot.declarations.length ||
    snapshot.declarations.some(
      (declaration) =>
        typeof declaration !== "string" ||
        !/^(?:0|[1-9]\d*):\S[^\r\n]*$/.test(declaration) ||
        declaration !== declaration.replace(/\s+/g, " ").trim(),
    )
  ) {
    throw new Error("Invalid or unavailable public declaration baseline");
  }
  if (
    createHash("sha256")
      .update(snapshot.declarations.join("\n"))
      .digest("hex") !== snapshot.declarations_sha256
  ) {
    throw new Error("Public declaration baseline does not match its digest");
  }
  if (
    !Array.isArray(snapshot.tool_choice_types) ||
    !snapshot.tool_choice_types.length ||
    snapshot.tool_choice_types.some(
      (type) =>
        typeof type !== "string" ||
        !/^[a-z][a-z0-9_]*$/.test(type) ||
        ["none", "auto", "required"].includes(type),
    ) ||
    JSON.stringify(snapshot.tool_choice_types) !==
      JSON.stringify([...new Set(snapshot.tool_choice_types)].sort())
  ) {
    throw new Error("Invalid Responses tool choice types");
  }
  const validTypes = new Set([
    "string",
    "object",
    "array",
    "number",
    "boolean",
    "null",
  ]);
  for (const [key, types] of Object.entries(snapshot.field_types)) {
    if (
      !snapshot.top_level_signatures[key] ||
      !Array.isArray(types) ||
      !types.length ||
      types.some((type) => !validTypes.has(type))
    ) {
      throw new Error(`Invalid contract rule for ${key}`);
    }
    const signature = snapshot.top_level_signatures[key];
    if (
      types.includes("null") &&
      !signature.includes("null") &&
      !snapshot.compatibility_nulls.includes(key)
    ) {
      throw new Error(`Undocumented null allowance for ${key}`);
    }
  }
  if (
    !snapshot.input_types.includes("compaction_trigger") ||
    !snapshot.input_types.includes("additional_tools") ||
    !snapshot.tool_types.includes("web_search") ||
    snapshot.invariants.length !== 3
  ) {
    throw new Error("Responses replay contract is incomplete");
  }
}

export function compareContract(snapshot, current) {
  return [
    "declarations_sha256",
    "top_level_signatures",
    "input_types",
    "tool_types",
    "tool_choice_types",
  ].filter(
    (key) => JSON.stringify(snapshot[key]) !== JSON.stringify(current[key]),
  );
}

export function declarationChanges(snapshot, current) {
  if (
    !Array.isArray(snapshot.declarations) ||
    !Array.isArray(current.declarations)
  ) {
    throw new Error("Public declaration baseline is unavailable");
  }
  function excess(declarations, baseline) {
    const remaining = new Map();
    for (const declaration of baseline) {
      remaining.set(declaration, (remaining.get(declaration) ?? 0) + 1);
    }
    return declarations.filter((declaration) => {
      const count = remaining.get(declaration) ?? 0;
      if (!count) return true;
      remaining.set(declaration, count - 1);
      return false;
    });
  }
  return {
    added: excess(current.declarations, snapshot.declarations),
    removed: excess(snapshot.declarations, current.declarations),
  };
}

export function reportDeclarationChanges(snapshot, current) {
  if (!Array.isArray(snapshot.declarations)) {
    console.log(
      "Public declaration baseline is unavailable; exact historical differences cannot be reconstructed",
    );
    return;
  }
  const { added, removed } = declarationChanges(snapshot, current);
  console.log(
    `Public declaration changes: ${added.length} added, ${removed.length} removed`,
  );
  if (!added.length && !removed.length) {
    if (snapshot.declarations_sha256 !== current.declarations_sha256) {
      console.log("Public declaration order changed; review the baseline diff");
    }
    return;
  }
  for (const [prefix, declarations] of [
    ["+", added],
    ["-", removed],
  ]) {
    for (const declaration of declarations.slice(0, maxDeclarationSamples)) {
      const sample =
        declaration.length <= maxDeclarationSampleLength
          ? declaration
          : `${declaration.slice(0, maxDeclarationSampleLength)} [truncated]`;
      console.log(`  ${prefix} ${sample}`);
    }
    if (declarations.length > maxDeclarationSamples) {
      console.log(
        `  ${prefix} ${declarations.length - maxDeclarationSamples} additional declaration(s) omitted`,
      );
    }
  }
}

async function fetchReference() {
  const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok)
    throw new Error(`Official reference returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Official reference exceeded the 2 MiB limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r\n/g, "\n");
}

export async function main(args) {
  const flags = new Set(args);
  if (
    args.some(
      (arg) =>
        !["--live", "--refresh", "--accept-reviewed-changes"].includes(arg),
    ) ||
    flags.has("--refresh") !== flags.has("--accept-reviewed-changes")
  ) {
    throw new Error(
      "Use --live to check, or --refresh --accept-reviewed-changes after reviewing documentation and runtime rules",
    );
  }
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  if (!flags.has("--refresh")) validateSnapshot(snapshot);
  if (!flags.has("--live") && !flags.has("--refresh")) {
    console.log("Responses contract snapshot: offline checks passed");
    return;
  }
  const markdown = await fetchReference();
  for (const invariant of snapshot.invariants) {
    if (!markdown.includes(invariant.evidence)) {
      throw new Error(
        `Official evidence changed for ${invariant.code}; review the runtime invariant`,
      );
    }
  }
  const current = extractContract(markdown);
  const changes = compareContract(snapshot, current);
  if (changes.length || flags.has("--refresh")) {
    reportDeclarationChanges(snapshot, current);
  }
  if (flags.has("--refresh")) {
    Object.assign(snapshot, current, {
      verified_at: new Date().toISOString().slice(0, 10),
    });
    validateSnapshot(snapshot);
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(
      "Responses contract reference refreshed; review the diff and run contract/Rust tests before merging",
    );
  } else if (changes.length) {
    throw new Error(
      `Official Responses declarations changed (${changes.join(", ")}); review and refresh the versioned contract`,
    );
  } else {
    console.log(
      "Responses contract snapshot matches current official declarations",
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
