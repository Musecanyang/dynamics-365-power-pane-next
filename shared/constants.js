/**
 * Dynamics 365 Power Pane Next - shared constants.
 *
 * This is the SINGLE SOURCE OF TRUTH for every cross-file string literal:
 * the product name, storage keys, message types and the page<->content-script
 * bridge markers. Change a value here and it changes everywhere.
 *
 * It is loaded in the service worker (importScripts), the options page (script
 * tag) and the ISOLATED-world content script. Keep this file dependency-free
 * and side-effect free: it only attaches the frozen `PP` namespace to the
 * current global.
 *
 * IMPORTANT: do not re-declare these values in any other file. Consumers
 * always read `window.PP` / `self.PP` directly. A duplicated fallback is a
 * silent divergence hazard.
 *
 * IMPORTANT: do NOT list this file in the MAIN-world content_scripts entry.
 * Chrome does not reliably share a content-script file that appears in both a
 * MAIN-world and an ISOLATED-world entry (crbug.com/324096753): the shared
 * globals go missing in one of the worlds. The MAIN-world bridge therefore
 * keeps its own copy of the three bridge markers (content/main-world.js), and
 * the CI workflow asserts they stay in sync with PP.BRIDGE here.
 */
(function (global) {
  "use strict";

  const PP = {
    /** Product identity. */
    NAME: "Dynamics 365 Power Pane Next",
    SHORT_NAME: "Power Pane Next",

    /** UI theme values persisted under {@link PP.SYNC.THEME}. */
    THEME: {
      DARK: "dark",
      LIGHT: "light"
    },

    /** chrome.storage.sync keys (user preferences, synced across devices). */
    SYNC: {
      SETTINGS: "ppSettings",
      THEME: "ppTheme",
      SHORTCUTS: "ppShortcuts",
      ORDER: "ppOrder"
    },

    /**
     * chrome.storage.local keys (device-specific state and large data).
     * SNIPPETS shares its key name with the old storage.sync location so the
     * one-time migration in content.js can find legacy copies.
     */
    LOCAL: {
      RECENT_USERS: "ppRecentUsers",
      PINNED_USERS: "ppPinnedUsers",
      LAYOUT: "ppLayout3",
      AUTO_OPEN_USERS: "ppAutoUsers",
      SNIPPETS: "ppSnippets"
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

    /**
     * window.postMessage bridge between the isolated-world UI and the
     * MAIN-world bridge. KEY is the marker property on every bridge message;
     * REQUEST/RESPONSE are its values. Using the frozen constants here (rather
     * than inline literals) keeps both sides of the bridge in lock-step.
     */
    BRIDGE: {
      KEY: "__ppNext",
      REQUEST: "req",
      RESPONSE: "res"
    },

    /**
     * localStorage debug-gate key (set to "1" to switch on debugLog
     * breadcrumbs for silently-degraded calls). Used by PPUtil.debugLog.
     * content/main-world.js keeps its OWN copy (DEBUG_KEY) because MAIN-world
     * scripts cannot load this file - scripts/check-bridge-sync.js asserts the
     * two copies stay identical, same pattern as the BRIDGE markers above.
     */
    DEBUG: "__ppNextDebug"
  };

  try {
    Object.freeze(PP);
  } catch (e) {
    /* Older engines: freezing is best-effort only. */
  }

  global.PP = PP;
})(typeof window !== "undefined" ? window : self);
