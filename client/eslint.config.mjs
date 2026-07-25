// JSX-aware ESLint config for the client. Catches real JS mistakes and broken
// JSX so CI fails on them instead of letting them merge. Kept practical for a
// beginner: prop-types and unescaped-entities (apostrophes in copy) are off.
import js from "@eslint/js";
import react from "eslint-plugin-react";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";

export default [
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat["jsx-runtime"],
  jsxA11y.flatConfigs.recommended,
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      "react/prop-types": "off",
      "react/no-unescaped-entities": "off",
      // The rule's default depth (2) is too shallow for our checkbox-list
      // labels (<label><input/><span><span>title</span><span>meta</span>
      // </span></label>) — the accessible-name text sits three levels down.
      // Browsers compute accessible names with no such depth limit, so this
      // is a lint false positive, not a real a11y bug; raise the search
      // depth instead of flattening working markup.
      "jsx-a11y/label-has-associated-control": ["error", { depth: 25 }],
    },
  },
  {
    files: ["src/**/*.test.{js,jsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
];
