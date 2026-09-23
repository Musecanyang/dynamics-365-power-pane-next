/**
 * Dynamics 365 Power Pane Next - feature: Impersonation.
 *
 * User search with pinned / recent lists, real impersonation (via the
 * service worker's declarativeNetRequest session), the DNR debug dialog and
 * the "Advanced Settings - Users" auto-navigation helper.
 *
 * Shared surface: window.PPPane (content/core.js). Globals: window.PP.
 * Loaded by the manifest after content/core.js and before content/boot.js.
 */
(function (Pane) {
  "use strict";
  const PP = window.PP;
  const PPUtil = window.PPUtil;
  const el = window.PPUtil.el;
  const {
    state,
    send,
    bgSend,
    openModal,
    showOutput,
    toast,
    renderImpersonation,
    registerLocal,
    onMount,
    localGet,
    localSet,
    RECENT_USERS_LIMIT,
    RELOAD_DELAY_MS,
    MIN_USER_SEARCH_LENGTH,
    USER_SEARCH_DEBOUNCE_MS
  } = Pane;

  /**
   * Dispatch a full pointer/mouse/click sequence - D365's React-based
   * command bar ignores plain `.click()` in some cases, so a realistic
   * interaction is replayed instead.
   * @param {HTMLElement} element
   */
  function realClick(element) {
    try {
      const opts = { bubbles: true, cancelable: true, view: window };
      element.dispatchEvent(new PointerEvent("pointerdown", opts));
      element.dispatchEvent(new MouseEvent("mousedown", opts));
      element.dispatchEvent(new PointerEvent("pointerup", opts));
      element.dispatchEvent(new MouseEvent("mouseup", opts));
      element.dispatchEvent(new MouseEvent("click", opts));
    } catch (e) {
      try {
        element.click();
      } catch (e2) {
        PPUtil.debugLog("impersonation.realClick", e2);
      }
    }
  }

  // Auto-navigate classic Advanced Settings to Security > Users when opened via
  // the "Advanced Settings - Users" action (flagged in extension storage).
  function autoOpenUsers() {
    const byName = window.name === PP.LOCAL.AUTO_OPEN_USERS;
    localGet(PP.LOCAL.AUTO_OPEN_USERS, 0).then(function (timestamp) {
      const byStore = timestamp && Date.now() - timestamp < 120000;
      if (!byName && !byStore) return;
      if (byName) {
        try {
          window.name = "";
        } catch (e) {
          PPUtil.debugLog("impersonation.autoNav", e);
        }
      }
      localSet(PP.LOCAL.AUTO_OPEN_USERS, 0);
      let step = 0;
      let tries = 0;
      const timer = setInterval(function () {
        tries++;
        if (tries > 90) {
          clearInterval(timer);
          return;
        }
        const labels = [].slice.call(document.querySelectorAll('button,[role="button"],a,span'));
        if (step === 0) {
          const settingsTab = document.getElementById("TabSettings-main");
          const area =
            settingsTab ||
            labels.filter(function (node) {
              const lab =
                (node.getAttribute("aria-label") || "") +
                " " +
                (node.getAttribute("title") || "") +
                " " +
                (node.textContent || "");
              return /settings area/i.test(lab) || /settings.*go to/i.test(lab);
            })[0];
          if (area) {
            realClick(area);
            step = 1;
          }
        } else if (step === 1) {
          const security = labels.filter(function (node) {
            return (node.textContent || "").trim() === "Security" && node.offsetParent !== null;
          })[0];
          if (security) {
            realClick(security);
            step = 2;
          }
        } else if (step === 2) {
          let doc = document;
          try {
            const frame = document.getElementById("contentIFrame0");
            if (frame && frame.contentDocument) doc = frame.contentDocument;
          } catch (e) {
            PPUtil.debugLog("impersonation.frameAccess", e);
            /* cross-origin frame */
          }
          const users = [].slice.call(doc.querySelectorAll("a,span,td,div")).filter(function (node) {
            return (node.textContent || "").trim() === "Users" && node.offsetParent !== null;
          })[0];
          if (users) {
            realClick(users);
            clearInterval(timer);
          }
        }
      }, 800);
    });
  }

  /* ------------------------------------------------------------------ *
   * Feature: impersonation
   * ------------------------------------------------------------------ */

  /** Resolve after `ms` milliseconds. */
  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /** Query the service worker for the active impersonation on this host. */
  function refreshImpersonation() {
    return bgSend({ type: PP.MSG.IMP_STATUS, hostname: location.hostname })
      .then(function (response) {
        renderImpersonation(response.impersonation);
        return response.impersonation;
      })
      .catch(function (error) {
        PPUtil.debugLog("impersonation.status", error);
        /* service worker unreachable - degrade to "no impersonation" */
        return null;
      });
  }

  function openImpersonate() {
    refreshImpersonation().then(buildImpersonateModal);
  }

  /**
   * Drop the cached identity key so a bypass-cache reload rebuilds it.
   * NOTE: intentionally does NOT wipe Cache Storage / IndexedDB - doing so
   * corrupts the D365 client's local store and leaves it stuck on "Loading...".
   * @returns {Promise<void>}
   */
  function clearIdentityCaches() {
    try {
      localStorage.removeItem("Microsoft.Crm.BusinessProcessClientCache");
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (/^Form:(userquery|savedquery)$/i.test(key) || /savedquery|viewcache/i.test(key)) {
          localStorage.removeItem(key);
        }
      }
    } catch (e) {
      PPUtil.debugLog("impersonation.cacheClear", e);
      /* localStorage unavailable; nothing to clear */
    }
    return Promise.resolve();
  }

  /** Start impersonation, clear caches, then reload the tab. */
  async function applyImpersonation(user) {
    await bgSend({ type: PP.MSG.IMP_START, hostname: location.hostname, user: user });
    renderImpersonation({ user: user });
    addRecent(user);
    await clearIdentityCaches();
    await delay(RELOAD_DELAY_MS);
    await bgSend({ type: PP.MSG.RELOAD_TAB });
    toast("Impersonating " + (user.fullname || "user") + ". Reloading...", "success");
  }

  function startImpersonate(user) {
    if (!user.azureactivedirectoryobjectid) {
      toast("User has no Azure AD object id; cannot impersonate.", "error");
      return;
    }
    applyImpersonation(user).catch(function (err) {
      toast(err.message, "error");
    });
  }

  /** Stop impersonation, clear caches, then reload the tab. */
  async function stopImpersonate() {
    try {
      await bgSend({ type: PP.MSG.IMP_STOP, hostname: location.hostname });
      renderImpersonation(null);
      await clearIdentityCaches();
      await delay(RELOAD_DELAY_MS);
      await bgSend({ type: PP.MSG.RELOAD_TAB });
      toast("Impersonation stopped. Reloading...", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  /** Show the active declarativeNetRequest rules + cached state (debug). */
  function openDnrRules() {
    bgSend({ type: PP.MSG.IMP_RULES })
      .then(function (response) {
        const rules = (response && response.rules) || [];
        showOutput({
          title: "Impersonation Debug",
          description: rules.length + " session rule(s)",
          items: [
            { label: "Rules", value: JSON.stringify(rules, null, 2) },
            { label: "Hosts", value: JSON.stringify((response && response.hosts) || {}, null, 2) },
            { label: "Tabs", value: JSON.stringify((response && response.tabs) || {}, null, 2) }
          ]
        });
      })
      .catch(function (err) {
        toast(err.message, "error");
      });
  }

  /** Shrink a user object to the fields we persist in recent/pinned lists. */
  function slimUser(user) {
    return {
      systemuserid: user.systemuserid,
      fullname: user.fullname,
      internalemailaddress: user.internalemailaddress,
      domainname: user.domainname,
      azureactivedirectoryobjectid: user.azureactivedirectoryobjectid
    };
  }

  function isPinned(user) {
    const id = user && user.systemuserid;
    return !!id && state.pinned.some(function (pinned) {
      return pinned.systemuserid === id;
    });
  }

  function togglePin(user) {
    if (!user || !user.systemuserid) return;
    if (isPinned(user)) {
      state.pinned = state.pinned.filter(function (pinned) {
        return pinned.systemuserid !== user.systemuserid;
      });
    } else {
      state.pinned = state.pinned.concat([slimUser(user)]);
    }
    localSet(PP.LOCAL.PINNED_USERS, state.pinned);
  }

  function addRecent(user) {
    if (!user || !user.systemuserid) return;
    state.recent = [slimUser(user)]
      .concat(
        state.recent.filter(function (recent) {
          return recent.systemuserid !== user.systemuserid;
        })
      )
      .slice(0, RECENT_USERS_LIMIT);
    localSet(PP.LOCAL.RECENT_USERS, state.recent);
  }

  /** Build a single user row (meta + pin + impersonate) via PPUtil.userRow. */
  function userRow(user, onPinChanged) {
    return window.PPUtil.userRow(user, [
      {
        label: isPinned(user) ? "\u2605" : "\u2606",
        title: isPinned(user) ? "Unpin" : "Pin",
        onClick: function () {
          togglePin(user);
          if (onPinChanged) onPinChanged();
        }
      },
      {
        label: "Impersonate",
        className: "mini primary",
        onClick: function () {
          startImpersonate(user);
        }
      }
    ]);
  }

  function buildImpersonateModal() {
    openModal(function (box, close) {
      box.appendChild(el("h3", { text: "Impersonate User" }));
      box.appendChild(el("p", {
        className: "desc",
        text: "Search by name, email or domain. Requires prvActOnBehalfOfAnotherUser."
      }));

      if (state.impersonation && state.impersonation.user) {
        const bar = el("div", { className: "impbar" });
        bar.appendChild(el("span", { className: "nm", text: "Active: " + state.impersonation.user.fullname }));
        bar.appendChild(el("button", { className: "mini", text: "Stop", onClick: stopImpersonate }));
        box.appendChild(bar);
      }

      const quick = el("div");
      box.appendChild(quick);

      const search = el("input", {
        className: "filter",
        placeholder: "Name, email or domain (min 2 chars)"
      });
      box.appendChild(search);

      const results = el("div");
      box.appendChild(results);

      function renderQuick() {
        quick.textContent = "";
        if (state.pinned.length) {
          quick.appendChild(el("div", { className: "sect", text: "Pinned" }));
          state.pinned.forEach(function (user) {
            quick.appendChild(userRow(user, renderQuick));
          });
        }
        const recentOnly = state.recent.filter(function (user) {
          return !isPinned(user);
        });
        if (recentOnly.length) {
          quick.appendChild(el("div", { className: "sect", text: "Recent" }));
          recentOnly.forEach(function (user) {
            quick.appendChild(userRow(user, renderQuick));
          });
        }
      }
      renderQuick();

      let timer = null;
      function doSearch() {
        const query = search.value.trim();
        if (query.length < MIN_USER_SEARCH_LENGTH) {
          results.textContent = "";
          return;
        }
        results.textContent = "";
        results.appendChild(el("div", { className: "muted", text: "Searching..." }));

        send("searchUsers", { query: query })
          .then(function (response) {
            const users = (response && response.users) || [];
            results.textContent = "";
            results.appendChild(el("div", { className: "sect", text: "Search Results" }));
            if (!users.length) {
              results.appendChild(el("div", { className: "empty", text: "No users found." }));
              return;
            }
            users.forEach(function (user) {
              results.appendChild(userRow(user, function () {}));
            });
          })
          .catch(function (err) {
            results.textContent = "";
            results.appendChild(el("div", { className: "empty", text: err.message }));
          });
      }
      search.addEventListener("input", function () {
        clearTimeout(timer);
        timer = setTimeout(doSearch, USER_SEARCH_DEBOUNCE_MS);
      });

      const foot = el("div", { className: "foot" });
      foot.appendChild(el("button", { text: "Close", onClick: close }));
      box.appendChild(foot);
    });
  }

  registerLocal("impersonate", openImpersonate);
  registerLocal("impersonateStop", stopImpersonate);
  registerLocal("dnrRules", openDnrRules);
  // Mount hook: wires the "Advanced Settings - Users" auto-navigation and the
  // active-impersonation refresh into the pane's post-mount tasks.
  onMount(refreshImpersonation);
  onMount(autoOpenUsers);

})(window.PPPane);
