/**
 * Unit tests for src/util.js (shared pure helpers).
 *
 * util.js is a plain (non-module) script that attaches PPUtil to `window`, so
 * it is loaded into a sandbox via `vm` - no bundler or transpile involved.
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

/** Load util.js in a minimal sandbox and return the PPUtil namespace. */
function loadUtil(stubDocument) {
  const source = fs.readFileSync(path.resolve("src/util.js"), "utf8");
  const sandbox = { window: {} };
  if (stubDocument) sandbox.document = stubDocument;
  vm.runInNewContext(source, sandbox);
  assert.ok(sandbox.window.PPUtil, "util.js must attach PPUtil to window");
  return sandbox.window.PPUtil;
}

const util = loadUtil();

test("matches: empty query matches everything", () => {
  assert.equal(util.matches("Anything", ""), true);
  assert.equal(util.matches("", "   "), true);
});

test("matches: single term is a fuzzy contains match", () => {
  assert.equal(util.matches("Send Notification Status", "notif"), true);
  assert.equal(util.matches("Send Notification Status", "NOTIF"), true);
  assert.equal(util.matches("Account", "acc"), true);
  assert.equal(util.matches("Account", "xyz"), false);
});

test("matches: multiple terms require the WHOLE name to equal one of them", () => {
  assert.equal(util.matches("Account", "account, System Administrator"), true);
  assert.equal(util.matches("System Administrator", "account , System Administrator"), true);
  // Partial names no longer count once several terms are given:
  assert.equal(util.matches("Send Notification Status", "Notification, Account"), false);
  assert.equal(util.matches("Account Manager", "Account, Team"), false);
});

test("matches: whitespace and mixed separators are tolerated", () => {
  assert.equal(util.matches("System Administrator", " System Administrator;\nAccount"), true);
  assert.equal(util.matches("Account", "; System Administrator ; Account ;"), true);
});

test("matches: null / empty text never matches a concrete term", () => {
  assert.equal(util.matches(null, "a"), false);
  assert.equal(util.matches("Account", "accounts"), false);
});

/* el() / userRow / normalizeSnippets run against a stub `document`. */
function stubDocument() {
  const created = [];
  return {
    created: created,
    createElement: function (tag) {
      const node = {
        tagName: tag,
        children: [],
        style: {},
        attributes: {},
        hidden: false,
        listeners: {}
      };
      node.appendChild = function (child) {
        node.children.push(child);
        return child;
      };
      node.addEventListener = function (name, handler) {
        const list = node.listeners[name] || [];
        list.push(handler);
        node.listeners[name] = list;
      };
      created.push(node);
      return node;
    },
    createTextNode: function (text) {
      return { nodeType: 3, text: String(text) };
    }
  };
}

function cloneNode(node) {
  return Object.assign({}, node);
}
void cloneNode;

test("el: builds the node and applies the className / text / title attributes", () => {
  const doc = stubDocument();
  const ui = loadUtil(doc);
  const node = ui.el("button", {
    className: "mini primary",
    text: "Copy",
    title: "Copy permissions"
  });
  assert.equal(node.tagName, "button");
  assert.equal(node.className, "mini primary");
  assert.equal(node.textContent, "Copy");
  assert.equal(node.title, "Copy permissions");
});

test("el: children append in order; strings become text nodes", () => {
  const doc = stubDocument();
  const ui = loadUtil(doc);
  const meta = ui.el("div", { className: "meta" });
  const row = ui.el("div", { className: "user", children: [meta, "hello"] });
  assert.equal(row.children.length, 2);
  assert.equal(row.children[0].className, "meta");
  assert.equal(row.children[1].nodeType, 3);
});

test("el: onClick registers a click listener; style feeds cssText", () => {
  const doc = stubDocument();
  const ui = loadUtil(doc);
  let clicked = 0;
  const node = ui.el("a", { onClick: function () { clicked++; }, style: "flex:none" });
  node.listeners.click[0]();
  assert.equal(clicked, 1);
  assert.equal(node.style.cssText, "flex:none");
});

test("el: text is never lost when children are also passed", () => {
  const doc = stubDocument();
  const ui = loadUtil(doc);
  const chip = ui.el("span", { className: "chip", text: "name " }, ["\u00d7"]);
  assert.equal(chip.textContent, "name ", "textContent assignment is last (final set wins)");
  assert.equal(chip.children.length, 1, "the × text node is still appended");
});

test("userRow: name / email meta + one button per action", () => {
  const doc = stubDocument();
  const ui = loadUtil(doc);
  let opened = 0;
  const row = ui.userRow(
    { fullname: "Song Hsiao", internalemailaddress: "x@y" },
    [{ label: "Open", className: "mini primary", onClick: function () { opened++; } }]
  );
  assert.equal(row.tagName, "div");
  assert.equal(row.className, "user");
  const meta = row.children[0];
  assert.equal(meta.children[0].className, "nm");
  assert.equal(meta.children[0].textContent, "Song Hsiao");
  assert.equal(meta.children[1].textContent, "x@y");
  const openButton = row.children[1];
  assert.equal(openButton.textContent, "Open");
  openButton.listeners.click[0]();
  assert.equal(opened, 1);
});

test("userRow: falls back to domain name when email is absent; no actions = no buttons", () => {
  const doc = stubDocument();
  const ui = loadUtil(doc);
  const row = ui.userRow({ fullname: "", domainname: "LENOVO\\user" });
  assert.equal(row.children[0].children[0].textContent, "(no name)");
  assert.equal(row.children[0].children[1].textContent, "LENOVO\\user");
  assert.equal(row.children.length, 1);
});

test("normalizeSnippets: accepts bare arrays and {snippets} exports, drops invalid entries", () => {
  const clean = util.normalizeSnippets([
    { name: " Active ", xml: "<fetch/>", type: "js" },
    { xml: "<fetch/>" },
    null,
    { name: "  ", xml: "<fetch/>" },
    { name: "X", xml: "<fetch/>" }
  ]);
  // The whitespace-only names trim to "" and become "Untitled" entries - the
  // first entry survives, the dropped one is the null and the "xml"-only item.
  assert.equal(clean.length, 2 + 1);
});

test("normalizeSnippets: accepts the export object shape", () => {
  const clean = util.normalizeSnippets({ snippets: [{ name: "Mine", xml: "<fetch/>" }] });
  assert.equal(clean.length, 1);
  assert.equal(clean[0].type, "fetchxml");
  assert.deepEqual(util.normalizeSnippets(null), []);
});
