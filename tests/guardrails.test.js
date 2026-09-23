/**
 * Guardrail tests (formerly scripts/check-syntax.js + check-bridge-sync.js).
 *
 * Running these as plain node:test cases keeps ONE test command (`npm test`)
 * as the whole quality gate: parse every shipped runtime file, validate the
 * manifest JSON, and assert the bridge/debug markers are byte-identical
 * between shared/constants.js (PP namespace) and content/main-world.js (the
 * MAIN-world cannot load that file - crbug.com/324096753).
 */
"use strict";

const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

/** Every runtime file that ships with the extension. */
const SHIPPED_FILES = [
  "manifest.json",
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
  "shared/actions.js",
  "shared/constants.js",
  "shared/util.js"
];

test("every shipped script parses and the manifest is valid JSON", () => {
  SHIPPED_FILES.forEach(function (file) {
    assert.ok(fs.existsSync(path.resolve(file)), "missing shipped file: " + file);
    try {
      if (file.endsWith(".json")) {
        JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
      } else {
        execFileSync(process.execPath, ["--check", path.resolve(file)], {
          stdio: "ignore"
        });
      }
    } catch (error) {
      const detail = String((error.stderr && error.stderr.toString()) || error.message);
      assert.fail("syntax/JSON failure in " + file + "\n" + detail);
    }
  });
});

/**
 * Extract the BRIDGE block's KEY / REQUEST / RESPONSE literals and the
 * PP.DEBUG literal from shared/constants.js.
 */
function declaredMarkers(source) {
  const block = /BRIDGE:\s*{([\s\S]*?)}/.exec(source);
  if (!block) throw new Error("BRIDGE block not found in shared/constants.js.");
  const markers = { KEY: "", REQUEST: "", RESPONSE: "" };
  block[1].replace(
    /(KEY|REQUEST|RESPONSE):\s*"([^"]*)"/g,
    function (whole, name, value) {
      if (!markers[name]) markers[name] = value;
      return whole;
    }
  );
  const debug = /DEBUG:\s*"([^"]*)"/.exec(source);
  if (debug) markers.DEBUG = debug[1];
  return markers;
}

test("bridge + debug markers are in sync between shared/constants.js and content/main-world.js", () => {
  const constantsSource = fs.readFileSync(path.resolve("shared/constants.js"), "utf8");
  const markers = declaredMarkers(constantsSource);

  const mainWorldSource = fs.readFileSync(path.resolve("content/main-world.js"), "utf8");
  const declared = {};
  mainWorldSource.replace(
    /const\s+(BRIDGE_KEY|BRIDGE_REQUEST|BRIDGE_RESPONSE|DEBUG_KEY)\s*=\s*"([^"]*)"/g,
    function (whole, symbol, value) {
      declared[symbol] = value;
      return whole;
    }
  );

  const expected = {
    KEY: "BRIDGE_KEY",
    REQUEST: "BRIDGE_REQUEST",
    RESPONSE: "BRIDGE_RESPONSE",
    DEBUG: "DEBUG_KEY"
  };
  Object.keys(expected).forEach(function (name) {
    assert.ok(
      declared[expected[name]] !== undefined,
      "main-world.js must declare " + expected[name]
    );
    assert.strictEqual(
      declared[expected[name]],
      markers[name],
      expected[name] + ' must be byte-identical to PP.' +
        (name === "DEBUG" ? "DEBUG" : "BRIDGE." + name) +
        " in shared/constants.js"
    );
  });
});
