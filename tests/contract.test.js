/**
 * Contract-surface tests for `window.PPMain` (content/main-world.js).
 *
 * The MAIN-world bridge is a FROZEN object; command files destructure their
 * dependencies out of it (`const { webApiGet, ... } = PPmain`). If a key is
 * missing from the surface, the destructured value is `undefined`, the handler
 * throws `undefined is not a function` inside a catch, and the user sees a
 * silent fallback instead of the real result - exactly what happened with
 * `parseRetrieveMultipleResponse` (Execute FetchXML always rendered the raw
 * XML dialog, v1.1.0).
 *
 * These tests guard BOTH halves of the drift equation:
 *   1. the documented PPMain key set (snapshot) - a missing or renamed key is
 *      a deliberate contract change, so it must edit the expected list;
 *   2. every key destructured from `window.PPMain` by content/commands/*.js
 *      (the real consumer contract) exists on the loaded surface.
 * Together they make "split a file, forget the contract" fail CI instead of
 * failing the user's screen.
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

/**
 * Load content/main-world.js in a sandbox and return the frozen PPMain
 * surface. Minimal window stub - main-world.js only attaches a message
 * listener and a test hook at load time; every runtime call stays in the
 * (lazily registered) command handlers.
 */
function loadPPMain() {
  const source = fs.readFileSync(path.resolve("content/main-world.js"), "utf8");
  const sandboxWindow = {
    addEventListener: function () {},
    removeEventListener: function () {},
    postMessage: function () {}
  };
  const sandbox = { window: sandboxWindow, location: {}, navigator: {} };
  vm.runInNewContext(source, sandbox);
  assert.ok(sandbox.window.PPMain, "main-world.js must attach window.PPMain");
  return sandbox.window.PPMain;
}

/**
 * Every key PPMain must expose (the contract implemented as the PPMain object
 * in content/main-world.js and live-verified by the consumer test below).
 * Frozen list: adding, removing or renaming a key is a contract
 * change and edits this file in the same commit as the consumer.
 */
const EXPECTED_PPMAIN_KEYS = [
  "register",
  "get",
  "getXrm",
  "requireForm",
  "clientUrl",
  "objectTypeCode",
  "buildRecordUrl",
  "apiVersion",
  "baseUrl",
  "webApiGet",
  "webApiGetAll",
  "webPatch",
  "webAssoc",
  "webDisassoc",
  "xmlEncode",
  "parseRetrieveMultipleResponse",
  "xmlEscapeText",
  "xmlEscapeAttr",
  "prettyXml",
  "applyUrlParam",
  "getEntitySolutionId",
  "formattedValue",
  "findContainer",
  "debugLog",
  "MIN_USER_SEARCH_LENGTH",
  "ROLE_CHECK_USER_LIMIT",
  "ENTITY_SEARCH_LIMIT"
];

/** Names a `const { ... } = PPmain;` destructure pulls out of the contract. */
function collectDestructuredNames(source) {
  const names = [];
  const destructures = /const\s*{([^}]*)}\s*=\s*PPmain\s*;/g;
  let match;
  while ((match = destructures.exec(source))) {
    match[1].split(",").forEach(function (raw) {
      const key = raw.trim();
      if (key) names.push(key);
    });
  }
  return names;
}

test("PPMain exposes exactly the documented contract keys", function () {
  const PPMain = loadPPMain();
  const expected = EXPECTED_PPMAIN_KEYS.slice().sort();
  const actual = Object.keys(PPMain).sort();
  assert.deepStrictEqual(
    actual,
    expected,
    "PPMain key drift: update this snapshot in the same commit as the consumer " +
      "(content/commands/*.js or content/main-world.js), never after it."
  );
});

test("every key content/commands/*.js destructures exists on PPMain", function () {
  const PPMain = loadPPMain();
  const commandsDir = path.resolve("content/commands");
  const files = fs
    .readdirSync(commandsDir)
    .filter(function (name) {
      return /\.js$/.test(name);
    })
    .sort();

  files.forEach(function (name) {
    const source = fs.readFileSync(path.join(commandsDir, name), "utf8");
    const names = collectDestructuredNames(source);
    names.forEach(function (key) {
      assert.ok(
        typeof PPMain[key] !== "undefined",
        name + " destructures \"" + key + "\" but PPMain does not expose it - " +
          "add it to the PPMain contract (content/main-world.js) when you move " +
          "the implementation."
      );
    });
  });
});
