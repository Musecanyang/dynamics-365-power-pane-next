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

  var PP =
    window.PP ||
    {
      NAME: "Dynamics 365 Power Pane Next",
      SHORT_NAME: "Power Pane Next",
      SYNC: {
        SETTINGS: "ppSettings",
        THEME: "ppTheme",
        SHORTCUTS: "ppShortcuts",
        SNIPPETS: "ppSnippets",
        ORDER: "ppOrder"
      },
      LOCAL: {
        RECENT_USERS: "ppRecentUsers",
        PINNED_USERS: "ppPinnedUsers",
        LAYOUT: "ppLayout3",
        AUTO_OPEN_USERS: "ppAutoUsers"
      },
      MSG: {
        IMP_START: "pp:imp-start",
        IMP_STOP: "pp:imp-stop",
        IMP_STATUS: "pp:imp-status",
        IMP_RULES: "pp:imp-rules",
        RELOAD_TAB: "pp:reload",
        OPEN_OPTIONS: "pp-open-options",
        PANE_TOGGLE: "pp-toggle"
      },
      BRIDGE: { REQUEST: "req", RESPONSE: "res" }
    };
  var ACTIONS = window.POWER_PANE_ACTIONS || [];
  var byId = {};
  ACTIONS.forEach(function (action) {
    byId[action.id] = action;
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
  var enabled = {};
  var shortcuts = {};
  var dragId = null;
  var recording = null;

  function setStatus(message) {
    statusEl.textContent = message;
    setTimeout(function () {
      statusEl.textContent = "";
    }, 1500);
  }

  /** Convert a keydown event into a "Ctrl+Alt+K" style combo, or null. */
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
    // A combo can only be bound to one action.
    Object.keys(shortcuts).forEach(function (other) {
      if (other !== id && shortcuts[other] === combo) delete shortcuts[other];
    });
    shortcuts[id] = combo;
    recording.button.classList.remove("recording");
    recording.button.textContent = combo;
    recording = null;
  });

  function idsOfGroup(group) {
    return order.filter(function (id) {
      return byId[id] && byId[id].group === group;
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
        return enabled[id] !== false;
      });
      var disabledIds = ids.filter(function (id) {
        return enabled[id] === false;
      });
      enabledIds.concat(disabledIds).forEach(function (id) {
        fieldset.appendChild(buildRow(id, group));
      });
      listEl.appendChild(fieldset);
    });
  }

  /** Build one editable row for an action. */
  function buildRow(actionId, group) {
    var action = byId[actionId];
    var isEnabled = enabled[actionId] !== false;

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
      enabled[actionId] = checkbox.checked;
      render();
    });

    var label = document.createElement("span");
    label.className = "lbl";
    label.textContent = action.label;
    label.addEventListener("click", function () {
      checkbox.checked = !checkbox.checked;
      enabled[actionId] = checkbox.checked;
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
      if (dragId && byId[dragId] && byId[dragId].group === group) event.preventDefault();
    });
    row.addEventListener("drop", function (event) {
      event.preventDefault();
      if (!dragId || dragId === actionId) return;
      if (!byId[dragId] || byId[dragId].group !== group) return;
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

  /** Load persisted preferences. */
  function load() {
    var defaults = {};
    defaults[PP.SYNC.SETTINGS] = {};
    defaults[PP.SYNC.THEME] = "dark";
    defaults[PP.SYNC.SHORTCUTS] = {};
    defaults[PP.SYNC.ORDER] = [];
    chrome.storage.sync.get(defaults, function (data) {
      enabled = data[PP.SYNC.SETTINGS] || {};
      shortcuts = data[PP.SYNC.SHORTCUTS] || {};
      themeSelect.value = data[PP.SYNC.THEME] || "dark";

      // Restore order (saved ids first, then any new actions appended).
      var saved = data[PP.SYNC.ORDER] || [];
      var seen = {};
      order = [];
      saved.forEach(function (id) {
        if (byId[id] && !seen[id]) {
          order.push(id);
          seen[id] = true;
        }
      });
      ACTIONS.forEach(function (action) {
        if (!seen[action.id]) order.push(action.id);
      });
      render();
    });
  }

  /** Persist the working state. */
  function save() {
    var settings = {};
    order.forEach(function (id) {
      settings[id] = enabled[id] !== false;
    });
    var payload = {};
    payload[PP.SYNC.SETTINGS] = settings;
    payload[PP.SYNC.THEME] = themeSelect.value;
    payload[PP.SYNC.SHORTCUTS] = shortcuts;
    payload[PP.SYNC.ORDER] = order;
    chrome.storage.sync.set(payload, function () {
      setStatus("Saved.");
    });
  }

  document.getElementById("all").addEventListener("click", function () {
    order.forEach(function (id) {
      enabled[id] = true;
    });
    render();
  });
  document.getElementById("none").addEventListener("click", function () {
    order.forEach(function (id) {
      enabled[id] = false;
    });
    render();
  });
  document.getElementById("resetPos").addEventListener("click", function () {
    chrome.storage.local.remove(PP.LOCAL.LAYOUT, function () {
      setStatus("Pane position reset (reopen the pane).");
    });
  });
  document.getElementById("restore").addEventListener("click", function () {
    if (!confirm("Restore all default settings? This clears visibility, order, theme, shortcuts and snippets.")) {
      return;
    }
    chrome.storage.sync.remove(
      [PP.SYNC.SETTINGS, PP.SYNC.THEME, PP.SYNC.SHORTCUTS, PP.SYNC.ORDER, PP.SYNC.SNIPPETS],
      function () {
        chrome.storage.local.remove(PP.LOCAL.LAYOUT, function () {
          enabled = {};
          shortcuts = {};
          themeSelect.value = "dark";
          order = ACTIONS.map(function (action) {
            return action.id;
          });
          render();
          setStatus("Defaults restored.");
        });
      }
    );
  });
  document.getElementById("save").addEventListener("click", save);

  load();
})();
