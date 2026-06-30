#!/usr/bin/env node
/**
 * scripts/copy-build-assets.mjs — copy non-TypeScript runtime assets into dist/.
 *
 * `tsc` only emits .js / .d.ts and silently ignores data files, so any file
 * the server reads at runtime *relative to its own compiled location*
 * (import.meta.url) must be copied into dist/ by hand after the compile.
 *
 * Charon currently ships no dist-relative non-.ts runtime assets (the agent
 * GUI lives under agent/ and is built in CI, not by the server tsc). This
 * step is kept as the second half of `npm run build` so that the moment a
 * service starts reading a bundled data file from a dist-relative path, the
 * copy is already wired in — just add an entry to ASSETS.
 */
import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Asset groups to mirror from src/<dir> into dist/<dir>, filtered by extension. */
const ASSETS = [];

let copied = 0;
for (const { dir, exts } of ASSETS) {
  const srcDir = join(ROOT, "src", dir);
  const outDir = join(ROOT, "dist", dir);

  let names;
  try {
    names = readdirSync(srcDir);
  } catch (err) {
    console.error(`copy-build-assets: cannot read source dir ${srcDir}: ${err.message}`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  for (const name of names) {
    if (!exts.some((e) => name.endsWith(e))) continue;
    const from = join(srcDir, name);
    if (!statSync(from).isFile()) continue;
    cpSync(from, join(outDir, name));
    copied++;
  }
}

console.log(`copy-build-assets: copied ${copied} asset file(s) into dist/`);
