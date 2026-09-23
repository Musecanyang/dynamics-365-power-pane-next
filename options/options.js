/**
 * Dynamics 365 Power Pane Next - options page.
 *
 * Lets the user configure, per action: visibility, keyboard shortcut and
 * ordering (drag within a group). Preferences are persisted to
 * chrome.storage.sync via the keys defined in src/constants.js.
 *
 * Depends on: src/constants.js (PP), src/actions.js (POWER_PANE_ACTIONS).
 */
(function () {
  "use strict";

  const PP = window.PP;
  const ACTIONS = window.POWER_PANE_ACTIONS || [];

  /** Shared DOM factory (shared/util.js). */
  const el = window.PPUtil.el;

  /** Lookup table action id -> action definition. */
  const actionsById = {};
  ACTIONS.forEach(function (action) {
    actionsById[action.id] = action;
  });

  /** Group order follows the declaration order in actions.js. */
  const GROUP_ORDER = [];
  (function () {
    const seen = {};
    ACTIONS.forEach(function (action) {
      if (!seen[action.group]) {
        seen[action.group] = true;
        GROUP_ORDER.push(action.group);
      }
    });
  })();

  const listEl = document.getElementById("list");
  const themeSelect = document.getElementById("theme");
  const statusEl = document.getElementById("status");
  document.getElementById("title").textContent = PP.NAME + " - Options";

  /** Working state (flushed to storage on Save). */
  let order = ACTIONS.map(function (action) {
    return action.id;
  });
  let visibility = {}; // action id -> visible (boolean)
  let shortcuts = {}; // action id -> "Ctrl+Alt+K" style combo
  let dragId = null;
  let recording = null;

  /** @type {number|undefined} handle for the transient status timeout. */
  let statusTimer;

  /** Show a transient status message that fades after 1.5s. */
  function setStatus(message) {
    statusEl.textContent = message;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
      statusEl.textContent = "";
    }, 1500);
  }

  /** Wrap chrome.storage.sync.get in a Promise. */
  function syncGet(defaults) {
    return new Promise(function (resolve) {
      chrome.storage.sync.get(defaults, resolve);
    });
  }

  /** Wrap chrome.storage.sync.set in a Promise. */
  function syncSet(payload) {
    return new Promise(function (resolve) {
      chrome.storage.sync.set(payload, resolve);
    });
  }

  /** Wrap chrome.storage.local.remove in a Promise. */
  function localRemove(key) {
    return new Promise(function (resolve) {
      chrome.storage.local.remove(key, resolve);
    });
  }

  /** Wrap chrome.storage.local.get in a Promise. */
  function localGet(key, fallback) {
    return new Promise(function (resolve) {
      chrome.storage.local.get({ [key]: fallback }, function (data) {
        resolve(data[key]);
      });
    });
  }

  /** Wrap chrome.storage.local.set in a Promise. */
  function localSet(key, value) {
    return new Promise(function (resolve) {
      chrome.storage.local.set({ [key]: value }, resolve);
    });
  }

  /** Trigger a client-side download (shared implementation in src/util.js). */
  const downloadTextFile = window.PPUtil.downloadTextFile;

  /** Wrap chrome.storage.sync.remove in a Promise. */
  function syncRemove(keys) {
    return new Promise(function (resolve) {
      chrome.storage.sync.remove(keys, resolve);
    });
  }

  /**
   * Convert a keydown event into a "Ctrl+Alt+K" style combo, or null when the
   * event is a bare modifier (no modifier + no real key is not a valid combo).
   * @param {KeyboardEvent} event
   * @returns {string|null}
   */
  function comboFromEvent(event) {
    const parts = [];
    if (event.ctrlKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    if (event.metaKey) parts.push("Meta");
    let key = event.key;
    if (["Control", "Alt", "Shift", "Meta"].indexOf(key) > -1) return null;
    if (key === " ") key = "Space";
    if (key.length === 1) key = key.toUpperCase();
    if (!parts.length) return null; // require at least one modifier
    return parts.join("+") + "+" + key;
  }

  /** Begin recording a shortcut for an action. */
  function startRecording(actionId, button) {
    if (recording) recording.button.classList.remove("recording");
    recording = { id: actionId, button: button };
    button.classList.add("recording");
    button.textContent = "press keys...";
  }

  document.addEventListener("keydown", function (event) {
    if (!recording) return;
    event.preventDefault();
    if (event.key === "Escape") {
      recording.button.classList.remove("recording");
      recording.button.textContent = shortcuts[recording.id] || "none";
      recording = null;
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      delete shortcuts[recording.id];
      recording.button.classList.remove("recording");
      recording.button.textContent = "none";
      recording = null;
      return;
    }
    const combo = comboFromEvent(event);
    if (!combo) return;
    const id = recording.id;
    // A combo can only be bound to one action: clear any previous binding.
    Object.keys(shortcuts).forEach(function (other) {
      if (other !== id && shortcuts[other] === combo) delete shortcuts[other];
    });
    shortcuts[id] = combo;
    recording.button.classList.remove("recording");
    recording.button.textContent = combo;
    recording = null;
  });

  /** Action ids that belong to a group, in the current order. */
  function idsOfGroup(group) {
    return order.filter(function (id) {
      return actionsById[id] && actionsById[id].group === group;
    });
  }

  /** Build the whole list (grouped, order-aware, disabled sunk last). */
  function render() {
    listEl.textContent = "";
    GROUP_ORDER.forEach(function (group) {
      const fieldset = el("fieldset");
      fieldset.appendChild(el("legend", { text: group }));

      const ids = idsOfGroup(group);
      const enabledIds = ids.filter(function (id) {
        return visibility[id] !== false;
      });
      const disabledIds = ids.filter(function (id) {
        return visibility[id] === false;
      });
      enabledIds.concat(disabledIds).forEach(function (id) {
        fieldset.appendChild(buildRow(id, group));
      });
      listEl.appendChild(fieldset);
    });
  }

  /** Build one editable row for an action. */
  function buildRow(actionId, group) {
    const action = actionsById[actionId];
    const isEnabled = visibility[actionId] !== false;

    const row = el("div", { className: "row" + (isEnabled ? "" : " disabled") });
    row.draggable = true;
    row.dataset.id = actionId;

    const handle = el("span", { className: "handle", text: "\u22ee\u22ee" });

    const checkbox = el("input", { type: "checkbox", checked: isEnabled });
    checkbox.addEventListener("change", function () {
      visibility[actionId] = checkbox.checked;
      render();
    });

    const label = el("span", { className: "lbl", text: action.label });
    label.addEventListener("click", function () {
      checkbox.checked = !checkbox.checked;
      visibility[actionId] = checkbox.checked;
      render();
    });

    const shortcut = el("button", {
      type: "button",
      className: "sc",
      text: shortcuts[actionId] || "none"
    });
    shortcut.addEventListener("click", function () {
      startRecording(actionId, shortcut);
    });

    row.appendChild(handle);
    row.appendChild(checkbox);
    row.appendChild(label);
    row.appendChild(shortcut);

    // Reordering is constrained to the same group.
    row.addEventListener("dragstart", function (event) {
      dragId = actionId;
      row.classList.add("dragging");
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", function () {
      row.classList.remove("dragging");
      dragId = null;
    });
    row.addEventListener("dragover", function (event) {
      if (dragId && actionsById[dragId] && actionsById[dragId].group === group) event.preventDefault();
    });
    row.addEventListener("drop", function (event) {
      event.preventDefault();
      if (!dragId || dragId === actionId) return;
      if (!actionsById[dragId] || actionsById[dragId].group !== group) return;
      const from = order.indexOf(dragId);
      const to = order.indexOf(actionId);
      if (from < 0 || to < 0) return;
      order.splice(from, 1);
      order.splice(to, 0, dragId);
      dragId = null;
      render();
    });
    return row;
  }

  /** Load persisted preferences into working state. */
  async function load() {
    const defaults = {};
    defaults[PP.SYNC.SETTINGS] = {};
    defaults[PP.SYNC.THEME] = PP.THEME.DARK;
    defaults[PP.SYNC.SHORTCUTS] = {};
    defaults[PP.SYNC.ORDER] = [];
    const data = await syncGet(defaults);

    visibility = data[PP.SYNC.SETTINGS] || {};
    shortcuts = data[PP.SYNC.SHORTCUTS] || {};
    themeSelect.value = data[PP.SYNC.THEME] || PP.THEME.DARK;

    // Restore order (saved ids first, then any new actions appended).
    const saved = data[PP.SYNC.ORDER] || [];
    const seen = {};
    order = [];
    saved.forEach(function (id) {
      if (actionsById[id] && !seen[id]) {
        order.push(id);
        seen[id] = true;
      }
    });
    ACTIONS.forEach(function (action) {
      if (!seen[action.id]) order.push(action.id);
    });
    render();
  }

  /** Persist the working state to chrome.storage.sync. */
  async function save() {
    const settings = {};
    order.forEach(function (id) {
      settings[id] = visibility[id] !== false;
    });
    const payload = {};
    payload[PP.SYNC.SETTINGS] = settings;
    payload[PP.SYNC.THEME] = themeSelect.value;
    payload[PP.SYNC.SHORTCUTS] = shortcuts;
    payload[PP.SYNC.ORDER] = order;
    await syncSet(payload);
    setStatus("Saved.");
  }

  document.getElementById("all").addEventListener("click", function () {
    order.forEach(function (id) {
      visibility[id] = true;
    });
    render();
  });
  document.getElementById("none").addEventListener("click", function () {
    order.forEach(function (id) {
      visibility[id] = false;
    });
    render();
  });
  document.getElementById("resetPos").addEventListener("click", async function () {
    await localRemove(PP.LOCAL.LAYOUT);
    setStatus("Pane position reset (reopen the pane).");
  });
  document.getElementById("restore").addEventListener("click", async function () {
    const confirmed = window.confirm(
      "Restore all default settings? This clears visibility, order, theme, shortcuts and snippets."
    );
    if (!confirmed) return;
    await syncRemove([PP.SYNC.SETTINGS, PP.SYNC.THEME, PP.SYNC.SHORTCUTS, PP.SYNC.ORDER]);
    await localRemove(PP.LOCAL.SNIPPETS);
    await localRemove(PP.LOCAL.LAYOUT);
    visibility = {};
    shortcuts = {};
    themeSelect.value = PP.THEME.DARK;
    order = ACTIONS.map(function (action) {
      return action.id;
    });
    render();
    setStatus("Defaults restored.");
  });
  document.getElementById("save").addEventListener("click", save);

  /* ------------------------------------------------------------------ *
   * Settings import / export (full backup: preferences + snippets)
   * ------------------------------------------------------------------ */

  /** Keep only well-formed {name, xml, type} entries (FetchXML is the default type). */
  /** Snippet normalize (shared implementation in src/util.js). */
  const sanitizeSnippets = window.PPUtil.normalizeSnippets;

  document.getElementById("exportSettings").addEventListener("click", async function () {
    const defaults = {};
    defaults[PP.SYNC.SETTINGS] = {};
    defaults[PP.SYNC.THEME] = PP.THEME.DARK;
    defaults[PP.SYNC.SHORTCUTS] = {};
    defaults[PP.SYNC.ORDER] = [];
    const data = await syncGet(defaults);
    const snippets = await localGet(PP.LOCAL.SNIPPETS, []);
    const payload = {
      type: "power-pane-settings",
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: data[PP.SYNC.SETTINGS] || {},
      theme: data[PP.SYNC.THEME] || PP.THEME.DARK,
      shortcuts: data[PP.SYNC.SHORTCUTS] || {},
      order: data[PP.SYNC.ORDER] || [],
      snippets: Array.isArray(snippets) ? snippets : []
    };
    downloadTextFile("power-pane-settings.json", JSON.stringify(payload, null, 2), "application/json");
    setStatus("Settings exported.");
  });

  document.getElementById("importSettings").addEventListener("click", function () {
    const input = el("input", { type: "file" });
    input.accept = ".json,application/json";
    input.style.display = "none";
    input.addEventListener("change", async function () {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      let parsed;
      try {
        parsed = JSON.parse(await file.text());
      } catch (e) {
        setStatus("Import failed: not a valid JSON file.");
        return;
      }
      if (!parsed || parsed.type !== "power-pane-settings") {
        setStatus("Import failed: not a Power Pane settings export.");
        return;
      }
      // Persist imported values, then refresh the working state and UI.
      const settings = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {};
      const theme = parsed.theme === PP.THEME.LIGHT ? PP.THEME.LIGHT : PP.THEME.DARK;
      const shortcutsImported = parsed.shortcuts && typeof parsed.shortcuts === "object" ? parsed.shortcuts : {};
      // Keep only known action ids, then append any actions missing from the
      // file (same completion rule as load()).
      const importedOrder = Array.isArray(parsed.order) ? parsed.order : [];
      const knownIds = {};
      ACTIONS.forEach(function (action) {
        knownIds[action.id] = true;
      });
      const seen = {};
      order = [];
      importedOrder.forEach(function (id) {
        if (typeof id === "string" && actionsById[id] && !seen[id]) {
          order.push(id);
          seen[id] = true;
        }
      });
      ACTIONS.forEach(function (action) {
        if (!seen[action.id]) order.push(action.id);
      });
      const snippets = sanitizeSnippets(parsed.snippets);
      const jsCount = snippets.filter(function (snippet) {
        return snippet.type === "js";
      }).length;
      if (
        jsCount &&
        !window.confirm(
          "The file contains " +
            jsCount +
            " JavaScript snippet(s). They run with your privileges in the page when executed. Import anyway?"
        )
      ) {
        setStatus("Import cancelled.");
        return;
      }

      const payload = {};
      payload[PP.SYNC.SETTINGS] = settings;
      payload[PP.SYNC.THEME] = theme;
      payload[PP.SYNC.SHORTCUTS] = shortcutsImported;
      payload[PP.SYNC.ORDER] = order;
      await syncSet(payload);
      await localSet(PP.LOCAL.SNIPPETS, snippets);

      visibility = settings;
      shortcuts = shortcutsImported;
      themeSelect.value = theme;
      render();
      setStatus(
        "Imported settings (" +
          Object.keys(settings).length +
          " actions, " +
          snippets.length +
          " snippet(s))."
      );
    });
    document.body.appendChild(input);
    input.click();
  });

  load();
})();
