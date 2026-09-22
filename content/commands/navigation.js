/**
 * Dynamics 365 Power Pane Next - command handlers: navigation.
 *
 * Navigation commands (classic and modern URLs): open records / create forms / editors / solutions / diagnostics / admin areas.
 *
 * Every handler registers via PPmain.register; cross-command reads go
 * through PPmain.get(name). See content/main-world.js for the loading
 * order, the postMessage contract and the response shapes.
 */
(function (PPmain) {
  "use strict";

  const { getXrm, requireForm, clientUrl, apiVersion, baseUrl, webApiGet, getEntitySolutionId } = PPmain;

  /* ------------------------------------------------------------------ *
   * Navigation
   * ------------------------------------------------------------------ */

  PPmain.register("goToRecord", function (args) {
    const xrm = requireForm();
    const entityName = (args && args.entityname || "").trim().toLowerCase();
    const id = (args && args.recordid || "").trim();
    if (!entityName || !id) throw new Error("Entity name and record id are both required.");
    window.open(
      xrm.Page.context.getClientUrl() + "/main.aspx?etn=" + entityName + "&id=" + id + "&pagetype=entityrecord",
      "_blank"
    );
    return { message: "Opened record.", level: "success" };
  });

  PPmain.register("goToCreateForm", function (args) {
    const xrm = requireForm();
    const entityName = (args && args.entityname || "").trim().toLowerCase();
    if (!entityName) throw new Error("Entity name is required.");
    window.open(
      xrm.Page.context.getClientUrl() + "/main.aspx?etn=" + entityName + "&newWindow=true&pagetype=entityrecord",
      "_blank"
    );
    return { message: "Opened create form.", level: "success" };
  });

  PPmain.register("openFormEditor", function () {
    const xrm = requireForm();
    const url =
      xrm.Page.context.getClientUrl() +
      "/main.aspx?pagetype=formeditor&appSolutionId={FD140AAF-4DF4-11DD-BD17-0019B9312238}&etn=" +
      xrm.Page.data.entity.getEntityName().toLowerCase() +
      "&extraqs=formtype=main&formId=" +
      xrm.Page.ui.formSelector.getCurrentItem().getId();
    window.open(url, "_blank");
    return { message: "Opened classic form editor.", level: "success" };
  });

  PPmain.register("openFormEditorNew", async function () {
    const xrm = requireForm();
    const entityName = xrm.Page.data.entity.getEntityName();
    let environmentId = "";
    try {
      environmentId = xrm.Utility.getGlobalContext().organizationSettings.bapEnvironmentId;
    } catch (e) {
      /* environment id unavailable */
    }
    let formId = "";
    try {
      formId = xrm.Page.ui.formSelector.getCurrentItem().getId();
    } catch (e) {
      /* form id unavailable */
    }
    const solutionId = await getEntitySolutionId(entityName);
    const url =
      environmentId && formId
        ? "https://make.powerapps.com/e/" + environmentId + "/s/" + solutionId + "/entity/" + entityName + "/form/edit/" + formId
        : "https://make.powerapps.com/";
    window.open(url, "_blank");
    return { message: "Opened new form designer (Power Apps).", level: "success" };
  });

  PPmain.register("openEntityEditor", function (args) {
    const xrm = requireForm();
    const entityName = ((args && args.entityname) || "").trim() || xrm.Page.data.entity.getEntityName();
    let detail = "";
    try {
      const typeCode = xrm.Internal.getEntityCode(entityName);
      detail = "&def_category=9801&def_type=" + typeCode;
    } catch (e) {
      /* type code unavailable */
    }
    const defaultSolutionId = "{FD140AAF-4DF4-11DD-BD17-0019B9312238}";
    window.open(
      xrm.Page.context.getClientUrl() + "/tools/solution/edit.aspx?id=" + defaultSolutionId + detail,
      "_blank"
    );
    return { message: "Opened entity editor for " + entityName + ".", level: "success" };
  });

  PPmain.register("solutions", function () {
    window.open(clientUrl() + "/tools/Solution/home_solution.aspx?etc=7100", "_blank");
    return { message: "Opened solutions.", level: "success" };
  });

  PPmain.register("crmDiagnostics", function () {
    window.open(clientUrl() + "/tools/diagnostics/diag.aspx", "_blank");
    return { message: "Opened diagnostics.", level: "success" };
  });

  PPmain.register("performanceCenter", function () {
    if (window.Mscrm && Mscrm.Performance && Mscrm.Performance.PerformanceCenter) {
      Mscrm.Performance.PerformanceCenter.get_instance().TogglePerformanceResultsVisibility();
      return { message: "Toggled performance results.", level: "success" };
    }
    throw new Error("Performance Center is not available on this page.");
  });

  PPmain.register("mobileClient", function () {
    const xrm = requireForm();
    const url = xrm.Page.context.getClientUrl();
    window.open(url + "/nga/main.htm?org=" + xrm.Page.context.getOrgUniqueName() + "&server=" + url, "_blank");
    return { message: "Opened mobile client.", level: "success" };
  });

  PPmain.register("openWebApi", async function () {
    const xrm = requireForm();
    const meta = await xrm.Utility.getEntityMetadata(xrm.Page.data.entity.getEntityName(), "");
    const url =
      xrm.Page.context.getClientUrl() +
      "/api/data/v" +
      apiVersion() +
      "/" +
      meta.EntitySetName +
      "(" +
      xrm.Page.data.entity.getId().replace(/[{}]/g, "") +
      ")";
    window.open(url, "_blank");
    return { message: "Opened Web API record URL.", level: "success" };
  });

  PPmain.register("entityMetadata", async function (args) {
    const xrm = requireForm();
    const name = (args && args.entityname || "").trim() || xrm.Page.data.entity.getEntityName();
    const data = await webApiGet(
      "EntityDefinitions(LogicalName='" +
        name +
        "')?$select=LogicalName,PrimaryIdAttribute&$expand=Attributes($select=LogicalName,AttributeType,IsCustomAttribute,RequiredLevel)"
    );
    const attributes = data.Attributes || [];
    const rows = attributes.map(function (attribute) {
      return {
        name: attribute.LogicalName,
        type: attribute.AttributeType,
        custom: attribute.IsCustomAttribute ? "yes" : "",
        required: attribute.RequiredLevel && attribute.RequiredLevel.Value ? attribute.RequiredLevel.Value : ""
      };
    });
    return {
      table: {
        title: "Entity Metadata",
        description: name + " - " + rows.length + " attributes",
        searchable: true,
        copyKey: "name",
        columns: [
          { key: "name", label: "Logical Name" },
          { key: "type", label: "Type" },
          { key: "custom", label: "Custom" },
          { key: "required", label: "Required" }
        ],
        rows: rows
      }
    };
  });

  PPmain.register("openUrl", function (args) {
    const url = args && args.url;
    if (!url) throw new Error("No URL to open.");
    window.open(url, "_blank");
    return { message: "Opened in a new tab.", level: "success" };
  });
  /* ------------------------------------------------------------------ *
   * Navigation (from Levelup)
   * ------------------------------------------------------------------ */

  PPmain.register("openEntityList", function (args) {
    const entityName = ((args && args.entityname) || "").trim().toLowerCase();
    if (!entityName) throw new Error("Entity name is required.");
    window.open(baseUrl() + "/main.aspx?pagetype=entitylist&etn=" + entityName, "_blank");
    return { message: "Opened " + entityName + " list.", level: "success" };
  });
  PPmain.register("openSystemJobs", function () {
    window.open(baseUrl() + "/main.aspx?pagetype=entitylist&etn=asyncoperation", "_blank");
    return { message: "Opened System Jobs.", level: "success" };
  });
  PPmain.register("openProcesses", function () {
    window.open(baseUrl() + "/main.aspx?pagetype=entitylist&etn=workflow", "_blank");
    return { message: "Opened Processes.", level: "success" };
  });
  PPmain.register("openMailboxes", function () {
    window.open(baseUrl() + "/main.aspx?pagetype=entitylist&etn=mailbox", "_blank");
    return { message: "Opened Mailboxes.", level: "success" };
  });
  PPmain.register("openHome", function () {
    window.open(baseUrl() + "/main.aspx", "_blank");
    return { message: "Opened Home.", level: "success" };
  });
  PPmain.register("openAdvancedFind", function () {
    window.open(baseUrl() + "/main.aspx?pagetype=AdvancedFind", "_blank");
    return { message: "Opened Advanced Find.", level: "success" };
  });
  PPmain.register("openSecurity", function () {
    try {
      const settings = getXrm().Utility.getGlobalContext().organizationSettings;
      if (settings && settings.bapEnvironmentId) {
        window.open(
          "https://admin.powerplatform.microsoft.com/manage/environments/" +
            settings.organizationId +
            "/" +
            settings.bapEnvironmentId +
            "/users",
          "_blank"
        );
      } else {
        window.open("https://admin.powerplatform.microsoft.com", "_blank");
      }
    } catch (e) {
      window.open("https://admin.powerplatform.microsoft.com", "_blank");
    }
    return { message: "Opened security/admin.", level: "success" };
  });
  PPmain.register("openSolutionsHistory", function () {
    try {
      const environmentId = getXrm().Utility.getGlobalContext().organizationSettings.bapEnvironmentId;
      window.open("https://make.powerapps.com/environments/" + environmentId + "/solutionsHistory", "_blank");
    } catch (e) {
      window.open("https://make.powerapps.com", "_blank");
    }
    return { message: "Opened solutions history.", level: "success" };
  });
  PPmain.register("pinSidePanel", async function () {
    const xrm = requireForm();
    const input = xrm.Utility.getPageContext().input;
    const pane = await xrm.App.sidePanes.createPane({ canClose: true });
    if (input.pageType === "entityrecord") {
      pane.navigate({ pageType: input.pageType, entityName: input.entityName, entityId: input.entityId });
    } else {
      pane.navigate({ pageType: input.pageType, entityName: input.entityName });
    }
    return { message: "Pinned current page to side panel.", level: "success" };
  });

})(window.PPMain);
