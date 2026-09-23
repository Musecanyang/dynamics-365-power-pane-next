/**
 * Dynamics 365 Power Pane Next - command handlers: records.
 *
 * Record-centric commands: ids, urls, record properties, Field Inspector, Lookups and the data table builders (All Fields / OptionSet Values / Table Processes).
 *
 * Every handler registers via PPmain.register; cross-command reads go
 * through PPmain.get(name). See content/main-world.js for the loading
 * order, the postMessage contract and the response shapes.
 */
(function (PPmain) {
  "use strict";

  const { requireForm, objectTypeCode, buildRecordUrl, baseUrl, webApiGet, formattedValue } = PPmain;

  /* ------------------------------------------------------------------ *
   * Record
   * ------------------------------------------------------------------ */

  PPmain.register("entityInfo", function () {
    const xrm = requireForm();
    const items = [{ label: "Entity Name", value: xrm.Page.data.entity.getEntityName() }];
    const typeCode = objectTypeCode(xrm);
    if (typeCode) items.push({ label: "Entity Type Code", value: String(typeCode) });
    return { output: { title: "Entity Info", items: items } };
  });

  PPmain.register("recordId", function () {
    const xrm = requireForm();
    return {
      output: { title: "Record Id", items: [{ label: "Record Id", value: xrm.Page.data.entity.getId() }] }
    };
  });

  PPmain.register("recordUrl", async function () {
    const xrm = requireForm();
    const items = [{ label: "Record Url", value: buildRecordUrl(xrm) }];
    try {
      const globalContext = xrm.Utility.getGlobalContext();
      if (globalContext.getCurrentAppProperties) {
        const app = await globalContext.getCurrentAppProperties();
        items.push({
          label: "Record Url (current app)",
          value: buildRecordUrl(xrm, app.appId)
        });
      }
    } catch (e) {
      /* app properties unavailable */
    }
    return { output: { title: "Record Url", items: items } };
  });

  PPmain.register("cloneRecord", function () {
    const xrm = requireForm();
    const excluded = ["createdon", "createdby", "modifiedon", "modifiedby", "ownerid"];
    const fields = [];
    xrm.Page.data.entity.attributes.forEach(function (attribute) {
      const name = attribute.getName();
      const value = attribute.getValue();
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
    const url =
      xrm.Page.context.getClientUrl() +
      "/main.aspx?etn=" +
      xrm.Page.data.entity.getEntityName() +
      "&pagetype=entityrecord&extraqs=?" +
      encodeURIComponent(fields.join("&"));
    window.open(url, "_blank");
    return { message: "Clone form opened in a new tab.", level: "success" };
  });

  PPmain.register("recordProperties", function () {
    const xrm = requireForm();
    const id = xrm.Page.data.entity.getId();
    const typeCode = objectTypeCode(xrm);
    if (window.Mscrm && Mscrm.RibbonActions && Mscrm.RibbonActions.openFormProperties) {
      Mscrm.RibbonActions.openFormProperties(id, typeCode);
      return { message: "Opened record properties.", level: "success" };
    }
    const url =
      xrm.Page.context.getClientUrl() +
      "/_forms/properties/properties.aspx?dType=1&id=" +
      id +
      "&objTypeCode=" +
      typeCode;
    window.open(url, "_blank", "width=420,height=505");
    return { message: "Opened record properties.", level: "success" };
  });

  PPmain.register("fieldInspector", function () {
    const xrm = requireForm();
    const rows = [];
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        const name = control.getName && control.getName();
        if (!name) return;
        const attribute = control.getAttribute ? control.getAttribute() : null;
        let value = null;
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
  });

  PPmain.register("listLookups", function () {
    const xrm = requireForm();
    const rows = [];
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        if (!control.getControlType || control.getControlType() !== "lookup") return;
        const value = control.getAttribute().getValue();
        const first = value && value.length ? value[0] : null;
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
  });

  PPmain.register("allFields", async function () {
    const xrm = requireForm();
    const entityName = xrm.Page.data.entity.getEntityName();
    const id = xrm.Page.data.entity.getId().replace(/[{}]/g, "");
    const meta = await xrm.Utility.getEntityMetadata(entityName, "");

    // The reads below only depend on the entity name / entity set name, so
    // they are issued together instead of one after the other.
    const attributesPath =
      "EntityDefinitions(LogicalName='" + entityName +
      "')/Attributes?$select=LogicalName,AttributeType,DisplayName,AttributeOf";
    const recordPath = meta.EntitySetName + "(" + id + ")";
    // Targets of every lookup of the entity, resolved with a single metadata
    // request (never one request per field). This is kept in addition to the
    // `lookuplogicalname` value annotation because the Web API only returns that
    // annotation for lookups that actually point at a record - empty lookups
    // would otherwise leave the "Entity" column blank.
    const lookupTargetsPath =
      "EntityDefinitions(LogicalName='" + entityName + "')/Attributes/Microsoft.Dynamics.CRM.LookupAttributeMetadata?$select=LogicalName,Targets";
    // Platform-declared "Virtual" columns (File / Image data) only reveal
    // their real type through the typed attribute casts below.
    const fileAttributesPath =
      "EntityDefinitions(LogicalName='" + entityName + "')/Attributes/Microsoft.Dynamics.CRM.FileAttributeMetadata?$select=LogicalName";
    const imageAttributesPath =
      "EntityDefinitions(LogicalName='" + entityName + "')/Attributes/Microsoft.Dynamics.CRM.ImageAttributeMetadata?$select=LogicalName";
    // Multi-select columns are also reported as "Virtual" in the generic feed;
    // only the typed cast reveals them (Same probe the OptionSet Values
    // feature uses).
    const multiSelectAttributesPath =
      "EntityDefinitions(LogicalName='" + entityName + "')/Attributes/Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata?$select=LogicalName";
    const responses = await Promise.all([
      webApiGet(attributesPath),
      webApiGet(recordPath),
      webApiGet(lookupTargetsPath).catch(function () {
        return null; // targets unavailable; the Entity column falls back to the value annotation
      }),
      webApiGet(fileAttributesPath).catch(function () {
        return null;
      }),
      webApiGet(imageAttributesPath).catch(function () {
        return null;
      }),
      webApiGet(multiSelectAttributesPath).catch(function () {
        return null;
      })
    ]);
    const attrData = responses[0];
    const record = responses[1];
    const lookupMeta = responses[2];

    // Dataverse exposes platform "companion" attributes for lookups, option
    // sets and virtual columns (e.g. accountidname, accountidyominame). They
    // only repeat the formatted name already shown in the "Value Name"
    // column, so hide them and keep one row per real field. Companions always
    // point at their parent via `AttributeOf`, which also covers Virtual
    // parents whose type is outside the classic suffix heuristic.
    const virtualFileAttributes = {};
    ((responses[3] && responses[3].value) || []).forEach(function (attribute) {
      virtualFileAttributes[String(attribute.LogicalName).toLowerCase()] = true;
    });
    const virtualImageAttributes = {};
    ((responses[4] && responses[4].value) || []).forEach(function (attribute) {
      virtualImageAttributes[String(attribute.LogicalName).toLowerCase()] = true;
    });
    const virtualMultiSelectAttributes = {};
    ((responses[5] && responses[5].value) || []).forEach(function (attribute) {
      virtualMultiSelectAttributes[String(attribute.LogicalName).toLowerCase()] = true;
    });

    // Dataverse exposes platform "companion" attributes for lookups and option
    // sets (e.g. accountidname, accountidyominame, activitiescompletename).
    // They only repeat the formatted name already shown in the "Value Name"
    // column, so hide them and keep one row per real field.
    const attributes = attrData.value || [];
    const typeByLogicalName = {};
    attributes.forEach(function (attribute) {
      typeByLogicalName[String(attribute.LogicalName).toLowerCase()] = attribute.AttributeType || "";
    });
    const COMPANION_PARENT_TYPES = {
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
      const lower = String(logicalName).toLowerCase();
      let baseName = "";
      if (lower.length > 8 && lower.slice(-8) === "yominame") baseName = lower.slice(0, -8);
      else if (lower.length > 4 && lower.slice(-4) === "name") baseName = lower.slice(0, -4);
      return !!baseName && !!COMPANION_PARENT_TYPES[typeByLogicalName[baseName]];
    }

    // Resolve the target entity (or entities) for each lookup attribute so the
    // "Entity" column can show what a lookup points to.
    const lookupTargets = {};
    ((lookupMeta && lookupMeta.value) || []).forEach(function (attribute) {
      lookupTargets[String(attribute.LogicalName).toLowerCase()] = (attribute.Targets || []).join(", ");
    });

    const rows = [];
    const seenLogicalNames = {}; // guard against duplicate metadata rows for one field
    attributes.forEach(function (attribute) {
      const logicalName = attribute.LogicalName;
      const dedupeKey = String(logicalName).toLowerCase();
      if (seenLogicalNames[dedupeKey]) return;
      seenLogicalNames[dedupeKey] = true;
      // Skip platform companions: they point at their parent via `AttributeOf`
      // and read back the same data (e.g. <prefix>_sendnotificationstatusname
      // for a custom entity: the platform generates the companion column>).
      if (attribute.AttributeOf && String(attribute.AttributeType) === "Virtual") {
        return;
      }
      if (isCompanionNameAttribute(logicalName)) return;
      const display =
        (attribute.DisplayName && attribute.DisplayName.UserLocalizedLabel && attribute.DisplayName.UserLocalizedLabel.Label) ||
        "";
      let type = attribute.AttributeType || "";
      // "Virtual" is the raw metadata type for File / Image data columns and
      // multi-select columns in the generic feed; resolve the real type where
      // the platform provides a typed cast.
      if (type === "Virtual") {
        const lower = dedupeKey;
        if (virtualFileAttributes[lower]) type = "File";
        else if (virtualImageAttributes[lower]) type = "Image";
        else if (virtualMultiSelectAttributes[lower]) type = "MultiSelectPicklist";
      }
      const isLookup = type === "Lookup" || type === "Owner" || type === "Customer";
      // Formatted-value annotations live on the lookup property `_<name>_value`
      // for lookups, and on `<name>` for simple/option-set attributes.
      const raw = record[logicalName];
      let value = "";
      let valueName = "";
      let entity = "";
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
          // Columns are capped so the longest name / value truncates (hover
          // reveals the full text via the tooltip, Copy JSON keeps everything)
          // instead of stretching the dialog into a horizontal scrollbar. Caps
          // are sized so typical content renders fully.
          { key: "display", label: "Display Name", maxWidthPx: 160 },
          { key: "logical", label: "Logical Name", maxWidthPx: 160 },
          { key: "type", label: "Type", maxWidthPx: 130 },
          { key: "entity", label: "Entity", maxWidthPx: 130 },
          { key: "value", label: "Value", maxWidthPx: 185 },
          { key: "name", label: "Value Name", maxWidthPx: 120 }
        ],
        rows: rows
      }
    };
  });

  PPmain.register("optionSetValues", async function () {
    const xrm = requireForm();
    const entityName = xrm.Page.data.entity.getEntityName();
    const rows = [];
    const seen = {}; // "logical|value" -> true, avoids duplicates
    function push(group, logical, optionSet) {
      const options = (optionSet && optionSet.Options) || [];
      options.forEach(function (option) {
        const value = String(option.Value);
        const key = logical + "|" + value;
        if (seen[key]) return;
        seen[key] = true;
        const label =
          (option.Label && option.Label.UserLocalizedLabel && option.Label.UserLocalizedLabel.Label) || "";
        rows.push({ group: group, attribute: logical, label: label, value: value });
      });
    }
    const casts = [
      "PicklistAttributeMetadata",
      "MultiSelectPicklistAttributeMetadata",
      "StateAttributeMetadata",
      "StatusAttributeMetadata"
    ];
    for (let i = 0; i < casts.length; i++) {
      try {
        const data = await webApiGet(
          "EntityDefinitions(LogicalName='" +
            entityName +
            "')/Attributes/Microsoft.Dynamics.CRM." +
            casts[i] +
            "?$select=LogicalName,DisplayName&$expand=OptionSet,GlobalOptionSet"
        );
        (data.value || []).forEach(function (attribute) {
          const display =
            (attribute.DisplayName && attribute.DisplayName.UserLocalizedLabel && attribute.DisplayName.UserLocalizedLabel.Label) ||
            "";
          const group = display ? display + " (" + attribute.LogicalName + ")" : attribute.LogicalName;
          // A global option set exposes its options through GlobalOptionSet;
          // use the first non-empty source so values are not listed twice.
          const source =
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
  });

  PPmain.register("tableProcesses", async function () {
    const xrm = requireForm();
    const entityName = xrm.Page.data.entity.getEntityName();
    const rows = [];
    try {
      const workflows = await webApiGet(
        "workflows?$select=name,category,mode,type,statecode,statuscode,primaryentity,scope,createdon,modifiedon,workflowid,description" +
          "&$filter=primaryentity eq '" +
          entityName +
          "'&$top=200"
      );
      (workflows.value || []).forEach(function (workflow) {
        const type = formattedValue(workflow, "category") + (workflow.mode != null ? " / " + formattedValue(workflow, "mode") : "");
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
      const customApis = await webApiGet(
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
  });

})(window.PPMain);
