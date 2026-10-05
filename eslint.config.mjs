import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/",
      "**/dist/",
      "**/build/",
      "**/.svelte-kit/",
      "dev-data/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Shared contracts are types only, so they must be imported as types.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },
  {
    // Nest injects by the class itself, so constructor parameter types must stay value imports.
    files: ["apps/api/**/*.ts"],
    rules: { "@typescript-eslint/consistent-type-imports": "off" },
  },
  {
    files: ["apps/web/**/*.{ts,svelte}"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    files: ["apps/web/static/sw.js"],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
);
