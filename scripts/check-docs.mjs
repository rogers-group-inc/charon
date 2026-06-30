#!/usr/bin/env node
/**
 * scripts/check-docs.mjs — guardrail that the four living docs exist and are
 * non-trivial. Wire into CI to nudge "update the docs on every commit".
 */
import { existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = ["CLAUDE.md", "ARCHITECTURE.md", "TEMPLATES.md", "TOUCHES.md"];
const MIN_BYTES = 500;

let ok = true;
for (const f of REQUIRED) {
  const p = join(ROOT, f);
  if (!existsSync(p)) {
    console.error(`check-docs: MISSING ${f}`);
    ok = false;
  } else if (statSync(p).size < MIN_BYTES) {
    console.error(`check-docs: ${f} is suspiciously small (<${MIN_BYTES} bytes)`);
    ok = false;
  }
}
if (!ok) process.exit(1);
console.log(`check-docs: all ${REQUIRED.length} living docs present.`);
