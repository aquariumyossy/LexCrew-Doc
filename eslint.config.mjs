import officeAddins from "eslint-plugin-office-addins";
import tsEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

/**
 * office-addin-lint looks for this file and, if missing, falls back to a
 * browser-only config. This project also lints the Node sidecar, so names
 * like `process` and types like `RequestInit` were reported as undefined.
 * TypeScript already checks that; `no-undef` does not understand types.
 */
export default [
  {
    ignores: ["dist/**", "node_modules/**", "src-tauri/**"],
  },
  ...officeAddins.configs.react,
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs,cts,mts}"],
    plugins: {
      "@typescript-eslint": tsEslint,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];
