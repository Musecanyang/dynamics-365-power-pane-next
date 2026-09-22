/**
 * Syntax guard: run the Node parser (`node --check` equivalent) on every
 * script that ships in the extension, plus a JSON parse of manifest.json, so
 * a broken file fails fast instead of only after "Reload extension" on a
 * live page.
 */
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const FILES = [
  "background.js",
  "content/core.js",
  "content/main-world.js",
  "content/commands/general.js",
  "content/commands/runcode.js",
  "content/commands/records.js",
  "content/commands/forms.js",
  "content/commands/navigation.js",
  "content/commands/security.js",
  "content/commands/debug.js",
  "content/features/impersonation.js",
  "content/features/user-access.js",
  "content/features/snippets.js",
  "content/boot.js",
  "options/options.js",
  "src/actions.js",
  "src/constants.js",
  "src/util.js"
];

let failed = 0;
FILES.forEach(function (file) {
  try {
    execFileSync(process.execPath, ["--check", path.resolve(file)], { stdio: "ignore" });
    console.log("ok      " + file);
  } catch (error) {
    failed++;
    console.error("FAILED  " + file);
    console.error(String(error.stderr || error.message || ""));
  }
});

try {
  JSON.parse(fs.readFileSync(path.resolve("manifest.json"), "utf8"));
  console.log("ok      manifest.json");
} catch (error) {
  failed++;
  console.error("FAILED  manifest.json - invalid JSON: " + error.message);
}

if (failed) {
  console.error("\n" + failed + " file(s) failed the syntax check.");
  process.exit(1);
}
console.log("All " + FILES.length + " scripts and the manifest parsed successfully.");
