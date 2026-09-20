/**
 * Dynamics 365 Power Pane Next - service worker.
 *
 * Responsibilities:
 *   1. Toggle the in-page pane when the toolbar icon is clicked.
 *   2. "Impersonate another user" support: inject the `CallerObjectId`
 *      (and legacy `MSCRMCallerID`) request header on the environment's
 *      Dataverse traffic using declarativeNetRequest *session* rules.
 *
 * Impersonation model
 * -------------------
 * Rules are scoped three ways so the impersonated identity survives SPA
 * navigation, Advanced Find windows and service-worker-forwarded requests:
 *   - HOST rule   : every request to the environment host (no tab filter)
 *   - SW rule     : requests not originating from a tab (tabIds: [-1])
 *   - TAB rule    : requests from the originating tab
 * The active impersonation is recorded per hostname in `chrome.storage.session`
 * so it survives service-worker restarts and can be re-applied to new tabs.
 *
 * All constants are defined in src/constants.js (imported below).
 */

importScripts("./src/constants.js");

var PP = self.PP || {
  SESSION: { HOSTS: "ppImpHosts", TABS: "ppImpTabs" },
  MSG: {
    IMP_START: "pp:imp-start",
    IMP_STOP: "pp:imp-stop",
    IMP_STATUS: "pp:imp-status",
    IMP_RULES: "pp:imp-rules",
    RELOAD_TAB: "pp:reload",
    OPEN_OPTIONS: "pp-open-options",
    PANE_TOGGLE: "pp-toggle"
  }
};

/* --- Rule identifiers ------------------------------------------------- */
/** Rule id for requests that do not originate from a tab (e.g. the SW). */
var SW_RULE_ID = 1;
/** Rule id for the host-wide rule (all tabs/windows on the environment). */
var HOST_RULE_ID = 2;

/* --- Session state helpers -------------------------------------------- */

/**
 * Read a value from chrome.storage.session with a fallback.
 * @param {string} key
 * @param {*} fallback
 * @returns {Promise<*>}
 */
async function sessionGet(key, fallback) {
  const data = await chrome.storage.session.get({ [key]: fallback });
  return data[key];
}

/**
 * Persist a value into chrome.storage.session.
 * @param {string} key
 * @param {*} value
 * @returns {Promise<void>}
 */
async function sessionSet(key, value) {
  await chrome.storage.session.set({ [key]: value });
}

/** @returns {Promise<Object<string, {user: Object, startedAt: number}>>} */
function getHosts() {
  return sessionGet(PP.SESSION.HOSTS, {});
}

/** @returns {Promise<Object<number, {hostname: string}>>} */
function getTabs() {
  return sessionGet(PP.SESSION.TABS, {});
}

/* --- DeclarativeNetRequest rule management ---------------------------- */

/**
 * Add/replace the impersonation rules for one tab on one host.
 * The host rule is best-effort: if a Chrome build rejects it, the tab and
 * service-worker rules are still applied so impersonation keeps working.
 *
 * @param {number|null} tabId   originating tab id (may be null)
 * @param {string} hostname     environment hostname
 * @param {{azureactivedirectoryobjectid: string, systemuserid?: string}} impUser
 * @returns {Promise<void>}
 */
async function addRule(tabId, hostname, impUser) {
  const requestHeaders = [
    { header: "CallerObjectId", operation: "set", value: impUser.azureactivedirectoryobjectid }
  ];
  if (impUser.systemuserid) {
    requestHeaders.push({ header: "MSCRMCallerID", operation: "set", value: impUser.systemuserid });
  }
  const action = { type: "modifyHeaders", requestHeaders: requestHeaders };
  const baseCondition = { urlFilter: `||${hostname}/` };

  const hostWideRule = {
    id: HOST_RULE_ID,
    priority: 1,
    action: action,
    condition: Object.assign({}, baseCondition, { requestDomains: [hostname] })
  };
  const serviceWorkerRule = {
    id: SW_RULE_ID,
    priority: 1,
    action: action,
    condition: Object.assign({}, baseCondition, { tabIds: [-1] })
  };
  const tabRule =
    tabId != null
      ? { id: tabId, priority: 1, action: action, condition: Object.assign({}, baseCondition, { tabIds: [tabId] }) }
      : null;

  const removeRuleIds = [SW_RULE_ID, HOST_RULE_ID];
  const addRules = [hostWideRule, serviceWorkerRule];
  if (tabRule) {
    removeRuleIds.push(tabId);
    addRules.push(tabRule);
  }

  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
  } catch (e) {
    // Fallback: drop the host-wide rule (retry without it).
    const fallbackRemove = [SW_RULE_ID];
    const fallbackAdd = [serviceWorkerRule];
    if (tabRule) {
      fallbackRemove.push(tabId);
      fallbackAdd.push(tabRule);
    }
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: fallbackRemove,
      addRules: fallbackAdd
    });
  }
}

/**
 * Remove every rule associated with an environment host.
 * @param {string} hostname
 * @returns {Promise<void>}
 */
async function removeRulesForHost(hostname) {
  const tabs = await getTabs();
  const ruleIds = [SW_RULE_ID, HOST_RULE_ID];
  Object.keys(tabs).forEach((tabId) => {
    if (tabs[tabId] && tabs[tabId].hostname === hostname) {
      ruleIds.push(Number(tabId));
      delete tabs[tabId];
    }
  });
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds }).catch(() => {});
  await sessionSet(PP.SESSION.TABS, tabs);
}

/* --- Impersonation lifecycle ------------------------------------------ */

/**
 * Start impersonating `user` on `hostname`, applying rules to the originating
 * tab (if any) and recording the state for later tabs.
 * @param {string} hostname
 * @param {{azureactivedirectoryobjectid: string, systemuserid?: string, fullname?: string, internalemailaddress?: string}} user
 * @param {number|null} tabId
 * @returns {Promise<void>}
 */
async function startImpersonation(hostname, user, tabId) {
  if (!hostname) throw new Error("Missing environment hostname.");
  if (!user || !user.azureactivedirectoryobjectid) {
    throw new Error("Selected user has no Azure AD object id; cannot impersonate.");
  }
  await removeRulesForHost(hostname);
  if (tabId != null) {
    await addRule(tabId, hostname, user);
    const tabs = await getTabs();
    tabs[tabId] = { hostname };
    await sessionSet(PP.SESSION.TABS, tabs);
  }
  const hosts = await getHosts();
  hosts[hostname] = {
    user: {
      systemuserid: user.systemuserid || "",
      fullname: user.fullname || "",
      internalemailaddress: user.internalemailaddress || "",
      azureactivedirectoryobjectid: user.azureactivedirectoryobjectid
    },
    startedAt: Date.now()
  };
  await sessionSet(PP.SESSION.HOSTS, hosts);
}

/**
 * Stop impersonating on a host and remove all its rules.
 * @param {string} hostname
 * @returns {Promise<void>}
 */
async function stopImpersonation(hostname) {
  await removeRulesForHost(hostname);
  const hosts = await getHosts();
  delete hosts[hostname];
  await sessionSet(PP.SESSION.HOSTS, hosts);
}

/**
 * @param {string} hostname
 * @returns {Promise<{user: Object, startedAt: number}|null>}
 */
async function getStatus(hostname) {
  const hosts = await getHosts();
  return hosts[hostname] || null;
}

/* --- New-tab propagation ---------------------------------------------- */

/**
 * Apply impersonation to a newly seen tab when its host is being impersonated.
 * The tab is reloaded once so it re-bootstraps under the impersonated identity
 * (covers Advanced Find windows, which boot before the rule lands).
 * @param {number} tabId
 * @param {string} url
 * @returns {Promise<void>}
 */
async function maybeApplyToTab(tabId, url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch (e) {
    return;
  }
  const hosts = await getHosts();
  const entry = hosts[hostname];
  if (!entry || !entry.user) return;
  const tabs = await getTabs();
  if (tabs[tabId] && tabs[tabId].hostname === hostname) return;
  try {
    await addRule(tabId, hostname, entry.user);
    tabs[tabId] = { hostname };
    await sessionSet(PP.SESSION.TABS, tabs);
    chrome.tabs.reload(tabId, { bypassCache: true });
  } catch (e) {}
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id == null || !tab.url) return;
  maybeApplyToTab(tab.id, tab.url);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if (!url) return;
  maybeApplyToTab(tabId, url);
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tabs = await getTabs();
  if (!tabs[tabId]) return;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] }).catch(() => {});
  delete tabs[tabId];
  await sessionSet(PP.SESSION.TABS, tabs);
});

/* --- Message API ------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message && message.type) {
        case PP.MSG.IMP_START: {
          const tabId = sender && sender.tab ? sender.tab.id : null;
          await startImpersonation(message.hostname, message.user, tabId);
          sendResponse({ ok: true });
          break;
        }
        case PP.MSG.IMP_STOP:
          await stopImpersonation(message.hostname);
          sendResponse({ ok: true });
          break;
        case PP.MSG.IMP_STATUS:
          sendResponse({ ok: true, impersonation: await getStatus(message.hostname) });
          break;
        case PP.MSG.RELOAD_TAB: {
          const tabId = sender && sender.tab ? sender.tab.id : null;
          if (tabId != null) chrome.tabs.reload(tabId, { bypassCache: true });
          sendResponse({ ok: true });
          break;
        }
        case PP.MSG.OPEN_OPTIONS:
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        case PP.MSG.IMP_RULES: {
          const rules = await chrome.declarativeNetRequest.getSessionRules();
          sendResponse({
            ok: true,
            rules: rules.map((r) => ({ id: r.id, action: r.action, condition: r.condition })),
            hosts: await getHosts(),
            tabs: await getTabs()
          });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message." });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
    }
  })();
  return true; // keep the channel open for the async response
});

/* --- Lifecycle cleanup ------------------------------------------------ */

/**
 * Session rules and storage.session are cleared by the browser on restart;
 * clear any leftovers on install/update so a stale CallerObjectId can never
 * leak into normal browsing.
 */
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const ids = rules.map((rule) => rule.id);
    if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  } catch (e) {}
  await chrome.storage.session.remove([PP.SESSION.HOSTS, PP.SESSION.TABS]).catch(() => {});
});

/* --- Toolbar action --------------------------------------------------- */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: PP.MSG.PANE_TOGGLE });
  } catch (e) {
    /* No content script on this page; nothing to toggle. */
  }
});
