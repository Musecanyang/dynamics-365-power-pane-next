/**
 * Dynamics 365 Power Pane Next - action registry.
 *
 * Single source of truth for the pane's actions. The content script renders
 * the pane from this list; the options page uses it for visibility, ordering
 * and shortcut configuration.
 *
 * Action shape:
 *   id       {string}   stable identifier (persisted in settings/order)
 *   group    {string}   UI section (see GROUP_COLORS in content.js)
 *   label    {string}   text shown in the pane
 *   command  {string}   handler name; local actions use `local: true`
 *   local    {boolean}  handled inside the content script (no bridge call)
 *   inputs   {Array}    optional input fields:
 *                        { name, label, placeholder, type?, entity?, defaultCurrent? }
 *                        - type:"textarea" renders a multi-line field
 *                        - entity:true enables the entity search dropdown
 *                        - defaultCurrent:true pre-fills the current entity
 *
 * Keep ids stable: renaming an id resets that action's saved visibility,
 * order and shortcut for existing users.
 */
window.POWER_PANE_ACTIONS = [
  // General
  { id: "user-info", group: "General", label: "User Info", command: "userInfo" },
  { id: "context", group: "General", label: "Form Context", command: "getContext" },
  {
    id: "fetch-xml",
    group: "General",
    label: "Execute Fetch XML",
    command: "executeFetchXml",
    inputs: [{ name: "xml", label: "FetchXML", type: "textarea", placeholder: "&lt;fetch&gt;...&lt;/fetch&gt;" }]
  },
  { id: "fetch-snippets", group: "General", label: "FetchXML Snippets", command: "snippets", local: true },

  // Impersonation
  { id: "impersonate", group: "Impersonation", label: "Impersonate User", command: "impersonate", local: true },
  { id: "impersonate-stop", group: "Impersonation", label: "Stop Impersonation", command: "impersonateStop", local: true },
  { id: "dnr-rules", group: "Impersonation", label: "DNR Rules (debug)", command: "dnrRules", local: true },

  // Record
  { id: "entity-info", group: "Record", label: "Entity Info", command: "entityInfo" },
  { id: "record-id", group: "Record", label: "Record Id", command: "recordId" },
  { id: "record-url", group: "Record", label: "Record Url", command: "recordUrl" },
  { id: "clone-record", group: "Record", label: "Clone Record", command: "cloneRecord" },
  { id: "record-properties", group: "Record", label: "Record Properties", command: "recordProperties" },
  { id: "field-inspector", group: "Record", label: "Field Inspector", command: "fieldInspector" },
  { id: "list-lookups", group: "Record", label: "Lookups", command: "listLookups" },

  // Form
  { id: "enable-all-fields", group: "Form", label: "Enable All Fields", command: "enableAllFields" },
  { id: "god-mode", group: "Form", label: "God Mode", command: "godMode" },
  { id: "show-hidden-fields", group: "Form", label: "Show Hidden Fields", command: "showHiddenFields" },
  { id: "disable-required", group: "Form", label: "Disable Field Requirement", command: "disableRequired" },
  { id: "logical-names-inline", group: "Form", label: "Logical Names (inline, click to copy)", command: "logicalNamesInline" },
  { id: "optionset-values", group: "Form", label: "OptionSet Values", command: "optionSetValues" },
  {
    id: "show-field-value",
    group: "Form",
    label: "Show Field Value",
    command: "showFieldValue",
    inputs: [{ name: "fieldname", label: "Field Schema Name", placeholder: "e.g. name" }]
  },
  {
    id: "find-field",
    group: "Form",
    label: "Find Field in Form",
    command: "findField",
    inputs: [{ name: "fieldname", label: "Field Schema Name", placeholder: "e.g. name" }]
  },
  { id: "highlight-dirty", group: "Form", label: "Highlight Dirty Fields", command: "highlightDirty" },
  { id: "clear-notifications", group: "Form", label: "Clear All Notifications", command: "clearNotifications" },
  { id: "lookup-links", group: "Form", label: "Toggle Lookup Links", command: "toggleLookupLinks" },
  { id: "refresh-ribbon", group: "Form", label: "Refresh Ribbon", command: "refreshRibbon" },
  { id: "refresh-form", group: "Form", label: "Refresh Form", command: "refreshForm" },
  { id: "clear-names", group: "Form", label: "Clear Logical Names", command: "clearLogicalNames" },
  { id: "changed-fields", group: "Form", label: "Changed Fields", command: "changedFields" },
  { id: "refresh-subgrids", group: "Form", label: "Refresh Subgrids", command: "refreshSubgrids" },
  { id: "refresh-no-save", group: "Form", label: "Refresh Without Save", command: "refreshWithoutSave" },
  { id: "all-fields", group: "Form", label: "All Fields (Web API)", command: "allFields" },
  { id: "table-processes", group: "Form", label: "Table Processes", command: "tableProcesses" },

  // Navigation
  {
    id: "go-to-record",
    group: "Navigation",
    label: "Go to Record by Id",
    command: "goToRecord",
    inputs: [
      { name: "entityname", label: "Entity (search by name or logical name)", placeholder: "e.g. account", entity: true, defaultCurrent: true },
      { name: "recordid", label: "Record Id", placeholder: "GUID" }
    ]
  },
  {
    id: "go-to-create",
    group: "Navigation",
    label: "Go to Create Form",
    command: "goToCreateForm",
    inputs: [{ name: "entityname", label: "Entity (search by name or logical name)", placeholder: "e.g. account", entity: true, defaultCurrent: true }]
  },
  { id: "open-webapi", group: "Navigation", label: "Open Web API Record", command: "openWebApi" },
  {
    id: "entity-metadata",
    group: "Navigation",
    label: "Entity Metadata Browser",
    command: "entityMetadata",
    inputs: [
      { name: "entityname", label: "Entity (search by name or logical name)", placeholder: "current entity", entity: true, defaultCurrent: true }
    ]
  },
  {
    id: "open-entity-editor",
    group: "Navigation",
    label: "Entity Editor (Classic)",
    command: "openEntityEditor",
    inputs: [
      { name: "entityname", label: "Entity (defaults to current)", placeholder: "current entity", entity: true, defaultCurrent: true }
    ]
  },
  { id: "open-form-editor", group: "Navigation", label: "Form Editor (Classic)", command: "openFormEditor" },
  { id: "open-form-editor-new", group: "Navigation", label: "Form Editor (New)", command: "openFormEditorNew" },
  { id: "solutions", group: "Navigation", label: "Solutions", command: "solutions" },
  { id: "crm-diagnostics", group: "Navigation", label: "CRM Diagnostics", command: "crmDiagnostics" },
  { id: "performance-center", group: "Navigation", label: "Performance Center", command: "performanceCenter" },
  { id: "mobile-client", group: "Navigation", label: "Mobile Client", command: "mobileClient" },
  {
    id: "open-entity-list",
    group: "Navigation",
    label: "Open Entity List",
    command: "openEntityList",
    inputs: [{ name: "entityname", label: "Entity (search by name or logical name)", placeholder: "e.g. account", entity: true, defaultCurrent: true }]
  },
  { id: "open-system-jobs", group: "Navigation", label: "System Jobs", command: "openSystemJobs" },
  { id: "open-processes", group: "Navigation", label: "Processes", command: "openProcesses" },
  { id: "open-mailboxes", group: "Navigation", label: "Mailboxes", command: "openMailboxes" },
  { id: "open-home", group: "Navigation", label: "Home", command: "openHome" },
  { id: "open-advanced-find", group: "Navigation", label: "Open Advanced Find", command: "openAdvancedFind" },
  { id: "open-security", group: "Navigation", label: "Security (Admin)", command: "openSecurity" },
  { id: "open-solutions-history", group: "Navigation", label: "Solutions History", command: "openSolutionsHistory" },
  { id: "open-advanced-settings-users", group: "Navigation", label: "Advanced Settings - Users", command: "advancedSettingsUsers", local: true },
  { id: "pin-side-panel", group: "Navigation", label: "Pin to Side Panel", command: "pinSidePanel" },

  // Debug (URL flags, merged from Levelup)
  { id: "debug-forms-monitor", group: "Debug", label: "Forms Monitor", command: "formsMonitor" },
  { id: "debug-command-checker", group: "Debug", label: "Command Checker", command: "commandChecker" },
  { id: "debug-perf-center", group: "Debug", label: "Perf Center (URL)", command: "perfCenterFlag" },
  { id: "debug-disable-handlers", group: "Debug", label: "Disable Form Handlers", command: "disableFormHandlers" },
  { id: "debug-disable-rules", group: "Debug", label: "Disable Business Rules", command: "disableBusinessRules" },
  { id: "debug-disable-libs", group: "Debug", label: "Disable Form Libraries", command: "disableFormLibraries" },
  { id: "debug-disable-commandbar", group: "Debug", label: "Disable Form Command Bar", command: "disableFormCommandbar" },
  {
    id: "debug-disable-webresources",
    group: "Debug",
    label: "Disable Web Resource Controls",
    command: "disableWebResourceControls"
  },
  {
    id: "debug-disable-bpf",
    group: "Debug",
    label: "Disable Business Process Flow",
    command: "disableBusinessProcessFlow"
  },
  {
    id: "debug-disable-control",
    group: "Debug",
    label: "Disable Form Control",
    command: "disableFormControl",
    inputs: [{ name: "control", label: "Control (schema name)", placeholder: "e.g. name" }]
  },
  { id: "debug-navbar-off", group: "Debug", label: "Navbar Off", command: "navbarOff" },
  { id: "debug-disable-all", group: "Debug", label: "Disable All Components (combined)", command: "disableAllComponents" },
  { id: "debug-dark-mode", group: "Debug", label: "Enable Dark Mode (flag)", command: "darkModeFlag" },
  { id: "debug-clear-flags", group: "Debug", label: "Clear Flags", command: "clearFlags" },

  // Admin / Info
  { id: "environment-info", group: "Admin", label: "Environment Info", command: "environmentInfo" },
  { id: "org-settings", group: "Admin", label: "Organization Settings", command: "orgSettings" },
  { id: "client-info", group: "Admin", label: "Client Info", command: "clientInfo" },
  { id: "user-access", group: "Admin", label: "User Permissions (view/edit)", command: "userAccess", local: true },
  {
    id: "role-check",
    group: "Admin",
    label: "Role Check",
    command: "roleCheck",
    inputs: [
      {
        name: "query",
        label: "Name(s) or Email(s)",
        type: "textarea",
        placeholder: "one per line, or comma separated"
      }
    ]
  }
];
