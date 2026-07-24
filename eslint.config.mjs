import js from "@eslint/js";

export default [
  {
    ignores: [
      "node_modules/**",
      "client/node_modules/**",
      "server/node_modules/**",
      "client/dist/**",
      "server/data/**",
      "server/uploads/**",
    ],
  },
  {
    // Lint the whole server (source, scripts, evals, and tests). Client linting
    // needs a JSX-aware setup and is handled separately.
    files: ["server/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        AbortController: "readonly",
        AbortSignal: "readonly",
        Buffer: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        fetch: "readonly",
        performance: "readonly",
        process: "readonly",
        ReadableStream: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        structuredClone: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
];
