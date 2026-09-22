/**
 * Dynamics 365 Power Pane Next - command handlers: runcode.
 *
 * Run Code: executeFetchXml (SOAP RetrieveMultiple -> data table) and runScript (JavaScript invoked with the page's own Xrm client API).
 *
 * Every handler registers via PPmain.register; cross-command reads go
 * through PPmain.get(name). See content/main-world.js for the loading
 * order, the postMessage contract and the response shapes.
 */
(function (PPmain) {
  "use strict";

  const { getXrm, baseUrl, xmlEncode, parseRetrieveMultipleResponse, prettyXml } = PPmain;


  PPmain.register("executeFetchXml", async function (args) {
    const xml = (args && args.xml || "").trim();
    if (!xml) throw new Error("FetchXML is empty.");
    const envelope =
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
    // baseUrl() (instead of a form's client URL) means Run Code (FetchXML) also
    // works on pages without an open record form.
    const response = await fetch(baseUrl() + "/XRMServices/2011/Organization.svc/web", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "text/xml",
        Accept: "application/xml, text/xml, */*",
        SOAPAction: "http://schemas.microsoft.com/xrm/2011/Contracts/Services/IOrganizationService/Execute"
      },
      body: envelope
    });
    const text = await response.text();

    // Prefer a parsed record table; fall back to the raw XML view for SOAP
    // faults and anything that is not an entity collection.
    let parsed = null;
    try {
      parsed = parseRetrieveMultipleResponse(text);
    } catch (e) {
      parsed = null;
    }
    if (!parsed) {
      // Breadcrumb for the "ran but no table" case: the toast / dialog the
      // buyer sees says WHAT the service returned (or nothing, in which case
      // the __ppNextDebug switch prints the parse rejection / excerpt here).
      PPmain.debugLog("runcode.fetchXml.parse", {
        status: response.status + " " + response.statusText,
        bytes: text.length,
        head: text.slice(0, 400)
      });
    }
    if (parsed.rows.length === 0) {
      // An empty result is a success, but a corner toast reads like an error -
      // give it the same result dialog as every other outcome.
      return {
        output: {
          title: "Fetch XML Result",
          description: "Query executed successfully - no records matched.",
          items: [
            { label: "Entity", value: parsed.entityName || "(not returned)" },
            { label: "Records", value: "0" },
            { label: "More records available", value: parsed.moreRecords ? "yes" : "no" }
          ]
        }
      };
    }
    if (parsed) {
      return {
        table: {
          title: "Fetch XML Result",
          description:
            (parsed.entityName || "records") +
            " - " +
            parsed.rows.length +
            " record(s)" +
            (parsed.moreRecords ? " (more records available)" : ""),
          searchable: true,
          copyKey: parsed.columns[0],
          rawJson: JSON.stringify(parsed.payload, null, 2),
          columns: parsed.columns.map(function (key) {
            return { key: key, label: key, maxWidthPx: 240 };
          }),
          rows: parsed.rows
        }
      };
    }

    // SOAP faults arrive with an HTTP 500 and a faultstring - surface the
    // human-readable message and keep the raw envelope for inspection.
    let faultText = "";
    try {
      const faultDoc = new DOMParser().parseFromString(text, "text/xml");
      const faultElement = faultDoc.getElementsByTagName("faultstring")[0];
      if (faultElement) faultText = faultElement.textContent;
    } catch (e) {
      /* fall through to the generic description */
    }
    return {
      output: {
        title: "Fetch XML Result",
        description: faultText || response.status + " " + response.statusText,
        items: [{ label: "Response", value: prettyXml(text) }]
      }
    };
  });
  /**
   * Run a JavaScript snippet in the page's MAIN world. The body is compiled
   * into an async function, so both `await` and `return` work at the top
   * level. `xrm` (possibly undefined outside record forms) is in scope; the
   * script runs with the signed-in user's own privileges - exactly like
   * typing the same code into DevTools on this page.
   * @param {{code: string}} args
   * @returns {Promise<Object>}
   */
  PPmain.register("runScript", async function (args) {
    // Accept `code` (Snippets / direct calls) or `xml` (Run Code dialog
    // running in JavaScript mode).
    const code = ((args && (args.code || args.xml)) || "").trim();
    if (!code) throw new Error("Script is empty.");
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const result = await new AsyncFunction("xrm", code)(getXrm());
    if (result === undefined) {
      return { message: "Script completed (no return value).", level: "success" };
    }
    let text;
    if (typeof result === "string") {
      text = result;
    } else {
      try {
        text = JSON.stringify(result, null, 2);
      } catch (e) {
        text = String(result);
      }
    }
    return { output: { title: "Script Result", items: [{ label: "Result", value: text }] } };
  });

})(window.PPMain);
