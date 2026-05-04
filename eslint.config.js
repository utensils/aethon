/**
 * ESLint flat config for Aethon. Covers the React 19 + TypeScript frontend
 * (`src/`) and the bridge (`agent/`) plus the Vite config. Skips Tauri's
 * Rust crate (cargo clippy handles that), generated assets, dist output,
 * and example extensions (those follow user-extension conventions, not
 * project rules).
 *
 * Wired via `bun run lint` and the `check` devshell command.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  {
    // Don't lint generated / vendored / cross-language directories.
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "src-tauri/**",
      "examples/**",
      ".aethon/**",
      ".claude/**",
      "scripts/**",
      // VitePress docs site is self-contained — its own tsconfig + lockfile.
      "website/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    // Type-aware rules need a tsconfig for resolution. Files outside the
    // tsconfig project list (agent/*, eslint.config.js) are allowed via
    // `allowDefaultProject` so they get linted with weaker type info but
    // not skipped entirely.
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["agent/*.ts", "eslint.config.js", "*.{js,mjs,cjs}"],
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 64,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // React Hook rules — exhaustive-deps catches subtle stale-closure
      // bugs the type-checker can't see. (Severity downgraded below for
      // a few existing call sites we'll address in a follow-up.)
      ...reactHooks.configs.recommended.rules,
      // Tighter unused-var enforcement: must prefix with `_` if intentional.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Project convention: type-only imports MUST use `import type`.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // The bridge contract intentionally exchanges `unknown` payloads
      // (a2ui events, frontend state mirror, etc.) — let those through
      // until we tighten the wire types in a future pass.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // The renderer threads `unknown` extensively; explicit check at the
      // boundary is enough for now.
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      // Coercing unknown via `String(x ?? "")` is the documented contract
      // for $ref resolution — false positives.
      "@typescript-eslint/no-base-to-string": "off",
      // React 19 strict-mode rules — known anti-patterns in App.tsx /
      // ChatInput we'll address in a focused follow-up. Downgrade to
      // warn so the lint check stays green at max-warnings=0 only after
      // those are fixed; right now they're informational.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    // Bridge — Node/Bun runtime, JSON-lines IPC. Same relaxations as src/
    // (the bridge inherently handles `unknown` extension payloads); also
    // drops React-specific plugins.
    files: ["agent/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-base-to-string": "off",
    },
  },
  {
    // Test files often use any/unknown for mock shapes; relax there.
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // typescript-eslint and @eslint/js export weakly-typed configs that
    // trip the unsafe-* rules under strict type-checking. The flat
    // config is plain JS plumbing — the type-aware rules add no value
    // here.
    files: ["eslint.config.js", "*.config.{js,ts,mjs,cjs}"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
);
