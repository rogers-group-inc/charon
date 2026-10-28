/**
 * src/utils/safeRegex.ts — operator-supplied regexes (polaris
 * business rule 116), Charon adaptation.
 *
 * Every operator pattern compiles on `re2js` (linear-time RE2), as in polaris,
 * so a pathological pattern can never park a worker: operator patterns run at
 * save-time validation, against a capped Test Connection body, and as
 * integration discovery filters over every discovered directory object
 * (utils/wildcard.ts → compilePattern). RE2 has no lookaround and no
 * backreferences; both are refused with an operator-readable reason.
 *
 * Charon addition: safeRegexProblem (the save-time check) still refuses the
 * classic nested-quantifier shapes (`(a+)+`) — harmless on RE2, but it keeps a
 * pattern portable to any engine an export lands on.
 */

import { RE2JS } from "re2js";
import { AppError } from "./errors.js";

export interface SafeRegex {
  /** The operator's pattern, as typed. */
  readonly source: string;
  /** Does the pattern match anywhere in `s` (unanchored, like RegExp.test)? */
  test(s: string): boolean;
  /** First match as [whole, group1, …] (unset groups → undefined), like RegExp.exec, or null. */
  exec(s: string): Array<string | undefined> | null;
  /** Every non-overlapping match, left to right, like a /g exec loop. */
  execAll(s: string): SafeMatch[];
}

/** One match from execAll: [whole, group1, …] plus where it started. */
export type SafeMatch = Array<string | undefined> & { index: number };

export interface SafeRegexOptions {
  ignoreCase?: boolean;
}

const cache = new Map<string, SafeRegex>();
const CACHE_MAX = 2000;

/** Why `pattern` cannot be used, in operator words, or null when it is acceptable. */
export function safeRegexProblem(pattern: string, opts: SafeRegexOptions = {}): string | null {
  try {
    compileSafeRegex(pattern, opts);
    // The catastrophic-shape refusal applies to OPERATOR patterns, which all
    // pass through here at save time. compileSafeRegex itself skips it so the
    // ported modules' own fixed parser patterns (e.g. `(?:\s+[A-Z-]+)*` in the
    // MIB module-header scan) still compile.
    if (hasNestedQuantifier(pattern)) {
      return `Regex "${pattern}" repeats a group that itself repeats (e.g. (a+)+), which can take exponential time. Simplify the pattern.`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * True when `pattern` holds a quantified group whose body is itself
 * quantified — the nested-quantifier shape behind most catastrophic
 * backtracking. Scans the source (escapes and character classes skipped).
 */
export function hasNestedQuantifier(pattern: string): boolean {
  // Stack of "does the currently-open group contain a quantifier?" flags.
  const stack: boolean[] = [];
  let inClass = false;
  const isQuant = (c: string | undefined) => c === "*" || c === "+" || c === "?" || c === "{";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") { i++; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "(") { stack.push(false); continue; }
    if (c === ")") {
      const inner = stack.pop() ?? false;
      const next = pattern[i + 1];
      // `?` alone after a group is a 0/1 choice, not repetition.
      const repeats = next === "*" || next === "+" || next === "{";
      if (inner && repeats) return true;
      if (stack.length && (inner || isQuant(next))) stack[stack.length - 1] = true;
      continue;
    }
    if ((c === "*" || c === "+" || c === "{") && stack.length) stack[stack.length - 1] = true;
  }
  return false;
}

function describeRe2Error(pattern: string, message: string): string {
  if (/\(\?[=!<]/.test(pattern)) {
    return `Regex "${pattern}" uses lookahead or lookbehind, which is not supported (patterns run on the linear-time RE2 engine). Rewrite it without (?= (?! (?<= (?<!.`;
  }
  if (/\\[1-9]/.test(pattern)) {
    return `Regex "${pattern}" uses a backreference (\\1 …), which is not supported (patterns run on the linear-time RE2 engine).`;
  }
  return `Invalid regex "${pattern}": ${message.replace(/^error parsing regexp:\s*/i, "")}`;
}

/** Compile `pattern` on RE2. Throws AppError(400) with an operator-readable reason. */
export function compileSafeRegex(pattern: string, opts: SafeRegexOptions = {}): SafeRegex {
  if (typeof pattern !== "string") throw new AppError(400, "Regex must be a string");
  const key = `${opts.ignoreCase ? "i" : ""}\u0000${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let re: RE2JS;
  try {
    re = RE2JS.compile(pattern, opts.ignoreCase ? RE2JS.CASE_INSENSITIVE : 0);
  } catch (err) {
    throw new AppError(400, describeRe2Error(pattern, err instanceof Error ? err.message : String(err)));
  }
  const compiled: SafeRegex = {
    source: pattern,
    test(s: string): boolean {
      return re.matcher(String(s)).find();
    },
    exec(s: string): Array<string | undefined> | null {
      const m = re.matcher(String(s));
      if (!m.find()) return null;
      const out: Array<string | undefined> = [];
      for (let i = 0; i <= m.groupCount(); i++) {
        const g = m.group(i);
        out.push(g === null || g === undefined ? undefined : g);
      }
      return out;
    },
    execAll(s: string): SafeMatch[] {
      const m = re.matcher(String(s));
      const all: SafeMatch[] = [];
      while (m.find()) {
        const one = [] as unknown as SafeMatch;
        for (let i = 0; i <= m.groupCount(); i++) {
          const g = m.group(i);
          one.push(g === null || g === undefined ? undefined : g);
        }
        one.index = m.start();
        all.push(one);
      }
      return all;
    },
  };
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, compiled);
  return compiled;
}

/** compileSafeRegex, or null when the pattern does not compile — for consumers of STORED patterns. */
export function tryCompileSafeRegex(pattern: string, opts: SafeRegexOptions = {}): SafeRegex | null {
  try {
    return compileSafeRegex(pattern, opts);
  } catch {
    return null;
  }
}
