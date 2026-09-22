/**
 * Dynamics 365 Power Pane Next - command handlers: general.
 *
 * General diagnostics and context commands: pane ping, form context, user info and the environment reports.
 *
 * Every handler registers via PPmain.register; cross-command reads go
 * through PPmain.get(name). See content/main-world.js for the loading
 * order, the postMessage contract and the response shapes.
 */
(function (PPmain) {
  "use strict";

  const { getXrm, requireForm, webApiGet } = PPmain;

  /* ------------------------------------------------------------------ *
   * General / context
   * ------------------------------------------------------------------ */

  PPmain.register("ping", function () {
    return { hasXrm: !!getXrm(), environment: getXrm() ? "dynamics" : "unknown" };
  });

  PPmain.register("getContext", function () {
    const xrm = requireForm();
    const entity = xrm.Page.data && xrm.Page.data.entity;
    let formName = "";
    let formId = "";
    try {
      const item = xrm.Page.ui.formSelector.getCurrentItem();
      if (item) {
        formName = item.getLabel();
        formId = item.getId();
      }
    } catch (e) {
      /* form selector unavailable */
    }
    const formTypeCode = xrm.Page.ui ? xrm.Page.ui.getFormType() : "";
    const formTypeMeanings = {
      0: "Undefined",
      1: "Create",
      2: "Update",
      3: "Read Only",
      4: "Disabled",
      5: "Quick Create",
      6: "Bulk Edit"
    };
    const formTypeText =
      formTypeMeanings[formTypeCode] != null
        ? formTypeCode + " - " + formTypeMeanings[formTypeCode]
        : String(formTypeCode);
    return {
      output: {
        title: "Form Context",
        items: [
          { label: "Client URL", value: xrm.Page.context.getClientUrl() },
          { label: "Entity", value: entity ? entity.getEntityName() : "(not a form)" },
          { label: "Record Id", value: entity ? entity.getId() : "(not a form)" },
          { label: "Form Name", value: formName },
          { label: "Form Id", value: formId },
          { label: "Form Type", value: formTypeText }
        ]
      }
    };
  });

  PPmain.register("userInfo", async function () {
    const xrm = requireForm();
    const context = xrm.Page.context;
    const userId = context.getUserId();
    const cleanId = userId.replace(/[{}]/g, "");
    let roles = [];
    let teams = [];
    try {
      const data = await webApiGet(
        "systemusers(" +
          cleanId +
          ")?$select=fullname&$expand=systemuserroles_association($select=name),teammembership_association($select=name)"
      );
      roles = (data.systemuserroles_association || []).map(function (role) {
        return role.name;
      });
      teams = (data.teammembership_association || []).map(function (team) {
        return team.name;
      });
    } catch (e) {
      roles = ["(failed: " + e.message + ")"];
    }
    return {
      output: {
        title: "User Info",
        description: "Current signed-in user.",
        items: [
          { label: "User name", value: context.getUserName() },
          { label: "User id", value: userId },
          { label: "Roles", value: roles },
          { label: "Teams", value: teams }
        ]
      }
    };
  });

  PPmain.register("currentContext", function () {
    const xrm = getXrm();
    const context = { entityName: "", formName: "" };
    try {
      context.entityName = xrm.Page.data.entity.getEntityName();
    } catch (e) {
      /* not a form */
    }
    try {
      const item = xrm.Page.ui.formSelector.getCurrentItem();
      if (item) context.formName = item.getLabel();
    } catch (e) {
      /* form selector unavailable */
    }
    return context;
  });
  /* ------------------------------------------------------------------ *
   * Admin / environment info
   * ------------------------------------------------------------------ */

  PPmain.register("environmentInfo", function () {
    const globalContext = getXrm().Utility.getGlobalContext();
    const settings = globalContext.organizationSettings || {};
    return {
      output: {
        title: "Environment Info",
        items: [
          { label: "Unique Name", value: settings.uniqueName || "" },
          { label: "Organization Id", value: settings.organizationId || "" },
          { label: "Environment Id", value: settings.bapEnvironmentId || "(n/a)" },
          { label: "Geo", value: settings.organizationGeo || "" },
          { label: "Version", value: globalContext.getVersion() },
          { label: "Language Id", value: String(settings.languageId || "") },
          { label: "On Premise", value: String(!!globalContext.isOnPremise) },
          { label: "Client URL", value: globalContext.getClientUrl() }
        ]
      }
    };
  });

  PPmain.register("orgSettings", function () {
    const settings = getXrm().Utility.getGlobalContext().organizationSettings || {};
    return {
      output: {
        title: "Organization Settings",
        items: [
          { label: "Base Currency Id", value: settings.baseCurrencyId || "" },
          { label: "Default Country Code", value: settings.defaultCountryCode || "" },
          { label: "Auto Save Enabled", value: String(!!settings.isAutoSaveEnabled) },
          { label: "Language Id", value: String(settings.languageId || "") }
        ]
      }
    };
  });

  PPmain.register("clientInfo", function () {
    const globalContext = getXrm().Utility.getGlobalContext();
    return {
      output: {
        title: "Client Info",
        items: [
          { label: "Client", value: globalContext.client ? globalContext.client.getClient() : "" },
          { label: "Theme", value: globalContext.getCurrentTheme ? globalContext.getCurrentTheme() : "" },
          { label: "Version", value: globalContext.getVersion() },
          { label: "Language", value: navigator.language },
          { label: "User Agent", value: navigator.userAgent }
        ]
      }
    };
  });

})(window.PPMain);
