/**
 * Dynamics 365 Power Pane Next - shared pure helpers.
 *
 * Dependency-free, side-effect free script loaded by:
 *   - the ISOLATED-world content script (manifest `content_scripts` entry)
 *   - the options page (options/options.html script tag)
 *
 * Everything here is a self-contained helper with no knowledge of the pane's
 * UI, of chrome.* APIs or of the page bridge, so the options page and the
 * content script share ONE implementation instead of drifting copies.
 * (Helpers that need chrome.* APIs or the pane's own state stay in their
 * consumers; only cross-consumer helpers belong here.)
 *
 * NOTE: do not load this file in the MAIN world (see src/constants.js header
 * for the crbug.com/324096753 constraint on files shared between worlds).
 */
(function (global) {
  "use strict";

  const PPUtil = {
    /**
     * Multi-term matcher. A single term matches fuzzily (contains); several
     * comma/; /newline separated terms must match the whole name exactly - a
     * batch of specific roles / teams would otherwise devolve into fuzzy
     * noise. Case-insensitive, whitespace around terms is ignored.
     * @param {string} text value to test
     * @param {string} query user input (optional; empty matches everything)
     * @returns {boolean}
     */
    matches: function (text, query) {
      if (!query) return true;
      const terms = String(query)
        .toLowerCase()
        .split(/[,;\n]+/)
        .map(function (term) {
          return term.trim();
        })
        .filter(Boolean);
      if (!terms.length) return true;
      const lowerText = String(text || "").toLowerCase();
      return terms.some(function (term) {
        if (terms.length > 1) return lowerText === term;
        return lowerText.indexOf(term) > -1;
      });
    },

    /**
     * Compact DOM factory for the pane's row/button/badge building blocks
     * (the "createElement + className + textContent" trio that repeated
     * hundreds of times). Text is assigned via textContent only - never
     * pass markup through it. Adoption policy: new UI code and touched
     * modules use `el()`; untouched `createElement` sites migrate
     * opportunistically (mechanical mass-rewrites are not worth the risk).
     * @param {string} tag
     * @param {{className?: string, text?: string, title?: string,
     *     style?: string, onClick?: function, hidden?: boolean}} [attrs]
     * @param {Array<Node|string>} [children] nodes to append in order
     * @returns {HTMLElement}
     */
    el: function (tag, attrs, children) {
      attrs = attrs || {};
      const node = document.createElement(tag);
      if (attrs.className) node.className = attrs.className;
      if (attrs.text != null) node.textContent = attrs.text;
      if (attrs.value != null) node.value = attrs.value;
      if (attrs.title != null) node.title = attrs.title;
      if (attrs.style) node.style.cssText = attrs.style;
      if (attrs.hidden) node.hidden = attrs.hidden;
      if (attrs.onClick) node.addEventListener("click", attrs.onClick);
      // Children may arrive as the third argument or inline in the attrs
      // object (`el("div", { className: "x", children: [...] })`) - both spell
      // the same intent.
      const kids = children || attrs.children || [];
      kids.forEach(function (child) {
        node.appendChild(
          typeof child === "string" ? document.createTextNode(child) : child
        );
      });
      return node;
    },

    /**
     * Build a `.user` result row from a systemuser row: name / email on the
     * left, the caller's action buttons on the right. Shared by the
     * impersonation and User Permissions features (they pass their own
     * buttons; the row structure stays identical).
     * @param {Object} user systemuser row (`fullname`, `internalemailaddress`,
     *     `domainname`)
     * @param {Array<{label: string, className?: string, title?: string,
     *     onClick: function}>} [actions] buttons appended after the meta
     * @returns {HTMLElement}
     */
    userRow: function (user, actions) {
      const meta = PPUtil.el("div", {
        className: "meta",
        children: [
          PPUtil.el("div", {
            className: "nm",
            text: user.fullname || "(no name)"
          }),
          PPUtil.el("div", {
            className: "em",
            text: user.internalemailaddress || user.domainname || ""
          })
        ]
      });
      const row = PPUtil.el("div", { className: "user", children: [meta] });
      (actions || []).forEach(function (action) {
        const button = PPUtil.el("button", {
          className: action.className || "mini",
          text: action.label,
          title: action.title,
          onClick: action.onClick
        });
        row.appendChild(button);
      });
      return row;
    },

    /**
     * Validate + normalize raw snippet entries. Accepts either a snippets
     * export object (`{ snippets: [...] }`) or a bare array; drops invalid
     * entries and defaults unknown types to FetchXML. Shared by the options
     * import and the snippets dialog import.
     * @param {*} raw
     * @returns {Array<{name: string, xml: string, type: string}>}
     */
    normalizeSnippets: function (raw) {
      const list = Array.isArray(raw)
        ? raw
        : raw && Array.isArray(raw.snippets)
        ? raw.snippets
        : [];
      return list
        .filter(function (item) {
          return !!item && typeof item.name === "string" && typeof item.xml === "string";
        })
        .map(function (item) {
          return {
            name: item.name.trim() || "Untitled",
            xml: item.xml,
            type: item.type === "js" ? "js" : "fetchxml"
          };
        });
    },

    /**
     * Shared "Type" field for snippet dialogs: a `.field` wrapper with a
     * label and the JavaScript / FetchXML select. One implementation for the
     * "Save to Snippets" dialog (content/core.js) and the snippet editor form
     * (content/features/snippets.js) - the two used to hold drifting copies.
     * The caller sets the initial value via `field.select.value` and its own
     * change listener.
     *
     * Deliberately calls `PPUtil.el` through the object name instead of
     * `this.el`: consumers destructure this method off `window.PPUtil`, and a
     * bare reference loses the `this` binding (that mistake broke the
     * Run Code "Save to Snippets" dialog once already).
     * @param {{fieldLabel?: string}} [opts] label text, defaults to "Type"
     * @returns {{root: HTMLElement, select: HTMLSelectElement}}
     */
    snippetTypeField: function (opts) {
      opts = opts || {};
      const select = PPUtil.el("select");
      select.style.alignSelf = "flex-start";
      [
        ["js", "JavaScript"],
        ["fetchxml", "FetchXML"]
      ].forEach(function (pair) {
        select.appendChild(
          PPUtil.el("option", { value: pair[0], text: pair[1] })
        );
      });
      const field = PPUtil.el("div", {
        className: "field",
        children: [
          PPUtil.el("label", { text: opts.fieldLabel || "Type" }),
          select
        ]
      });
      return { root: field, select: select };
    },

    /**
     * Trigger a client-side download of `text` as `filename` (no network).
     * Uses DOM APIs and therefore only works in document contexts (options
     * page / content script), never inside a service worker.
     * @param {string} filename
     * @param {string} text
     * @param {string} mime
     */
    downloadTextFile: function (filename, text, mime) {
      const blob = new Blob([text], { type: mime });
      const anchor = document.createElement("a");
      anchor.href = URL.createObjectURL(blob);
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(function () {
        URL.revokeObjectURL(anchor.href);
      }, 1500);
    },

    /**
     * Conditional debug logging for the silent-catch paths (network / storage
     * failures that degrade the UI on purpose). Silent by default; enable
     * with `localStorage.setItem("__ppNextDebug", "1")` in the page (or on
     * the options page) and watch the console - then every swallowed failure
     * gets a one-line breadcrumb instead of a black hole.
     * @param {string} source short tag identifying the failing call site
     * @param {*} error whatever the catch received
     */
    debugLog: function (source, error) {
      try {
        // PP.DEBUG (src/constants.js) is the single source of truth; the
        // literal fallback only covers a file-load-order failure.
        const debugKey = (global.PP && global.PP.DEBUG) || "__ppNextDebug";
        if (!global.localStorage || global.localStorage.getItem(debugKey) !== "1") {
          return;
        }
        global.console.debug("[Power Pane Next][" + source + "]", error || "");
      } catch (e) {
        /* localStorage unavailable */
      }
    }
  };

  try {
    Object.freeze(PPUtil);
  } catch (e) {
    /* Older engines: freezing is best-effort only. */
  }

  global.PPUtil = PPUtil;
})(typeof window !== "undefined" ? window : self);
