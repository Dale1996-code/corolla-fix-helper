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
    files: [
      "server/src/initDatabase.js",
      "server/src/scripts/importFolder.js",
      "server/src/services/aiAnswerService.js",
      "server/test/importFolder.test.js",
      "server/test/seedData.test.js",
    ],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        Buffer: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
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
