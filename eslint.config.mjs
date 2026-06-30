// Pragmatic starter ESLint flat config for the TypeScript backend (src/).
//
// Deliberately conservative: a SMALL set of high-value correctness/hygiene
// rules, not the full recommended set. Type-checked rules are intentionally
// OFF — `npm run typecheck` already covers type correctness.
//
// Frontend (public/) is plain browser globals and is not linted here.
// Generated Prisma client + vendored libs are ignored.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "src/generated/**",
      "public/js/vendor/**",
      "dist/**",
      "node_modules/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ["src/**/*.ts"],
  })),
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "smart"],
      "@typescript-eslint/no-explicit-any": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-unused-vars": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
    },
  },
);
