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

  var PP = window.PP;
  var ACTIONS = window.POWER_PANE_ACTIONS || [];

  /** Lookup table action id -> action definition. */
  var actionsById = {};
  ACTIONS.forEach(function (action) {
    actionsById[action.id] = action;
  });

  /** Group order follows the declaration order in actions.js. */
  var GROUP_ORDER = [];
  (function () {
    var seen = {};
    ACTIONS.forEach(function (action) {
      if (!seen[action.group]) {
        seen[action.group] = true;
        GROUP_ORDER.push(action.group);
      }
    });
  })();

  var listEl = document.getElementById("list");
  var themeSelect = document.getElementById("theme");
  var statusEl = document.getElementById("status");
  document.getElementById("title").textContent = PP.NAME + " - Options";

  /** Working state (flushed to storage on Save). */
  var order = ACTIONS.map(function (action) {
    return action.id;
  });
  var visibility = {}; // action id -> visible (boolean)
  var shortcuts = {}; // action id -> "Ctrl+Alt+K" style combo
  var dragId = null;
  var recording = null;

  /** @type {number|undefined} handle for the transient status timeout. */
  var statusTimer;

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
    var parts = [];
    if (event.ctrlKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    if (event.metaKey) parts.push("Meta");
    var key = event.key;
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
    var combo = comboFromEvent(event);
    if (!combo) return;
    var id = recording.id;
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
      var fieldset = document.createElement("fieldset");
      var legend = document.createElement("legend");
      legend.textContent = group;
      fieldset.appendChild(legend);

      var ids = idsOfGroup(group);
      var enabledIds = ids.filter(function (id) {
        return visibility[id] !== false;
      });
      var disabledIds = ids.filter(function (id) {
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
    var action = actionsById[actionId];
    var isEnabled = visibility[actionId] !== false;

    var row = document.createElement("div");
    row.className = "row" + (isEnabled ? "" : " disabled");
    row.draggable = true;
    row.dataset.id = actionId;

    var handle = document.createElement("span");
    handle.className = "handle";
    handle.textContent = "\u22ee\u22ee";

    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = isEnabled;
    checkbox.addEventListener("change", function () {
      visibility[actionId] = checkbox.checked;
      render();
    });

    var label = document.createElement("span");
    label.className = "lbl";
    label.textContent = action.label;
    label.addEventListener("click", function () {
      checkbox.checked = !checkbox.checked;
      visibility[actionId] = checkbox.checked;
      render();
    });

    var shortcut = document.createElement("button");
    shortcut.type = "button";
    shortcut.className = "sc";
    shortcut.textContent = shortcuts[actionId] || "none";
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
      var from = order.indexOf(dragId);
      var to = order.indexOf(actionId);
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
    var defaults = {};
    defaults[PP.SYNC.SETTINGS] = {};
    defaults[PP.SYNC.THEME] = PP.THEME.DARK;
    defaults[PP.SYNC.SHORTCUTS] = {};
    defaults[PP.SYNC.ORDER] = [];
    var data = await syncGet(defaults);

    visibility = data[PP.SYNC.SETTINGS] || {};
    shortcuts = data[PP.SYNC.SHORTCUTS] || {};
    themeSelect.value = data[PP.SYNC.THEME] || PP.THEME.DARK;

    // Restore order (saved ids first, then any new actions appended).
    var saved = data[PP.SYNC.ORDER] || [];
    var seen = {};
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
    var settings = {};
    order.forEach(function (id) {
      settings[id] = visibility[id] !== false;
    });
    var payload = {};
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
    var confirmed = window.confirm(
      "Restore all default settings? This clears visibility, order, theme, shortcuts and snippets."
    );
    if (!confirmed) return;
    await syncRemove([PP.SYNC.SETTINGS, PP.SYNC.THEME, PP.SYNC.SHORTCUTS, PP.SYNC.ORDER, PP.SYNC.SNIPPETS]);
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

  load();
})();
