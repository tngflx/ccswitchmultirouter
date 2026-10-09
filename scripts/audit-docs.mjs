import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import markdown from "prettier/plugins/markdown";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = "docs/README.md";
const mode = process.argv[2] ?? "--check";

function text(node) {
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(text).join("");
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function compact(value, limit = 210) {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 3)}...` : cleaned;
}

function cell(value) {
  return compact(value, 500).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, "")
    .replace(/\s/gu, "-");
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolute)));
    else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll("\\", "/"));
  }
  return files.sort();
}

async function parseFile(file) {
  const source = await fs.readFile(path.join(root, file), "utf8");
  const ast = await markdown.parsers.markdown.parse(source);
  const headings = [];
  const paragraphs = [];
  const references = [];
  const codePaths = new Set();
  const definitions = new Map();
  const anchors = new Set();
  const anchorCounts = new Map();
  let checked = 0;
  let unchecked = 0;
  walk(ast, (node) => {
    if (node.type === "heading") {
      const title = text(node);
      const base = slug(title);
      const count = anchorCounts.get(base) ?? 0;
      const anchor = count ? `${base}-${count}` : base;
      anchorCounts.set(base, count + 1);
      anchors.add(anchor);
      headings.push({ title, depth: node.depth, line: node.position.start.line, anchor });
    }
    if (node.type === "paragraph") {
      paragraphs.push({ value: text(node), line: node.position.start.line });
    }
    if (node.type === "definition") definitions.set(node.identifier, node.url);
    if (node.type === "link" || node.type === "image") {
      references.push({
        target: node.url,
        label: text(node),
        line: node.position.start.line,
        image: node.type === "image",
      });
    }
    if (node.type === "linkReference" || node.type === "imageReference") {
      references.push({
        identifier: node.identifier,
        label: text(node),
        line: node.position.start.line,
        image: node.type === "imageReference",
      });
    }
    if (node.type === "listItem") {
      if (node.checked === true) checked += 1;
      if (node.checked === false) unchecked += 1;
    }
    if (
      node.type === "inlineCode" &&
      /^(?:src|src-tauri|scripts|tests)\/[\w./-]+\.(?:rs|tsx?|[cm]?js|json|toml|ps1)(?::\d+)?$/u.test(node.value)
    ) {
      codePaths.add(node.value.replace(/:\d+$/u, ""));
    }
  });
  for (const reference of references) {
    if (reference.identifier) reference.target = definitions.get(reference.identifier);
  }
  const title = headings[0]?.title ?? path.basename(file);
  const goalHeading = headings.find((heading) =>
    /^(?:goal|purpose|objective|summary|overview|目标|目的|概述|概要|摘要|本次范围|本次变更)(?:\b|$|[ :：])/iu.test(heading.title),
  );
  const useful = (paragraph) =>
    paragraph.value.length > 35 &&
    !/^(?:date|日期|版本|version|approval|implementation|verification|runtime freshness|for agentic workers|this plan|状态|status|发布日期|更新日期)\s*[:：]/iu.test(paragraph.value) &&
    !/^[-*>]\s*$/u.test(paragraph.value);
  const scope = (goalHeading
    ? paragraphs.find((paragraph) => paragraph.line > goalHeading.line && useful(paragraph))
    : undefined) ?? paragraphs.find(useful);
  return {
    file, source, ast, title, headings, paragraphs, references, codePaths, anchors,
    checked, unchecked, scope: compact(scope?.value ?? title),
    digest: hash(source.replace(/\r\n/gu, "\n").trim()),
  };
}

function category(file) {
  if (file.startsWith("docs/release-notes/")) return "Release Notes";
  if (file.startsWith("docs/user-manual/")) return "User Manuals";
  if (file.startsWith("docs/guides/")) return "Topic Guides";
  if (file.startsWith("docs/superpowers/plans/")) return "Implementation Plans";
  if (file.startsWith("docs/superpowers/specs/")) return "Design Specifications";
  if (file.startsWith("docs/audits/")) return "Audit Records";
  if (file.startsWith("docs/memory/")) return "Engineering History";
  return "Standalone References";
}

const roles = {
  "Release Notes": ["Historical announcement and change list", "Keep release history; not current implementation evidence"],
  "User Manuals": ["User-facing instructions", "Keep; review UI/version drift separately"],
  "Topic Guides": ["Feature explanation or operational procedure", "Keep one canonical topic; preserve translations"],
  "Implementation Plans": ["Task-by-task implementation or release recipe", "Archive/consolidation candidate after checking unique rationale and open work"],
  "Design Specifications": ["Proposed behavior, ownership, constraints and tradeoffs", "Keep unique contracts; consolidate with the canonical topic when implemented"],
  "Audit Records": ["Dated investigation or release-verification evidence", "Historical evidence; consolidate summaries without claiming fresh verification"],
  "Engineering History": ["Retained project history or documentation policy", "Keep concise/frozen; no per-chat continuation logs"],
  "Standalone References": ["Specialized design or investigation", "Candidate for moving into its matching existing topic"],
};

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const name = key(item);
    if (name === undefined) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  return groups;
}

function topicKey(file) {
  if (file.startsWith("docs/release-notes/")) {
    return file.replace(/-(?:en|zh|ja)\.md$/u, "");
  }
  if (/^docs\/user-manual\/(?:en|zh|ja)\//u.test(file)) {
    return file.replace(/\/(?:en|zh|ja)\//u, "/{locale}/");
  }
  if (file.startsWith("docs/guides/")) {
    return file.replace(/-(?:en|zh|ja)\.md$/u, "");
  }
}

function documentLink(file, line) {
  const relative = path.posix.relative("docs", file);
  return `[${file}${line ? `:${line}` : ""}](${encodeURI(relative)})`;
}

function sectionRecords(document, match) {
  return document.headings.filter(match).map((heading, index, headings) => {
    const nextLine = headings[index + 1]?.line ?? Infinity;
    const paragraphs = document.paragraphs.filter(
      (paragraph) => paragraph.line > heading.line && paragraph.line < nextLine,
    );
    const titleHeading = document.headings.find(
      (candidate) => candidate.line > heading.line && candidate.line < nextLine,
    );
    return {
      heading,
      title: titleHeading?.title ?? heading.title,
      scope: compact(paragraphs.find((paragraph) => paragraph.value.length > 40)?.value ?? "Empty heading; no recorded outcome."),
      empty: paragraphs.length === 0,
    };
  });
}

async function fixRetiredReferences() {
  const journalFile = path.join(root, "docs/memory/journal.md");
  const journal = await parseFile("docs/memory/journal.md");
  let source = journal.source;
  const records = sectionRecords(journal, (heading) => /^\d{4}-\d{2}-\d{2}/u.test(heading.title));
  let count = 0;
  for (const record of [...records].reverse()) {
    const heading = record.heading;
    const next = records[records.indexOf(record) + 1]?.heading;
    const start = journal.ast.children.find((node) =>
      node.type === "heading" && node.position.start.line === heading.line,
    ).position.start.offset;
    const end = next
      ? journal.ast.children.find((node) =>
        node.type === "heading" && node.position.start.line === next.line,
      ).position.start.offset
      : journal.source.length;
    const block = source.slice(start, end).replace(
      /`docs\/decisions\/[^`]+\.md`/gu,
      () => {
        count += 1;
        return `[retained journal record](#${heading.anchor})`;
      },
    );
    source = source.slice(0, start) + block + source.slice(end);
  }
  assert(!source.includes("docs/decisions/"), "A retired decision reference was not repaired.");
  await fs.writeFile(journalFile, source);
  console.log(`Repaired ${count} historical journal references; outcomes were not rewritten.`);
}

async function audit() {
  const files = (await listFiles(path.join(root, "docs"))).filter((file) => file !== reportPath);
  const documents = [];
  for (const file of files.filter((candidate) => candidate.endsWith(".md"))) {
    documents.push(await parseFile(file));
  }
  const byFile = new Map(documents.map((document) => [document.file, document]));
  const brokenFiles = [];
  const brokenAnchors = [];
  const assetUsers = new Map();
  const sourcePaths = [];
  for (const document of documents) {
    for (const reference of document.references) {
      if (!reference.target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(reference.target)) continue;
      const [targetPath, anchor] = reference.target.split("#", 2);
      let decoded;
      try { decoded = decodeURIComponent(targetPath.split("?")[0]); } catch { continue; }
      const absolute = decoded.startsWith("/")
        ? path.join(root, decoded)
        : path.resolve(root, path.dirname(document.file), decoded);
      const targetFile = path.relative(root, absolute).replaceAll("\\", "/");
      let exists = true;
      try { await fs.stat(absolute); } catch { exists = false; }
      const entry = { file: document.file, line: reference.line, target: reference.target, targetFile, label: reference.label };
      if (!exists) brokenFiles.push(entry);
      else if (anchor && byFile.has(targetFile) && !byFile.get(targetFile).anchors.has(decodeURIComponent(anchor))) {
        brokenAnchors.push(entry);
      }
      if (exists && reference.image) {
        if (!assetUsers.has(targetFile)) assetUsers.set(targetFile, []);
        assetUsers.get(targetFile).push(entry);
      }
    }
    for (const reference of document.codePaths) {
      try { await fs.stat(path.join(root, reference)); } catch {
        sourcePaths.push({ file: document.file, target: reference });
      }
    }
  }
  const exactDuplicates = [...groupBy(documents, (document) => document.digest).values()]
    .filter((group) => group.length > 1);
  const translations = [...groupBy(documents, (document) => topicKey(document.file)).values()]
    .filter((group) => group.length > 1);
  const planSpecs = [];
  const specs = documents.filter((document) => category(document.file) === "Design Specifications");
  for (const plan of documents.filter((document) => category(document.file) === "Implementation Plans")) {
    const stem = path.basename(plan.file, ".md");
    const specification = specs.find((spec) =>
      path.basename(spec.file, ".md").replace(/-design$/u, "") === stem,
    );
    if (specification) planSpecs.push([plan, specification]);
  }
  const sharedParagraphs = [...groupBy(
    documents.flatMap((document) => document.paragraphs
      .filter((paragraph) => paragraph.value.length >= 180)
      .map((paragraph) => ({ file: document.file, ...paragraph }))),
    (paragraph) => hash(paragraph.value.replace(/\s+/gu, " ").trim()),
  ).values()].filter((group) => new Set(group.map((item) => item.file)).size > 1);
  const manifestFile = "docs/images/codex-multirouter-guide/pages/manifest.json";
  const manifest = JSON.parse(await fs.readFile(path.join(root, manifestFile), "utf8"));
  const assetTitles = new Map(manifest.pages.map((page) => [
    path.posix.join(path.posix.dirname(manifestFile), page.png), page.title,
  ]));
  const archive = sectionRecords(
    byFile.get("docs/memory/root-notes-archive.md"),
    (heading) => heading.depth === 2 && heading.title.endsWith(".md"),
  );
  const journal = sectionRecords(
    byFile.get("docs/memory/journal.md"),
    (heading) => /^\d{4}-\d{2}-\d{2}/u.test(heading.title),
  );
  return {
    files, documents, byFile, brokenFiles, brokenAnchors, assetUsers, sourcePaths,
    exactDuplicates, translations, planSpecs, sharedParagraphs, assetTitles, archive, journal,
  };
}

function render(result) {
  const lines = [
    "# Documentation Map",
    "",
    "Content audit: 2026-10-07. This is the single documentation index, not another",
    "per-task log. Regenerate with `node scripts/audit-docs.mjs --write`; validate",
    "with `node scripts/audit-docs.mjs --check`.",
    "",
    "## Scope And Limits",
    "",
    `- Parsed the complete content of all ${result.documents.length} remaining Markdown files, including fenced-code boundaries, headings, prose, links, status notes and task checkboxes.`,
    `- Indexed ${result.files.length - result.documents.length} supporting files by references and the image manifest. Images were not visually reverified; the HTML prototype was not executed.`,
    "- The purpose excerpts below come from document content, not just filenames. Original-language wording is retained where it is the available evidence.",
    "- Dated logs, unchecked historical checklists and old successful test runs are not evidence of current implementation or live runtime health.",
    "- Only the requested decision files were removed. Their old content remains recoverable through Git history; it was not copied into another archive.",
    "- No app rebuild, process stop, live provider switch, model-memory configuration change or network verification was performed.",
    "",
    "## Where Things Belong",
    "",
    "| Kind | What it actually does | Maintenance verdict |",
    "| --- | --- | --- |",
  ];
  const categories = groupBy(result.documents, (document) => category(document.file));
  for (const [name, documents] of categories) {
    lines.push(`| ${name} (${documents.length}) | ${roles[name][0]} | ${roles[name][1]} |`);
  }
  lines.push(
    "",
    "## Redundancy Findings",
    "",
    `- ${result.exactDuplicates.length} exact whole-document duplicate groups after newline normalization.`,
    `- ${result.translations.length} language-sibling groups. These are translations, not automatic deletion candidates.`,
    `- ${result.planSpecs.length} exact-name plan/spec pairs. A plan describes execution while a specification describes contracts; consolidate only when their distinct information is preserved.`,
    `- ${result.sharedParagraphs.length} long paragraphs occur verbatim in more than one document. Shared text can be boilerplate or intentional quotation, not proof that the whole files are redundant.`,
    "- The archive and journal repeat investigation narratives by design. Freeze the archive and record a milestone only once; do not generate a file or status transition for each chat continuation.",
    "",
    "### Plan And Specification Overlap",
    "",
    "| Implementation recipe | Contract/design record |",
    "| --- | --- |",
  );
  for (const [plan, specification] of result.planSpecs) {
    lines.push(`| ${documentLink(plan.file)} | ${documentLink(specification.file)} |`);
  }
  if (!result.planSpecs.length) lines.push("| None | None |");
  if (result.exactDuplicates.length) {
    lines.push("", "### Identical Files", "");
    for (const group of result.exactDuplicates) {
      lines.push(`- ${group.map((document) => documentLink(document.file)).join("; ")}`);
    }
  }
  lines.push(
    "",
    "## File-By-File Purpose",
    "",
    "These are recorded scopes, not assertions that the documented feature is still",
    "implemented exactly this way. Guide/manual currency requires a separate code/UI review.",
  );
  for (const [name, documents] of categories) {
    lines.push("", `### ${name}`, "", "| File | Actual recorded topic/scope | Review signal |", "| --- | --- | --- |");
    for (const document of documents) {
      const signals = [];
      if (document.checked || document.unchecked) signals.push(`Historical checklist: ${document.checked} checked / ${document.unchecked} unchecked`);
      if (document.paragraphs.some((paragraph) => /superseded boundary|superseded on|已取代|已被.{0,40}取代/iu.test(paragraph.value))) signals.push("Contains an explicit supersession note");
      const missing = result.brokenFiles.filter((entry) => entry.file === document.file).length;
      if (missing) signals.push(`${missing} missing local link target(s)`);
      const missingSource = result.sourcePaths.filter((entry) => entry.file === document.file).length;
      if (missingSource) signals.push(`${missingSource} absent literal source path(s)`);
      const scopeHeadings = document.headings.filter((heading) => heading.depth === 2 &&
        !/^(?:goal|purpose|目标|目录|table of contents|contents|toc|前提|prerequisites|verification|verification plan|files|status history)$/iu.test(heading.title))
        .slice(0, 3).map((heading) => compact(heading.title, 65));
      const purpose = `${compact(document.title, 110)}. ${document.scope}${scopeHeadings.length ? ` Sections: ${scopeHeadings.join("; ")}.` : ""}`;
      lines.push(`| ${documentLink(document.file)} | ${cell(purpose)} | ${cell(signals.join("; ") || roles[name][1])} |`);
    }
  }
  lines.push(
    "",
    "## Embedded Historical Notes",
    "",
    `The single root-note archive contains ${result.archive.length} separately named former files.`,
    "They are mapped individually here so they do not disappear behind one large filename.",
    "",
    "| Former file / retained section | Recorded purpose |",
    "| --- | --- |",
  );
  for (const record of result.archive) {
    lines.push(`| [${cell(record.heading.title)}](memory/root-notes-archive.md#${record.heading.anchor}) | ${cell(`${record.title}. ${record.scope}`)} |`);
  }
  lines.push(
    "",
    "## Journal Entry Map",
    "",
    "These are historical outcomes. Later entries can supersede earlier findings;",
    "nothing in this table means the same tests were run during this documentation audit.",
    "",
    "| Entry | Recorded outcome |",
    "| --- | --- |",
  );
  for (const record of result.journal) {
    lines.push(`| [${cell(record.heading.title)}](memory/journal.md#${record.heading.anchor}) | ${cell(record.scope)} |`);
  }
  const emptyJournal = result.journal.filter((record) => record.empty);
  if (emptyJournal.length) {
    lines.push("", `Journal cleanup candidate: ${emptyJournal.length} empty historical heading(s):`);
    for (const record of emptyJournal) lines.push(`- ${documentLink("docs/memory/journal.md", record.heading.line)}: ${record.heading.title}`);
  }
  lines.push(
    "",
    "## Reference Problems",
    "",
    "These findings are from the surviving documentation. Missing legacy paths are",
    "flagged, not silently rewritten to guessed replacements. Remote links were not checked.",
    "",
    `### Missing Local File Targets (${result.brokenFiles.length})`,
    "",
    "| Referencing file | Written target |",
    "| --- | --- |",
  );
  for (const entry of result.brokenFiles) {
    lines.push(`| ${documentLink(entry.file, entry.line)} | \`${cell(entry.target)}\` |`);
  }
  if (!result.brokenFiles.length) lines.push("| None | None |");
  lines.push(
    "",
    `### Missing Heading Anchors (${result.brokenAnchors.length})`,
    "",
    "Anchors use a GitHub-style heading normalization; renderer-specific anchors may differ.",
    "",
    "| Referencing file | Written target |",
    "| --- | --- |",
  );
  for (const entry of result.brokenAnchors) {
    lines.push(`| ${documentLink(entry.file, entry.line)} | \`${cell(entry.target)}\` |`);
  }
  if (!result.brokenAnchors.length) lines.push("| None | None |");
  lines.push(
    "",
    `### Literal Source Paths Absent From This Refork (${result.sourcePaths.length})`,
    "",
    "This checks concrete inline-code source paths, not paths inside code examples.",
    "An absent path can describe the old checkout or a proposed new file, so it is",
    "a review signal rather than an automatic documentation bug.",
    "",
    "| Document | Absent source path |",
    "| --- | --- |",
  );
  for (const entry of result.sourcePaths) {
    lines.push(`| ${documentLink(entry.file)} | \`${cell(entry.target)}\` |`);
  }
  if (!result.sourcePaths.length) lines.push("| None | None |");
  lines.push(
    "",
    "## Supporting Files",
    "",
    "Image roles come from referring documents/alt text or the page manifest, not a",
    "claim that the screenshots match the current UI. Unreferenced assets need review,",
    "not automatic deletion: a manual or external README may still use them.",
    "",
    "| File | Recorded role / referring documentation |",
    "| --- | --- |",
  );
  for (const file of result.files.filter((candidate) => !candidate.endsWith(".md"))) {
    const users = result.assetUsers.get(file) ?? [];
    let role;
    if (file.endsWith("manifest.json")) role = "Generated routing-guide page manifest: image ordering, page titles, dimensions and generation metadata.";
    else if (file.endsWith(".html")) role = "Standalone interactive Codex router-workspace design prototype; not the production application.";
    else if (result.assetTitles.has(file)) role = `Generated guide page: ${result.assetTitles.get(file)}. Listed in the page manifest.`;
    else if (users.length) role = users.slice(0, 3).map((entry) => `${entry.label || "Screenshot"} in ${entry.file}`).join("; ");
    else role = "No surviving Markdown image backlink found inside docs; inspect external references before removal.";
    lines.push(`| ${documentLink(file)} | ${cell(role)} |`);
  }
  lines.push(
    "",
    "## Cleanup Order",
    "",
    "1. Do not recreate the retired per-fix decision folder.",
    "2. Use existing topic guides for unique, still-applicable architectural rationale.",
    "3. Resolve missing local references against the actual source/history, not guesses.",
    "4. Consolidate completed plan/spec pairs only after checking unique constraints and unresolved work.",
    "5. Keep translated manuals and release history separate from assistant recaps.",
    "6. Freeze historical archives and stop repeated continuation/test-rerun entries.",
    "",
  );
  return lines.join("\n");
}

if (mode === "--fix-retired-links") {
  await fixRetiredReferences();
} else {
  const result = await audit();
  if (mode === "--inspect") {
    const filter = process.argv[3] ?? "";
    for (const document of result.documents.filter((candidate) => candidate.file.includes(filter))) {
      console.log(JSON.stringify({
        file: document.file, title: document.title, scope: document.scope,
        headings: document.headings.filter((heading) => heading.depth <= 2).map((heading) => heading.title).slice(0, 10),
        checked: document.checked, unchecked: document.unchecked,
      }));
    }
  } else if (mode === "--write") {
    await fs.writeFile(path.join(root, reportPath), render(result));
    console.log(`Wrote ${reportPath}.`);
  } else if (mode === "--check") {
    const report = await fs.readFile(path.join(root, reportPath), "utf8");
    assert.equal(report, render(result), "Documentation map is stale; run with --write.");
    const reportAst = await markdown.parsers.markdown.parse(report);
    const localTargets = [];
    walk(reportAst, (node) => {
      if ((node.type === "link" || node.type === "image") && !/^[a-z][a-z\d+.-]*:/iu.test(node.url)) {
        localTargets.push(node.url);
      }
    });
    for (const target of localTargets) {
      const [file, anchor] = target.split("#", 2);
      const resolved = path.resolve(root, "docs", decodeURIComponent(file));
      await fs.stat(resolved);
      if (anchor) {
        const document = result.byFile.get(path.relative(root, resolved).replaceAll("\\", "/"));
        assert(document?.anchors.has(decodeURIComponent(anchor)), `Invalid map anchor: ${target}`);
      }
    }
    assert.equal(result.documents.length, new Set(result.documents.map((document) => document.file)).size);
    for (const document of result.documents) {
      assert(report.includes(`](${encodeURI(path.posix.relative("docs", document.file))})`), `Unmapped document: ${document.file}`);
      assert(!document.source.includes("docs/decisions/"), `Retired reference in ${document.file}`);
    }
    const pointer = await fs.readFile(path.join(root, "memory.md"), "utf8");
    assert(!pointer.includes("docs/decisions/"), "Retired reference in root memory pointer.");
    assert.equal((await listFiles(path.join(root, "docs"))).filter((file) => file.startsWith("docs/decisions/")).length, 0);
    console.log("Map coverage, generated links/anchors, deterministic regeneration and retired-reference checks passed.");
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }
  console.log(JSON.stringify({
    markdownFiles: result.documents.length,
    supportingFiles: result.files.length - result.documents.length,
    archiveNotes: result.archive.length,
    journalEntries: result.journal.length,
    exactDuplicateGroups: result.exactDuplicates.length,
    translationGroups: result.translations.length,
    planSpecPairs: result.planSpecs.length,
    sharedLongParagraphGroups: result.sharedParagraphs.length,
    missingLocalTargets: result.brokenFiles.length,
    missingAnchors: result.brokenAnchors.length,
    absentSourcePaths: result.sourcePaths.length,
    categories: Object.fromEntries([...groupBy(result.documents, (document) => category(document.file))]
      .map(([name, documents]) => [name, documents.length])),
  }, null, 2));
}
