import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * `tsconfigRootDir` is pinned because sibling worktrees (`.kilo/worktrees/*`) contain their own
 * tsconfig.json, which makes typescript-eslint's root inference ambiguous and fails the whole run.
 */
const tsconfigRootDir = import.meta.dirname;

export default tseslint.config(
  {
    ignores: [
      "dist",
      "coverage",
      ".kilo",
      "src-tauri/target",
      "src-tauri/gen",
      "src-tauri/icons",
      "src-tauri/binaries",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: { tsconfigRootDir },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      globals: globals.node,
      parserOptions: { tsconfigRootDir },
    },
  },
);
