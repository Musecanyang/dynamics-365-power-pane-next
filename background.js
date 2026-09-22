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
 * Rule-id namespacing
 * -------------------
 * DeclarativeNetRequest session-rule ids and Chrome tab ids share a single
 * integer namespace. To support impersonating *multiple* environments at once
 * (and to never collide with a real tab id), every rule id is derived
 * deterministically rather than reused from a fixed pool:
 *   - TAB rules  -> TAB_RULE_ID_OFFSET + tabId
 *   - HOST/SW    -> a per-host band computed from a hash of the hostname
 * This fixes the previous design where two hosts would overwrite each other's
 * single shared HOST/SW rule.
 *
 * All cross-file constants come from src/constants.js (imported below).
 */

importScripts("./src/constants.js");

const PP = self.PP;

/* --- Rule-id namespacing ------------------------------------------------ */

/** Tab rules live in a high band so they can never clash with a tab id. */
const TAB_RULE_ID_OFFSET = 1000000;
/** Host/SW rules start in a band above the tab band. */
const HOST_RULE_ID_BAND_BASE = 1001000;
/** Size of the host/SW band (two ids are consumed per host). */
const HOST_RULE_ID_BAND_SIZE = 100000;

/**
 * Deterministic rule-id band base for a hostname. Two ids are reserved per
 * host: `base` (HOST rule) and `base + 1` (SW rule). Collisions between two
 * different hostnames are astronomically unlikely for a real-world set of
 * environments.
 * @param {string} hostname
 * @returns {number}
 */
function hostRuleBase(hostname) {
  let hash = 0;
  for (let i = 0; i < hostname.length; i++) {
    hash = (hash * 31 + hostname.charCodeAt(i)) >>> 0;
  }
  return HOST_RULE_ID_BAND_BASE + (hash % HOST_RULE_ID_BAND_SIZE);
}

/**
 * Rule id for the per-tab rule of a tab.
 * @param {number} tabId
 * @returns {number}
 */
function tabRuleId(tabId) {
  return TAB_RULE_ID_OFFSET + tabId;
}

/* --- Logging ------------------------------------------------------------ */

/** Best-effort debug logging; never throws, even if console is unavailable. */
function logDebug() {
  try {
    console.debug.apply(console, ["[Power Pane]"].concat(Array.prototype.slice.call(arguments)));
  } catch (e) {
    /* ignore */
  }
}

/* --- Session state helpers ---------------------------------------------- */

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

/**
 * @returns {Promise<Object<string, {user: Object, startedAt: number, ruleIds: number[]}>>}
 */
function getHosts() {
  return sessionGet(PP.SESSION.HOSTS, {});
}

/**
 * @returns {Promise<Object<number, {hostname: string, ruleId: number}>>}
 */
function getTabs() {
  return sessionGet(PP.SESSION.TABS, {});
}

/* --- DeclarativeNetRequest rule management ------------------------------ */

/**
 * Build the request-headers action and shared URL condition for a host.
 * @param {string} hostname
 * @param {{azureactivedirectoryobjectid: string, systemuserid?: string}} impUser
 * @returns {{action: Object, baseCondition: Object}}
 */
function buildRuleAction(hostname, impUser) {
  const requestHeaders = [
    { header: "CallerObjectId", operation: "set", value: impUser.azureactivedirectoryobjectid }
  ];
  if (impUser.systemuserid) {
    requestHeaders.push({ header: "MSCRMCallerID", operation: "set", value: impUser.systemuserid });
  }
  return {
    action: { type: "modifyHeaders", requestHeaders: requestHeaders },
    baseCondition: { urlFilter: `||${hostname}/` }
  };
}

/**
 * Assemble the three rules (host, service-worker and optionally tab) for one
 * environment, keyed by the namespaced ids described above.
 * @param {string} hostname
 * @param {{azureactivedirectoryobjectid: string, systemuserid?: string}} impUser
 * @param {number|null} tabId
 * @returns {Object[]} the rules to add
 */
function buildRulesForHost(hostname, impUser, tabId) {
  const { action, baseCondition } = buildRuleAction(hostname, impUser);
  const base = hostRuleBase(hostname);

  const hostWideRule = {
    id: base,
    priority: 1,
    action: action,
    condition: Object.assign({}, baseCondition, { requestDomains: [hostname] })
  };
  const serviceWorkerRule = {
    id: base + 1,
    priority: 1,
    action: action,
    condition: Object.assign({}, baseCondition, { tabIds: [-1] })
  };
  const tabRule =
    tabId != null
      ? {
          id: tabRuleId(tabId),
          priority: 1,
          action: action,
          condition: Object.assign({}, baseCondition, { tabIds: [tabId] })
        }
      : null;

  const rules = [hostWideRule, serviceWorkerRule];
  if (tabRule) rules.push(tabRule);
  return rules;
}

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
async function addRulesForHost(tabId, hostname, impUser) {
  const allRules = buildRulesForHost(hostname, impUser, tabId);
  const hostAndSwRules = allRules.slice(0, 2);
  const tabOnlyRules = allRules.slice(2);

  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [], addRules: allRules });
  } catch (e) {
    // Fallback: drop the host-wide rule and retry without it. updateSessionRules
    // replaces rules by id, so re-adding the tab/SW rules is idempotent.
    logDebug("Host-wide rule rejected, retrying without it.", e);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [],
      addRules: hostAndSwRules.slice(1).concat(tabOnlyRules)
    });
  }
}

/**
 * Remove every rule associated with an environment host (host-wide, SW and all
 * of its tab rules) without touching any other host's rules.
 * @param {string} hostname
 * @returns {Promise<void>}
 */
async function removeRulesForHost(hostname) {
  const tabs = await getTabs();
  const base = hostRuleBase(hostname);
  const ruleIds = [base, base + 1];

  Object.keys(tabs).forEach((tabId) => {
    if (tabs[tabId] && tabs[tabId].hostname === hostname) {
      ruleIds.push(tabs[tabId].ruleId);
      delete tabs[tabId];
    }
  });

  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds }).catch((e) => {
    logDebug("Failed to remove rules for host " + hostname, e);
  });
  await sessionSet(PP.SESSION.TABS, tabs);
}

/* --- Impersonation lifecycle -------------------------------------------- */

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
    await addRulesForHost(tabId, hostname, user);
    const tabs = await getTabs();
    tabs[tabId] = { hostname: hostname, ruleId: tabRuleId(tabId) };
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
    startedAt: Date.now(),
    ruleIds: [hostRuleBase(hostname), hostRuleBase(hostname) + 1]
  };
  await sessionSet(PP.SESSION.HOSTS, hosts);
}

/**
 * Stop impersonating on a host and remove all of its rules.
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

/* --- New-tab propagation ------------------------------------------------ */

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
    await addRulesForHost(tabId, hostname, entry.user);
    tabs[tabId] = { hostname: hostname, ruleId: tabRuleId(tabId) };
    await sessionSet(PP.SESSION.TABS, tabs);
    chrome.tabs.reload(tabId, { bypassCache: true });
  } catch (e) {
    logDebug("Failed to apply impersonation to tab " + tabId, e);
  }
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
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [tabs[tabId].ruleId] })
    .catch((e) => logDebug("Failed to remove tab rule for " + tabId, e));
  delete tabs[tabId];
  await sessionSet(PP.SESSION.TABS, tabs);
});

/* --- Message API -------------------------------------------------------- */

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

/* --- Lifecycle cleanup -------------------------------------------------- */

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
  } catch (e) {
    logDebug("Failed to clear session rules on install/update.", e);
  }
  await chrome.storage.session
    .remove([PP.SESSION.HOSTS, PP.SESSION.TABS])
    .catch((e) => logDebug("Failed to clear session storage on install/update.", e));
});

/* --- Toolbar action ----------------------------------------------------- */

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: PP.MSG.PANE_TOGGLE });
  } catch (e) {
    /* No content script on this page; nothing to toggle. */
  }
});
