/**
 * ESLint flat config.
 *
 * Scope: correctness checks that flag REAL hazards (undefined references,
 * duplicate declarations) - the recent `modal is not defined` content-script
 * crash is exactly the class of bug this config catches before the
 * "Reload extension" step. Style decisions (quotes, semicolons, spacing) keep
 * the codebase's existing conventions.
 *
 * File environments:
 *   - content/ + shared/  browser page world (`window`, `chrome`; MAIN world
 *                         also touches the page globals Xrm / Mscrm)
 *   - background.js       service worker (importScripts / self, no DOM)
 *   - tests/              plain Node (CommonJS tooling; the guardrails live here too)
 */
import globals from "globals";

/** Hazard rules shared by every environment. */
const RULES = {
  // Hazard classes - these have already produced shipped bugs:
  "no-undef": "error", // `modal is not defined` class of failure
  "no-redeclare": "error",
  "no-dupe-keys": "error",
  "no-dupe-args": "error",
  "no-const-assign": "error",
  "no-fallthrough": "error",
  "no-cond-assign": ["error", "except-parens"],
  "no-self-assign": "error",
  "no-return-assign": "error",
  "no-async-promise-executor": "error",
  "no-compare-neg-zero": "error",
  "valid-typeof": "error",
  // Standards hygiene:
  "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
  "no-var": "error",
  "eqeqeq": ["error", "smart"],
  "prefer-const": "warn"
};

const EXTENSION_RULES = {
  ...RULES,
  "no-template-curly-in-string": "warn",
  "require-atomic-updates": "warn"
};

export default [
  {
    ignores: ["node_modules/**"]
  },
  {
    // Extension runtime sources: browser page context + chrome.* APIs.
    files: ["content/**/*.js", "shared/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        chrome: "readonly",
        // Page-world globals inspected by the MAIN-world bridge:
        Xrm: "readonly",
        Mscrm: "readonly"
      }
    },
    rules: EXTENSION_RULES
  },
  {
    files: ["background.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.serviceworker, chrome: "readonly" }
    },
    rules: RULES
  },
  {
    // Node tests use CommonJS (require / process / node:test).
    files: ["tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node }
    },
    rules: RULES
  }
];
