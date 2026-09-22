/**
 * Dynamics 365 Power Pane Next - bootstrap.
 *
 * The manifest loads this file LAST (after content/core.js and every
 * content/features/*.js module): it rides the same boot decision the core
 * used to carry and calls `PPPane.boot()` exactly once.
 */
(function () {
  "use strict";

  const Pane = window.PPPane;
  if (!Pane || typeof Pane.boot !== "function") {
    // core.js missing or a feature file failed to parse - surface it loudly
    // in the console instead of a silently broken pane.
    console.error("[Power Pane Next] content/core.js did not initialize; features cannot run.");
    return;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", Pane.boot);
  } else {
    Pane.boot();
  }
})();
