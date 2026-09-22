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
  // verifies these three values (and PP.DEBUG) stay in sync with
  // src/constants.js.
  const BRIDGE_KEY = "__ppNext";
  const BRIDGE_REQUEST = "req";
  const BRIDGE_RESPONSE = "res";
  const DEBUG_KEY = "__ppNextDebug";

  /* --- Tunables (named to avoid magic numbers) -------------------------- */
  /** Minimum characters before a user search fires. */
  const MIN_USER_SEARCH_LENGTH = 2;
  /** Cap on users returned by the batch "Role Check" report. */
  const ROLE_CHECK_USER_LIMIT = 25;
  /** Cap on entity search results shown in the entity picker. */
  const ENTITY_SEARCH_LIMIT = 50;

  /** Module-local cache of entity definitions used by the entity picker. */
  let entityCache = null;

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
    const xrm = getXrm();
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
      const entityName = xrm.Page.data.entity.getEntityName();
      const etc = xrm.Page.context.getQueryStringParameters().etc;
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
    let url = xrm.Page.context.getClientUrl() + "/main.aspx?";
    if (appId) url += "appid=" + appId + "&";
    url += "etn=" + xrm.Page.data.entity.getEntityName();
    url += "&id=" + xrm.Page.data.entity.getId();
    url += "&pagetype=entityrecord";
    return url;
  }

  /** @returns {string} the Dataverse Web API version (e.g. "9.2"). */
  function apiVersion() {
    try {
      const version = getXrm().Utility.getGlobalContext().getVersion();
      const match = /^(\d+\.\d+)/.exec(version);
      return match ? match[1] : "9.2";
    } catch (e) {
      debugLog("bridge.apiVersion", e);
      return "9.2";
    }
  }

  /**
   * The environment base URL, falling back to location.origin when Xrm is
   * unavailable (e.g. on a non-form page).
   * @returns {string}
   */
  function baseUrl() {
    const xrm = getXrm();
    try {
      if (xrm && xrm.Utility && xrm.Utility.getGlobalContext) {
        return xrm.Utility.getGlobalContext().getClientUrl();
      }
    } catch (e) {
      debugLog("bridge.baseUrl", e);
    }
    try {
      if (xrm && xrm.Page && xrm.Page.context) {
        return xrm.Page.context.getClientUrl();
      }
    } catch (e) {
      debugLog("bridge.baseUrlFallback", e);
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
    const url = baseUrl() + "/api/data/v" + apiVersion() + "/" + path;
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
    let out = [];
    let guard = 0;
    const MAX_PAGES = 40;
    let data = await webApiGet(path);
    out = out.concat(data.value || []);
    let next = data["@odata.nextLink"];
    while (next && guard < MAX_PAGES) {
      guard++;
      try {
        const response = await fetch(next, {
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
    const url = baseUrl() + "/api/data/v" + apiVersion() + "/" + path;
    const response = await fetch(url, {
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
    const cleanId = String(userId).replace(/[{}]/g, "");
    const base = baseUrl() + "/api/data/v" + apiVersion();
    const url = base + "/systemusers(" + cleanId + ")/" + nav + "/$ref";
    const body = JSON.stringify({
      "@odata.id": base + "/" + entitySet + "(" + String(refId).replace(/[{}]/g, "") + ")"
    });
    const response = await fetch(url, {
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
    const cleanId = String(userId).replace(/[{}]/g, "");
    const base = baseUrl() + "/api/data/v" + apiVersion();
    const url =
      base +
      "/systemusers(" +
      cleanId +
      ")/" +
      nav +
      "/$ref?$id=" +
      encodeURIComponent(base + "/" + entitySet + "(" + String(refId).replace(/[{}]/g, "") + ")");
    const response = await fetch(url, {
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

  /** Escape XML text content when re-serializing manually. */
  function xmlEscapeText(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** Escape XML attribute values when re-serializing manually. */
  function xmlEscapeAttr(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }

  /**
   * Pretty-print an XML string with a small DOM walker. The previous
   * implementation relied on XSLTProcessor, which browsers have deprecated
   * and will remove; the walker produces the same indented shape without it.
   * Returns the input on parse failure.
   * @param {string} source
   * @returns {string}
   */
  function prettyXml(source) {
    let doc;
    try {
      doc = new DOMParser().parseFromString(source, "text/xml");
    } catch (e) {
      return source;
    }
    if (doc.getElementsByTagName("parsererror").length) return source;

    const lines = [];
    const walk = function (node, depth) {
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        const pad = "  ".repeat(depth);
        if (child.nodeType === 3) {
          // Whitespace between elements is layout noise; other text at this
          // level (mixed content) is emitted as-is.
          if (child.nodeValue && child.nodeValue.trim()) lines.push(pad + xmlEscapeText(child.nodeValue));
        } else if (child.nodeType === 4) {
          lines.push(pad + "<![CDATA[" + child.nodeValue + "]]>");
        } else if (child.nodeType === 8) {
          lines.push(pad + "<!--" + child.nodeValue + "-->");
        } else if (child.nodeType === 7) {
          lines.push(pad + "<?" + child.nodeValue + "?>");
        } else if (child.nodeType === 1) {
          let open = "<" + child.nodeName;
          for (let a = 0; a < child.attributes.length; a++) {
            const attribute = child.attributes[a];
            open += " " + attribute.name + '="' + xmlEscapeAttr(attribute.value) + '"';
          }
          let elementChildren = 0;
          let textContent = "";
          for (let c = 0; c < child.childNodes.length; c++) {
            const grand = child.childNodes[c];
            if (grand.nodeType === 1) elementChildren++;
            else if (grand.nodeType === 3) textContent += grand.nodeValue;
          }
          if (!elementChildren) {
            // Leaf element: keep the value on one line; a whitespace-only or
            // empty value collapses to a self-closing tag.
            const text = textContent.trim();
            if (!text) lines.push(pad + open + " />");
            else lines.push(pad + open + ">" + xmlEscapeText(text) + "</" + child.nodeName + ">");
          } else {
            lines.push(pad + open + ">");
            walk(child, depth + 1);
            lines.push(pad + "</" + child.nodeName + ">");
          }
        }
      }
    };

    walk(doc, 0);
    return lines.join("\n");
  }

  /**
   * Add a URL parameter and reload the page. Used by the debug flag actions.
   * @param {string} name
   * @param {string} value
   * @returns {{message: string, level: string}}
   */
  function applyUrlParam(name, value) {
    try {
      const url = new URL(location.href);
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
      const entityMetadata = await webApiGet("EntityDefinitions(LogicalName='" + entityName + "')?$select=MetadataId");
      const metadataId = entityMetadata.MetadataId;
      const components = await webApiGet(
        "solutioncomponents?$select=solutionid,componenttype,objectid&$filter=objectid eq " +
          metadataId +
          " and componenttype eq 1&$top=10&$expand=solutionid($select=solutionid,uniquename)"
      );
      const list = components.value || [];
      for (let i = 0; i < list.length; i++) {
        const solution = list[i].solutionid;
        if (solution && solution.solutionid) return solution.solutionid;
      }
    } catch (e) {
      debugLog("bridge.entitySolutionId", e);
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

  /**
   * DOM element that hosts a form control, by schema name. Used by the form
   * handlers for highlighting / inline links (forms.js destructure it off
   * PPMain - a missing key here used to crash those handlers silently, which
   * the contract test in tests/contract.test.js now catches).
   *
   * Form DOM shapes differ between generations, so probe them in order and
   * return the first hit:
   *   - legacy 2011 forms: the label cell `<name>_c`
   *   - UCI: `div[data-id="<name>"]` (control wrapper)
   *   - UCI (custom control): `[data-control-name="<name>"]`
   * @param {string} name field schema name
   * @returns {HTMLElement|null}
   */
  function findContainer(name) {
    if (!name || !global.document || !global.document.querySelector) return null;
    try {
      return (
        global.document.getElementById(name + "_c") ||
        global.document.querySelector('div[data-id="' + name + '"]') ||
        global.document.querySelector('[data-control-name="' + name + '"]')
      );
    } catch (e) {
      debugLog("bridge.findContainer", e);
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * SOAP RetrieveMultiple response parsing
   * ------------------------------------------------------------------ */

  const SOAP_XRM_NS = "http://schemas.microsoft.com/xrm/2011/Contracts";
  const SOAP_ENVELOPE_NS = "http://schemas.xmlsoap.org/soap/envelope/";

  /** First direct-child element with the given localName (any namespace). */
  function childElement(element, localName) {
    for (let i = 0; i < element.childNodes.length; i++) {
      const node = element.childNodes[i];
      if (node.nodeType === 1 && node.localName === localName) return node;
    }
    return null;
  }

  /**
   * Parse a RetrieveMultiple SOAP response into a record table. Returns null
   * when the envelope carries no entity collection (SOAP fault, unexpected
   * shape), so the caller can fall back to the raw response view.
   * @param {string} text
   * @returns {{entityName: string, moreRecords: boolean, columns: string[], rows: Object[], payload: Object}|null}
   */
  function parseRetrieveMultipleResponse(text) {
    let doc;
    try {
      doc = new DOMParser().parseFromString(text, "text/xml");
    } catch (e) {
      return null;
    }
    if (doc.getElementsByTagName("parsererror").length) return null;
    if (doc.getElementsByTagNameNS(SOAP_ENVELOPE_NS, "Fault").length) return null;
    const entities = doc.getElementsByTagNameNS(SOAP_XRM_NS, "Entity");
    if (!entities.length) return null;

    // a:Entities sits inside the EntityCollection value element, which also
    // carries EntityName / MoreRecords / TotalRecordCount as siblings.
    const collectionElement = entities[0].parentNode.parentNode;
    const readSibling = function (localName) {
      const node = childElement(collectionElement, localName);
      return node ? node.textContent : "";
    };
    const entityName = readSibling("EntityName");
    const moreRecords = readSibling("MoreRecords") === "true";
    const totalRecordCount = parseInt(readSibling("TotalRecordCount"), 10) || 0;

    const columnOrder = [];
    const seenColumns = {};
    const rows = [];
    const payloadRecords = [];

    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const attributesElement = childElement(entity, "Attributes");
      const formattedElement = childElement(entity, "FormattedValues");
      const attributes = {};
      const formatted = {};

      if (attributesElement) {
        const pairs = attributesElement.getElementsByTagNameNS(SOAP_XRM_NS, "KeyValuePairOfstringanyType");
        for (let p = 0; p < pairs.length; p++) {
          const pair = pairs[p];
          const keyElement = childElement(pair, "key");
          const valueElement = childElement(pair, "value");
          if (!keyElement || !valueElement) continue;
          const key = keyElement.textContent;
          const type = valueElement.getAttribute("i:type") || "";
          let value = valueElement.textContent;
          if (/EntityReference/i.test(type)) {
            const nameNode = valueElement.getElementsByTagNameNS(SOAP_XRM_NS, "Name")[0];
            if (nameNode) value = nameNode.textContent;
          }
          attributes[key] = value;
        }
      }
      if (formattedElement) {
        const pairs = formattedElement.getElementsByTagNameNS(SOAP_XRM_NS, "KeyValuePairOfstringanyType");
        for (let p = 0; p < pairs.length; p++) {
          const pair = pairs[p];
          const keyElement = childElement(pair, "key");
          const valueElement = childElement(pair, "value");
          if (keyElement && valueElement) formatted[keyElement.textContent] = valueElement.textContent;
        }
      }

      const row = {};
      const payloadRecord = {};
      Object.keys(attributes).forEach(function (key) {
        if (!seenColumns[key]) {
          seenColumns[key] = true;
          columnOrder.push(key);
        }
        // Prefer the platform formatted value (option labels, localized dates,
        // currency strings); fall back to the raw attribute value.
        row[key] = formatted[key] != null && formatted[key] !== "" ? formatted[key] : attributes[key];
        payloadRecord[key] = attributes[key];
        if (formatted[key] != null && formatted[key] !== "") payloadRecord[key + "@formatted"] = formatted[key];
      });
      const idElement = childElement(entity, "Id");
      if (idElement && idElement.textContent) {
        // Register the id column once (front of the column order), but set
        // the value on every row - each entity carries its own Id.
        if (!seenColumns["id"]) {
          seenColumns["id"] = true;
          columnOrder.unshift("id");
        }
        row["id"] = idElement.textContent;
        payloadRecord["id"] = idElement.textContent;
      }
      rows.push(row);
      payloadRecords.push(payloadRecord);
    }

    if (!columnOrder.length) return null;
    return {
      entityName: entityName,
      moreRecords: moreRecords,
      totalRecordCount: totalRecordCount,
      columns: columnOrder,
      rows: rows,
      payload: {
        entityName: entityName,
        moreRecords: moreRecords,
        totalRecordCount: totalRecordCount,
        records: payloadRecords
      }
    };
  }

  // Test hook (scripts/tests + CI): the parser is a pure text -> data
  // transform, so the unit tests drive it directly after loading this file in
  // a sandbox with a stubbed DOMParser. Runtime code never reads __PPTest.
  global.__PPTest = global.__PPTest || {};
  global.__PPTest.parseRetrieveMultipleResponse = parseRetrieveMultipleResponse;

  /* ------------------------------------------------------------------ *
   * Command registry
   * ------------------------------------------------------------------ */

  /** Command name -> handler function. */
  const handlers = {};


  /* ------------------------------------------------------------------ *
   * Script runner (JavaScript snippets)
   * ------------------------------------------------------------------ */


  /**
   * Load + cache the full entity list (logical name + display name) used to
   * complete partial inputs in the "entity" search fields.
   * @returns {Promise<Array<{logical: string, display: string}>>}
   */
  async function loadEntityCache() {
    const data = await webApiGet("EntityDefinitions?$select=LogicalName,DisplayName");
    // Snapshot-built list, flipped into the cache in one assignment.
    entityCache = (data.value || []).map(function (entity) {
      return {
        logical: entity.LogicalName,
        display:
          (entity.DisplayName && entity.DisplayName.UserLocalizedLabel && entity.DisplayName.UserLocalizedLabel.Label) ||
          entity.LogicalName
      };
    });
    return entityCache;
  }

  /**
   * Entity-def search for the picker: reads from the module-local cache and
   * truncates to the top candidates. Stays in the entry because it owns the
   * module-local entity cache/loader pair.
   * @param {{query: string}} args
   * @returns {Promise<{entities: Array<{logical: string, display: string}>}>}
   */
  handlers.searchEntities = async function (args) {
    const query = ((args && args.query) || "").trim().toLowerCase();
    if (!query) return { entities: [] };
    // Snapshot the module cache into a local before awaiting: concurrent
    // handlers could flip `entityCache` while the network call is in flight,
    // so re-reading it after the await would be racy (ESLint flagged it).
    let candidates = entityCache;
    if (!candidates) {
      candidates = await loadEntityCache();
    }
    const matches = candidates
      .filter(function (entity) {
        return entity.logical.toLowerCase().indexOf(query) > -1 || entity.display.toLowerCase().indexOf(query) > -1;
      })
      .slice(0, ENTITY_SEARCH_LIMIT);
    return { entities: matches };
  };

  /* ------------------------------------------------------------------ *
   * Impersonation & user-access data
   * ------------------------------------------------------------------ */


  /* ------------------------------------------------------------------ *
   * Shared surface for the command files (content/commands/*.js).
   *
   * Same blocker as PP.BRIDGE: Chrome does not share content-script files
   * across a MAIN-world and an ISOLATED-world entry (crbug.com/324096753),
   * so the plumbing helpers have to be re-exposed here (in the MAIN world)
   * for the command files, which then register their handlers.
   * ------------------------------------------------------------------ */

  /**
   * Silent-catch breadcrumbs for the MAIN world. Behavior/switch identical to
   * PPUtil.debugLog (ISOLATED world) - `src/util.js` cannot be loaded here
   * (see the crbug note above), so this is a deliberate local copy.
   * @param {string} source short tag identifying the failing call site
   * @param {*} detail whatever the catch received
   */
  function debugLog(source, detail) {
    try {
      if (!global.localStorage || global.localStorage.getItem(DEBUG_KEY) !== "1") {
        return;
      }
      global.console.debug("[Power Pane Next][" + source + "]", detail || "");
    } catch (e) {
      /* localStorage unavailable */
    }
  }

  function register(name, handler) {
    handlers[name] = handler;
  }

  function get(name) {
    return handlers[name];
  }

  const PPMain = {
    register: register,
    get: get,
    getXrm: getXrm,
    requireForm: requireForm,
    clientUrl: clientUrl,
    objectTypeCode: objectTypeCode,
    buildRecordUrl: buildRecordUrl,
    apiVersion: apiVersion,
    baseUrl: baseUrl,
    webApiGet: webApiGet,
    webApiGetAll: webApiGetAll,
    webPatch: webPatch,
    webAssoc: webAssoc,
    webDisassoc: webDisassoc,
    xmlEncode: xmlEncode,
    parseRetrieveMultipleResponse: parseRetrieveMultipleResponse,
    xmlEscapeText: xmlEscapeText,
    xmlEscapeAttr: xmlEscapeAttr,
    prettyXml: prettyXml,
    applyUrlParam: applyUrlParam,
    getEntitySolutionId: getEntitySolutionId,
    formattedValue: formattedValue,
    findContainer: findContainer,
    debugLog: debugLog,
    MIN_USER_SEARCH_LENGTH: MIN_USER_SEARCH_LENGTH,
    ROLE_CHECK_USER_LIMIT: ROLE_CHECK_USER_LIMIT,
    ENTITY_SEARCH_LIMIT: ENTITY_SEARCH_LIMIT
  };
  try {
    Object.freeze(PPMain);
  } catch (e) {
    /* Older engines: freezing is best-effort only. */
  }

  global.PPMain = PPMain;

  /* ------------------------------------------------------------------ *
   * Bridge listener
   * ------------------------------------------------------------------ */

  global.addEventListener("message", function (event) {
    // Only accept messages from this same window (and, when available, the same
    // origin) carrying our bridge marker. This is a hygiene check, not a trust
    // boundary — the page can always call Xrm/Web API directly.
    if (event.source !== global) return;
    if (event.origin && event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message[BRIDGE_KEY] !== BRIDGE_REQUEST) return;
    if (typeof message.id !== "string" || typeof message.command !== "string") return;

    const handler = handlers[message.command];

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
