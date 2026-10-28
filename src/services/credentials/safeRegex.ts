/**
 * src/services/credentials/safeRegex.ts — operator-supplied regexes (polaris
 * business rule 116), Charon adaptation.
 *
 * Polaris compiles every operator pattern on `re2js` (linear-time RE2) so a
 * pathological pattern can never park a monitor worker. Charon does not carry
 * the re2js dependency, and — more to the point — never RUNS these patterns
 * against device data: there is no monitoring path, only save-time validation
 * and the occasional Test Connection body match against a capped response. So
 * this module keeps polaris's API and its RE2 *syntax* contract (no lookaround,
 * no backreferences — a pattern exported to polaris must still compile there)
 * and backs it with the native engine plus two guards:
 *
 *   - a static refusal (safeRegexProblem — every operator pattern's save-time
 *     check) of the classic catastrophic shapes: a repeated group that itself
 *     repeats, e.g. `(a+)+`, `(.*)*`, `(\w+\s?)*`;
 *   - callers clamp short subjects (clampRegexSubject), as in polaris; an HTTP
 *     check body is already capped by the probe (MAX_BODY_BYTES).
 *
 * Swap the engine for re2js if Charon ever starts polling devices.
 */

import { AppError } from "../../utils/errors.js";

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

/** Compile `pattern`. Throws AppError(400) with an operator-readable reason. */
export function compileSafeRegex(pattern: string, opts: SafeRegexOptions = {}): SafeRegex {
  if (typeof pattern !== "string") throw new AppError(400, "Regex must be a string");
  const key = `${opts.ignoreCase ? "i" : ""}\u0000${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (/\(\?[=!]|\(\?<[=!]/.test(pattern)) {
    throw new AppError(400, `Regex "${pattern}" uses lookahead or lookbehind, which is not supported (patterns must stay RE2-compatible). Rewrite it without (?= (?! (?<= (?<!.`);
  }
  if (/\\[1-9]/.test(pattern)) {
    throw new AppError(400, `Regex "${pattern}" uses a backreference (\\1 …), which is not supported (patterns must stay RE2-compatible).`);
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, opts.ignoreCase ? "i" : "");
  } catch (err) {
    throw new AppError(400, `Invalid regex "${pattern}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const toArr = (m: RegExpExecArray): Array<string | undefined> => Array.from(m, (g) => (g === undefined ? undefined : g));
  const compiled: SafeRegex = {
    source: pattern,
    test(s: string): boolean {
      re.lastIndex = 0;
      return re.test(String(s));
    },
    exec(s: string): Array<string | undefined> | null {
      re.lastIndex = 0;
      const m = re.exec(String(s));
      return m ? toArr(m) : null;
    },
    execAll(s: string): SafeMatch[] {
      const g = new RegExp(re.source, re.flags + "g");
      const subject = String(s);
      const all: SafeMatch[] = [];
      let m: RegExpExecArray | null;
      while ((m = g.exec(subject)) !== null) {
        const one = toArr(m) as SafeMatch;
        one.index = m.index;
        all.push(one);
        if (m[0] === "") g.lastIndex++;
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
