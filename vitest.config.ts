import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    // .claude/worktrees/<slug> holds full scratch checkouts of this repo (one per
    // in-flight branch); without this every worktree's tests are collected too.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
