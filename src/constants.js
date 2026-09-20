/**
 * Dynamics 365 Power Pane Next - shared constants.
 *
 * Loaded in every extension context (service worker, options page, isolated
 * content scripts and the MAIN-world bridge). Keep this file dependency-free
 * and side-effect free: it only attaches the frozen `PP` namespace to the
 * current global. All cross-file string literals (storage keys, message
 * types, bridge markers) live here so they can be changed in one place.
 */
(function (global) {
  "use strict";

  var PP = {
    /** Product identity. */
    NAME: "Dynamics 365 Power Pane Next",
    SHORT_NAME: "Power Pane Next",

    /** chrome.storage.sync keys (user preferences, synced across devices). */
    SYNC: {
      SETTINGS: "ppSettings",
      THEME: "ppTheme",
      SHORTCUTS: "ppShortcuts",
      SNIPPETS: "ppSnippets",
      ORDER: "ppOrder"
    },

    /** chrome.storage.local keys (device-specific UI state). */
    LOCAL: {
      RECENT_USERS: "ppRecentUsers",
      PINNED_USERS: "ppPinnedUsers",
      LAYOUT: "ppLayout3",
      AUTO_OPEN_USERS: "ppAutoUsers"
    },

    /** chrome.storage.session keys (impersonation runtime state). */
    SESSION: {
      HOSTS: "ppImpHosts",
      TABS: "ppImpTabs"
    },

    /** chrome.runtime message types exchanged with the service worker. */
    MSG: {
      IMP_START: "pp:imp-start",
      IMP_STOP: "pp:imp-stop",
      IMP_STATUS: "pp:imp-status",
      IMP_RULES: "pp:imp-rules",
      RELOAD_TAB: "pp:reload",
      OPEN_OPTIONS: "pp-open-options",
      PANE_TOGGLE: "pp-toggle"
    },

    /** window.postMessage bridge markers (page <-> isolated content script). */
    BRIDGE: {
      REQUEST: "req",
      RESPONSE: "res"
    }
  };

  try {
    Object.freeze(PP);
  } catch (e) {
    /* older engines: freezing is best-effort */
  }

  global.PP = PP;
})(typeof window !== "undefined" ? window : self);
