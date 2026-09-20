/**
 * Dynamics 365 Power Pane Next - MAIN-world bridge.
 *
 * Runs in the page's MAIN JavaScript world so it can reach the global `Xrm`
 * client API and the environment's Web API. The isolated content script sends
 * commands over window.postMessage (see PP.BRIDGE) and this file replies with
 * the result. Every command handler returns a plain serialisable object:
 *
 *   { message, level }                 -> toast only
 *   { output: { title, items } }       -> key/value result dialog
 *   { table: { title, columns, rows } }-> sortable/exportable table dialog
 *   { users: [...] } / { items: [...] }-> data consumed by the UI directly
 *
 * Handlers are grouped by area (context, record, form, navigation, debug,
 * admin, impersonation data) and delegate to the small helpers above them.
 */
(function () {
  "use strict";
  if (window.__ppNextBridgeLoaded) return;
  window.__ppNextBridgeLoaded = true;

  var ORIGINAL_LABEL_KEY = "__ppOriginalLabel";
  var entityCache = null;

  function getXrm() {
    return window.Xrm;
  }

  function requireForm() {
    var X = getXrm();
    if (!X || !X.Page || !X.Page.context) {
      throw new Error("Open a record form to use this action.");
    }
    return X;
  }

  function clientUrl() {
    return requireForm().Page.context.getClientUrl();
  }

  function objectTypeCode(X) {
    try {
      var entityName = X.Page.data.entity.getEntityName();
      var etc = X.Page.context.getQueryStringParameters().etc;
      if (etc) return etc;
      try {
        return X.Internal.getEntityCode(entityName);
      } catch (e) {
        return null;
      }
    } catch (e) {
      return null;
    }
  }

  function buildRecordUrl(X, appId) {
    var url = X.Page.context.getClientUrl() + "/main.aspx?";
    if (appId) url += "appid=" + appId + "&";
    url += "etn=" + X.Page.data.entity.getEntityName();
    url += "&id=" + X.Page.data.entity.getId();
    url += "&pagetype=entityrecord";
    return url;
  }

  function apiVersion() {
    try {
      var v = getXrm().Utility.getGlobalContext().getVersion();
      var m = /^(\d+\.\d+)/.exec(v);
      return m ? m[1] : "9.2";
    } catch (e) {
      return "9.2";
    }
  }

  function baseUrl() {
    var X = getXrm();
    try {
      if (X && X.Utility && X.Utility.getGlobalContext) {
        return X.Utility.getGlobalContext().getClientUrl();
      }
    } catch (e) {}
    try {
      if (X && X.Page && X.Page.context) {
        return X.Page.context.getClientUrl();
      }
    } catch (e) {}
    return location.origin;
  }

  function webApiGet(path) {
    var url = baseUrl() + "/api/data/v" + apiVersion() + "/" + path;
    return fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        "Prefer": "odata.include-annotations=*"
      }
    }).then(function (r) {
      if (!r.ok) throw new Error("Web API " + r.status + " " + r.statusText);
      return r.json();
    });
  }

  function xmlEncode(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function prettyXml(source) {
    try {
      var xmlDoc = new DOMParser().parseFromString(source, "application/xml");
      var xsltDoc = new DOMParser().parseFromString(
        [
          '<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform">',
          '  <xsl:strip-space elements="*"/>',
          '  <xsl:template match="node()|@*">',
          "    <xsl:copy><xsl:apply-templates select=\"node()|@*\"/></xsl:copy>",
          "  </xsl:template>",
          '  <xsl:output indent="yes"/>',
          "</xsl:stylesheet>"
        ].join("\n"),
        "application/xml"
      );
      var p = new XSLTProcessor();
      p.importStylesheet(xsltDoc);
      return new XMLSerializer().serializeToString(p.transformToDocument(xmlDoc));
    } catch (e) {
      return source;
    }
  }

  function findContainer(name) {
    return document.querySelector('[data-id="' + name + '"]') || document.getElementById(name);
  }

  function applyUrlParam(name, value) {
    try {
      var url = new URL(location.href);
      if (url.searchParams.getAll(name).indexOf(value) === -1) {
        url.searchParams.append(name, value);
        location.href = url.toString();
        return { message: "Applied " + name + "=" + value + "; reloading...", level: "success" };
      }
      return { message: "Already applied: " + name + "=" + value, level: "success" };
    } catch (e) {
      throw new Error("Could not update the URL.");
    }
  }

  async function getEntitySolutionId(entityName) {
    try {
      var em = await webApiGet("EntityDefinitions(LogicalName='" + entityName + "')?$select=MetadataId");
      var mid = em.MetadataId;
      var sc = await webApiGet(
        "solutioncomponents?$select=solutionid,componenttype,objectid&$filter=objectid eq " +
          mid +
          " and componenttype eq 1&$top=10&$expand=solutionid($select=solutionid,uniquename)"
      );
      var list = sc.value || [];
      for (var i = 0; i < list.length; i++) {
        var s = list[i].solutionid;
        if (s && s.solutionid) return s.solutionid;
      }
    } catch (e) {}
    return "fd140aaf-4df4-11dd-bd17-0019b9312238";
  }

  async function webAssoc(userId, nav, entitySet, refId) {
    var clean = String(userId).replace(/[{}]/g, "");
    var base = baseUrl() + "/api/data/v" + apiVersion();
    var url = base + "/systemusers(" + clean + ")/" + nav + "/$ref";
    var body = JSON.stringify({
      "@odata.id": base + "/" + entitySet + "(" + String(refId).replace(/[{}]/g, "") + ")"
    });
    var r = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "OData-MaxVersion": "4.0", "OData-Version": "4.0" },
      body: body
    });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + r.statusText);
  }
  async function webDisassoc(userId, nav, entitySet, refId) {
    var clean = String(userId).replace(/[{}]/g, "");
    var base = baseUrl() + "/api/data/v" + apiVersion();
    var url =
      base +
      "/systemusers(" +
      clean +
      ")/" +
      nav +
      "/$ref?$id=" +
      encodeURIComponent(base + "/" + entitySet + "(" + String(refId).replace(/[{}]/g, "") + ")");
    var r = await fetch(url, {
      method: "DELETE",
      credentials: "include",
      headers: { "OData-MaxVersion": "4.0", "OData-Version": "4.0" }
    });
    if (!r.ok && r.status !== 204) throw new Error("HTTP " + r.status + " " + r.statusText);
  }
  async function webPatch(path, body) {
    var url = baseUrl() + "/api/data/v" + apiVersion() + "/" + path;
    var r = await fetch(url, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json", "OData-MaxVersion": "4.0", "OData-Version": "4.0" },
      body: JSON.stringify(body)
    });
    if (!r.ok && r.status !== 204) throw new Error("HTTP " + r.status + " " + r.statusText);
  }

  async function webApiGetAll(path) {
    var out = [];
    var guard = 0;
    var d = await webApiGet(path);
    out = out.concat(d.value || []);
    var next = d["@odata.nextLink"];
    while (next && guard < 40) {
      guard++;
      try {
        var r = await fetch(next, {
          credentials: "include",
          headers: { Accept: "application/json", "OData-MaxVersion": "4.0", "OData-Version": "4.0" }
        });
        if (!r.ok) break;
        d = await r.json();
        out = out.concat(d.value || []);
        next = d["@odata.nextLink"];
      } catch (e) {
        break;
      }
    }
    return out;
  }

  var handlers = {
    ping: function () {
      return { hasXrm: !!getXrm(), environment: getXrm() ? "dynamics" : "unknown" };
    },

    getContext: function () {
      var X = requireForm();
      var entity = X.Page.data && X.Page.data.entity;
      var formName = "";
      var formId = "";
      try {
        var item = X.Page.ui.formSelector.getCurrentItem();
        if (item) {
          formName = item.getLabel();
          formId = item.getId();
        }
      } catch (e) {}
      var formTypeCode = X.Page.ui ? X.Page.ui.getFormType() : "";
      var formTypeMeanings = {
        0: "Undefined",
        1: "Create",
        2: "Update",
        3: "Read Only",
        4: "Disabled",
        5: "Quick Create",
        6: "Bulk Edit"
      };
      var formTypeText =
        formTypeMeanings[formTypeCode] != null
          ? formTypeCode + " - " + formTypeMeanings[formTypeCode]
          : String(formTypeCode);
      return {
        output: {
          title: "Form Context",
          items: [
            { label: "Client URL", value: X.Page.context.getClientUrl() },
            { label: "Entity", value: entity ? entity.getEntityName() : "(not a form)" },
            { label: "Record Id", value: entity ? entity.getId() : "(not a form)" },
            { label: "Form Name", value: formName },
            { label: "Form Id", value: formId },
            { label: "Form Type", value: formTypeText }
          ]
        }
      };
    },

    userInfo: async function () {
      var X = requireForm();
      var c = X.Page.context;
      var userId = c.getUserId();
      var cleanId = userId.replace(/[{}]/g, "");
      var roles = [];
      var teams = [];
      try {
        var data = await webApiGet(
          "systemusers(" +
            cleanId +
            ")?$select=fullname&$expand=systemuserroles_association($select=name),teammembership_association($select=name)"
        );
        roles = (data.systemuserroles_association || []).map(function (r) {
          return r.name;
        });
        teams = (data.teammembership_association || []).map(function (t) {
          return t.name;
        });
      } catch (e) {
        roles = ["(failed: " + e.message + ")"];
      }
      return {
        output: {
          title: "User Info",
          description: "Current signed-in user.",
          items: [
            { label: "User name", value: c.getUserName() },
            { label: "User id", value: userId },
            { label: "Roles", value: roles },
            { label: "Teams", value: teams }
          ]
        }
      };
    },

    entityInfo: function () {
      var X = requireForm();
      var items = [{ label: "Entity Name", value: X.Page.data.entity.getEntityName() }];
      var etc = objectTypeCode(X);
      if (etc) items.push({ label: "Entity Type Code", value: String(etc) });
      return { output: { title: "Entity Info", items: items } };
    },

    recordId: function () {
      var X = requireForm();
      return { output: { title: "Record Id", items: [{ label: "Record Id", value: X.Page.data.entity.getId() }] } };
    },

    recordUrl: async function () {
      var X = requireForm();
      var items = [{ label: "Record Url", value: buildRecordUrl(X) }];
      try {
        var gc = X.Utility.getGlobalContext();
        if (gc.getCurrentAppProperties) {
          var app = await gc.getCurrentAppProperties();
          items.push({
            label: "Record Url (current app)",
            value: buildRecordUrl(X, app.appId)
          });
        }
      } catch (e) {
        /* app props unavailable */
      }
      return { output: { title: "Record Url", items: items } };
    },

    enableAllFields: function () {
      var X = requireForm();
      X.Page.ui.controls.forEach(function (c) {
        try {
          c.setDisabled(false);
        } catch (e) {}
      });
      return { message: "All fields are enabled.", level: "success" };
    },

    showHiddenFields: function () {
      var X = requireForm();
      X.Page.ui.controls.forEach(function (c) {
        try {
          c.setVisible(true);
        } catch (e) {}
      });
      X.Page.ui.tabs.forEach(function (t) {
        try {
          if (t.setVisible) t.setVisible(true);
          if (t.sections && t.sections.getAll) {
            t.sections.getAll().forEach(function (s) {
              try {
                if (s && s.setVisible) s.setVisible(true);
              } catch (e) {}
            });
          }
        } catch (e) {}
      });
      return { message: "All hidden fields, tabs and sections are now visible.", level: "success" };
    },

    disableRequired: function () {
      var X = requireForm();
      X.Page.ui.controls.forEach(function (c) {
        try {
          if (c && c.getAttribute && c.getAttribute().setRequiredLevel) {
            c.getAttribute().setRequiredLevel("none");
          }
        } catch (e) {}
      });
      return { message: "Required level of all fields set to none.", level: "success" };
    },

    showFieldValue: function (args) {
      var X = requireForm();
      var name = (args && args.fieldname || "").trim();
      if (!name) throw new Error("Field schema name is required.");
      var control = X.Page.getControl(name);
      if (!control || !control.getControlType) throw new Error("Field not found on this form.");
      var type = control.getControlType();
      var items = [{ label: "Control Type", value: type }];
      if (type === "optionset") {
        items.push({ label: "Selected Text", value: control.getAttribute().getText() });
        items.push({ label: "Selected Value", value: control.getAttribute().getValue() });
      } else if (type === "lookup") {
        var v = control.getAttribute().getValue();
        var first = v && v.length ? v[0] : null;
        items.push({ label: "Name", value: first ? first.name : "" });
        items.push({ label: "Id", value: first ? first.id : "" });
        items.push({ label: "Entity Name", value: first ? first.entityType : "" });
        items.push({ label: "Entity Type Code", value: first ? first.type : "" });
      } else {
        items.push({ label: "Value", value: control.getAttribute().getValue() });
      }
      return { output: { title: "Field Value", description: name, items: items } };
    },

    findField: function (args) {
      var X = requireForm();
      var name = (args && args.fieldname || "").trim();
      if (!name) throw new Error("Field schema name is required.");
      var control = X.Page.getControl(name);
      if (!control) throw new Error("Field not found on this form.");
      control.setFocus();
      var hidden = "";
      if (control.getVisible && control.getVisible() === false) {
        control.setVisible(true);
        hidden = " It was hidden and is now visible.";
      }
      var el = findContainer(name);
      if (el) el.style.background = "#FFFF00";
      return { message: "Focused field " + name + "." + hidden, level: "success" };
    },

    highlightDirty: function () {
      var X = requireForm();
      X.Page.ui.controls.forEach(function (c) {
        var attr = c && c.getAttribute ? c.getAttribute() : null;
        if (attr && attr.getIsDirty && attr.getIsDirty()) {
          var el = findContainer(c.getName());
          if (el) el.style.background = "#FFFF00";
        }
      });
      return { message: "Dirty fields highlighted.", level: "success" };
    },

    clearNotifications: function () {
      var X = requireForm();
      X.Page.ui.controls.forEach(function (c) {
        try {
          c.clearNotification();
        } catch (e) {}
      });
      return { message: "All field notifications cleared.", level: "success" };
    },

    refreshForm: function () {
      var X = requireForm();
      X.Page.data.refresh(false);
      return { message: "Form refreshed.", level: "success" };
    },

    refreshRibbon: function () {
      var X = requireForm();
      X.Page.ui.refreshRibbon();
      return { message: "Ribbon refreshed.", level: "success" };
    },

    toggleLookupLinks: function () {
      var X = requireForm();
      var existing = document.querySelectorAll(".pp-lookup-link");
      if (existing.length) {
        existing.forEach(function (n) {
          n.remove();
        });
        return { message: "Lookup links removed.", level: "success" };
      }
      var icon =
        '<svg viewBox="0 0 32 32" width="14" height="14" fill="none" stroke="currentcolor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M14 9 L3 9 3 29 23 29 23 18 M18 4 L28 4 28 14 M28 4 L14 18" /></svg>';
      X.Page.ui.controls.forEach(function (c) {
        try {
          if (c.getControlType() !== "lookup") return;
          var holder = findContainer(c.getName());
          if (!holder) return;
          var a = document.createElement("a");
          a.className = "pp-lookup-link";
          a.title = "Open this record in a new window";
          a.style.cssText = "cursor:pointer;margin-left:5px;display:inline-block;vertical-align:middle";
          a.innerHTML = icon;
          a.addEventListener("click", function () {
            try {
              var rec = c.getAttribute().getValue()[0];
              window.open(
                X.Page.context.getClientUrl() +
                  "/main.aspx?etn=" +
                  rec.entityType +
                  "&id=" +
                  rec.id +
                  "&pagetype=entityrecord"
              );
            } catch (e) {}
          });
          holder.appendChild(a);
        } catch (e) {}
      });
      return { message: "Lookup links added.", level: "success" };
    },

    cloneRecord: function () {
      var X = requireForm();
      var excluded = ["createdon", "createdby", "modifiedon", "modifiedby", "ownerid"];
      var fields = [];
      X.Page.data.entity.attributes.forEach(function (a) {
        var name = a.getName();
        var value = a.getValue();
        if (!value || excluded.indexOf(name) > -1) return;
        switch (a.getAttributeType()) {
          case "lookup":
            if (a.getLookupTypes() && value[0]) {
              fields.push(name + "=" + value[0].id);
              fields.push(name + "name=" + value[0].name);
              if (a.getLookupTypes().length > 1) fields.push(name + "type=" + value[0].entityType);
            }
            break;
          case "datetime":
            fields.push(name + "=" + new Date(value).toLocaleDateString());
            break;
          default:
            fields.push(name + "=" + value);
        }
      });
      var url =
        X.Page.context.getClientUrl() +
        "/main.aspx?etn=" +
        X.Page.data.entity.getEntityName() +
        "&pagetype=entityrecord&extraqs=?" +
        encodeURIComponent(fields.join("&"));
      window.open(url, "_blank");
      return { message: "Clone form opened in a new tab.", level: "success" };
    },

    goToRecord: function (args) {
      var X = requireForm();
      var etn = (args && args.entityname || "").trim().toLowerCase();
      var id = (args && args.recordid || "").trim();
      if (!etn || !id) throw new Error("Entity name and record id are both required.");
      window.open(
        X.Page.context.getClientUrl() + "/main.aspx?etn=" + etn + "&id=" + id + "&pagetype=entityrecord",
        "_blank"
      );
      return { message: "Opened record.", level: "success" };
    },

    goToCreateForm: function (args) {
      var X = requireForm();
      var etn = (args && args.entityname || "").trim().toLowerCase();
      if (!etn) throw new Error("Entity name is required.");
      window.open(
        X.Page.context.getClientUrl() + "/main.aspx?etn=" + etn + "&newWindow=true&pagetype=entityrecord",
        "_blank"
      );
      return { message: "Opened create form.", level: "success" };
    },

    openFormEditor: function () {
      var X = requireForm();
      var url =
        X.Page.context.getClientUrl() +
        "/main.aspx?pagetype=formeditor&appSolutionId={FD140AAF-4DF4-11DD-BD17-0019B9312238}&etn=" +
        X.Page.data.entity.getEntityName().toLowerCase() +
        "&extraqs=formtype=main&formId=" +
        X.Page.ui.formSelector.getCurrentItem().getId();
      window.open(url, "_blank");
      return { message: "Opened classic form editor.", level: "success" };
    },

    openFormEditorNew: async function () {
      var X = requireForm();
      var entityName = X.Page.data.entity.getEntityName();
      var env = "";
      try {
        env = X.Utility.getGlobalContext().organizationSettings.bapEnvironmentId;
      } catch (e) {}
      var formId = "";
      try {
        formId = X.Page.ui.formSelector.getCurrentItem().getId();
      } catch (e) {}
      var sol = await getEntitySolutionId(entityName);
      var url =
        env && formId
          ? "https://make.powerapps.com/e/" + env + "/s/" + sol + "/entity/" + entityName + "/form/edit/" + formId
          : "https://make.powerapps.com/";
      window.open(url, "_blank");
      return { message: "Opened new form designer (Power Apps).", level: "success" };
    },

    openEntityEditor: function (args) {
      var X = requireForm();
      var entityName = ((args && args.entityname) || "").trim() || X.Page.data.entity.getEntityName();
      var detail = "";
      try {
        var etc = X.Internal.getEntityCode(entityName);
        detail = "&def_category=9801&def_type=" + etc;
      } catch (e) {}
      var defaultSolutionId = "{FD140AAF-4DF4-11DD-BD17-0019B9312238}";
      window.open(
        X.Page.context.getClientUrl() + "/tools/solution/edit.aspx?id=" + defaultSolutionId + detail,
        "_blank"
      );
      return { message: "Opened entity editor for " + entityName + ".", level: "success" };
    },

    solutions: function () {
      window.open(clientUrl() + "/tools/Solution/home_solution.aspx?etc=7100", "_blank");
      return { message: "Opened solutions.", level: "success" };
    },

    crmDiagnostics: function () {
      window.open(clientUrl() + "/tools/diagnostics/diag.aspx", "_blank");
      return { message: "Opened diagnostics.", level: "success" };
    },

    performanceCenter: function () {
      if (window.Mscrm && Mscrm.Performance && Mscrm.Performance.PerformanceCenter) {
        Mscrm.Performance.PerformanceCenter.get_instance().TogglePerformanceResultsVisibility();
        return { message: "Toggled performance results.", level: "success" };
      }
      throw new Error("Performance Center is not available on this page.");
    },

    mobileClient: function () {
      var X = requireForm();
      var url = X.Page.context.getClientUrl();
      window.open(url + "/nga/main.htm?org=" + X.Page.context.getOrgUniqueName() + "&server=" + url, "_blank");
      return { message: "Opened mobile client.", level: "success" };
    },

    openWebApi: async function () {
      var X = requireForm();
      var meta = await X.Utility.getEntityMetadata(X.Page.data.entity.getEntityName(), "");
      var url =
        X.Page.context.getClientUrl() +
        "/api/data/v" +
        apiVersion() +
        "/" +
        meta.EntitySetName +
        "(" +
        X.Page.data.entity.getId().replace(/[{}]/g, "") +
        ")";
      window.open(url, "_blank");
      return { message: "Opened Web API record URL.", level: "success" };
    },

    recordProperties: function () {
      var X = requireForm();
      var id = X.Page.data.entity.getId();
      var etc = objectTypeCode(X);
      if (window.Mscrm && Mscrm.RibbonActions && Mscrm.RibbonActions.openFormProperties) {
        Mscrm.RibbonActions.openFormProperties(id, etc);
        return { message: "Opened record properties.", level: "success" };
      }
      var url =
        X.Page.context.getClientUrl() +
        "/_forms/properties/properties.aspx?dType=1&id=" +
        id +
        "&objTypeCode=" +
        etc;
      window.open(url, "_blank", "width=420,height=505");
      return { message: "Opened record properties.", level: "success" };
    },

    executeFetchXml: async function (args) {
      var X = requireForm();
      var xml = (args && args.xml || "").trim();
      if (!xml) throw new Error("FetchXML is empty.");
      var envelope =
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
        '<Execute xmlns="http://schemas.microsoft.com/xrm/2011/Contracts/Services">' +
        '<request i:type="b:RetrieveMultipleRequest" xmlns:b="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">' +
        '<b:Parameters xmlns:c="http://schemas.datacontract.org/2004/07/System.Collections.Generic">' +
        "<b:KeyValuePairOfstringanyType><c:key>Query</c:key>" +
        '<c:value i:type="b:FetchExpression"><b:Query>' +
        xmlEncode(xml) +
        "</b:Query></c:value></b:KeyValuePairOfstringanyType></b:Parameters>" +
        '<b:RequestId i:nil="true"/><b:RequestName>RetrieveMultiple</b:RequestName></request></Execute>' +
        "</s:Body></s:Envelope>";
      var res = await fetch(X.Page.context.getClientUrl() + "/XRMServices/2011/Organization.svc/web", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "text/xml",
          Accept: "application/xml, text/xml, */*",
          SOAPAction:
            "http://schemas.microsoft.com/xrm/2011/Contracts/Services/IOrganizationService/Execute"
        },
        body: envelope
      });
      var text = await res.text();
      return { output: { title: "Fetch XML Result", description: res.status + " " + res.statusText, items: [{ label: "Response", value: prettyXml(text) }] } };
    },

    fieldInspector: function () {
      var X = requireForm();
      var rows = [];
      X.Page.ui.controls.forEach(function (c) {
        try {
          var name = c.getName && c.getName();
          if (!name) return;
          var attr = c.getAttribute ? c.getAttribute() : null;
          var value = null;
          try {
            value = attr ? attr.getValue() : null;
          } catch (e) {}
          if (value && typeof value === "object") {
            if (Array.isArray(value)) {
              value = value
                .map(function (v) {
                  return v && (v.name || v.id) ? v.name || v.id : "";
                })
                .filter(Boolean)
                .join("; ");
            } else {
              value = JSON.stringify(value);
            }
          }
          rows.push({
            label: c.getLabel ? c.getLabel() : "",
            name: name,
            type: c.getControlType ? c.getControlType() : "",
            value: value == null ? "" : String(value),
            required: attr && attr.getRequiredLevel ? attr.getRequiredLevel() : "",
            visible: c.getVisible ? String(c.getVisible()) : "",
            disabled: c.getDisabled ? String(c.getDisabled()) : ""
          });
        } catch (e) {}
      });
      return {
        table: {
          title: "Field Inspector",
          description: X.Page.data.entity.getEntityName(),
          searchable: true,
          copyKey: "name",
          columns: [
            { key: "label", label: "Label" },
            { key: "name", label: "Schema Name" },
            { key: "type", label: "Type" },
            { key: "value", label: "Value" },
            { key: "required", label: "Required" },
            { key: "visible", label: "Visible" }
          ],
          rows: rows
        }
      };
    },

    listLookups: function () {
      var X = requireForm();
      var rows = [];
      X.Page.ui.controls.forEach(function (c) {
        try {
          if (!c.getControlType || c.getControlType() !== "lookup") return;
          var value = c.getAttribute().getValue();
          var first = value && value.length ? value[0] : null;
          rows.push({
            label: c.getLabel ? c.getLabel() : "",
            field: c.getName(),
            name: first ? first.name : "(empty)",
            entity: first ? first.entityType : "",
            id: first ? first.id : "",
            url: first
              ? X.Page.context.getClientUrl() +
                "/main.aspx?etn=" +
                first.entityType +
                "&id=" +
                first.id +
                "&pagetype=entityrecord"
              : ""
          });
        } catch (e) {}
      });
      return {
        table: {
          title: "Lookups",
          description: X.Page.data.entity.getEntityName(),
          searchable: true,
          columns: [
            { key: "label", label: "Field" },
            { key: "name", label: "Value" },
            { key: "entity", label: "Entity" },
            { key: "id", label: "Id" }
          ],
          rows: rows
        }
      };
    },

    entityMetadata: async function (args) {
      var X = requireForm();
      var name = (args && args.entityname || "").trim() || X.Page.data.entity.getEntityName();
      var data = await webApiGet(
        "EntityDefinitions(LogicalName='" +
          name +
          "')?$select=LogicalName,PrimaryIdAttribute&$expand=Attributes($select=LogicalName,AttributeType,IsCustomAttribute,RequiredLevel)"
      );
      var attrs = data.Attributes || [];
      var rows = attrs.map(function (a) {
        return {
          name: a.LogicalName,
          type: a.AttributeType,
          custom: a.IsCustomAttribute ? "yes" : "",
          required: a.RequiredLevel && a.RequiredLevel.Value ? a.RequiredLevel.Value : ""
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
    },

    openUrl: function (args) {
      var url = args && args.url;
      if (!url) throw new Error("No URL to open.");
      window.open(url, "_blank");
      return { message: "Opened in a new tab.", level: "success" };
    },

    searchUsers: async function (args) {
      var q = ((args && args.query) || "").trim();
      if (q.length < 2) return { users: [] };
      var safe = q.replace(/'/g, "''");
      var filter =
        "isdisabled eq false and (contains(fullname,'" +
        safe +
        "') or contains(internalemailaddress,'" +
        safe +
        "') or contains(domainname,'" +
        safe +
        "'))";
      var data = await webApiGet(
        "systemusers?$select=systemuserid,fullname,internalemailaddress,domainname,azureactivedirectoryobjectid,isdisabled" +
          "&$filter=" +
          encodeURIComponent(filter) +
          "&$orderby=fullname asc&$top=25"
      );
      return { users: data.value || [] };
    },

    whoAmI: async function () {
      var d = await webApiGet("WhoAmI");
      return { userId: d.UserId, organizationId: d.OrganizationId };
    },

    roleCheck: async function (args) {
      var raw = ((args && args.query) || "").trim();
      if (!raw) throw new Error("Enter one or more names or emails (separate with commas or new lines).");
      var terms = raw
        .split(/[,;\n\r]+/)
        .map(function (s) {
          return s.trim();
        })
        .filter(function (s) {
          return s.length >= 2;
        });
      if (!terms.length) throw new Error("Enter at least 2 characters per name/email.");
      var map = {};
      for (var t = 0; t < terms.length; t++) {
        try {
          var found = await handlers.searchUsers({ query: terms[t] });
          (found && found.users ? found.users : []).forEach(function (u) {
            if (!map[u.systemuserid]) map[u.systemuserid] = u;
          });
        } catch (e) {}
      }
      var users = Object.keys(map)
        .map(function (k) {
          return map[k];
        })
        .slice(0, 25);
      if (!users.length) throw new Error("No users found for: " + terms.join(", "));
      var rows = [];
      for (var i = 0; i < users.length; i++) {
        var u = users[i];
        var row = {
          name: u.fullname || "",
          email: u.internalemailaddress || "",
          bu: "",
          roles: "",
          teams: ""
        };
        try {
          var d = await webApiGet(
            "systemusers(" +
              u.systemuserid +
              ")?$select=fullname,internalemailaddress,domainname" +
              "&$expand=businessunitid($select=name),systemuserroles_association($select=name),teammembership_association($select=name)"
          );
          row.name = d.fullname || row.name;
          row.email = d.internalemailaddress || row.email;
          row.bu = (d.businessunitid && d.businessunitid.name) || "";
          row.roles = (d.systemuserroles_association || [])
            .map(function (r) {
              return r.name;
            })
            .join(", ");
          row.teams = (d.teammembership_association || [])
            .map(function (t) {
              return t.name;
            })
            .join(", ");
        } catch (e) {
          row.roles = "(read failed: " + e.message + ")";
        }
        rows.push(row);
      }
      return {
        table: {
          title: "Role Check",
          description: rows.length + " user(s)",
          searchable: true,
          columns: [
            { key: "name", label: "Name" },
            { key: "email", label: "Email" },
            { key: "bu", label: "Business Unit" },
            { key: "roles", label: "Roles" },
            { key: "teams", label: "Teams" }
          ],
          rows: rows
        }
      };
    },

    // ---- Form: logical names / changed fields (from Levelup) ------------
    clearLogicalNames: function () {
      var els = document.querySelectorAll(".pp-logical-name");
      for (var i = 0; i < els.length; i++) {
        els[i].classList.remove("pp-logical-name");
        els[i].removeAttribute("title");
        els[i].__ppBound = false;
      }
      return { message: "Logical name mode cleared.", level: "success" };
    },

    godMode: function () {
      var X = requireForm();
      var n = 0;
      X.Page.data.entity.attributes.forEach(function (a) {
        try {
          if (a.getRequiredLevel() === "required") {
            a.setRequiredLevel("none");
            n++;
          }
        } catch (e) {}
      });
      X.Page.ui.controls.forEach(function (c) {
        try {
          if (c.setVisible) c.setVisible(true);
          if (c.setDisabled) c.setDisabled(false);
          n++;
        } catch (e) {}
      });
      X.Page.ui.tabs.forEach(function (t) {
        try {
          if (t.setVisible) t.setVisible(true);
          if (t.sections && t.sections.forEach) {
            t.sections.forEach(function (s) {
              try {
                if (s.setVisible) s.setVisible(true);
              } catch (e) {}
            });
          }
        } catch (e) {}
      });
      return { message: "God mode: " + n + " elements unlocked.", level: "success" };
    },

    changedFields: function () {
      var X = requireForm();
      var names = [];
      try {
        var xml = X.Page.data.entity.getDataXml();
        var doc = new DOMParser().parseFromString(xml, "text/xml");
        var root = doc.documentElement;
        for (var i = 0; i < root.children.length; i++) names.push(root.children[i].tagName);
      } catch (e) {
        X.Page.data.entity.attributes.forEach(function (a) {
          if (a.getIsDirty && a.getIsDirty()) names.push(a.getName());
        });
      }
      var marked = 0;
      names.forEach(function (n) {
        var el = findContainer(n);
        if (el) {
          el.style.boxShadow = "inset 4px 0 0 #742774";
          marked++;
        }
      });
      return { message: names.length + " changed field(s), " + marked + " highlighted.", level: "success" };
    },

    refreshSubgrids: function () {
      var X = requireForm();
      var n = 0;
      X.Page.ui.controls.forEach(function (c) {
        try {
          if (c.getControlType && c.getControlType() === "subgrid" && c.refresh) {
            c.refresh();
            n++;
          }
        } catch (e) {}
      });
      return { message: n + " subgrid(s) refreshed.", level: "success" };
    },

    refreshWithoutSave: async function () {
      var X = requireForm();
      await X.Page.data.refresh(false);
      try {
        X.Page.data.entity.addOnSave(function (ctx) {
          var args = ctx.getEventArgs();
          if (args.getSaveMode() === 70 || args.getSaveMode() === 2) args.preventDefault();
        });
      } catch (e) {}
      return { message: "Form refreshed; auto-save disabled for this session.", level: "success" };
    },

    allFields: async function () {
      var X = requireForm();
      var entityName = X.Page.data.entity.getEntityName();
      var id = X.Page.data.entity.getId().replace(/[{}]/g, "");
      var meta = await X.Utility.getEntityMetadata(entityName, "");
      var attrData = await webApiGet(
        "EntityDefinitions(LogicalName='" + entityName + "')/Attributes?$select=LogicalName,AttributeType,DisplayName"
      );
      var rec = await webApiGet(meta.EntitySetName + "(" + id + ")");
      var rows = [];
      (attrData.value || []).forEach(function (a) {
        var ln = a.LogicalName;
        var display =
          (a.DisplayName && a.DisplayName.UserLocalizedLabel && a.DisplayName.UserLocalizedLabel.Label) || "";
        var type = a.AttributeType || "";
        var raw = rec[ln];
        var isLookup = type === "Lookup" || type === "Owner" || type === "Customer";
        // Formatted-value annotations live on the lookup property `_<name>_value`
        // for lookups, and on `<name>` for simple/option-set attributes.
        var value = "";
        var valueName = "";
        if (isLookup) {
          value = rec["_" + ln + "_value"] || "";
          valueName =
            rec["_" + ln + "_value@OData.Community.Display.V1.FormattedValue"] ||
            rec[ln + "@OData.Community.Display.V1.FormattedValue"] ||
            "";
        } else {
          valueName = rec[ln + "@OData.Community.Display.V1.FormattedValue"] || "";
          if (raw == null) {
            value = "";
          } else if (typeof raw === "object") {
            value = JSON.stringify(raw);
          } else {
            value = String(raw);
          }
        }
        rows.push({
          display: display,
          logical: ln,
          type: type,
          value: value,
          name: valueName == null ? "" : String(valueName)
        });
      });
      rows.sort(function (a, b) {
        return a.logical.localeCompare(b.logical);
      });
      return {
        table: {
          title: "All Fields (Web API)",
          description: entityName + " - " + rows.length + " attributes",
          searchable: true,
          copyKey: "logical",
          columns: [
            { key: "display", label: "Display Name" },
            { key: "logical", label: "Logical Name" },
            { key: "type", label: "Type" },
            { key: "value", label: "Value" },
            { key: "name", label: "Value Name" }
          ],
          rows: rows
        }
      };
    },

    optionSetValues: async function () {
      var X = requireForm();
      var entityName = X.Page.data.entity.getEntityName();
      var rows = [];
      var seen = {}; // "logical|value" -> true, avoids duplicates
      function push(group, logical, optSet) {
        var opts = (optSet && optSet.Options) || [];
        opts.forEach(function (o) {
          var value = String(o.Value);
          var key = logical + "|" + value;
          if (seen[key]) return;
          seen[key] = true;
          var label =
            (o.Label && o.Label.UserLocalizedLabel && o.Label.UserLocalizedLabel.Label) || "";
          rows.push({ group: group, attribute: logical, label: label, value: value });
        });
      }
      var casts = [
        "PicklistAttributeMetadata",
        "MultiSelectPicklistAttributeMetadata",
        "StateAttributeMetadata",
        "StatusAttributeMetadata"
      ];
      for (var i = 0; i < casts.length; i++) {
        try {
          var data = await webApiGet(
            "EntityDefinitions(LogicalName='" +
              entityName +
              "')/Attributes/Microsoft.Dynamics.CRM." +
              casts[i] +
              "?$select=LogicalName,DisplayName&$expand=OptionSet,GlobalOptionSet"
          );
          (data.value || []).forEach(function (a) {
            var display =
              (a.DisplayName && a.DisplayName.UserLocalizedLabel && a.DisplayName.UserLocalizedLabel.Label) || "";
            var group = display ? display + " (" + a.LogicalName + ")" : a.LogicalName;
            // A global option set exposes its options through GlobalOptionSet;
            // use the first non-empty source so values are not listed twice.
            var source =
              (a.GlobalOptionSet && a.GlobalOptionSet.Options && a.GlobalOptionSet.Options.length
                ? a.GlobalOptionSet
                : null) ||
              (a.OptionSet && a.OptionSet.Options && a.OptionSet.Options.length ? a.OptionSet : null);
            push(group, a.LogicalName, source);
          });
        } catch (e) {}
      }
      rows.sort(function (a, b) {
        return a.attribute.localeCompare(b.attribute) || Number(a.value) - Number(b.value);
      });
      return {
        table: {
          title: "OptionSet Values",
          description: entityName + " - " + rows.length + " option(s)",
          searchable: true,
          copyKey: "value",
          groupBy: "group",
          columns: [
            { key: "label", label: "Label" },
            { key: "value", label: "Value" }
          ],
          rows: rows
        }
      };
    },

    logicalNamesInline: function () {
      var X = requireForm();
      var on = null;
      X.Page.ui.controls.forEach(function (c) {
        try {
          if (!c.getName || !c.setLabel || !c.getLabel) return;
          var name = c.getName();
          if (!c.__ppOrigLabel) {
            c.__ppOrigLabel = c.getLabel();
            c.setLabel(c.__ppOrigLabel + " [" + name + "]");
            on = "update";
          } else {
            c.setLabel(c.__ppOrigLabel);
            c.__ppOrigLabel = null;
            on = "rollback";
          }
          var el = findContainer(name) || document.getElementById(name + "_c");
          var lab = el && el.tagName === "LABEL" ? el : el && el.querySelector ? el.querySelector("label") : el;
          if (lab) {
            if (on === "update") {
              lab.style.cursor = "pointer";
              lab.title = 'Click to copy "' + name + '"';
              if (!lab.__ppBound) {
                lab.__ppBound = true;
                lab.addEventListener(
                  "click",
                  function (ev) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    try {
                      navigator.clipboard.writeText(name);
                    } catch (e) {}
                  },
                  true
                );
              }
            } else {
              lab.style.cursor = "";
              lab.removeAttribute("title");
              lab.__ppBound = false;
            }
          }
        } catch (e) {}
      });
      return {
        message: on === "rollback" ? "Logical name labels removed." : "Logical names appended; click a label to copy.",
        level: "success"
      };
    },

    currentContext: function () {
      var X = getXrm();
      var out = { entityName: "", formName: "" };
      try {
        out.entityName = X.Page.data.entity.getEntityName();
      } catch (e) {}
      try {
        var it = X.Page.ui.formSelector.getCurrentItem();
        if (it) out.formName = it.getLabel();
      } catch (e) {}
      return out;
    },

    tableProcesses: async function () {
      var X = requireForm();
      var entityName = X.Page.data.entity.getEntityName();
      var rows = [];
      function ann(obj, key) {
        return obj[key + "@OData.Community.Display.V1.FormattedValue"] || "";
      }
      try {
        var wf = await webApiGet(
          "workflows?$select=name,category,mode,type,statecode,statuscode,primaryentity,scope,createdon,modifiedon,workflowid,description" +
            "&$filter=primaryentity eq '" +
            entityName +
            "'&$top=200"
        );
        (wf.value || []).forEach(function (w) {
          var type = ann(w, "category") + (w.mode != null ? " / " + ann(w, "mode") : "");
          rows.push({
            name: w.name || "(unnamed)",
            type: type || String(w.category),
            state: ann(w, "statecode") || String(w.statecode),
            url: w.workflowid
              ? baseUrl() + "/main.aspx?etn=workflow&id=" + w.workflowid + "&pagetype=entityrecord"
              : "",
            _detail: [
              { label: "Name", value: w.name || "" },
              { label: "Type", value: ann(w, "category") + " (" + w.category + ")" },
              { label: "Mode", value: ann(w, "mode") + " (" + w.mode + ")" },
              { label: "State", value: ann(w, "statecode") + " (" + w.statecode + ")" },
              { label: "Status", value: ann(w, "statuscode") + " (" + w.statuscode + ")" },
              { label: "Scope", value: ann(w, "scope") + " (" + w.scope + ")" },
              { label: "Primary Entity", value: w.primaryentity || "" },
              { label: "Workflow Id", value: w.workflowid || "" },
              { label: "Created On", value: w.createdon || "" },
              { label: "Modified On", value: w.modifiedon || "" },
              { label: "Description", value: w.description || "" }
            ]
          });
        });
      } catch (e) {}
      try {
        var apis = await webApiGet(
          "customapis?$select=uniquename,displayname,bindingtype,boundentitylogicalname,customapiid,createdon,modifiedon" +
            "&$filter=boundentitylogicalname eq '" +
            entityName +
            "'&$top=200"
        );
        (apis.value || []).forEach(function (a) {
          rows.push({
            name: a.displayname || a.uniquename,
            type: "Custom API / " + (a.bindingtype === 1 ? "Entity" : "Global"),
            state: a.bindingtype === 1 ? "Bound" : "Global",
            url: a.customapiid
              ? baseUrl() + "/main.aspx?etn=customapi&id=" + a.customapiid + "&pagetype=entityrecord"
              : "",
            _detail: [
              { label: "Display Name", value: a.displayname || "" },
              { label: "Unique Name", value: a.uniquename || "" },
              { label: "Binding", value: a.bindingtype === 1 ? "Entity (1)" : "Global (0)" },
              { label: "Bound Entity", value: a.boundentitylogicalname || "" },
              { label: "Custom API Id", value: a.customapiid || "" },
              { label: "Created On", value: a.createdon || "" },
              { label: "Modified On", value: a.modifiedon || "" }
            ]
          });
        });
      } catch (e) {}
      return {
        table: {
          title: "Table Processes",
          description: entityName + " - " + rows.length + " found (click a row for details)",
          searchable: true,
          rowDetail: true,
          columns: [
            { key: "name", label: "Name" },
            { key: "type", label: "Type" },
            { key: "state", label: "State" }
          ],
          rows: rows
        }
      };
    },

    getUserAccess: async function (args) {
      var id = String((args && args.userid) || "").replace(/[{}]/g, "");
      if (!id) throw new Error("Missing user id.");
      var d = await webApiGet(
        "systemusers(" +
          id +
          ")?$select=fullname,internalemailaddress,domainname,isdisabled" +
          "&$expand=businessunitid($select=businessunitid,name),systemuserroles_association($select=roleid,name),teammembership_association($select=teamid,name)"
      );
      return {
        user: { id: id, name: d.fullname, email: d.internalemailaddress, domain: d.domainname, disabled: d.isdisabled },
        businessUnit: d.businessunitid ? { id: d.businessunitid.businessunitid, name: d.businessunitid.name } : null,
        roles: (d.systemuserroles_association || []).map(function (r) {
          return { id: r.roleid, name: r.name };
        }),
        teams: (d.teammembership_association || []).map(function (t) {
          return { id: t.teamid, name: t.name };
        })
      };
    },
    getAllRoles: async function () {
      var items = await webApiGetAll("roles?$select=roleid,name,_businessunitid_value&$orderby=name");
      return {
        items: items.map(function (r) {
          return { id: r.roleid, name: r.name, buId: r._businessunitid_value || "" };
        })
      };
    },
    getAllTeams: async function () {
      var items = await webApiGetAll("teams?$select=teamid,name,teamtype&$filter=teamtype eq 0&$orderby=name");
      return {
        items: items.map(function (t) {
          return { id: t.teamid, name: t.name };
        })
      };
    },
    getBusinessUnits: async function () {
      var items = await webApiGetAll("businessunits?$select=businessunitid,name&$orderby=name");
      return {
        items: items.map(function (b) {
          return { id: b.businessunitid, name: b.name };
        })
      };
    },
    setBusinessUnit: async function (args) {
      var id = String(args.userid).replace(/[{}]/g, "");
      var bu = String(args.buid).replace(/[{}]/g, "");
      await webPatch("systemusers(" + id + ")", { "businessunitid@odata.bind": "/businessunits(" + bu + ")" });
      return { message: "Business unit updated.", level: "success" };
    },
    assignRole: async function (args) {
      await webAssoc(args.userid, "systemuserroles_association", "roles", args.roleid);
      return { message: "Role assigned.", level: "success" };
    },
    removeRole: async function (args) {
      await webDisassoc(args.userid, "systemuserroles_association", "roles", args.roleid);
      return { message: "Role removed.", level: "success" };
    },
    addTeam: async function (args) {
      await webAssoc(args.userid, "teammembership_association", "teams", args.teamid);
      return { message: "Added to team.", level: "success" };
    },
    removeTeam: async function (args) {
      await webDisassoc(args.userid, "teammembership_association", "teams", args.teamid);
      return { message: "Removed from team.", level: "success" };
    },

    searchEntities: async function (args) {
      var q = ((args && args.query) || "").trim().toLowerCase();
      if (!q) return { entities: [] };
      if (!entityCache) {
        var data = await webApiGet("EntityDefinitions?$select=LogicalName,DisplayName");
        entityCache = (data.value || []).map(function (e) {
          return {
            logical: e.LogicalName,
            display:
              (e.DisplayName && e.DisplayName.UserLocalizedLabel && e.DisplayName.UserLocalizedLabel.Label) ||
              e.LogicalName
          };
        });
      }
      var res = entityCache
        .filter(function (e) {
          return e.logical.toLowerCase().indexOf(q) > -1 || e.display.toLowerCase().indexOf(q) > -1;
        })
        .slice(0, 50);
      return { entities: res };
    },

    // ---- merged from Levelup: debug URL flags ---------------------------
    formsMonitor: function () {
      return applyUrlParam("monitor", "true");
    },
    commandChecker: function () {
      return applyUrlParam("ribbondebug", "true");
    },
    perfCenterFlag: function () {
      return applyUrlParam("perf", "true");
    },
    disableFormHandlers: function () {
      return applyUrlParam("flags", "DisableFormHandlers=true");
    },
    disableBusinessRules: function () {
      return applyUrlParam("flags", "DisableFormHandlers=businessrule");
    },
    disableFormLibraries: function () {
      return applyUrlParam("flags", "DisableFormLibraries=true");
    },
    disableFormCommandbar: function () {
      return applyUrlParam("flags", "DisableFormCommandbar=true");
    },
    disableWebResourceControls: function () {
      return applyUrlParam("flags", "DisableWebResourceControls=true");
    },
    disableBusinessProcessFlow: function () {
      return applyUrlParam("flags", "DisableBusinessProcessFlow=true");
    },
    disableFormControl: function (args) {
      var name = ((args && args.control) || "").trim();
      if (!name) throw new Error("Control name is required.");
      return applyUrlParam("flags", "DisableFormControl=" + name);
    },
    navbarOff: function () {
      return applyUrlParam("navbar", "off");
    },
    disableAllComponents: function () {
      var value =
        "DisableFormHandlers=true,DisableWebResourceControls=true,DisableFormCommandbar=true,DisableBusinessProcessFlow=true";
      var url = new URL(location.href);
      url.searchParams.set("flags", value);
      location.href = url.toString();
      return { message: "Disabled handlers, web resource controls, command bar and BPF; reloading...", level: "success" };
    },
    darkModeFlag: function () {
      return applyUrlParam("flags", "themeoption=darkmode");
    },
    clearFlags: function () {
      var url = new URL(location.href);
      if (!url.searchParams.has("flags")) return { message: "No flags to clear.", level: "success" };
      url.searchParams.delete("flags");
      location.href = url.toString();
      return { message: "Flags cleared; reloading...", level: "success" };
    },

    // ---- merged from Levelup: navigation --------------------------------
    openEntityList: function (args) {
      var etn = ((args && args.entityname) || "").trim().toLowerCase();
      if (!etn) throw new Error("Entity name is required.");
      window.open(baseUrl() + "/main.aspx?pagetype=entitylist&etn=" + etn, "_blank");
      return { message: "Opened " + etn + " list.", level: "success" };
    },
    openSystemJobs: function () {
      window.open(baseUrl() + "/main.aspx?pagetype=entitylist&etn=asyncoperation", "_blank");
      return { message: "Opened System Jobs.", level: "success" };
    },
    openProcesses: function () {
      window.open(baseUrl() + "/main.aspx?pagetype=entitylist&etn=workflow", "_blank");
      return { message: "Opened Processes.", level: "success" };
    },
    openMailboxes: function () {
      window.open(baseUrl() + "/main.aspx?pagetype=entitylist&etn=mailbox", "_blank");
      return { message: "Opened Mailboxes.", level: "success" };
    },
    openHome: function () {
      window.open(baseUrl() + "/main.aspx", "_blank");
      return { message: "Opened Home.", level: "success" };
    },
    openAdvancedFind: function () {
      window.open(baseUrl() + "/main.aspx?pagetype=AdvancedFind", "_blank");
      return { message: "Opened Advanced Find.", level: "success" };
    },
    openSecurity: function () {
      try {
        var o = getXrm().Utility.getGlobalContext().organizationSettings;
        if (o && o.bapEnvironmentId) {
          window.open(
            "https://admin.powerplatform.microsoft.com/manage/environments/" + o.organizationId + "/" + o.bapEnvironmentId + "/users",
            "_blank"
          );
        } else {
          window.open("https://admin.powerplatform.microsoft.com", "_blank");
        }
      } catch (e) {
        window.open("https://admin.powerplatform.microsoft.com", "_blank");
      }
      return { message: "Opened security/admin.", level: "success" };
    },
    openSolutionsHistory: function () {
      try {
        var env = getXrm().Utility.getGlobalContext().organizationSettings.bapEnvironmentId;
        window.open("https://make.powerapps.com/environments/" + env + "/solutionsHistory", "_blank");
      } catch (e) {
        window.open("https://make.powerapps.com", "_blank");
      }
      return { message: "Opened solutions history.", level: "success" };
    },
    pinSidePanel: async function () {
      var X = requireForm();
      var input = X.Utility.getPageContext().input;
      var pane = await X.App.sidePanes.createPane({ canClose: true });
      if (input.pageType === "entityrecord") {
        pane.navigate({ pageType: input.pageType, entityName: input.entityName, entityId: input.entityId });
      } else {
        pane.navigate({ pageType: input.pageType, entityName: input.entityName });
      }
      return { message: "Pinned current page to side panel.", level: "success" };
    },

    // ---- merged from Levelup: environment info --------------------------
    environmentInfo: function () {
      var g = getXrm().Utility.getGlobalContext();
      var o = g.organizationSettings || {};
      return {
        output: {
          title: "Environment Info",
          items: [
            { label: "Unique Name", value: o.uniqueName || "" },
            { label: "Organization Id", value: o.organizationId || "" },
            { label: "Environment Id", value: o.bapEnvironmentId || "(n/a)" },
            { label: "Geo", value: o.organizationGeo || "" },
            { label: "Version", value: g.getVersion() },
            { label: "Language Id", value: String(o.languageId || "") },
            { label: "On Premise", value: String(!!g.isOnPremise) },
            { label: "Client URL", value: g.getClientUrl() }
          ]
        }
      };
    },
    orgSettings: function () {
      var o = getXrm().Utility.getGlobalContext().organizationSettings || {};
      return {
        output: {
          title: "Organization Settings",
          items: [
            { label: "Base Currency Id", value: o.baseCurrencyId || "" },
            { label: "Default Country Code", value: o.defaultCountryCode || "" },
            { label: "Auto Save Enabled", value: String(!!o.isAutoSaveEnabled) },
            { label: "Language Id", value: String(o.languageId || "") }
          ]
        }
      };
    },
    clientInfo: function () {
      var g = getXrm().Utility.getGlobalContext();
      return {
        output: {
          title: "Client Info",
          items: [
            { label: "Client", value: g.client ? g.client.getClient() : "" },
            { label: "Theme", value: g.getCurrentTheme ? g.getCurrentTheme() : "" },
            { label: "Version", value: g.getVersion() },
            { label: "Language", value: navigator.language },
            { label: "User Agent", value: navigator.userAgent }
          ]
        }
      };
    }
  };

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var msg = ev.data;
    if (!msg || msg.__pp !== "req") return;
    var handler = handlers[msg.command];
    Promise.resolve()
      .then(function () {
        if (!handler) throw new Error("Unknown command: " + msg.command);
        return handler(msg.args || {});
      })
      .then(function (result) {
        window.postMessage({ __pp: "res", id: msg.id, ok: true, result: result || null }, "*");
      })
      .catch(function (err) {
        window.postMessage(
          { __pp: "res", id: msg.id, ok: false, error: err && err.message ? err.message : String(err) },
          "*"
        );
      });
  });
})();
