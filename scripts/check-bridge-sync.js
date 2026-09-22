/**
 * Bridge marker assertion.
 *
 * The MAIN world cannot share src/constants.js (crbug.com/324096753 - see
 * that file's header), so content/main-world.js keeps its own copy of the
 * three bridge markers. This script keeps that promise verifiable: both files
 * must declare identical values, and any divergence fails the check before it
 * ships.
 *
 * Run manually with `npm run check` or by CI (see .github/workflows/ci.yml).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Extract the BRIDGE block's KEY / REQUEST / RESPONSE literals and the PP.DEBUG literal. */
function declaredMarkers(source) {
  const block = /BRIDGE:\s*{([\s\S]*?)}/.exec(source);
  if (!block) throw new Error("BRIDGE block not found in src/constants.js.");
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

const constantsSource = fs.readFileSync(path.resolve("src/constants.js"), "utf8");
const markers = declaredMarkers(constantsSource);

const mainWorldSource = fs.readFileSync(path.resolve("content/main-world.js"), "utf8");

let failed = 0;
Object.keys(markers).forEach(function (name) {
  const value = markers[name];
  // BRIDGE_* markers are `const BRIDGE_<NAME> = "..."` copies; the DEBUG gate
  // key is copied as DEBUG_KEY. Both must stay byte-identical to src/constants.
  const pattern =
    name === "DEBUG"
      ? new RegExp("const\\s+DEBUG_KEY\\s*=\\s*\"" + value + "\"")
      : new RegExp(
          "const\\s+BRIDGE_" + name + "\\s*=\\s*\"" + value + "\""
        );
  if (pattern.test(mainWorldSource)) {
    console.log("ok      " + (name === "DEBUG" ? "DEBUG_KEY" : "BRIDGE_" + name) + " = \"" + value + "\"");
  } else {
    failed++;
    const symbol = name === "DEBUG" ? "DEBUG_KEY" : "BRIDGE_" + name;
    console.error(
      "FAILED  " + symbol + ': src/constants.js declares "' + value +
      '" but content/main-world.js does not declare the same marker.'
    );
  }
});

if (failed) {
  console.error("\nBridge marker drift: update content/main-world.js to match PP.BRIDGE / PP.DEBUG.");
  process.exit(1);
}
console.log("Bridge markers are in sync.");
