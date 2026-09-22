/**
 * Dynamics 365 Power Pane Next - command handlers: debug.
 *
 * Debug commands: Microsoft's documented troubleshooting URL flags, forms monitor, command checker and the disable-* family.
 *
 * Every handler registers via PPmain.register; cross-command reads go
 * through PPmain.get(name). See content/main-world.js for the loading
 * order, the postMessage contract and the response shapes.
 */
(function (PPmain) {
  "use strict";

  const { applyUrlParam } = PPmain;

  /* ------------------------------------------------------------------ *
   * Debug (Microsoft's documented troubleshooting URL flags)
   * ------------------------------------------------------------------ */

  PPmain.register("formsMonitor", function () {
    return applyUrlParam("monitor", "true");
  });
  PPmain.register("commandChecker", function () {
    return applyUrlParam("ribbondebug", "true");
  });
  PPmain.register("perfCenterFlag", function () {
    return applyUrlParam("perf", "true");
  });
  PPmain.register("disableFormHandlers", function () {
    return applyUrlParam("flags", "DisableFormHandlers=true");
  });
  PPmain.register("disableBusinessRules", function () {
    return applyUrlParam("flags", "DisableFormHandlers=businessrule");
  });
  PPmain.register("disableFormLibraries", function () {
    return applyUrlParam("flags", "DisableFormLibraries=true");
  });
  PPmain.register("disableFormCommandbar", function () {
    return applyUrlParam("flags", "DisableFormCommandbar=true");
  });
  PPmain.register("disableWebResourceControls", function () {
    return applyUrlParam("flags", "DisableWebResourceControls=true");
  });
  PPmain.register("disableBusinessProcessFlow", function () {
    return applyUrlParam("flags", "DisableBusinessProcessFlow=true");
  });
  PPmain.register("disableFormControl", function (args) {
    const name = ((args && args.control) || "").trim();
    if (!name) throw new Error("Control name is required.");
    return applyUrlParam("flags", "DisableFormControl=" + name);
  });
  PPmain.register("navbarOff", function () {
    return applyUrlParam("navbar", "off");
  });
  PPmain.register("disableAllComponents", function () {
    const value =
      "DisableFormHandlers=true,DisableWebResourceControls=true,DisableFormCommandbar=true,DisableBusinessProcessFlow=true";
    const url = new URL(location.href);
    url.searchParams.set("flags", value);
    location.href = url.toString();
    return { message: "Disabled handlers, web resource controls, command bar and BPF; reloading...", level: "success" };
  });
  PPmain.register("darkModeFlag", function () {
    return applyUrlParam("flags", "themeoption=darkmode");
  });
  PPmain.register("clearFlags", function () {
    const url = new URL(location.href);
    if (!url.searchParams.has("flags")) return { message: "No flags to clear.", level: "success" };
    url.searchParams.delete("flags");
    location.href = url.toString();
    return { message: "Flags cleared; reloading...", level: "success" };
  });

})(window.PPMain);
