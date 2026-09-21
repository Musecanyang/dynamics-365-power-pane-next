/**
 * Dynamics 365 Power Pane Next - MAIN-world bridge.
 *
 * Runs in the page's MAIN JavaScript world so it can reach the global `Xrm`
 * client API and the environment's Web API. The isolated content script sends
 * commands over window.postMessage (see PP.BRIDGE) and this file replies with
 * the result.
 *
 * The file has three parts:
 *   1. Helpers every handler relies on (Xrm access, Web API, URL flags).
 *   2. The command registry (`handlers`) - one handler per action command.
 *   3. The postMessage listener that validates and dispatches requests.
 *
 * Every command handler returns a plain serialisable object:
 *   { message, level }                  -> toast only
 *   { output: { title, items } }        -> key/value result dialog
 *   { table: { title, columns, rows } } -> sortable/exportable table dialog
 *   { users: [...] } / { items: [...] } -> data consumed by the UI directly
 *
 * Security note: this code runs with the page's own privileges (it is loaded in
 * the MAIN world). A script already running on the page can use `Xrm` and the
 * Web API directly, so the bridge adds no privilege beyond the page's own. The
 * isolated content script remains the privileged side and must validate every
 * response it receives (see content/content.js).
 */
(function (global) {
  "use strict";
  if (global.__ppNextBridgeLoaded) return;
  global.__ppNextBridgeLoaded = true;

  // Bridge markers. These MUST match PP.BRIDGE in src/constants.js.
  //
  // Why duplicated instead of read from src/constants.js: Chrome does not
  // reliably share a content-script file that is listed in BOTH a MAIN-world
  // and an ISOLATED-world content_scripts entry (crbug.com/324096753). When the
  // same file is in both entries, its globals go missing in one of the worlds,
  // so src/constants.js is loaded only in the isolated world. The CI workflow
  // verifies these three values stay in sync with src/constants.js.
  var BRIDGE_KEY = "__ppNext";
  var BRIDGE_REQUEST = "req";
  var BRIDGE_RESPONSE = "res";

  /* --- Tunables (named to avoid magic numbers) -------------------------- */
  /** Minimum characters before a user search fires. */
  var MIN_USER_SEARCH_LENGTH = 2;
  /** Cap on users returned by the batch "Role Check" report. */
  var ROLE_CHECK_USER_LIMIT = 25;
  /** Cap on entity search results shown in the entity picker. */
  var ENTITY_SEARCH_LIMIT = 50;

  /** Module-local cache of entity definitions used by the entity picker. */
  var entityCache = null;

  /* ------------------------------------------------------------------ *
   * Xrm / environment helpers
   * ------------------------------------------------------------------ */

  /** @returns {Object|undefined} the global Xrm client API, if present. */
  function getXrm() {
    return global.Xrm;
  }

  /**
   * Return the Xrm object, throwing a friendly error when no record form is
   * open (most handlers require a form).
   * @returns {Object}
   */
  function requireForm() {
    var xrm = getXrm();
    if (!xrm || !xrm.Page || !xrm.Page.context) {
      throw new Error("Open a record form to use this action.");
    }
    return xrm;
  }

  /** @returns {string} the environment client URL (requires a form). */
  function clientUrl() {
    return requireForm().Page.context.getClientUrl();
  }

  /**
   * Best-effort entity type code (ETC) for the current form entity.
   * @param {Object} xrm
   * @returns {string|null}
   */
  function objectTypeCode(xrm) {
    try {
      var entityName = xrm.Page.data.entity.getEntityName();
      var etc = xrm.Page.context.getQueryStringParameters().etc;
      if (etc) return etc;
      try {
        return xrm.Internal.getEntityCode(entityName);
      } catch (e) {
        return null;
      }
    } catch (e) {
      return null;
    }
  }

  /**
   * Build the direct URL for the current record, optionally for a specific app.
   * @param {Object} xrm
   * @param {string} [appId]
   * @returns {string}
   */
  function buildRecordUrl(xrm, appId) {
    var url = xrm.Page.context.getClientUrl() + "/main.aspx?";
    if (appId) url += "appid=" + appId + "&";
    url += "etn=" + xrm.Page.data.entity.getEntityName();
    url += "&id=" + xrm.Page.data.entity.getId();
    url += "&pagetype=entityrecord";
    return url;
  }

  /** @returns {string} the Dataverse Web API version (e.g. "9.2"). */
  function apiVersion() {
    try {
      var version = getXrm().Utility.getGlobalContext().getVersion();
      var match = /^(\d+\.\d+)/.exec(version);
      return match ? match[1] : "9.2";
    } catch (e) {
      return "9.2";
    }
  }

  /**
   * The environment base URL, falling back to location.origin when Xrm is
   * unavailable (e.g. on a non-form page).
   * @returns {string}
   */
  function baseUrl() {
    var xrm = getXrm();
    try {
      if (xrm && xrm.Utility && xrm.Utility.getGlobalContext) {
        return xrm.Utility.getGlobalContext().getClientUrl();
      }
    } catch (e) {
      /* ignore */
    }
    try {
      if (xrm && xrm.Page && xrm.Page.context) {
        return xrm.Page.context.getClientUrl();
      }
    } catch (e) {
      /* ignore */
    }
    return location.origin;
  }

  /* ------------------------------------------------------------------ *
   * Web API helpers
   * ------------------------------------------------------------------ */

  /**
   * GET a Dataverse Web API path and parse the JSON. Throws on non-2xx.
   * @param {string} path - path relative to /api/data/v<version>/
   * @returns {Promise<Object>}
   */
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
    }).then(function (response) {
      if (!response.ok) throw new Error("Web API " + response.status + " " + response.statusText);
      return response.json();
    });
  }

  /**
   * Follow `@odata.nextLink` to page through a collection, bounded to avoid an
   * unbounded loop on a misbehaving endpoint.
   * @param {string} path
   * @returns {Promise<Array>}
   */
  async function webApiGetAll(path) {
    var out = [];
    var guard = 0;
    var MAX_PAGES = 40;
    var data = await webApiGet(path);
    out = out.concat(data.value || []);
    var next = data["@odata.nextLink"];
    while (next && guard < MAX_PAGES) {
      guard++;
      try {
        var response = await fetch(next, {
          credentials: "include",
          headers: { Accept: "application/json", "OData-MaxVersion": "4.0", "OData-Version": "4.0" }
        });
        if (!response.ok) break;
        data = await response.json();
        out = out.concat(data.value || []);
        next = data["@odata.nextLink"];
      } catch (e) {
        break;
      }
    }
    return out;
  }

  /** @param {string} path @param {Object} body @returns {Promise<void>} */
  async function webPatch(path, body) {
    var url = baseUrl() + "/api/data/v" + apiVersion() + "/" + path;
    var response = await fetch(url, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json", "OData-MaxVersion": "4.0", "OData-Version": "4.0" },
      body: JSON.stringify(body)
    });
    if (!response.ok && response.status !== 204) {
      throw new Error("HTTP " + response.status + " " + response.statusText);
    }
  }

  /**
   * Associate a record via a navigation property (POST .../$ref).
   * @param {string} userId    target systemuser id
   * @param {string} nav       navigation property name (e.g. "systemuserroles_association")
   * @param {string} entitySet entity set name of the referenced record (e.g. "roles")
   * @param {string} refId     referenced record id
   * @returns {Promise<void>}
   */
  async function webAssoc(userId, nav, entitySet, refId) {
    var cleanId = String(userId).replace(/[{}]/g, "");
    var base = baseUrl() + "/api/data/v" + apiVersion();
    var url = base + "/systemusers(" + cleanId + ")/" + nav + "/$ref";
    var body = JSON.stringify({
      "@odata.id": base + "/" + entitySet + "(" + String(refId).replace(/[{}]/g, "") + ")"
    });
    var response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "OData-MaxVersion": "4.0", "OData-Version": "4.0" },
      body: body
    });
    if (!response.ok) throw new Error("HTTP " + response.status + " " + response.statusText);
  }

  /**
   * Disassociate a record via a navigation property (DELETE .../$ref).
   * Mirrors {@link webAssoc}.
   */
  async function webDisassoc(userId, nav, entitySet, refId) {
    var cleanId = String(userId).replace(/[{}]/g, "");
    var base = baseUrl() + "/api/data/v" + apiVersion();
    var url =
      base +
      "/systemusers(" +
      cleanId +
      ")/" +
      nav +
      "/$ref?$id=" +
      encodeURIComponent(base + "/" + entitySet + "(" + String(refId).replace(/[{}]/g, "") + ")");
    var response = await fetch(url, {
      method: "DELETE",
      credentials: "include",
      headers: { "OData-MaxVersion": "4.0", "OData-Version": "4.0" }
    });
    if (!response.ok && response.status !== 204) {
      throw new Error("HTTP " + response.status + " " + response.statusText);
    }
  }

  /* ------------------------------------------------------------------ *
   * Misc helpers
   * ------------------------------------------------------------------ */

  /** XML-encode a string for safe embedding in a SOAP envelope. */
  function xmlEncode(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  /** Pretty-print an XML string using XSLT; returns the input on failure. */
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
      var processor = new XSLTProcessor();
      processor.importStylesheet(xsltDoc);
      return new XMLSerializer().serializeToString(processor.transformToDocument(xmlDoc));
    } catch (e) {
      return source;
    }
  }

  /** Locate a form control's DOM container by its data-id or id attribute. */
  function findContainer(name) {
    return document.querySelector('[data-id="' + name + '"]') || document.getElementById(name);
  }

  /**
   * Add a URL parameter and reload the page. Used by the debug flag actions.
   * @param {string} name
   * @param {string} value
   * @returns {{message: string, level: string}}
   */
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

  /**
   * Resolve the solution id that owns an entity, defaulting to the classic
   * "Default Solution" when it cannot be determined.
   * @param {string} entityName
   * @returns {Promise<string>}
   */
  async function getEntitySolutionId(entityName) {
    try {
      var entityMetadata = await webApiGet("EntityDefinitions(LogicalName='" + entityName + "')?$select=MetadataId");
      var metadataId = entityMetadata.MetadataId;
      var components = await webApiGet(
        "solutioncomponents?$select=solutionid,componenttype,objectid&$filter=objectid eq " +
          metadataId +
          " and componenttype eq 1&$top=10&$expand=solutionid($select=solutionid,uniquename)"
      );
      var list = components.value || [];
      for (var i = 0; i < list.length; i++) {
        var solution = list[i].solutionid;
        if (solution && solution.solutionid) return solution.solutionid;
      }
    } catch (e) {
      /* fall through to the default solution */
    }
    return "fd140aaf-4df4-11dd-bd17-0019b9312238";
  }

  /**
   * Read the `@OData.Community.Display.V1.FormattedValue` annotation for a
   * property, returning "" when absent.
   * @param {Object} obj
   * @param {string} key
   * @returns {string}
   */
  function formattedValue(obj, key) {
    return obj[key + "@OData.Community.Display.V1.FormattedValue"] || "";
  }

  /* ------------------------------------------------------------------ *
   * Command registry
   * ------------------------------------------------------------------ */

  /** Command name -> handler function. */
  var handlers = {};

  /* ------------------------------------------------------------------ *
   * General / context
   * ------------------------------------------------------------------ */

  handlers.ping = function () {
    return { hasXrm: !!getXrm(), environment: getXrm() ? "dynamics" : "unknown" };
  };

  handlers.getContext = function () {
    var xrm = requireForm();
    var entity = xrm.Page.data && xrm.Page.data.entity;
    var formName = "";
    var formId = "";
    try {
      var item = xrm.Page.ui.formSelector.getCurrentItem();
      if (item) {
        formName = item.getLabel();
        formId = item.getId();
      }
    } catch (e) {
      /* form selector unavailable */
    }
    var formTypeCode = xrm.Page.ui ? xrm.Page.ui.getFormType() : "";
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
          { label: "Client URL", value: xrm.Page.context.getClientUrl() },
          { label: "Entity", value: entity ? entity.getEntityName() : "(not a form)" },
          { label: "Record Id", value: entity ? entity.getId() : "(not a form)" },
          { label: "Form Name", value: formName },
          { label: "Form Id", value: formId },
          { label: "Form Type", value: formTypeText }
        ]
      }
    };
  };

  handlers.userInfo = async function () {
    var xrm = requireForm();
    var context = xrm.Page.context;
    var userId = context.getUserId();
    var cleanId = userId.replace(/[{}]/g, "");
    var roles = [];
    var teams = [];
    try {
      var data = await webApiGet(
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
  };

  /* ------------------------------------------------------------------ *
   * Record
   * ------------------------------------------------------------------ */

  handlers.entityInfo = function () {
    var xrm = requireForm();
    var items = [{ label: "Entity Name", value: xrm.Page.data.entity.getEntityName() }];
    var typeCode = objectTypeCode(xrm);
    if (typeCode) items.push({ label: "Entity Type Code", value: String(typeCode) });
    return { output: { title: "Entity Info", items: items } };
  };

  handlers.recordId = function () {
    var xrm = requireForm();
    return {
      output: { title: "Record Id", items: [{ label: "Record Id", value: xrm.Page.data.entity.getId() }] }
    };
  };

  handlers.recordUrl = async function () {
    var xrm = requireForm();
    var items = [{ label: "Record Url", value: buildRecordUrl(xrm) }];
    try {
      var globalContext = xrm.Utility.getGlobalContext();
      if (globalContext.getCurrentAppProperties) {
        var app = await globalContext.getCurrentAppProperties();
        items.push({
          label: "Record Url (current app)",
          value: buildRecordUrl(xrm, app.appId)
        });
      }
    } catch (e) {
      /* app properties unavailable */
    }
    return { output: { title: "Record Url", items: items } };
  };

  handlers.cloneRecord = function () {
    var xrm = requireForm();
    var excluded = ["createdon", "createdby", "modifiedon", "modifiedby", "ownerid"];
    var fields = [];
    xrm.Page.data.entity.attributes.forEach(function (attribute) {
      var name = attribute.getName();
      var value = attribute.getValue();
      if (!value || excluded.indexOf(name) > -1) return;
      switch (attribute.getAttributeType()) {
        case "lookup":
          if (attribute.getLookupTypes() && value[0]) {
            fields.push(name + "=" + value[0].id);
            fields.push(name + "name=" + value[0].name);
            if (attribute.getLookupTypes().length > 1) fields.push(name + "type=" + value[0].entityType);
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
      xrm.Page.context.getClientUrl() +
      "/main.aspx?etn=" +
      xrm.Page.data.entity.getEntityName() +
      "&pagetype=entityrecord&extraqs=?" +
      encodeURIComponent(fields.join("&"));
    window.open(url, "_blank");
    return { message: "Clone form opened in a new tab.", level: "success" };
  };

  handlers.recordProperties = function () {
    var xrm = requireForm();
    var id = xrm.Page.data.entity.getId();
    var typeCode = objectTypeCode(xrm);
    if (window.Mscrm && Mscrm.RibbonActions && Mscrm.RibbonActions.openFormProperties) {
      Mscrm.RibbonActions.openFormProperties(id, typeCode);
      return { message: "Opened record properties.", level: "success" };
    }
    var url =
      xrm.Page.context.getClientUrl() +
      "/_forms/properties/properties.aspx?dType=1&id=" +
      id +
      "&objTypeCode=" +
      typeCode;
    window.open(url, "_blank", "width=420,height=505");
    return { message: "Opened record properties.", level: "success" };
  };

  handlers.fieldInspector = function () {
    var xrm = requireForm();
    var rows = [];
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        var name = control.getName && control.getName();
        if (!name) return;
        var attribute = control.getAttribute ? control.getAttribute() : null;
        var value = null;
        try {
          value = attribute ? attribute.getValue() : null;
        } catch (e) {
          /* attribute value unreadable */
        }
        if (value && typeof value === "object") {
          if (Array.isArray(value)) {
            value = value
              .map(function (item) {
                return item && (item.name || item.id) ? item.name || item.id : "";
              })
              .filter(Boolean)
              .join("; ");
          } else {
            value = JSON.stringify(value);
          }
        }
        rows.push({
          label: control.getLabel ? control.getLabel() : "",
          name: name,
          type: control.getControlType ? control.getControlType() : "",
          value: value == null ? "" : String(value),
          required: attribute && attribute.getRequiredLevel ? attribute.getRequiredLevel() : "",
          visible: control.getVisible ? String(control.getVisible()) : "",
          disabled: control.getDisabled ? String(control.getDisabled()) : ""
        });
      } catch (e) {
        /* skip controls that throw */
      }
    });
    return {
      table: {
        title: "Field Inspector",
        description: xrm.Page.data.entity.getEntityName(),
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
  };

  handlers.listLookups = function () {
    var xrm = requireForm();
    var rows = [];
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        if (!control.getControlType || control.getControlType() !== "lookup") return;
        var value = control.getAttribute().getValue();
        var first = value && value.length ? value[0] : null;
        rows.push({
          label: control.getLabel ? control.getLabel() : "",
          field: control.getName(),
          name: first ? first.name : "(empty)",
          entity: first ? first.entityType : "",
          id: first ? first.id : "",
          url: first
            ? xrm.Page.context.getClientUrl() +
              "/main.aspx?etn=" +
              first.entityType +
              "&id=" +
              first.id +
              "&pagetype=entityrecord"
            : ""
        });
      } catch (e) {
        /* skip lookups that throw */
      }
    });
    return {
      table: {
        title: "Lookups",
        description: xrm.Page.data.entity.getEntityName(),
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
  };

  handlers.executeFetchXml = async function (args) {
    var xrm = requireForm();
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
    var response = await fetch(xrm.Page.context.getClientUrl() + "/XRMServices/2011/Organization.svc/web", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "text/xml",
        Accept: "application/xml, text/xml, */*",
        SOAPAction: "http://schemas.microsoft.com/xrm/2011/Contracts/Services/IOrganizationService/Execute"
      },
      body: envelope
    });
    var text = await response.text();
    return {
      output: {
        title: "Fetch XML Result",
        description: response.status + " " + response.statusText,
        items: [{ label: "Response", value: prettyXml(text) }]
      }
    };
  };

  /* ------------------------------------------------------------------ *
   * Form
   * ------------------------------------------------------------------ */

  handlers.enableAllFields = function () {
    var xrm = requireForm();
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        control.setDisabled(false);
      } catch (e) {
        /* ignore controls that cannot be enabled */
      }
    });
    return { message: "All fields are enabled.", level: "success" };
  };

  handlers.showHiddenFields = function () {
    var xrm = requireForm();
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        control.setVisible(true);
      } catch (e) {
        /* ignore */
      }
    });
    xrm.Page.ui.tabs.forEach(function (tab) {
      try {
        if (tab.setVisible) tab.setVisible(true);
        if (tab.sections && tab.sections.getAll) {
          tab.sections.getAll().forEach(function (section) {
            try {
              if (section && section.setVisible) section.setVisible(true);
            } catch (e) {
              /* ignore */
            }
          });
        }
      } catch (e) {
        /* ignore */
      }
    });
    return { message: "All hidden fields, tabs and sections are now visible.", level: "success" };
  };

  handlers.disableRequired = function () {
    var xrm = requireForm();
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        if (control && control.getAttribute && control.getAttribute().setRequiredLevel) {
          control.getAttribute().setRequiredLevel("none");
        }
      } catch (e) {
        /* ignore */
      }
    });
    return { message: "Required level of all fields set to none.", level: "success" };
  };

  handlers.showFieldValue = function (args) {
    var xrm = requireForm();
    var name = (args && args.fieldname || "").trim();
    if (!name) throw new Error("Field schema name is required.");
    var control = xrm.Page.getControl(name);
    if (!control || !control.getControlType) throw new Error("Field not found on this form.");
    var type = control.getControlType();
    var items = [{ label: "Control Type", value: type }];
    if (type === "optionset") {
      items.push({ label: "Selected Text", value: control.getAttribute().getText() });
      items.push({ label: "Selected Value", value: control.getAttribute().getValue() });
    } else if (type === "lookup") {
      var value = control.getAttribute().getValue();
      var first = value && value.length ? value[0] : null;
      items.push({ label: "Name", value: first ? first.name : "" });
      items.push({ label: "Id", value: first ? first.id : "" });
      items.push({ label: "Entity Name", value: first ? first.entityType : "" });
      items.push({ label: "Entity Type Code", value: first ? first.type : "" });
    } else {
      items.push({ label: "Value", value: control.getAttribute().getValue() });
    }
    return { output: { title: "Field Value", description: name, items: items } };
  };

  handlers.findField = function (args) {
    var xrm = requireForm();
    var name = (args && args.fieldname || "").trim();
    if (!name) throw new Error("Field schema name is required.");
    var control = xrm.Page.getControl(name);
    if (!control) throw new Error("Field not found on this form.");
    control.setFocus();
    var hidden = "";
    if (control.getVisible && control.getVisible() === false) {
      control.setVisible(true);
      hidden = " It was hidden and is now visible.";
    }
    var element = findContainer(name);
    if (element) element.style.background = "#FFFF00";
    return { message: "Focused field " + name + "." + hidden, level: "success" };
  };

  handlers.highlightDirty = function () {
    var xrm = requireForm();
    xrm.Page.ui.controls.forEach(function (control) {
      var attribute = control && control.getAttribute ? control.getAttribute() : null;
      if (attribute && attribute.getIsDirty && attribute.getIsDirty()) {
        var element = findContainer(control.getName());
        if (element) element.style.background = "#FFFF00";
      }
    });
    return { message: "Dirty fields highlighted.", level: "success" };
  };

  handlers.clearNotifications = function () {
    var xrm = requireForm();
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        control.clearNotification();
      } catch (e) {
        /* ignore */
      }
    });
    return { message: "All field notifications cleared.", level: "success" };
  };

  handlers.refreshForm = function () {
    var xrm = requireForm();
    xrm.Page.data.refresh(false);
    return { message: "Form refreshed.", level: "success" };
  };

  handlers.refreshRibbon = function () {
    var xrm = requireForm();
    xrm.Page.ui.refreshRibbon();
    return { message: "Ribbon refreshed.", level: "success" };
  };

  handlers.toggleLookupLinks = function () {
    var xrm = requireForm();
    var existing = document.querySelectorAll(".pp-lookup-link");
    if (existing.length) {
      existing.forEach(function (node) {
        node.remove();
      });
      return { message: "Lookup links removed.", level: "success" };
    }
    var icon =
      '<svg viewBox="0 0 32 32" width="14" height="14" fill="none" stroke="currentcolor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M14 9 L3 9 3 29 23 29 23 18 M18 4 L28 4 28 14 M28 4 L14 18" /></svg>';
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        if (control.getControlType() !== "lookup") return;
        var holder = findContainer(control.getName());
        if (!holder) return;
        var link = document.createElement("a");
        link.className = "pp-lookup-link";
        link.title = "Open this record in a new window";
        link.style.cssText = "cursor:pointer;margin-left:5px;display:inline-block;vertical-align:middle";
        link.innerHTML = icon;
        link.addEventListener("click", function () {
          try {
            var record = control.getAttribute().getValue()[0];
            window.open(
              xrm.Page.context.getClientUrl() +
                "/main.aspx?etn=" +
                record.entityType +
                "&id=" +
                record.id +
                "&pagetype=entityrecord"
            );
          } catch (e) {
            /* ignore */
          }
        });
        holder.appendChild(link);
      } catch (e) {
        /* ignore */
      }
    });
    return { message: "Lookup links added.", level: "success" };
  };

  handlers.godMode = function () {
    var xrm = requireForm();
    var count = 0;
    xrm.Page.data.entity.attributes.forEach(function (attribute) {
      try {
        if (attribute.getRequiredLevel() === "required") {
          attribute.setRequiredLevel("none");
          count++;
        }
      } catch (e) {
        /* ignore */
      }
    });
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        if (control.setVisible) control.setVisible(true);
        if (control.setDisabled) control.setDisabled(false);
        count++;
      } catch (e) {
        /* ignore */
      }
    });
    xrm.Page.ui.tabs.forEach(function (tab) {
      try {
        if (tab.setVisible) tab.setVisible(true);
        if (tab.sections && tab.sections.forEach) {
          tab.sections.forEach(function (section) {
            try {
              if (section.setVisible) section.setVisible(true);
            } catch (e) {
              /* ignore */
            }
          });
        }
      } catch (e) {
        /* ignore */
      }
    });
    return { message: "God mode: " + count + " elements unlocked.", level: "success" };
  };

  handlers.changedFields = function () {
    var xrm = requireForm();
    var names = [];
    try {
      var xml = xrm.Page.data.entity.getDataXml();
      var doc = new DOMParser().parseFromString(xml, "text/xml");
      var root = doc.documentElement;
      for (var i = 0; i < root.children.length; i++) names.push(root.children[i].tagName);
    } catch (e) {
      xrm.Page.data.entity.attributes.forEach(function (attribute) {
        if (attribute.getIsDirty && attribute.getIsDirty()) names.push(attribute.getName());
      });
    }
    var marked = 0;
    names.forEach(function (name) {
      var element = findContainer(name);
      if (element) {
        element.style.boxShadow = "inset 4px 0 0 #742774";
        marked++;
      }
    });
    return { message: names.length + " changed field(s), " + marked + " highlighted.", level: "success" };
  };

  handlers.clearLogicalNames = function () {
    var elements = document.querySelectorAll(".pp-logical-name");
    for (var i = 0; i < elements.length; i++) {
      elements[i].classList.remove("pp-logical-name");
      elements[i].removeAttribute("title");
      elements[i].__ppBound = false;
    }
    return { message: "Logical name mode cleared.", level: "success" };
  };

  handlers.refreshSubgrids = function () {
    var xrm = requireForm();
    var count = 0;
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        if (control.getControlType && control.getControlType() === "subgrid" && control.refresh) {
          control.refresh();
          count++;
        }
      } catch (e) {
        /* ignore */
      }
    });
    return { message: count + " subgrid(s) refreshed.", level: "success" };
  };

  handlers.refreshWithoutSave = async function () {
    var xrm = requireForm();
    await xrm.Page.data.refresh(false);
    try {
      xrm.Page.data.entity.addOnSave(function (ctx) {
        var args = ctx.getEventArgs();
        if (args.getSaveMode() === 70 || args.getSaveMode() === 2) args.preventDefault();
      });
    } catch (e) {
      /* ignore */
    }
    return { message: "Form refreshed; auto-save disabled for this session.", level: "success" };
  };

  handlers.logicalNamesInline = function () {
    var xrm = requireForm();
    var action = null;
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        if (!control.getName || !control.setLabel || !control.getLabel) return;
        var name = control.getName();
        if (!control.__ppOrigLabel) {
          control.__ppOrigLabel = control.getLabel();
          control.setLabel(control.__ppOrigLabel + " [" + name + "]");
          action = "update";
        } else {
          control.setLabel(control.__ppOrigLabel);
          control.__ppOrigLabel = null;
          action = "rollback";
        }
        var element = findContainer(name) || document.getElementById(name + "_c");
        var label =
          element && element.tagName === "LABEL"
            ? element
            : element && element.querySelector
            ? element.querySelector("label")
            : element;
        if (label) {
          if (action === "update") {
            label.style.cursor = "pointer";
            label.title = 'Click to copy "' + name + '"';
            if (!label.__ppBound) {
              label.__ppBound = true;
              label.addEventListener(
                "click",
                function (event) {
                  event.preventDefault();
                  event.stopPropagation();
                  try {
                    navigator.clipboard.writeText(name);
                  } catch (e) {
                    /* clipboard unavailable */
                  }
                },
                true
              );
            }
          } else {
            label.style.cursor = "";
            label.removeAttribute("title");
            label.__ppBound = false;
          }
        }
      } catch (e) {
        /* ignore */
      }
    });
    return {
      message: action === "rollback" ? "Logical name labels removed." : "Logical names appended; click a label to copy.",
      level: "success"
    };
  };

  handlers.allFields = async function () {
    var xrm = requireForm();
    var entityName = xrm.Page.data.entity.getEntityName();
    var id = xrm.Page.data.entity.getId().replace(/[{}]/g, "");
    var meta = await xrm.Utility.getEntityMetadata(entityName, "");

    // The three reads below only depend on the entity name / entity set name, so
    // they are issued together instead of one after the other.
    var attributesPath =
      "EntityDefinitions(LogicalName='" + entityName + "')/Attributes?$select=LogicalName,AttributeType,DisplayName";
    var recordPath = meta.EntitySetName + "(" + id + ")";
    // Targets of every lookup of the entity, resolved with a single metadata
    // request (never one request per field). This is kept in addition to the
    // `lookuplogicalname` value annotation because the Web API only returns that
    // annotation for lookups that actually point at a record - empty lookups
    // would otherwise leave the "Entity" column blank.
    var lookupTargetsPath =
      "EntityDefinitions(LogicalName='" + entityName + "')/Attributes/Microsoft.Dynamics.CRM.LookupAttributeMetadata?$select=LogicalName,Targets";
    var responses = await Promise.all([
      webApiGet(attributesPath),
      webApiGet(recordPath),
      webApiGet(lookupTargetsPath).catch(function () {
        return null; // targets unavailable; the Entity column falls back to the value annotation
      })
    ]);
    var attrData = responses[0];
    var record = responses[1];
    var lookupMeta = responses[2];

    // Dataverse exposes platform "companion" attributes for lookups and option
    // sets (e.g. accountidname, accountidyominame, activitiescompletename).
    // They only repeat the formatted name already shown in the "Value Name"
    // column, so hide them and keep one row per real field.
    var attributes = attrData.value || [];
    var typeByLogicalName = {};
    attributes.forEach(function (attribute) {
      typeByLogicalName[String(attribute.LogicalName).toLowerCase()] = attribute.AttributeType || "";
    });
    var COMPANION_PARENT_TYPES = {
      Lookup: true,
      Owner: true,
      Customer: true,
      Boolean: true,
      Picklist: true,
      State: true,
      Status: true,
      MultiSelectPicklist: true
    };
    function isCompanionNameAttribute(logicalName) {
      var lower = String(logicalName).toLowerCase();
      var baseName = "";
      if (lower.length > 8 && lower.slice(-8) === "yominame") baseName = lower.slice(0, -8);
      else if (lower.length > 4 && lower.slice(-4) === "name") baseName = lower.slice(0, -4);
      return !!baseName && !!COMPANION_PARENT_TYPES[typeByLogicalName[baseName]];
    }

    // Resolve the target entity (or entities) for each lookup attribute so the
    // "Entity" column can show what a lookup points to.
    var lookupTargets = {};
    ((lookupMeta && lookupMeta.value) || []).forEach(function (attribute) {
      lookupTargets[String(attribute.LogicalName).toLowerCase()] = (attribute.Targets || []).join(", ");
    });

    var rows = [];
    var seenLogicalNames = {}; // guard against duplicate metadata rows for one field
    attributes.forEach(function (attribute) {
      var logicalName = attribute.LogicalName;
      var dedupeKey = String(logicalName).toLowerCase();
      if (seenLogicalNames[dedupeKey]) return;
      seenLogicalNames[dedupeKey] = true;
      if (isCompanionNameAttribute(logicalName)) return;
      var display =
        (attribute.DisplayName && attribute.DisplayName.UserLocalizedLabel && attribute.DisplayName.UserLocalizedLabel.Label) ||
        "";
      var type = attribute.AttributeType || "";
      var raw = record[logicalName];
      var isLookup = type === "Lookup" || type === "Owner" || type === "Customer";
      // Formatted-value annotations live on the lookup property `_<name>_value`
      // for lookups, and on `<name>` for simple/option-set attributes.
      var value = "";
      var valueName = "";
      var entity = "";
      if (isLookup) {
        value = record["_" + logicalName + "_value"] || "";
        valueName =
          record["_" + logicalName + "_value@OData.Community.Display.V1.FormattedValue"] ||
          record[logicalName + "@OData.Community.Display.V1.FormattedValue"] ||
          "";
        entity =
          lookupTargets[String(logicalName).toLowerCase()] ||
          record["_" + logicalName + "_value@Microsoft.Dynamics.CRM.lookuplogicalname"] ||
          "";
      } else {
        valueName = record[logicalName + "@OData.Community.Display.V1.FormattedValue"] || "";
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
        logical: logicalName,
        type: type,
        value: value,
        name: valueName == null ? "" : String(valueName),
        entity: entity
      });
    });
    rows.sort(function (a, b) {
      return a.logical.localeCompare(b.logical);
    });
    return {
      table: {
        title: "All Fields",
        description: entityName + " - " + rows.length + " attributes",
        searchable: true,
        copyKey: "logical",
        // Raw Web API response for this record, exposed for one-click copying.
        rawJson: JSON.stringify(record, null, 2),
        columns: [
          { key: "display", label: "Display Name" },
          // Long logical names, target-entity lists and raw values are capped
          // so a single field cannot stretch the dialog; hovering a truncated
          // cell reveals the full text.
          { key: "logical", label: "Logical Name", maxWidthPx: 190 },
          { key: "type", label: "Type" },
          { key: "entity", label: "Entity", maxWidthPx: 200 },
          { key: "value", label: "Value", maxWidthPx: 240 },
          { key: "name", label: "Value Name" }
        ],
        rows: rows
      }
    };
  };

  handlers.optionSetValues = async function () {
    var xrm = requireForm();
    var entityName = xrm.Page.data.entity.getEntityName();
    var rows = [];
    var seen = {}; // "logical|value" -> true, avoids duplicates
    function push(group, logical, optionSet) {
      var options = (optionSet && optionSet.Options) || [];
      options.forEach(function (option) {
        var value = String(option.Value);
        var key = logical + "|" + value;
        if (seen[key]) return;
        seen[key] = true;
        var label =
          (option.Label && option.Label.UserLocalizedLabel && option.Label.UserLocalizedLabel.Label) || "";
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
        (data.value || []).forEach(function (attribute) {
          var display =
            (attribute.DisplayName && attribute.DisplayName.UserLocalizedLabel && attribute.DisplayName.UserLocalizedLabel.Label) ||
            "";
          var group = display ? display + " (" + attribute.LogicalName + ")" : attribute.LogicalName;
          // A global option set exposes its options through GlobalOptionSet;
          // use the first non-empty source so values are not listed twice.
          var source =
            (attribute.GlobalOptionSet &&
            attribute.GlobalOptionSet.Options &&
            attribute.GlobalOptionSet.Options.length
              ? attribute.GlobalOptionSet
              : null) ||
            (attribute.OptionSet && attribute.OptionSet.Options && attribute.OptionSet.Options.length
              ? attribute.OptionSet
              : null);
          push(group, attribute.LogicalName, source);
        });
      } catch (e) {
        /* skip cast types that throw */
      }
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
  };

  handlers.tableProcesses = async function () {
    var xrm = requireForm();
    var entityName = xrm.Page.data.entity.getEntityName();
    var rows = [];
    try {
      var workflows = await webApiGet(
        "workflows?$select=name,category,mode,type,statecode,statuscode,primaryentity,scope,createdon,modifiedon,workflowid,description" +
          "&$filter=primaryentity eq '" +
          entityName +
          "'&$top=200"
      );
      (workflows.value || []).forEach(function (workflow) {
        var type = formattedValue(workflow, "category") + (workflow.mode != null ? " / " + formattedValue(workflow, "mode") : "");
        rows.push({
          name: workflow.name || "(unnamed)",
          type: type || String(workflow.category),
          state: formattedValue(workflow, "statecode") || String(workflow.statecode),
          url: workflow.workflowid
            ? baseUrl() + "/main.aspx?etn=workflow&id=" + workflow.workflowid + "&pagetype=entityrecord"
            : "",
          _detail: [
            { label: "Name", value: workflow.name || "" },
            { label: "Type", value: formattedValue(workflow, "category") + " (" + workflow.category + ")" },
            { label: "Mode", value: formattedValue(workflow, "mode") + " (" + workflow.mode + ")" },
            { label: "State", value: formattedValue(workflow, "statecode") + " (" + workflow.statecode + ")" },
            { label: "Status", value: formattedValue(workflow, "statuscode") + " (" + workflow.statuscode + ")" },
            { label: "Scope", value: formattedValue(workflow, "scope") + " (" + workflow.scope + ")" },
            { label: "Primary Entity", value: workflow.primaryentity || "" },
            { label: "Workflow Id", value: workflow.workflowid || "" },
            { label: "Created On", value: workflow.createdon || "" },
            { label: "Modified On", value: workflow.modifiedon || "" },
            { label: "Description", value: workflow.description || "" }
          ]
        });
      });
    } catch (e) {
      /* workflows may not be queryable in every environment */
    }
    try {
      var customApis = await webApiGet(
        "customapis?$select=uniquename,displayname,bindingtype,boundentitylogicalname,customapiid,createdon,modifiedon" +
          "&$filter=boundentitylogicalname eq '" +
          entityName +
          "'&$top=200"
      );
      (customApis.value || []).forEach(function (api) {
        rows.push({
          name: api.displayname || api.uniquename,
          type: "Custom API / " + (api.bindingtype === 1 ? "Entity" : "Global"),
          state: api.bindingtype === 1 ? "Bound" : "Global",
          url: api.customapiid
            ? baseUrl() + "/main.aspx?etn=customapi&id=" + api.customapiid + "&pagetype=entityrecord"
            : "",
          _detail: [
            { label: "Display Name", value: api.displayname || "" },
            { label: "Unique Name", value: api.uniquename || "" },
            { label: "Binding", value: api.bindingtype === 1 ? "Entity (1)" : "Global (0)" },
            { label: "Bound Entity", value: api.boundentitylogicalname || "" },
            { label: "Custom API Id", value: api.customapiid || "" },
            { label: "Created On", value: api.createdon || "" },
            { label: "Modified On", value: api.modifiedon || "" }
          ]
        });
      });
    } catch (e) {
      /* custom APIs may not be queryable in every environment */
    }
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
  };

  /* ------------------------------------------------------------------ *
   * Navigation
   * ------------------------------------------------------------------ */

  handlers.goToRecord = function (args) {
    var xrm = requireForm();
    var entityName = (args && args.entityname || "").trim().toLowerCase();
    var id = (args && args.recordid || "").trim();
    if (!entityName || !id) throw new Error("Entity name and record id are both required.");
    window.open(
      xrm.Page.context.getClientUrl() + "/main.aspx?etn=" + entityName + "&id=" + id + "&pagetype=entityrecord",
      "_blank"
    );
    return { message: "Opened record.", level: "success" };
  };

  handlers.goToCreateForm = function (args) {
    var xrm = requireForm();
    var entityName = (args && args.entityname || "").trim().toLowerCase();
    if (!entityName) throw new Error("Entity name is required.");
    window.open(
      xrm.Page.context.getClientUrl() + "/main.aspx?etn=" + entityName + "&newWindow=true&pagetype=entityrecord",
      "_blank"
    );
    return { message: "Opened create form.", level: "success" };
  };

  handlers.openFormEditor = function () {
    var xrm = requireForm();
    var url =
      xrm.Page.context.getClientUrl() +
      "/main.aspx?pagetype=formeditor&appSolutionId={FD140AAF-4DF4-11DD-BD17-0019B9312238}&etn=" +
      xrm.Page.data.entity.getEntityName().toLowerCase() +
      "&extraqs=formtype=main&formId=" +
      xrm.Page.ui.formSelector.getCurrentItem().getId();
    window.open(url, "_blank");
    return { message: "Opened classic form editor.", level: "success" };
  };

  handlers.openFormEditorNew = async function () {
    var xrm = requireForm();
    var entityName = xrm.Page.data.entity.getEntityName();
    var environmentId = "";
    try {
      environmentId = xrm.Utility.getGlobalContext().organizationSettings.bapEnvironmentId;
    } catch (e) {
      /* environment id unavailable */
    }
    var formId = "";
    try {
      formId = xrm.Page.ui.formSelector.getCurrentItem().getId();
    } catch (e) {
      /* form id unavailable */
    }
    var solutionId = await getEntitySolutionId(entityName);
    var url =
      environmentId && formId
        ? "https://make.powerapps.com/e/" + environmentId + "/s/" + solutionId + "/entity/" + entityName + "/form/edit/" + formId
        : "https://make.powerapps.com/";
    window.open(url, "_blank");
    return { message: "Opened new form designer (Power Apps).", level: "success" };
  };

  handlers.openEntityEditor = function (args) {
    var xrm = requireForm();
    var entityName = ((args && args.entityname) || "").trim() || xrm.Page.data.entity.getEntityName();
    var detail = "";
    try {
      var typeCode = xrm.Internal.getEntityCode(entityName);
      detail = "&def_category=9801&def_type=" + typeCode;
    } catch (e) {
      /* type code unavailable */
    }
    var defaultSolutionId = "{FD140AAF-4DF4-11DD-BD17-0019B9312238}";
    window.open(
      xrm.Page.context.getClientUrl() + "/tools/solution/edit.aspx?id=" + defaultSolutionId + detail,
      "_blank"
    );
    return { message: "Opened entity editor for " + entityName + ".", level: "success" };
  };

  handlers.solutions = function () {
    window.open(clientUrl() + "/tools/Solution/home_solution.aspx?etc=7100", "_blank");
    return { message: "Opened solutions.", level: "success" };
  };

  handlers.crmDiagnostics = function () {
    window.open(clientUrl() + "/tools/diagnostics/diag.aspx", "_blank");
    return { message: "Opened diagnostics.", level: "success" };
  };

  handlers.performanceCenter = function () {
    if (window.Mscrm && Mscrm.Performance && Mscrm.Performance.PerformanceCenter) {
      Mscrm.Performance.PerformanceCenter.get_instance().TogglePerformanceResultsVisibility();
      return { message: "Toggled performance results.", level: "success" };
    }
    throw new Error("Performance Center is not available on this page.");
  };

  handlers.mobileClient = function () {
    var xrm = requireForm();
    var url = xrm.Page.context.getClientUrl();
    window.open(url + "/nga/main.htm?org=" + xrm.Page.context.getOrgUniqueName() + "&server=" + url, "_blank");
    return { message: "Opened mobile client.", level: "success" };
  };

  handlers.openWebApi = async function () {
    var xrm = requireForm();
    var meta = await xrm.Utility.getEntityMetadata(xrm.Page.data.entity.getEntityName(), "");
    var url =
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
  };

  handlers.entityMetadata = async function (args) {
    var xrm = requireForm();
    var name = (args && args.entityname || "").trim() || xrm.Page.data.entity.getEntityName();
    var data = await webApiGet(
      "EntityDefinitions(LogicalName='" +
        name +
        "')?$select=LogicalName,PrimaryIdAttribute&$expand=Attributes($select=LogicalName,AttributeType,IsCustomAttribute,RequiredLevel)"
    );
    var attributes = data.Attributes || [];
    var rows = attributes.map(function (attribute) {
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
  };

  handlers.openUrl = function (args) {
    var url = args && args.url;
    if (!url) throw new Error("No URL to open.");
    window.open(url, "_blank");
    return { message: "Opened in a new tab.", level: "success" };
  };

  handlers.roleCheck = async function (args) {
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
    var usersByKey = {};
    for (var t = 0; t < terms.length; t++) {
      try {
        var found = await handlers.searchUsers({ query: terms[t] });
        (found && found.users ? found.users : []).forEach(function (user) {
          if (!usersByKey[user.systemuserid]) usersByKey[user.systemuserid] = user;
        });
      } catch (e) {
        /* ignore per-term failures */
      }
    }
    var users = Object.keys(usersByKey)
      .map(function (key) {
        return usersByKey[key];
      })
      .slice(0, ROLE_CHECK_USER_LIMIT);
    if (!users.length) throw new Error("No users found for: " + terms.join(", "));
    var rows = [];
    for (var i = 0; i < users.length; i++) {
      var user = users[i];
      var row = { name: user.fullname || "", email: user.internalemailaddress || "", bu: "", roles: "", teams: "" };
      try {
        var data = await webApiGet(
          "systemusers(" +
            user.systemuserid +
            ")?$select=fullname,internalemailaddress,domainname" +
            "&$expand=businessunitid($select=name),systemuserroles_association($select=name),teammembership_association($select=name)"
        );
        row.name = data.fullname || row.name;
        row.email = data.internalemailaddress || row.email;
        row.bu = (data.businessunitid && data.businessunitid.name) || "";
        row.roles = (data.systemuserroles_association || [])
          .map(function (role) {
            return role.name;
          })
          .join(", ");
        row.teams = (data.teammembership_association || [])
          .map(function (team) {
            return team.name;
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
  };

  handlers.searchEntities = async function (args) {
    var query = ((args && args.query) || "").trim().toLowerCase();
    if (!query) return { entities: [] };
    if (!entityCache) {
      var data = await webApiGet("EntityDefinitions?$select=LogicalName,DisplayName");
      entityCache = (data.value || []).map(function (entity) {
        return {
          logical: entity.LogicalName,
          display:
            (entity.DisplayName && entity.DisplayName.UserLocalizedLabel && entity.DisplayName.UserLocalizedLabel.Label) ||
            entity.LogicalName
        };
      });
    }
    var matches = entityCache
      .filter(function (entity) {
        return entity.logical.toLowerCase().indexOf(query) > -1 || entity.display.toLowerCase().indexOf(query) > -1;
      })
      .slice(0, ENTITY_SEARCH_LIMIT);
    return { entities: matches };
  };

  handlers.currentContext = function () {
    var xrm = getXrm();
    var context = { entityName: "", formName: "" };
    try {
      context.entityName = xrm.Page.data.entity.getEntityName();
    } catch (e) {
      /* not a form */
    }
    try {
      var item = xrm.Page.ui.formSelector.getCurrentItem();
      if (item) context.formName = item.getLabel();
    } catch (e) {
      /* form selector unavailable */
    }
    return context;
  };

  /* ------------------------------------------------------------------ *
   * Debug (Microsoft's documented troubleshooting URL flags)
   * ------------------------------------------------------------------ */

  handlers.formsMonitor = function () {
    return applyUrlParam("monitor", "true");
  };
  handlers.commandChecker = function () {
    return applyUrlParam("ribbondebug", "true");
  };
  handlers.perfCenterFlag = function () {
    return applyUrlParam("perf", "true");
  };
  handlers.disableFormHandlers = function () {
    return applyUrlParam("flags", "DisableFormHandlers=true");
  };
  handlers.disableBusinessRules = function () {
    return applyUrlParam("flags", "DisableFormHandlers=businessrule");
  };
  handlers.disableFormLibraries = function () {
    return applyUrlParam("flags", "DisableFormLibraries=true");
  };
  handlers.disableFormCommandbar = function () {
    return applyUrlParam("flags", "DisableFormCommandbar=true");
  };
  handlers.disableWebResourceControls = function () {
    return applyUrlParam("flags", "DisableWebResourceControls=true");
  };
  handlers.disableBusinessProcessFlow = function () {
    return applyUrlParam("flags", "DisableBusinessProcessFlow=true");
  };
  handlers.disableFormControl = function (args) {
    var name = ((args && args.control) || "").trim();
    if (!name) throw new Error("Control name is required.");
    return applyUrlParam("flags", "DisableFormControl=" + name);
  };
  handlers.navbarOff = function () {
    return applyUrlParam("navbar", "off");
  };
  handlers.disableAllComponents = function () {
    var value =
      "DisableFormHandlers=true,DisableWebResourceControls=true,DisableFormCommandbar=true,DisableBusinessProcessFlow=true";
    var url = new URL(location.href);
    url.searchParams.set("flags", value);
    location.href = url.toString();
    return { message: "Disabled handlers, web resource controls, command bar and BPF; reloading...", level: "success" };
  };
  handlers.darkModeFlag = function () {
    return applyUrlParam("flags", "themeoption=darkmode");
  };
  handlers.clearFlags = function () {
    var url = new URL(location.href);
    if (!url.searchParams.has("flags")) return { message: "No flags to clear.", level: "success" };
    url.searchParams.delete("flags");
    location.href = url.toString();
    return { message: "Flags cleared; reloading...", level: "success" };
  };

  /* ------------------------------------------------------------------ *
   * Navigation (from Levelup)
   * ------------------------------------------------------------------ */

  handlers.openEntityList = function (args) {
    var entityName = ((args && args.entityname) || "").trim().toLowerCase();
    if (!entityName) throw new Error("Entity name is required.");
    window.open(baseUrl() + "/main.aspx?pagetype=entitylist&etn=" + entityName, "_blank");
    return { message: "Opened " + entityName + " list.", level: "success" };
  };
  handlers.openSystemJobs = function () {
    window.open(baseUrl() + "/main.aspx?pagetype=entitylist&etn=asyncoperation", "_blank");
    return { message: "Opened System Jobs.", level: "success" };
  };
  handlers.openProcesses = function () {
    window.open(baseUrl() + "/main.aspx?pagetype=entitylist&etn=workflow", "_blank");
    return { message: "Opened Processes.", level: "success" };
  };
  handlers.openMailboxes = function () {
    window.open(baseUrl() + "/main.aspx?pagetype=entitylist&etn=mailbox", "_blank");
    return { message: "Opened Mailboxes.", level: "success" };
  };
  handlers.openHome = function () {
    window.open(baseUrl() + "/main.aspx", "_blank");
    return { message: "Opened Home.", level: "success" };
  };
  handlers.openAdvancedFind = function () {
    window.open(baseUrl() + "/main.aspx?pagetype=AdvancedFind", "_blank");
    return { message: "Opened Advanced Find.", level: "success" };
  };
  handlers.openSecurity = function () {
    try {
      var settings = getXrm().Utility.getGlobalContext().organizationSettings;
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
  };
  handlers.openSolutionsHistory = function () {
    try {
      var environmentId = getXrm().Utility.getGlobalContext().organizationSettings.bapEnvironmentId;
      window.open("https://make.powerapps.com/environments/" + environmentId + "/solutionsHistory", "_blank");
    } catch (e) {
      window.open("https://make.powerapps.com", "_blank");
    }
    return { message: "Opened solutions history.", level: "success" };
  };
  handlers.pinSidePanel = async function () {
    var xrm = requireForm();
    var input = xrm.Utility.getPageContext().input;
    var pane = await xrm.App.sidePanes.createPane({ canClose: true });
    if (input.pageType === "entityrecord") {
      pane.navigate({ pageType: input.pageType, entityName: input.entityName, entityId: input.entityId });
    } else {
      pane.navigate({ pageType: input.pageType, entityName: input.entityName });
    }
    return { message: "Pinned current page to side panel.", level: "success" };
  };

  /* ------------------------------------------------------------------ *
   * Admin / environment info
   * ------------------------------------------------------------------ */

  handlers.environmentInfo = function () {
    var globalContext = getXrm().Utility.getGlobalContext();
    var settings = globalContext.organizationSettings || {};
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
  };

  handlers.orgSettings = function () {
    var settings = getXrm().Utility.getGlobalContext().organizationSettings || {};
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
  };

  handlers.clientInfo = function () {
    var globalContext = getXrm().Utility.getGlobalContext();
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
  };

  /* ------------------------------------------------------------------ *
   * Impersonation & user-access data
   * ------------------------------------------------------------------ */

  /**
   * Search system users by name / email / domain.
   * @param {{query: string}} args
   * @returns {Promise<{users: Array}>}
   */
  handlers.searchUsers = async function (args) {
    var query = ((args && args.query) || "").trim();
    if (query.length < MIN_USER_SEARCH_LENGTH) return { users: [] };
    var safe = query.replace(/'/g, "''");
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
  };

  /** Return the current user's and organization ids (diagnostics helper). */
  handlers.whoAmI = async function () {
    var data = await webApiGet("WhoAmI");
    return { userId: data.UserId, organizationId: data.OrganizationId };
  };

  /**
   * Fetch a single user's access profile (roles, teams, business unit).
   * @param {{userid: string}} args
   * @returns {Promise<{user: Object, businessUnit: Object|null, roles: Array, teams: Array}>}
   */
  handlers.getUserAccess = async function (args) {
    var id = String((args && args.userid) || "").replace(/[{}]/g, "");
    if (!id) throw new Error("Missing user id.");
    var data = await webApiGet(
      "systemusers(" +
        id +
        ")?$select=fullname,internalemailaddress,domainname,isdisabled" +
        "&$expand=businessunitid($select=businessunitid,name),systemuserroles_association($select=roleid,name),teammembership_association($select=teamid,name)"
    );
    return {
      user: { id: id, name: data.fullname, email: data.internalemailaddress, domain: data.domainname, disabled: data.isdisabled },
      businessUnit: data.businessunitid
        ? { id: data.businessunitid.businessunitid, name: data.businessunitid.name }
        : null,
      roles: (data.systemuserroles_association || []).map(function (role) {
        return { id: role.roleid, name: role.name };
      }),
      teams: (data.teammembership_association || []).map(function (team) {
        return { id: team.teamid, name: team.name };
      })
    };
  };

  /** List all security roles with their business unit id. */
  handlers.getAllRoles = async function () {
    var items = await webApiGetAll("roles?$select=roleid,name,_businessunitid_value&$orderby=name");
    return {
      items: items.map(function (role) {
        return { id: role.roleid, name: role.name, buId: role._businessunitid_value || "" };
      })
    };
  };

  /** List all owner teams (teamtype eq 0). */
  handlers.getAllTeams = async function () {
    var items = await webApiGetAll("teams?$select=teamid,name,teamtype&$filter=teamtype eq 0&$orderby=name");
    return {
      items: items.map(function (team) {
        return { id: team.teamid, name: team.name };
      })
    };
  };

  /** List all business units. */
  handlers.getBusinessUnits = async function () {
    var items = await webApiGetAll("businessunits?$select=businessunitid,name&$orderby=name");
    return {
      items: items.map(function (businessUnit) {
        return { id: businessUnit.businessunitid, name: businessUnit.name };
      })
    };
  };

  /** Change a user's business unit. */
  handlers.setBusinessUnit = async function (args) {
    var userId = String(args.userid).replace(/[{}]/g, "");
    var buId = String(args.buid).replace(/[{}]/g, "");
    await webPatch("systemusers(" + userId + ")", { "businessunitid@odata.bind": "/businessunits(" + buId + ")" });
    return { message: "Business unit updated.", level: "success" };
  };

  /** Assign a security role to a user. */
  handlers.assignRole = async function (args) {
    await webAssoc(args.userid, "systemuserroles_association", "roles", args.roleid);
    return { message: "Role assigned.", level: "success" };
  };

  /** Remove a security role from a user. */
  handlers.removeRole = async function (args) {
    await webDisassoc(args.userid, "systemuserroles_association", "roles", args.roleid);
    return { message: "Role removed.", level: "success" };
  };

  /** Add a user to a team. */
  handlers.addTeam = async function (args) {
    await webAssoc(args.userid, "teammembership_association", "teams", args.teamid);
    return { message: "Added to team.", level: "success" };
  };

  /** Remove a user from a team. */
  handlers.removeTeam = async function (args) {
    await webDisassoc(args.userid, "teammembership_association", "teams", args.teamid);
    return { message: "Removed from team.", level: "success" };
  };

  /* ------------------------------------------------------------------ *
   * Bridge listener
   * ------------------------------------------------------------------ */

  global.addEventListener("message", function (event) {
    // Only accept messages from this same window (and, when available, the same
    // origin) carrying our bridge marker. This is a hygiene check, not a trust
    // boundary — the page can always call Xrm/Web API directly.
    if (event.source !== global) return;
    if (event.origin && event.origin !== location.origin) return;
    var message = event.data;
    if (!message || message[BRIDGE_KEY] !== BRIDGE_REQUEST) return;
    if (typeof message.id !== "string" || typeof message.command !== "string") return;

    var handler = handlers[message.command];

    Promise.resolve()
      .then(function () {
        if (!handler) throw new Error("Unknown command: " + message.command);
        return handler(message.args || {});
      })
      .then(function (result) {
        global.postMessage(
          { [BRIDGE_KEY]: BRIDGE_RESPONSE, id: message.id, ok: true, result: result || null },
          "*"
        );
      })
      .catch(function (err) {
        global.postMessage(
          {
            [BRIDGE_KEY]: BRIDGE_RESPONSE,
            id: message.id,
            ok: false,
            error: err && err.message ? err.message : String(err)
          },
          "*"
        );
      });
  });
})(window);
