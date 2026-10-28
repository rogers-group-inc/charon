#!/usr/bin/env node
// Version-pin consistency guard: every declaration site of a runtime version agrees, so a bump
// can't land in four sites of six and leave the fifth provisioning the old runtime. Pure file
// reads — no npm, network or database.
//
// Run:  npm run check:versions      (or: node scripts/check-versions.mjs [--json])
// Wired as a pre-commit arm (.githooks/pre-commit) and a CI step (.github/workflows/check-docs.yml).
//
// FAMILIES mirrors the "Family index" table in
// .claude/skills/charon-tech-lifecycle/references/version-pin-inventory.md — the two drift
// together or not at all. Each site is { file, label, kind: pin|floor|prose, re } where `re`
// captures the version; whole-line comments are blanked first so a comment never reads as a pin
// (prose sites are matched against the raw text). Asserts floors agree, pins agree, floor <= pin.
//
// Then the EOL dataset (scripts/data/platformEol.json): it parses; every technology has
// `source` + `sourceCheckedOn`; `reviewedAt` older than 120 days warns; and a family whose pin
// sits on a track past its `eol` WARNS (an upgrade is a decision, not a commit-blocker).
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const blankComments = (text) => text.split("\n").map((l) => (/^\s*(#|\/\/)/.test(l) ? "" : l)).join("\n");

const FAMILIES = [
  {
    id: "node-major", agree: "major", eolId: "node",
    sites: [
      { file: "package.json", label: "engines.node", kind: "floor", re: /"node":\s*">=(\d+)/ },
      { file: "package.json", label: "@types/node", kind: "floor", re: /"@types\/node":\s*"\^(\d+)/ },
      { file: "Dockerfile", label: "builder FROM", kind: "pin", re: /^FROM node:(\d+)[^\n]*AS builder/m },
      { file: "Dockerfile", label: "runtime FROM", kind: "pin", re: /^FROM node:(\d+)[^\n]*AS runtime/m },
      { file: "Dockerfile.dev", label: "FROM", kind: "pin", re: /^FROM node:(\d+)/m },
      { file: ".github/workflows/ci.yml", label: "setup-node", kind: "pin", re: /node-version:\s*"?(\d+)/ },
      { file: ".github/workflows/check-docs.yml", label: "setup-node", kind: "pin", re: /node-version:\s*"?(\d+)/ },
      { file: "deploy/install-rhel.sh", label: "minimum check", kind: "floor", re: /-lt (\d+) \]\]/ },
      { file: "deploy/install-rhel.sh", label: "NodeSource setup_N.x", kind: "pin", re: /setup_(\d+)\.x/ },
    ],
  },
  {
    id: "postgres-major", agree: "major", eolId: "postgres",
    sites: [
      { file: "compose.dev.yml", label: "postgres image", kind: "pin", re: /image:\s*\S*postgres:(\d+)/ },
      { file: "compose.podman.yml", label: "postgres image", kind: "pin", re: /image:\s*\S*postgres:(\d+)/ },
      { file: "compose.setup.yml", label: "postgres image", kind: "pin", re: /image:\s*\S*postgres:(\d+)/ },
      { file: "deploy/install-rhel.sh", label: "postgresqlN-server", kind: "pin", re: /postgresql(\d+)-server/ },
      { file: "deploy/install-rhel.sh", label: "postgresql-N unit", kind: "pin", re: /enable --now postgresql-(\d+)/ },
    ],
  },
  {
    id: "openssl-minor", agree: "minor", eolId: "openssl",
    sites: [
      { file: "deploy/nginx/Dockerfile.pqc", label: "ARG OPENSSL_VERSION", kind: "pin", re: /ARG OPENSSL_VERSION=(\d+\.\d+)/ },
      { file: "deploy/install-rhel.sh", label: "openssl tarball", kind: "pin", re: /openssl-(\d+\.\d+)\.\d+\.tar\.gz/ },
      { file: "deploy/install-rhel.sh", label: "/opt/openssl-X.Y prefix", kind: "prose", re: /\/opt\/openssl-(\d+\.\d+)/ },
      { file: "deploy/nginx/Dockerfile.pqc", label: "/opt/openssl-X.Y prefix", kind: "prose", re: /\/opt\/openssl-(\d+\.\d+)/ },
    ],
  },
  {
    id: "rust-msrv", agree: "minor", eolId: null,
    sites: [
      { file: "agent/src-tauri/Cargo.toml", label: "rust-version", kind: "floor", re: /^rust-version\s*=\s*"(\d+\.\d+)/m },
    ],
  },
];

const failures = [];
const warnings = [];
const cmp = (a, b) => {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};
const results = {};

for (const fam of FAMILIES) {
  const found = [];
  for (const s of fam.sites) {
    if (!existsSync(join(ROOT, s.file))) { failures.push(`[${fam.id}] ${s.file} (${s.label}) is listed as a site but does not exist.`); continue; }
    const raw = read(s.file);
    const m = s.re.exec(s.kind === "prose" ? raw : blankComments(raw));
    if (!m) { failures.push(`[${fam.id}] ${s.file} (${s.label}): no version found — the site moved or its form changed; update FAMILIES and the inventory.`); continue; }
    found.push({ ...s, version: m[1] });
  }
  const pins = found.filter((s) => s.kind !== "floor");
  const floors = found.filter((s) => s.kind === "floor");
  const uniq = (list) => [...new Set(list.map((s) => s.version))];
  if (uniq(pins).length > 1) failures.push(`[${fam.id}] pins disagree: ${pins.map((s) => `${s.file} ${s.label}=${s.version}`).join(", ")}`);
  if (uniq(floors).length > 1) failures.push(`[${fam.id}] floors disagree: ${floors.map((s) => `${s.file} ${s.label}=${s.version}`).join(", ")}`);
  const pin = uniq(pins)[0];
  const floor = uniq(floors)[0];
  if (pin && floor && cmp(floor, pin) > 0) failures.push(`[${fam.id}] floor ${floor} exceeds pin ${pin}.`);
  results[fam.id] = { pin: pin ?? null, floor: floor ?? null, sites: found.length };
}

// --- EOL dataset ---
const DATA = "scripts/data/platformEol.json";
let dataset = null;
if (!existsSync(join(ROOT, DATA))) failures.push(`${DATA} is missing.`);
else {
  try { dataset = JSON.parse(read(DATA)); } catch (e) { failures.push(`${DATA} does not parse: ${e.message}`); }
}
if (dataset) {
  const today = new Date();
  const ageDays = (today - new Date(dataset.reviewedAt)) / 86_400_000;
  if (!(ageDays >= 0)) failures.push(`${DATA}: reviewedAt "${dataset.reviewedAt}" is not a past date.`);
  else if (ageDays > 120) warnings.push(`${DATA} was last reviewed ${Math.round(ageDays)} days ago (> 120) — run the refresh procedure (eol-dataset.md).`);
  const byId = new Map((dataset.technologies ?? []).map((t) => [t.id, t]));
  for (const t of byId.values()) {
    if (!t.source || !t.sourceCheckedOn) failures.push(`${DATA}: technology "${t.id}" needs source + sourceCheckedOn.`);
  }
  for (const fam of FAMILIES) {
    if (!fam.eolId) continue;
    const tech = byId.get(fam.eolId);
    if (!tech) { failures.push(`${DATA}: no technology "${fam.eolId}" for family ${fam.id}.`); continue; }
    const pin = results[fam.id].pin;
    const track = tech.tracks?.find((tr) => pin && (tr.track === pin || pin.startsWith(`${tr.track}.`)));
    if (!track) { warnings.push(`[${fam.id}] pin ${pin} has no track in ${DATA} — add it.`); continue; }
    if (track.eol && new Date(track.eol) < today) warnings.push(`[${fam.id}] pinned ${tech.label} ${track.track} reached end of life on ${track.eol} (${tech.source}). Plan the upgrade — charon-tech-lifecycle → upgrade-playbooks.md.`);
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ok: failures.length === 0, results, failures, warnings }, null, 2));
  process.exit(failures.length ? 1 : 0);
}
for (const w of warnings) console.warn(`⚠ check-versions (warn): ${w}`);
if (failures.length === 0) {
  console.log(`✓ check-versions: ${FAMILIES.length} families consistent (${Object.entries(results).map(([k, v]) => `${k} ${v.pin ?? v.floor}`).join(", ")}).`);
  process.exit(0);
}
console.error(`\n✗ check-versions: ${failures.length} issue(s):\n`);
for (const f of failures) console.error(`  ${f}`);
console.error("\nThe site list per family is .claude/skills/charon-tech-lifecycle/references/version-pin-inventory.md.");
process.exit(1);
