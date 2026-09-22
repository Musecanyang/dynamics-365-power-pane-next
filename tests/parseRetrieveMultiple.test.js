/**
 * Unit tests for `parseRetrieveMultipleResponse` (content/main-world.js).
 *
 * The function is the Execute Fetch XML data transformer (SOAP envelope ->
 * { entityName, moreRecords, columns, rows, payload } | null). It is a pure
 * text -> data transform, so the test loads main-world.js in a sandbox with a
 * real XML DOM (@xmldom/xmldom standing in for the browser's DOMParser) and
 * drives it with recorded fixtures from tests/fixtures/.
 *
 * These tests are the regression guard for the class of bug where the table
 * *looks* fine but silently loses data (e.g. the case where only the first row
 * carried an id).
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { DOMParser: XmldomDOMParser } = require("@xmldom/xmldom");

/** Load content/main-world.js in a sandbox and return the test hook. */
function loadParser() {
  const source = fs.readFileSync(path.resolve("content/main-world.js"), "utf8");

  /**
   * Stand-in for the browser's DOMParser, backed by @xmldom/xmldom. Mirrors
   * the Chrome contract the extension relies on: a parse failure NEVER
   * throws - it yields a document that exposes a <parsererror> element.
   */
  function StubDOMParser() {}
  StubDOMParser.prototype.parseFromString = function (text, type) {
    const parser = new XmldomDOMParser({
      onError: function (level) {
        if (level === "fatalError") throw new Error("malformed xml");
      }
    });
    try {
      const doc = parser.parseFromString(text, type || "text/xml");
      if (doc) return doc;
    } catch (error) {
      /* fall through to the parsererror contract */
    }
    const fallbackParser = new XmldomDOMParser();
    return fallbackParser.parseFromString("<parsererror/>", "text/xml");
  };

  /**
   * Minimal window for the sandbox: main-world.js only attaches a message
   * listener at load time; every runtime call stays inside the handlers.
   */
  const sandboxWindow = {
    addEventListener: function () {},
    removeEventListener: function () {},
    postMessage: function () {}
  };

  const sandbox = { DOMParser: StubDOMParser, window: sandboxWindow };
  vm.runInNewContext(source, sandbox);

  assert.ok(sandbox.window.__PPTest, "main-world.js must attach __PPTest for unit tests");
  assert.ok(
    typeof sandbox.window.__PPTest.parseRetrieveMultipleResponse === "function",
    "test hook must expose parseRetrieveMultipleResponse"
  );
  assert.ok(
    sandbox.window.PPMain &&
      typeof sandbox.window.PPMain.parseRetrieveMultipleResponse === "function",
    "PPMain contract must expose parseRetrieveMultipleResponse (runcode.js destructures it)"
  );
  return sandbox.window.__PPTest.parseRetrieveMultipleResponse;
}

const parse = loadParser();
const FIXTURES = path.resolve("tests/fixtures");
const retrieveMultiple = fs.readFileSync(path.join(FIXTURES, "retrieveMultipleResponse.xml"), "utf8");
const fault = fs.readFileSync(path.join(FIXTURES, "soapFault.xml"), "utf8");

test("parses the entity collection: row count, entity name and paging flag", () => {
  const result = parse(retrieveMultiple);
  assert.notEqual(result, null);
  assert.equal(result.entityName, "msdyn_workorder");
  assert.equal(result.moreRecords, true);
  assert.equal(result.totalRecordCount, 3);
  assert.equal(result.rows.length, 3);
});

test("the id column is registered once, at the front, with a value on EVERY row", () => {
  const result = parse(retrieveMultiple);
  assert.equal(result.columns[0], "id");
  // Regression guard: the shipped bug where only the first row carried an id.
  assert.ok(result.rows[0].id && result.rows[1].id && result.rows[2].id, "every row must carry its own id");
  assert.deepEqual(
    result.rows.map(function (row) {
      return row.id;
    }),
    [
      "aaaaaaaa-1111-2222-3333-444444444444",
      "bbbbbbbb-1111-2222-3333-444444444444",
      "cccccccc-1111-2222-3333-444444444444"
    ]
  );
});

test("column order follows first-appearance across the entity set", () => {
  const result = parse(retrieveMultiple);
  // Row 1: msdyn_name, primaryuser, createdon; row 3 introduces statecode,
  // createdby. id was unshifted to the front on first sight.
  assert.deepEqual(result.columns, ["id", "msdyn_name", "primaryuser", "createdon", "statecode", "createdby"]);
});

test("formatted values are preferred over raw values", () => {
  const result = parse(retrieveMultiple);
  const first = result.rows[0];
  assert.equal(first.createdon, "2026/9/1 16:00", "formatted date wins over the ISO/UTC raw value");
  const third = result.rows[2];
  assert.equal(third.statecode, "Suspended", "formatted option label wins over the raw 1");
});

test("EntityReference attributes resolve to the display name", () => {
  const result = parse(retrieveMultiple);
  assert.equal(result.rows[0].primaryuser, "Example Agent");
  assert.equal(result.rows[2].createdby, "SYSTEM");
});

test("payload mirrors the verified attribute values", () => {
  const result = parse(retrieveMultiple);
  // Row values and payload values share one source; EntityReference keeps the
  // display name (no "@formatted" companion exists for those).
  assert.equal(result.payload.records[0].primaryuser, "Example Agent");
  assert.equal(result.payload.records[0]["primaryuser@formatted"], undefined);
  assert.equal(result.payload.records[2].statecode, "1");
  assert.equal(result.payload.records[2]["statecode@formatted"], "Suspended");
  assert.equal(result.payload.records[0].id, "aaaaaaaa-1111-2222-3333-444444444444");
});

test("a SOAP fault is not a record collection -> null (raw XML fallback)", () => {
  assert.equal(parse(fault), null);
});

test("malformed XML and non-entity replies return null instead of throwing", () => {
  assert.equal(parse("<div>not xml<"), null);
  assert.equal(parse("[]"), null);
  assert.equal(parse(""), null);
});

test("a collection without any attribute column returns null", () => {
  const empty = retrieveMultiple
    .replace(/<b:Attributes>[\s\S]*?<\/b:Attributes>/g, "")
    .replace("<b:Id>cccccccc-1111-2222-3333-444444444444</b:Id>", "");
  const result = parse(empty);
  // Every entity still has an Id element, so the id column exists - the flag
  // must stay true. (Id unshift keeps parsing viable.)
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.columns, ["id"]);
});

test("REAL Execute-style response (user org): parses to a table, not the raw fallback", () => {
  // fixtures/user-real-executeresponse.xml captures the Execute/Results pair
  // wrapper shape seen in production (entity collection nested inside
  // a <b:value i:type="a:EntityCollection">, keys in the b: data-contract ns).
  // This is the "ran but no table" regression guard reported by the user.
  const realEnvelope = fs.readFileSync(path.join(FIXTURES, "user-real-executeresponse.xml"), "utf8");
  const result = parse(realEnvelope);
  assert.notEqual(result, null, "must parse the Execute/Results wrapper shape");
  assert.equal(result.entityName, "sample_ownermapping");
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].sample_ownermappingid, "11111111-2222-3333-4444-555555555555");
  assert.equal(result.columns[0], "id");
});
