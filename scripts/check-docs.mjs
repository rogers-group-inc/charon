#!/usr/bin/env node
// Doc-drift guard for the project memory: CLAUDE.md (always loaded) plus every Markdown file
// under .claude/skills/** (the project skills and their references). Catches the
// *mechanically-checkable* drift — it CANNOT judge whether prose is still accurate, only
// structural coverage + reference hygiene. The prose review is /charon-docs-sync.
//
// Run:  npm run check:docs    (or: node scripts/check-docs.mjs)
// Wired as a pre-commit hook via .githooks/pre-commit and as a CI job (.github/workflows/check-docs.yml).
// Bypass a single commit with:  git commit --no-verify
//
// Exit 0 = all checks pass; exit 1 = at least one failure (with a report).
//
// Checks (see .claude/skills/charon-docs-sync/references/check-docs-reference.md):
//   docs-present               CLAUDE.md + each SKILL.md in SKILLS exist.
//   no-line-numbers            No `file.ext:NNN` or prose "(line N)" references in any doc.
//   models-documented          Every Prisma model in schema.prisma is named in some doc.
//   files-documented           Every src/ service, job, route, util file is named in some doc.
//   paths-exist                Every concrete src/ public/ prisma/ scripts/ deploy/ agent/ tests/
//                              .claude/skills/ path referenced in the docs exists on disk.
//   retired-doc                No pointer to the retired root files ARCHITECTURE.md /
//                              TEMPLATES.md / TOUCHES.md (split into skills); a provenance phrase
//                              ("moved from TOUCHES.md") is allowed.
//   touches-service-coverage   Every src/services file is mentioned as services/<name>.ts under
//                              charon-change-impact/references/ (warns when it has no heading).
//   skill-frontmatter          Every SKILL.md has name == directory + a description; known keys only.
//   reference-size             No reference .md over 1500 lines (fail); over 100 KB warns.
//   orphan-reference           Every references/**/*.md and scripts/* is linked from its SKILL.md.
//   claude-md-size             CLAUDE.md under 25 KB (fail); over 15 KB warns.
//   rule-anchors               charon-business-rules: every invariant from rule NO_NARRATIVE_MAX+1 on
//                              ends in a "→ [narrative-N.md#rule-N]" pointer that resolves to a
//                              "## Rule N" heading; every index row has an invariant (and its
//                              narrative heading, when it names one); every narrative heading has
//                              an invariant.
//   util-tests (warn)          src/utils files with exports lacking tests/unit/<name>.test.ts.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative, sep } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const r = (p) => join(ROOT, p);
const read = (p) => readFileSync(r(p), "utf8");
const exists = (p) => existsSync(r(p));
const rel = (abs) => relative(ROOT, abs).split(sep).join("/");

const SKILLS_DIR = ".claude/skills";
const SKILLS = [
  "charon-domain-model", "charon-business-rules", "charon-api-rbac", "charon-change-impact",
  "charon-ui-canon", "charon-enforcement", "charon-agent", "charon-tech-lifecycle",
  "charon-worktree-workflow", "charon-deploy", "charon-docs-sync",
];
const KNOWN_FRONTMATTER_KEYS = new Set(["name", "description", "user-invocable", "disable-model-invocation", "allowed-tools", "argument-hint"]);
// Rules 1..NO_NARRATIVE_MAX are the founding invariants and carry no narrative by design.
const NO_NARRATIVE_MAX = 7;

const failures = [];
const fail = (check, msg) => failures.push({ check, msg });

// --- collect the doc set: CLAUDE.md + every .md under .claude/skills/** ---
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const docText = {};
if (!exists("CLAUDE.md")) fail("docs-present", "CLAUDE.md is missing from the repo root.");
else docText["CLAUDE.md"] = read("CLAUDE.md").replace(/\r\n/g, "\n");
for (const s of SKILLS) {
  if (!exists(`${SKILLS_DIR}/${s}/SKILL.md`)) fail("docs-present", `${SKILLS_DIR}/${s}/SKILL.md is missing.`);
}
for (const abs of walk(r(SKILLS_DIR))) {
  // Normalize CRLF: Windows checkouts (core.autocrlf) hand us \r\n, and the frontmatter and
  // heading regexes below anchor on \n.
  if (abs.endsWith(".md")) docText[rel(abs)] = readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
}
const DOCS = Object.keys(docText);
const ALL = DOCS.map((d) => docText[d]).join("\n");

// --- helper: list *.ts basenames in a dir, skipping _helpers and .d.ts ---
function tsFiles(dir) {
  if (!exists(dir)) return [];
  return readdirSync(r(dir))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.startsWith("_"))
    .map((f) => f.replace(/\.ts$/, ""));
}

// === no-line-numbers ===
const LINE_REF = /\.(ts|js|tsx|jsx|mjs|prisma|sql|sh|ps1|rs):\d+/g;
const PROSE_LINE_REF = /\((?:around\s+)?lines?\s+~?\d+/gi;
for (const d of DOCS) {
  const hits = [...docText[d].matchAll(LINE_REF)].map((m) => m[0]);
  const prose = [...docText[d].matchAll(PROSE_LINE_REF)].map((m) => m[0]);
  if (hits.length || prose.length) {
    fail(
      "no-line-numbers",
      `${d} has ${hits.length + prose.length} line-number reference(s) (e.g. ${[...new Set([...hits, ...prose])].slice(0, 5).join(", ")}). ` +
        `Use "path/file.ts -> symbolName()" instead — line numbers drift.`,
    );
  }
}

// === models-documented ===
if (exists("prisma/schema.prisma")) {
  const models = [...read("prisma/schema.prisma").matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
  const undocModels = models.filter((name) => !new RegExp(`\\b${name}\\b`).test(ALL));
  if (undocModels.length) {
    fail(
      "models-documented",
      `${undocModels.length} Prisma model(s) not named in any skill doc: ${undocModels.join(", ")}. ` +
        `Add a Definitions bullet + Schema block to the right ${SKILLS_DIR}/charon-domain-model/references/<domain>.md.`,
    );
  }
}

// === files-documented ===
const codeDirs = [
  ["src/services", "service"],
  ["src/jobs", "job"],
  ["src/api/routes", "route"],
  ["src/utils", "util"],
];
const undocFiles = [];
for (const [dir, kind] of codeDirs) {
  for (const base of tsFiles(dir)) {
    if (!ALL.includes(`${base}.ts`) && !ALL.includes(base)) undocFiles.push(`${kind}: ${dir}/${base}.ts`);
  }
}
if (undocFiles.length) {
  fail(
    "files-documented",
    `${undocFiles.length} source file(s) not named in any skill doc:\n      ` +
      undocFiles.join("\n      ") +
      `\n    Add them to the file map (${SKILLS_DIR}/charon-change-impact/references/file-map/src.md) and, for a job, the queue table.`,
  );
}

// === paths-exist ===
// Templated paths (containing < > or *) are skipped. Lookbehind `(?<![\w/.-])` prevents matching
// a path-root keyword in the MIDDLE of a longer path.
const PATH_REF = /(?<![\w/.-])(?:src|public|prisma|scripts|deploy|agent|tests|\.claude\/skills)\/[A-Za-z0-9_./@-]+\.(?:ts|js|tsx|jsx|mjs|prisma|sql|sh|ps1|html|css|json|md|rs|toml|service|target|template|yml)\b/g;
const deadPaths = new Set();
for (const d of DOCS) {
  const docDir = dirname(d);
  for (const m of docText[d].matchAll(PATH_REF)) {
    const p = m[0];
    if (p.includes("<") || p.includes(">") || p.includes("*")) continue;
    if (exists(p)) continue;
    if (existsSync(join(r(docDir), p))) continue;
    deadPaths.add(`${p}  (referenced in ${d})`);
  }
}
if (deadPaths.size) {
  fail("paths-exist", `${deadPaths.size} doc-referenced path(s) don't exist on disk:\n      ` + [...deadPaths].join("\n      "));
}

// === retired-doc ===
// ARCHITECTURE.md, TEMPLATES.md and TOUCHES.md were split into .claude/skills/ (2026-10-28). A
// reference to one is a dead pointer. A provenance statement ("moved verbatim from TOUCHES.md",
// "from ARCHITECTURE.md § 3") is not a pointer and is allowed.
const RETIRED_ALLOWLIST = new Set([
  `${SKILLS_DIR}/charon-docs-sync/references/check-docs-reference.md`,
  `${SKILLS_DIR}/charon-docs-sync/references/change-routing.md`,
]);
const PROVENANCE = /\b(?:from|retired|formerly|was|split from)\s+(?:the\s+)?(?:retired\s+)?(?:root\s+)?`?(?:ARCHITECTURE|TEMPLATES|TOUCHES)\.md\b/gi;
for (const d of DOCS) {
  if (RETIRED_ALLOWLIST.has(d)) continue;
  const retired = [...docText[d].replace(PROVENANCE, "").matchAll(/\b(ARCHITECTURE|TEMPLATES|TOUCHES)\.md\b/g)].map((m) => m[0]);
  if (retired.length) {
    fail(
      "retired-doc",
      `${d} has ${retired.length} reference(s) to retired root doc(s) (${[...new Set(retired)].join(", ")}). ` +
        `Point at the skill that now holds the content (domain-model / change-impact / enforcement / api-rbac / ui-canon / agent).`,
    );
  }
}

// === touches-service-coverage ===
const TOUCHES_DOCS = DOCS.filter((d) => d.startsWith(`${SKILLS_DIR}/charon-change-impact/references/`));
const TOUCHES_TEXT = TOUCHES_DOCS.map((d) => docText[d]).join("\n");
const TOUCHES_EXEMPT = new Set([
  // (none today — every service carries an entry)
]);
const serviceBases = tsFiles("src/services").filter((base) => !TOUCHES_EXEMPT.has(base));
const undocServices = serviceBases.filter((base) => !TOUCHES_TEXT.includes(`services/${base}.ts`));
if (undocServices.length) {
  fail(
    "touches-service-coverage",
    `${undocServices.length} service(s) are not mentioned anywhere under ${SKILLS_DIR}/charon-change-impact/references/services/:\n      ` +
      undocServices.map((s) => `services/${s}.ts`).join("\n      ") +
      `\n    Add a per-service entry (What it owns / Public API / Cross-service deps / Used by / Invariants / When changing this).`,
  );
}
const headingless = serviceBases.filter((base) => !undocServices.includes(base) && !new RegExp(`^## services/${base}\\.ts\\s*$`, "m").test(TOUCHES_TEXT));
if (headingless.length) {
  console.warn(
    `\n⚠ check-docs (warn): ${headingless.length} service(s) are mentioned in the touches index but have no "## services/<name>.ts" section of their own:\n      ` +
      headingless.map((s) => `services/${s}.ts`).join("\n      ") +
      `\n    Add a per-service entry when you next change one of them.\n`,
  );
}

// === skill-frontmatter ===
for (const s of SKILLS) {
  const p = `${SKILLS_DIR}/${s}/SKILL.md`;
  if (!docText[p]) continue;
  const m = /^---\n([\s\S]*?)\n---\n/.exec(docText[p]);
  if (!m) { fail("skill-frontmatter", `${p} has no YAML frontmatter block.`); continue; }
  const fm = Object.fromEntries(m[1].split("\n").filter((l) => /^[\w-]+:/.test(l)).map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  if (fm.name !== s) fail("skill-frontmatter", `${p}: name "${fm.name}" must equal the directory name "${s}".`);
  if (!fm.description || fm.description.replace(/^"|"$/g, "").length < 40) fail("skill-frontmatter", `${p}: description is missing or too short — it is the only auto-load signal.`);
  for (const k of Object.keys(fm)) if (!KNOWN_FRONTMATTER_KEYS.has(k)) fail("skill-frontmatter", `${p}: unknown frontmatter key "${k}".`);
}
// A skill directory on disk that SKILLS does not list is invisible to every check above.
for (const e of existsSync(r(SKILLS_DIR)) ? readdirSync(r(SKILLS_DIR), { withFileTypes: true }) : []) {
  if (e.isDirectory() && !SKILLS.includes(e.name)) fail("docs-present", `${SKILLS_DIR}/${e.name} is not listed in SKILLS in scripts/check-docs.mjs (nor, presumably, in the CLAUDE.md skills table).`);
}

// === reference-size ===
const bigWarn = [];
for (const d of DOCS) {
  if (d === "CLAUDE.md" || d.endsWith("/SKILL.md")) continue;
  const lines = docText[d].split("\n").length;
  const bytes = Buffer.byteLength(docText[d]);
  if (lines > 1500) fail("reference-size", `${d} is ${lines} lines (limit 1500). Split it by heading and link both halves from the SKILL.md.`);
  else if (bytes > 100 * 1024) bigWarn.push(`${d} (${Math.round(bytes / 1024)} KB)`);
}
if (bigWarn.length) console.warn(`\n⚠ check-docs (warn): ${bigWarn.length} reference file(s) over 100 KB — consider splitting by heading:\n      ${bigWarn.join("\n      ")}\n`);

// === orphan-reference ===
for (const s of SKILLS) {
  const skillDir = r(`${SKILLS_DIR}/${s}`);
  const skillMd = docText[`${SKILLS_DIR}/${s}/SKILL.md`];
  if (!skillMd) continue;
  const linked = new Set([...skillMd.matchAll(/\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g)].map((m) => m[1].replace(/^\.\//, "")));
  for (const abs of walk(skillDir)) {
    const relToSkill = relative(skillDir, abs).split(sep).join("/");
    if (relToSkill === "SKILL.md") continue;
    if (!/^(references|scripts)\//.test(relToSkill)) { fail("orphan-reference", `${SKILLS_DIR}/${s}/${relToSkill}: only SKILL.md, references/ and scripts/ belong in a skill directory.`); continue; }
    if (!linked.has(relToSkill)) fail("orphan-reference", `${SKILLS_DIR}/${s}/${relToSkill} is not linked from ${s}/SKILL.md — add it to the routing table or delete it.`);
  }
}

// === claude-md-size ===
if (docText["CLAUDE.md"]) {
  const kb = Buffer.byteLength(docText["CLAUDE.md"]) / 1024;
  if (kb > 25) fail("claude-md-size", `CLAUDE.md is ${kb.toFixed(1)} KB (limit 25 KB). It holds conventions and the skills index only — move reference material into a skill.`);
  else if (kb > 15) console.warn(`\n⚠ check-docs (warn): CLAUDE.md is ${kb.toFixed(1)} KB (target ≤ 15 KB).\n`);
}

// === rule-anchors: the three layers of every business rule agree ===
{
  const RS = `${SKILLS_DIR}/charon-business-rules`;
  const refDocs = DOCS.filter((d) => d.startsWith(`${RS}/references/`));
  const base = (d) => d.split("/").pop();
  const narrativeHeadings = new Map(); // "narrative-x.md" -> Set of rule ids with a "## Rule N" heading
  for (const d of refDocs) {
    if (!/^narrative-/.test(base(d))) continue;
    narrativeHeadings.set(base(d), new Set([...docText[d].matchAll(/^## Rule (\d+[a-z]?)\b/gm)].map((m) => m[1])));
  }
  const invariantIds = new Map(); // id -> invariants file basename (without .md)
  for (const d of refDocs) {
    if (!/^invariants.*\.md$/.test(base(d))) continue;
    for (const line of docText[d].split("\n")) {
      const m = /^(\d+[a-z]?)\. \*\*/.exec(line);
      if (!m) continue;
      const id = m[1];
      if (invariantIds.has(id)) fail("rule-anchors", `rule ${id} has an invariant line in both ${invariantIds.get(id)}.md and ${base(d)}.`);
      invariantIds.set(id, base(d).replace(/\.md$/, ""));
      if (Number.parseInt(id, 10) <= NO_NARRATIVE_MAX) continue;
      // The pointer ends the paragraph, which may wrap: look ahead to the next numbered line.
      const para = docText[d].slice(docText[d].indexOf(line)).split(/\n(?=\d+[a-z]?\. \*\*)/)[0].trim();
      const ptr = /→ \[(narrative-[\w.-]+\.md)#rule-(\d+[a-z]?)\]\((narrative-[\w.-]+\.md)#rule-(\d+[a-z]?)\)\s*$/.exec(para);
      if (!ptr) { fail("rule-anchors", `${d}: rule ${id} does not end with a "→ [narrative-X.md#rule-${id}](narrative-X.md#rule-${id})" pointer.`); continue; }
      const [, textFile, textId, linkFile, linkId] = ptr;
      if (textFile !== linkFile || textId !== linkId) fail("rule-anchors", `${d}: rule ${id}'s pointer text (${textFile}#rule-${textId}) and link target (${linkFile}#rule-${linkId}) disagree.`);
      if (linkId !== id) fail("rule-anchors", `${d}: rule ${id}'s pointer targets rule ${linkId}.`);
      const heads = narrativeHeadings.get(linkFile);
      if (!heads) fail("rule-anchors", `${d}: rule ${id} points at ${linkFile}, which does not exist under ${RS}/references/.`);
      else if (!heads.has(id)) fail("rule-anchors", `${d}: rule ${id} points at ${linkFile}, which has no "## Rule ${id}" heading.`);
    }
  }
  // Index rows in SKILL.md: | N | title | invariants-file | narrative-file |  ("—" = none / retired)
  const skill = docText[`${RS}/SKILL.md`] ?? "";
  for (const m of skill.matchAll(/^\| (\d+[a-z]?) \| ((?:\\\||[^|])*) \| ([\w—.-]+) \| ([\w—.-]+) \|/gm)) {
    const [, id, , invCell, narrCell] = m;
    const invBase = invCell.replace(/\.md$/, "");
    const narrBase = narrCell.replace(/\.md$/, "");
    if (invBase !== "—") {
      if (!invariantIds.has(id)) fail("rule-anchors", `${RS}/SKILL.md: index row for rule ${id} but no "${id}. **" invariant line in any invariants*.md.`);
      else if (invariantIds.get(id) !== invBase) fail("rule-anchors", `${RS}/SKILL.md: index row says rule ${id} is in ${invBase}.md; its invariant line is in ${invariantIds.get(id)}.md.`);
    }
    if (narrBase === "—") {
      if (invBase !== "—" && Number.parseInt(id, 10) > NO_NARRATIVE_MAX) fail("rule-anchors", `${RS}/SKILL.md: rule ${id} needs a narrative file (only rules 1–${NO_NARRATIVE_MAX} have none by design).`);
      continue;
    }
    const heads = narrativeHeadings.get(`${narrBase}.md`);
    if (!heads) fail("rule-anchors", `${RS}/SKILL.md: index row for rule ${id} names ${narrBase}.md, which does not exist.`);
    else if (!heads.has(id)) fail("rule-anchors", `${RS}/SKILL.md: index row for rule ${id} names ${narrBase}.md, which has no "## Rule ${id}" heading.`);
  }
  for (const [file, ids] of narrativeHeadings) {
    for (const id of ids) if (!invariantIds.has(id)) fail("rule-anchors", `${RS}/references/${file} has a "## Rule ${id}" heading but no invariants*.md line states rule ${id}.`);
  }
}

// === util-tests (WARN-only) ===
const utilTestWarnings = [];
for (const base of tsFiles("src/utils")) {
  const src = read(`src/utils/${base}.ts`);
  if (!/\bexport\s+(async\s+)?(function|const|class)\b/.test(src)) continue;
  if (!exists(`tests/unit/${base}.test.ts`)) utilTestWarnings.push(`src/utils/${base}.ts`);
}
if (utilTestWarnings.length) {
  console.warn(
    `\n⚠ check-docs (warn): ${utilTestWarnings.length} src/utils file(s) with exports lack a tests/unit/<name>.test.ts:\n      ` +
      utilTestWarnings.join("\n      ") +
      `\n    Not a failure — but add coverage when you next touch one.\n`,
  );
}

// --- report ---
if (failures.length === 0) {
  console.log(`✓ check-docs: all structural doc checks passed (${DOCS.length} docs scanned).`);
  process.exit(0);
}
console.error(`\n✗ check-docs: ${failures.length} issue(s) found.\n`);
for (const { check, msg } of failures) console.error(`  [${check}] ${msg}\n`);
console.error(
  "These are structural checks (coverage + reference hygiene) — they don't judge prose accuracy.\n" +
    "Fix the docs (see /charon-docs-sync), or bypass this one commit with:  git commit --no-verify\n",
);
process.exit(1);
