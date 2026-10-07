// ESLint flat config: Node/CommonJS for the server, browser scripts for backend/public/js,
// Jest globals for tests. Correctness rules only; formatting is Prettier's job.
const js = require("@eslint/js");
const globals = require("globals");

const sharedRules = {
  "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
  "no-empty": ["error", { allowEmptyCatch: true }],
  eqeqeq: ["error", "smart"],
  "no-var": "off",
};

module.exports = [
  {
    ignores: ["node_modules/**", "coverage/**", "public/vendor/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: sharedRules,
  },
  {
    // Server code logs through utils/logger (pino, with secret redaction), not console.
    files: ["app.js", "server.js", "config/**/*.js", "controllers/**/*.js", "middleware/**/*.js", "models/**/*.js", "routes/**/*.js", "services/**/*.js", "utils/**/*.js"],
    rules: { "no-console": "warn" },
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
  },
  {
    // Puppeteer suites: code inside page.evaluate() runs in the browser.
    files: ["tests/e2e/**/*.js"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["public/js/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        katex: "readonly",
        renderMathInElement: "readonly",
        google: "readonly",
        AppleID: "readonly",
      },
    },
  },
];
