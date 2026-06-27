import eslint from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import globals from "globals";

const tsRules = {
  ...tsPlugin.configs.recommended.rules,
  "no-unused-vars": "off",
  "@typescript-eslint/no-unused-vars": [
    "error",
    { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }
  ],
  "@typescript-eslint/consistent-type-imports": "error",
  "@typescript-eslint/no-explicit-any": "warn"
};

export default [
  eslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true }
      },
      globals: {
        ...globals.node,
        NodeJS: "readonly",
        RequestInit: "readonly"
      }
    },
    plugins: {
      "@typescript-eslint": tsPlugin
    },
    rules: {
      ...tsRules,
      "preserve-caught-error": "off"
    }
  },
  {
    files: ["src/ui/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        NodeJS: "readonly",
        RequestInit: "readonly"
      }
    },
    rules: {
      "no-import-assign": "off"
    }
  },
  {
    files: ["tests/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
        NodeJS: "readonly",
        RequestInit: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { "disallowTypeAnnotations": false }
      ]
    }
  },
  {
    ignores: ["dist/**", "node_modules/**", "data/**"]
  }
];