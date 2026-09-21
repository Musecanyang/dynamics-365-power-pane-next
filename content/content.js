/**
 * Dynamics 365 Power Pane Next - in-page UI (isolated world content script).
 *
 * Responsibilities:
 *   - Render the action pane (Shadow DOM so host page styles never leak in).
 *   - Persist/apply user preferences (visibility, order, theme, shortcuts).
 *   - Forward action commands to the MAIN-world bridge and render results.
 *   - Own the bridge plumbing (request/response with a nonce id) and the shared
 *     UI primitives (modals, toasts, output/table renderers, storage wrappers).
 *   - Host the self-contained feature editors: impersonation, user permissions
 *     and FetchXML snippets.
 *
 * Dependencies: src/constants.js (PP), src/actions.js (POWER_PANE_ACTIONS).
 * The MAIN-world bridge is content/main-world.js.
 */
(function () {
  "use strict";
  if (window.__ppNextUiLoaded) return;
  window.__ppNextUiLoaded = true;

  var PP = window.PP;
  var ACTIONS = window.POWER_PANE_ACTIONS || [];

  /* --- Tunables (named to avoid magic numbers) -------------------------- */
  var BRIDGE_TIMEOUT_MS = 30000;
  var TOAST_DURATION_MS = 5000;
  var ENTITY_SEARCH_DEBOUNCE_MS = 250;
  var LONG_VALUE_THRESHOLD = 400;
  var ORDER_UNSET_INDEX = 9999;
  /** Minimum characters before a user search fires. */
  var MIN_USER_SEARCH_LENGTH = 2;
  /** Debounce for the user search inputs. */
  var USER_SEARCH_DEBOUNCE_MS = 350;
  /** Number of recent users retained. */
  var RECENT_USERS_LIMIT = 3;
  /** Delay before reloading after applying/clearing the impersonated identity. */
  var RELOAD_DELAY_MS = 300;
  /** Cap on user search results shown in the permissions editor. */
  var USER_SEARCH_RESULT_LIMIT = 15;
  /** Cap on teams listed in the "add team" picker. */
  var TEAM_LIST_LIMIT = 200;

  /** Group header colour by group name; unknown groups fall back to accent. */
  var GROUP_COLORS = {
    General: "#3a63ff",
    Impersonation: "#f59e0b",
    Record: "#22c55e",
    Form: "#a855f7",
    Navigation: "#06b6d4",
    Debug: "#ef4444",
    Admin: "#64748b"
  };

  function groupColor(name) {
    return GROUP_COLORS[name] || "#3a63ff";
  }

  /** Shared mutable UI state (read/written by the feature sections below). */
  var state = {
    settings: {},
    theme: PP.THEME.DARK,
    layout: null,
    shortcuts: {},
    snippets: [],
    impersonation: null,
    recent: [],
    pinned: [],
    order: []
  };

  /* ------------------------------------------------------------------ *
   * Bridge (isolated world <-> MAIN world)
   * ------------------------------------------------------------------ */

  var pending = new Map();

  /**
   * Generate an unpredictable message id. Used as the bridge correlation id so
   * that a response can only resolve the request that carries the same id.
   * @returns {string}
   */
  function newMessageId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    if (window.crypto && window.crypto.getRandomValues) {
      var bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      return Array.prototype.map.call(bytes, function (b) {
        return ("0" + b.toString(16)).slice(-2);
      }).join("");
    }
    return "pp-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  window.addEventListener("message", function (event) {
    // Accept only responses from this same window (and same origin) that carry
    // our bridge marker and a pending id. Never trust the page's data.
    if (event.source !== window) return;
    if (event.origin && event.origin !== location.origin) return;
    var message = event.data;
    if (!message || message[PP.BRIDGE.KEY] !== PP.BRIDGE.RESPONSE) return;
    if (typeof message.id !== "string") return;

    var entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error || "Action failed"));
  });

  /**
   * Send a command to the MAIN-world bridge and resolve/reject with its result.
   * @param {string} command
   * @param {Object} [args]
   * @returns {Promise<Object>}
   */
  function send(command, args) {
    return new Promise(function (resolve, reject) {
      var id = newMessageId();
      var timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error("Timed out waiting for the page."));
      }, BRIDGE_TIMEOUT_MS);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      window.postMessage(
        { [PP.BRIDGE.KEY]: PP.BRIDGE.REQUEST, id: id, command: command, args: args || {} },
        "*"
      );
    });
  }

  /**
   * Send a message to the service worker and resolve with its (ok:true) reply.
   * @param {Object} message
   * @returns {Promise<Object>}
   */
  function bgSend(message) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response || !response.ok) {
            reject(new Error((response && response.error) || "Background request failed."));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Storage wrappers (Promise-based, never throw)
   * ------------------------------------------------------------------ */

  function syncGet(defaults) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.get(defaults, resolve);
      } catch (e) {
        resolve(defaults);
      }
    });
  }
  function syncSet(obj) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.set(obj, resolve);
      } catch (e) {
        resolve();
      }
    });
  }
  function localGet(key, fallback) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get({ [key]: fallback }, function (data) {
          resolve(data[key]);
        });
      } catch (e) {
        resolve(fallback);
      }
    });
  }
  function localSet(key, value) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.set({ [key]: value }, resolve);
      } catch (e) {
        resolve();
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Clipboard
   * ------------------------------------------------------------------ */

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.cssText = "position:fixed;top:-9999px;left:-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } catch (e) {
      /* copy failed; ignore */
    }
    textarea.remove();
  }

  /* ------------------------------------------------------------------ *
   * Styles + DOM scaffold (Shadow DOM)
   * ------------------------------------------------------------------ */

  var CSS = [
    ":host{all:initial}",
    ".pp{--bg:#171a21;--fg:#e6e8ee;--sub:#8b93a7;--bd:#2c313c;--hover:#232836;--field:#0f1218;--accent:#3a63ff;--scroll:rgba(139,147,167,.34);--scroll-hover:rgba(139,147,167,.58)}",
    ".pp.light{--bg:#ffffff;--fg:#1c1f26;--sub:#6b7280;--bd:#e5e7eb;--hover:#f3f4f6;--field:#ffffff;--accent:#3a63ff;--scroll:rgba(107,114,128,.38);--scroll-hover:rgba(107,114,128,.62)}",
    ".pp *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    // Scrollbars: the pane lives in a shadow root and the native Windows
    // scrollbar (bright track + grey thumb) clashes with the dark chrome. Both
    // syntaxes below are needed - Chrome 121+ uses the standard properties,
    // older engines fall back to the plain ::-webkit-scrollbar pseudo-elements.
    ".pp *{scrollbar-width:thin;scrollbar-color:var(--scroll) transparent}",
    ".pp ::-webkit-scrollbar{width:10px;height:10px}",
    ".pp ::-webkit-scrollbar-track{background:transparent}",
    ".pp ::-webkit-scrollbar-thumb{background:var(--scroll);border-radius:6px}",
    ".pp ::-webkit-scrollbar-thumb:hover{background:var(--scroll-hover)}",
    ".pp ::-webkit-scrollbar-corner{background:transparent}",
    ".pp .btn{position:fixed;top:50px;left:10px;z-index:2147483646;width:34px;height:34px;border-radius:8px;border:none;cursor:pointer;background:transparent;color:var(--accent);box-shadow:none;display:flex;align-items:center;justify-content:center;opacity:.95}",
    ".pp .btn:hover{background:rgba(127,127,127,.15);opacity:1}",
    ".pp .btn:focus{outline:none}",
    ".pp .btn svg{width:26px;height:26px}",
    ".pp .panel{position:fixed;top:42px;left:8px;right:8px;z-index:2147483646;width:auto;max-width:calc(100vw - 16px);height:auto;max-height:72vh;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.45);overflow:hidden;resize:vertical;transform-origin:top center}",
    ".pp .panel.hidden{display:none}",
    ".pp .panel.opening{animation:pp-open .16s ease-out}",
    "@keyframes pp-open{from{opacity:0;transform:translateY(-12px)}to{opacity:1;transform:translateY(0)}}",
    ".pp .hd{display:flex;align-items:center;gap:6px;padding:6px 9px;border-bottom:1px solid var(--bd);cursor:move;user-select:none}",
    ".pp .hd b{font-size:12px;letter-spacing:.02em}",
    ".pp .hd .sp{flex:1}",
    ".pp .hd button{background:none;border:none;color:var(--fg);opacity:.65;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;border-radius:6px}",
    ".pp .hd button:hover{opacity:1;background:var(--hover)}",
    ".pp .search{margin:6px 8px;display:flex}",
    ".pp .search input{flex:1;background:var(--field);border:1px solid var(--bd);color:var(--fg);border-radius:6px;padding:5px 8px;font-size:11.5px;outline:none}",
    ".pp .search input:focus{border-color:var(--accent)}",
    ".pp .list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:row;align-items:stretch;padding:0 2px 6px}",
    ".pp .grp{display:flex;flex-direction:column;flex:0 0 auto;min-width:152px;max-width:230px;padding:0 7px;border-right:1px solid var(--bd)}",
    ".pp .grp:last-child{border-right:none}",
    ".pp .grp h4{position:sticky;top:0;background:var(--bg);margin:6px 2px 4px;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--sub);font-weight:700}",
    ".pp .item{display:flex;align-items:center;gap:7px;width:100%;text-align:left;background:transparent;border:none;color:var(--fg);padding:4px 7px;border-radius:5px;font-size:11.5px;line-height:1.3;white-space:nowrap;cursor:pointer}",
    ".pp .item:hover,.pp .item.active{background:var(--hover)}",
    ".pp .item:disabled{opacity:.5;cursor:default}",
    ".pp .item .dot{width:7px;height:7px;border-radius:2px;flex:none}",
    ".pp .toast{position:fixed;right:18px;bottom:74px;z-index:2147483647;max-width:300px;background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-left:3px solid var(--accent);border-radius:8px;padding:9px 11px;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.4)}",
    ".pp .toast.success{border-left-color:#22c55e}",
    ".pp .toast.error{border-left-color:#ef4444}",
    ".pp .toast.warning{border-left-color:#f59e0b}",
    ".pp .modal{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center}",
    ".pp .modal .box{width:430px;max-width:92vw;max-height:84vh;overflow:auto;background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.5);padding:14px}",
    ".pp .modal .box.wide{width:auto;min-width:min(680px,94vw);max-width:min(1080px,94vw)}",
    ".pp .modal .box{position:relative}",
    ".pp .modalctl{position:absolute;top:5px;right:7px;display:flex;gap:4px;z-index:6;cursor:move}",
    ".pp .modalctl button{border:1px solid var(--bd);background:var(--hover);color:var(--fg);border-radius:6px;font-size:10.5px;padding:2px 7px;cursor:pointer}",
    ".pp .modalctl button:hover{filter:brightness(1.15)}",
    ".pp .modal.popped{background:transparent;pointer-events:none;display:block}",
    ".pp .modal.popped .box{pointer-events:auto;position:fixed;margin:0;max-height:82vh;overflow:auto}",
    ".pp .modal h3{margin:0 0 4px;font-size:13px}",
    ".pp .modal p.desc{margin:0 0 10px;font-size:11.5px;color:var(--sub)}",
    ".pp .field{margin-bottom:9px;display:flex;flex-direction:column;gap:4px}",
    ".pp .field label{font-size:11.5px;color:var(--sub)}",
    ".pp .field input,.pp .field textarea,.pp .modal input.filter{background:var(--field);border:1px solid var(--bd);color:var(--fg);border-radius:8px;padding:7px 9px;font-size:12px;outline:none;font-family:inherit}",
    ".pp .field textarea{min-height:150px;resize:vertical;font-family:ui-monospace,Consolas,monospace}",
    ".pp .field input:focus,.pp .field textarea:focus,.pp .modal input.filter:focus{border-color:var(--accent)}",
    ".pp input.filter{width:100%;margin-bottom:8px}",
    ".pp table{border-collapse:collapse;width:100%;font-size:11.5px}",
    ".pp td.grouphead{background:var(--hover);font-weight:700;color:var(--fg);padding:6px 8px;border-bottom:1px solid var(--bd)}",
    ".pp th{position:sticky;top:0;background:var(--bg);text-align:left;color:var(--sub);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--bd);white-space:nowrap}",
    ".pp td{padding:5px 8px;border-bottom:1px solid var(--bd);vertical-align:top;word-break:break-word}",
    ".pp td.col-logical,.pp td.col-type,.pp td.col-entity{white-space:nowrap}",
    // Table cells wrap their text in a `.cell` span (see `showTable`) so a
    // column can cap its own width - `max-width` on the `td` itself is ignored
    // by `table-layout:auto` tables.
    ".pp td .cell{display:inline-block;vertical-align:top}",
    ".pp td .cell.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".pp tr:hover td{background:var(--hover)}",
    ".pp td.copy{cursor:pointer}",
    ".pp td.copy:hover{color:var(--accent)}",
    ".pp .out{margin-bottom:9px}",
    ".pp .out .k{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--sub);margin-bottom:2px}",
    ".pp .out .k .cp{cursor:pointer;opacity:.6;font-size:10.5px;border:1px solid var(--bd);border-radius:5px;padding:0 5px}",
    ".pp .out .k .cp:hover{opacity:1}",
    ".pp .out .v{font-size:12.5px;word-break:break-all;white-space:pre-wrap}",
    ".pp .out .v pre{margin:0;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;white-space:pre-wrap}",
    ".pp .chip{display:inline-block;background:var(--hover);border:1px solid var(--bd);border-radius:999px;padding:2px 8px;margin:2px 4px 2px 0;font-size:11.5px}",
    ".pp .foot{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}",
    ".pp .foot.split{justify-content:space-between}",
    ".pp .foot button,.pp .actions button,.pp .mini{border:1px solid var(--bd);background:var(--hover);color:var(--fg);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer}",
    ".pp .foot button.primary,.pp .actions button.primary{background:var(--accent);border-color:var(--accent);color:#fff}",
    ".pp .actions{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:2px 0 10px}",
    ".pp .actions-buttons{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
    ".pp .mini{padding:2px 8px;font-size:11px;border-radius:6px}",
    ".pp .srow{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--bd)}",
    ".pp .srow .nm{flex:1;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".pp .muted{color:var(--sub);font-size:11.5px}",
    ".pp .empty{padding:16px;color:var(--sub);font-size:12px;text-align:center}",
    ".pp .imp-pill{display:inline-flex;align-items:center;font-size:10.5px;background:rgba(245,158,11,.13);color:#f59e0b;border:1px solid rgba(245,158,11,.35);border-radius:999px;padding:1px 7px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".pp .imp-pill[hidden]{display:none}",
    ".pp .btn.imp{color:#f59e0b;background:transparent;box-shadow:none}",
    ".pp .user{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--bd)}",
    ".pp .user .meta{flex:1;min-width:0}",
    ".pp .user .nm{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".pp .user .em{font-size:11px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".pp .impbar{display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:10px;border:1px solid rgba(245,158,11,.35);background:rgba(245,158,11,.08);border-radius:8px;font-size:11.5px}",
    ".pp .impbar .nm{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".pp .deeprow{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--sub);margin:0 0 10px}",
    ".pp .sect{margin:10px 0 2px;font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--sub);font-weight:700}",
    ".pp .entity-results{max-height:170px;overflow:auto;margin-top:4px;border:1px solid var(--bd);border-radius:8px;display:flex;flex-direction:column}",
    ".pp .entity-results:empty{display:none}",
    ".pp .entity-opt{display:flex;justify-content:space-between;gap:8px;background:transparent;border:none;border-bottom:1px solid var(--bd);color:var(--fg);padding:5px 8px;font-size:11.5px;cursor:pointer;text-align:left}",
    ".pp .entity-opt:hover{background:var(--hover)}",
    ".pp .entity-opt .dname{color:var(--sub)}",
    ".pp .ua-head{margin:6px 0 8px;font-size:13px}",
    ".pp .ua-row{display:flex;gap:8px;margin:3px 0}",
    ".pp .ua-k{width:110px;color:var(--sub);font-size:11.5px}",
    ".pp .ua-v{flex:1;font-size:12.5px;word-break:break-all}",
    ".pp .ua-list{max-height:190px;overflow:auto;border:1px solid var(--bd);border-radius:8px;padding:4px 8px;display:flex;flex-direction:column}",
    ".pp .ua-item{display:flex;align-items:center;gap:6px;font-size:12px;padding:2px 0;cursor:pointer}",
    ".pp .ua-chips{margin-bottom:6px}"
  ].join("");

  var host = document.createElement("div");
  host.id = "pp-host";
  var root = host.attachShadow({ mode: "open" });
  var style = document.createElement("style");
  style.textContent = CSS;
  root.appendChild(style);

  var wrap = document.createElement("div");
  wrap.className = "pp";
  root.appendChild(wrap);

  var bolt =
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13l1-8z"/></svg>';

  var toggleBtn = document.createElement("button");
  toggleBtn.className = "btn";
  toggleBtn.title = PP.SHORT_NAME + " (Alt+P)";
  toggleBtn.innerHTML = bolt;

  var panel = document.createElement("div");
  panel.className = "panel hidden";
  panel.innerHTML =
    '<div class="hd"><b>' + PP.SHORT_NAME + '</b><span class="imp-pill" hidden></span><span class="sp"></span>' +
    '<button data-act="theme" title="Toggle theme">&#9788;</button>' +
    '<button data-act="options" title="Options">&#9881;</button>' +
    '<button data-act="close" title="Close">&times;</button></div>' +
    '<div class="search"><input type="text" placeholder="Search actions... (Alt+P)"/></div>' +
    '<div class="list"></div>';

  var toastLayer = document.createElement("div");

  wrap.appendChild(toggleBtn);
  wrap.appendChild(panel);
  wrap.appendChild(toastLayer);

  var listEl = panel.querySelector(".list");
  var searchEl = panel.querySelector(".search input");
  var pill = panel.querySelector(".imp-pill");
  var itemButtons = [];
  var activeIndex = -1;
  var pageBtn = null;

  /* ------------------------------------------------------------------ *
   * Action list rendering
   * ------------------------------------------------------------------ */

  /** Actions that pass the visibility + search filter, in declaration order. */
  function visibleActions() {
    var query = (searchEl.value || "").toLowerCase();
    return ACTIONS.filter(function (action) {
      if (state.settings[action.id] === false) return false;
      if (
        query &&
        action.label.toLowerCase().indexOf(query) === -1 &&
        action.group.toLowerCase().indexOf(query) === -1
      ) {
        return false;
      }
      return true;
    });
  }

  function renderList() {
    var actions = visibleActions();
    listEl.textContent = "";
    itemButtons = [];
    activeIndex = -1;
    if (!actions.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No matching actions.";
      listEl.appendChild(empty);
      return;
    }

    // Group by declaration order.
    var groups = [];
    actions.forEach(function (action) {
      var group = groups.filter(function (candidate) {
        return candidate.name === action.group;
      })[0];
      if (!group) {
        group = { name: action.group, items: [] };
        groups.push(group);
      }
      group.items.push(action);
    });

    groups.forEach(function (group) {
      if (state.order && state.order.length) {
        group.items.sort(function (a, b) {
          var indexA = state.order.indexOf(a.id);
          var indexB = state.order.indexOf(b.id);
          if (indexA === -1) indexA = ORDER_UNSET_INDEX;
          if (indexB === -1) indexB = ORDER_UNSET_INDEX;
          return indexA - indexB;
        });
      }
    });

    groups.forEach(function (group) {
      var block = document.createElement("div");
      block.className = "grp";
      var heading = document.createElement("h4");
      heading.textContent = group.name;
      heading.style.color = groupColor(group.name);
      block.appendChild(heading);

      group.items.forEach(function (action) {
        var button = document.createElement("button");
        button.className = "item";

        var dot = document.createElement("span");
        dot.className = "dot";
        dot.style.background = groupColor(group.name);
        var label = document.createElement("span");
        label.textContent = action.label;
        button.appendChild(dot);
        button.appendChild(label);

        button.addEventListener("click", function () {
          // Close the pane first; any input/output modal is shown independently.
          panel.classList.add("hidden");
          runAction(action, button);
        });
        block.appendChild(button);
        itemButtons.push(button);
      });

      listEl.appendChild(block);
    });
  }

  /** Move the keyboard highlight to item index `i` (wraps around). */
  function setActive(i) {
    if (!itemButtons.length) return;
    activeIndex = (i + itemButtons.length) % itemButtons.length;
    itemButtons.forEach(function (button, idx) {
      button.classList.toggle("active", idx === activeIndex);
    });
    itemButtons[activeIndex].scrollIntoView({ block: "nearest" });
  }

  function openPanel() {
    panel.classList.remove("hidden");
    panel.classList.remove("opening");
    void panel.offsetWidth; // force reflow so the animation restarts
    panel.classList.add("opening");
    renderList();
    searchEl.focus();
  }

  function togglePanel() {
    if (panel.classList.contains("hidden")) openPanel();
    else panel.classList.add("hidden");
  }

  toggleBtn.addEventListener("click", togglePanel);
  panel.querySelector('[data-act="close"]').addEventListener("click", function () {
    panel.classList.add("hidden");
  });
  panel.querySelector('[data-act="theme"]').addEventListener("click", function () {
    setTheme(state.theme === PP.THEME.DARK ? PP.THEME.LIGHT : PP.THEME.DARK, true);
  });
  panel.querySelector('[data-act="options"]').addEventListener("click", function () {
    bgSend({ type: PP.MSG.OPEN_OPTIONS }).catch(function () {
      try {
        chrome.runtime.openOptionsPage();
      } catch (e) {
        /* options page unavailable */
      }
    });
  });
  searchEl.addEventListener("input", renderList);
  searchEl.addEventListener("keydown", function (event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(activeIndex - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0 && itemButtons[activeIndex]) itemButtons[activeIndex].click();
      else if (itemButtons[0]) itemButtons[0].click();
    } else if (event.key === "Escape") {
      panel.classList.add("hidden");
    }
  });

  /* ------------------------------------------------------------------ *
   * Theme
   * ------------------------------------------------------------------ */

  function setTheme(theme, persist) {
    state.theme = theme === PP.THEME.LIGHT ? PP.THEME.LIGHT : PP.THEME.DARK;
    wrap.classList.toggle("light", state.theme === PP.THEME.LIGHT);
    panel.querySelector('[data-act="theme"]').innerHTML =
      state.theme === PP.THEME.LIGHT ? "&#9790;" : "&#9788;";
    if (persist) syncSet({ [PP.SYNC.THEME]: state.theme });
  }

  /* ------------------------------------------------------------------ *
   * Toast
   * ------------------------------------------------------------------ */

  function toast(message, level) {
    var existing = toastLayer.querySelector(".toast");
    if (existing) existing.remove();
    var node = document.createElement("div");
    node.className = "toast " + (level || "info");
    node.textContent = message;
    toastLayer.appendChild(node);
    setTimeout(function () {
      node.remove();
    }, TOAST_DURATION_MS);
  }

  /* ------------------------------------------------------------------ *
   * Modals (pin/pop/drag) + output/table renderers
   * ------------------------------------------------------------------ */

  /**
   * Open a modal and hand its content box to `buildBody`.
   * @param {function(HTMLElement, function): void} buildBody
   * @param {{wide?: boolean}} [opts]
   * @returns {HTMLElement} the modal element
   */
  function openModal(buildBody, opts) {
    opts = opts || {};
    var modal = document.createElement("div");
    modal.className = "modal";
    var box = document.createElement("div");
    box.className = "box" + (opts.wide ? " wide" : "");
    modal.appendChild(box);

    var controls = document.createElement("div");
    controls.className = "modalctl";
    var pinButton = document.createElement("button");
    pinButton.type = "button";
    pinButton.title = "Pin: keep open when clicking outside";
    pinButton.textContent = "Pin";
    var popButton = document.createElement("button");
    popButton.type = "button";
    popButton.title = "Pop out: float over the page without blocking it";
    popButton.textContent = "Pop";
    controls.appendChild(pinButton);
    controls.appendChild(popButton);
    box.appendChild(controls);

    var content = document.createElement("div");
    content.className = "modal-content";
    box.appendChild(content);

    pinButton.addEventListener("click", function () {
      var on = modal.classList.toggle("pinned");
      pinButton.textContent = on ? "Pinned" : "Pin";
    });
    popButton.addEventListener("click", function () {
      var on = modal.classList.toggle("popped");
      popButton.textContent = on ? "Dock" : "Pop";
      if (on) {
        var rect = box.getBoundingClientRect();
        box.style.left = Math.max(8, rect.left) + "px";
        box.style.top = Math.max(8, rect.top) + "px";
      } else {
        box.style.left = "";
        box.style.top = "";
      }
    });

    var drag = null;
    box.addEventListener("mousedown", function (event) {
      if (!modal.classList.contains("popped")) return;
      var tag = (event.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea" || tag === "button" || tag === "a" || tag === "label") {
        return;
      }
      var rect = box.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      event.preventDefault();
    });
    document.addEventListener("mousemove", function (event) {
      if (!drag) return;
      box.style.left = Math.max(0, event.clientX - drag.dx) + "px";
      box.style.top = Math.max(0, event.clientY - drag.dy) + "px";
    });
    document.addEventListener("mouseup", function () {
      drag = null;
    });

    modal.addEventListener("click", function (event) {
      if (
        event.target === modal &&
        !modal.classList.contains("pinned") &&
        !modal.classList.contains("popped")
      ) {
        modal.remove();
      }
    });

    function close() {
      modal.remove();
    }

    buildBody(content, close);
    wrap.appendChild(modal);
    var first = content.querySelector("input,textarea");
    if (first) first.focus();
    return modal;
  }

  /** Render a value as a chip list / <pre> / plain text node. */
  function valueNode(value) {
    var container = document.createElement("div");
    container.className = "v";
    if (Array.isArray(value)) {
      if (!value.length) {
        container.textContent = "(none)";
      } else {
        value.forEach(function (item) {
          var chip = document.createElement("span");
          chip.className = "chip";
          chip.textContent = item;
          container.appendChild(chip);
        });
      }
    } else if (typeof value === "string" && value.length > LONG_VALUE_THRESHOLD) {
      var pre = document.createElement("pre");
      pre.textContent = value;
      container.appendChild(pre);
    } else {
      container.textContent = value == null ? "" : String(value);
    }
    return container;
  }

  /** A small "copy" affordance bound to a value. */
  function copyBtn(text) {
    var button = document.createElement("span");
    button.className = "cp";
    button.textContent = "copy";
    button.addEventListener("click", function () {
      copyText(String(text)).then(function () {
        toast("Copied to clipboard.", "success");
      });
    });
    return button;
  }

  /** Render a `{ title, description, items }` result dialog. */
  function showOutput(output) {
    openModal(function (box, close) {
      var heading = document.createElement("h3");
      heading.textContent = output.title || "Result";
      box.appendChild(heading);
      if (output.description) {
        var description = document.createElement("p");
        description.className = "desc";
        description.textContent = output.description;
        box.appendChild(description);
      }
      (output.items || []).forEach(function (item) {
        var row = document.createElement("div");
        row.className = "out";
        var key = document.createElement("div");
        key.className = "k";
        key.appendChild(document.createTextNode(item.label));
        if (!Array.isArray(item.value) && typeof item.value !== "object") {
          key.appendChild(copyBtn(item.value == null ? "" : item.value));
        }
        row.appendChild(key);
        row.appendChild(valueNode(item.value));
        box.appendChild(row);
      });
      var foot = document.createElement("div");
      foot.className = "foot";
      var ok = document.createElement("button");
      ok.className = "primary";
      ok.textContent = "Close";
      ok.addEventListener("click", close);
      foot.appendChild(ok);
      box.appendChild(foot);
    });
  }

  /** Render a `{ title, columns, rows }` table dialog (filter/CSV/copy). */
  function showTable(table) {
    openModal(
      function (box, close) {
        var heading = document.createElement("h3");
        heading.textContent = table.title || "Result";
        box.appendChild(heading);
        if (table.description) {
          var description = document.createElement("p");
          description.className = "desc";
          description.textContent = table.description;
          box.appendChild(description);
        }

        var filter = null;
        if (table.searchable) {
          filter = document.createElement("input");
          filter.className = "filter";
          filter.placeholder = "Filter...";
          box.appendChild(filter);
        }

        var tbl = document.createElement("table");
        var hasUrl = (table.rows || []).some(function (row) {
          return row.url;
        });

        var thead = document.createElement("thead");
        var headRow = document.createElement("tr");
        (table.columns || []).forEach(function (column) {
          var th = document.createElement("th");
          th.textContent = column.label;
          headRow.appendChild(th);
        });
        if (hasUrl) {
          headRow.appendChild(document.createElement("th"));
        }
        thead.appendChild(headRow);
        tbl.appendChild(thead);

        var tbody = document.createElement("tbody");
        tbl.appendChild(tbody);

        function renderRows() {
          var query = filter ? (filter.value || "").toLowerCase() : "";
          var lastGroup = null;
          tbody.textContent = "";
          (table.rows || []).forEach(function (row) {
            var text = (table.columns || [])
              .map(function (column) {
                return row[column.key] == null ? "" : String(row[column.key]);
              })
              .join(" ");
            if (table.groupBy) {
              text += " " + (row[table.groupBy] == null ? "" : String(row[table.groupBy]));
            }
            if (query && text.toLowerCase().indexOf(query) === -1) return;

            if (table.groupBy) {
              var groupValue = row[table.groupBy];
              if (groupValue !== lastGroup) {
                lastGroup = groupValue;
                var groupRow = document.createElement("tr");
                var groupCell = document.createElement("td");
                groupCell.className = "grouphead";
                groupCell.colSpan = (table.columns || []).length + (hasUrl ? 1 : 0);
                groupCell.textContent = groupValue;
                groupRow.appendChild(groupCell);
                tbody.appendChild(groupRow);
              }
            }

            var tr = document.createElement("tr");
            (table.columns || []).forEach(function (column) {
              var td = document.createElement("td");
              td.className = "col-" + column.key;
              // The text lives in a span so a column can cap its own width.
              // `max-width` on the `td` itself is unreliable with
              // `table-layout:auto`, whereas the inline-block span honours it.
              var cell = document.createElement("span");
              cell.className = "cell";
              var cellText = row[column.key] == null ? "" : String(row[column.key]);
              cell.textContent = cellText;
              // A per-column `maxWidthPx` stops one long identifier or value
              // from stretching the whole table. The full text stays reachable
              // through the tooltip and the table's copy/CSV exports.
              if (column.maxWidthPx) {
                cell.classList.add("truncate");
                cell.style.maxWidth = column.maxWidthPx + "px";
                cell.title = cellText;
              }
              td.appendChild(cell);
              if (table.copyKey === column.key) {
                td.classList.add("copy");
                td.title = "Click to copy";
                td.addEventListener("click", function () {
                  copyText(td.textContent).then(function () {
                    toast("Copied: " + td.textContent, "success");
                  });
                });
              }
              tr.appendChild(td);
            });

            if (hasUrl) {
              var urlCell = document.createElement("td");
              if (row.url) {
                var openButton = document.createElement("button");
                openButton.className = "mini";
                openButton.textContent = "Open";
                openButton.addEventListener("click", function () {
                  send("openUrl", { url: row.url }).catch(function (err) {
                    toast(err.message, "error");
                  });
                });
                urlCell.appendChild(openButton);
              }
              tr.appendChild(urlCell);
            }

            if (table.rowDetail && row._detail) {
              tr.style.cursor = "pointer";
              tr.title = "Click for details";
              tr.addEventListener("click", function (event) {
                if (event.target.closest && event.target.closest("button")) return;
                showOutput({
                  title: String(row[table.columns[0].key] || "Detail"),
                  items: row._detail
                });
              });
            }

            tbody.appendChild(tr);
          });
        }

        renderRows();
        if (filter) filter.addEventListener("input", renderRows);
        box.appendChild(tbl);

        var actionBar = document.createElement("div");
        actionBar.className = "actions";
        var count = document.createElement("span");
        count.className = "muted";
        count.textContent = (table.rows || []).length + " row(s)";

        var right = document.createElement("div");
        right.className = "actions-buttons";

        // Optional one-click copy of the raw data (e.g. the Web API JSON for
        // "All Fields"). Only rendered when the table carries `rawJson`.
        if (table.rawJson) {
          var copyJsonButton = document.createElement("button");
          copyJsonButton.textContent = "Copy JSON";
          copyJsonButton.addEventListener("click", function () {
            copyText(table.rawJson).then(function () {
              toast("Copied raw JSON to clipboard.", "success");
            });
          });
          right.appendChild(copyJsonButton);
        }

        var csvButton = document.createElement("button");
        csvButton.textContent = "CSV";
        csvButton.addEventListener("click", function () {
          function quote(value) {
            value = value == null ? "" : String(value);
            return '"' + value.replace(/"/g, '""') + '"';
          }
          var lines = [
            (table.columns || [])
              .map(function (column) {
                return quote(column.label);
              })
              .join(",")
          ];
          [].slice.call(tbody.querySelectorAll("tr")).forEach(function (tr) {
            var cells = [].slice.call(tr.querySelectorAll("td"));
            if (hasUrl) cells.pop();
            lines.push(
              cells
                .map(function (td) {
                  return quote(td.textContent);
                })
                .join(",")
            );
          });
          var blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
          var anchor = document.createElement("a");
          anchor.href = URL.createObjectURL(blob);
          anchor.download = "power-pane-export.csv";
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          setTimeout(function () {
            URL.revokeObjectURL(anchor.href);
          }, 1500);
        });
        right.appendChild(csvButton);

        var copyAllButton = document.createElement("button");
        copyAllButton.textContent = "Copy table";
        copyAllButton.addEventListener("click", function () {
          var lines = [];
          lines.push(
            (table.columns || [])
              .map(function (column) {
                return column.label;
              })
              .join("\t")
          );
          var rows = [].slice.call(tbody.querySelectorAll("tr"));
          rows.forEach(function (tr) {
            var cells = [].slice.call(tr.querySelectorAll("td"));
            if (hasUrl) cells.pop();
            lines.push(
              cells
                .map(function (td) {
                  return td.textContent.replace(/\t|\n/g, " ");
                })
                .join("\t")
            );
          });
          copyText(lines.join("\r\n")).then(function () {
            toast("Copied " + rows.length + " row(s) to clipboard.", "success");
          });
        });
        right.appendChild(copyAllButton);

        var ok = document.createElement("button");
        ok.className = "primary";
        ok.textContent = "Close";
        ok.addEventListener("click", close);
        right.appendChild(ok);

        actionBar.appendChild(count);
        actionBar.appendChild(right);
        // Keep the action bar at the top of the dialog so copy/export are
        // reachable without scrolling to the bottom of a long table.
        box.insertBefore(actionBar, filter || tbl);
      },
      { wide: true }
    );
  }

  /** Prompt for an action's inputs, then call `submit(args)`. */
  function promptInputs(action, submit, ctx) {
    openModal(function (box, close) {
      var heading = document.createElement("h3");
      heading.textContent = action.label;
      box.appendChild(heading);
      var description = document.createElement("p");
      description.className = "desc";
      description.textContent = "Fill the inputs and run.";
      box.appendChild(description);

      var inputs = [];
      (action.inputs || []).forEach(function (spec) {
        var field = document.createElement("div");
        field.className = "field";
        var label = document.createElement("label");
        label.textContent = spec.label;
        field.appendChild(label);

        var input = document.createElement(spec.type === "textarea" ? "textarea" : "input");
        if (spec.type !== "textarea") input.type = "text";
        if (spec.placeholder) input.placeholder = spec.placeholder;
        if (spec.defaultCurrent && ctx && ctx.entityName) input.value = ctx.entityName;
        field.appendChild(input);

        if (spec.entity) {
          input.setAttribute("autocomplete", "off");
          var results = document.createElement("div");
          results.className = "entity-results";
          field.appendChild(results);
          var debounceTimer = null;
          input.addEventListener("input", function () {
            clearTimeout(debounceTimer);
            var query = input.value.trim();
            if (query.length < MIN_USER_SEARCH_LENGTH) {
              results.textContent = "";
              return;
            }
            debounceTimer = setTimeout(function () {
              send("searchEntities", { query: query })
                .then(function (response) {
                  results.textContent = "";
                  ((response && response.entities) || []).forEach(function (entity) {
                    var option = document.createElement("button");
                    option.type = "button";
                    option.className = "entity-opt";
                    var logicalName = document.createElement("span");
                    logicalName.className = "lname";
                    logicalName.textContent = entity.logical;
                    var displayName = document.createElement("span");
                    displayName.className = "dname";
                    displayName.textContent = entity.display;
                    option.appendChild(logicalName);
                    option.appendChild(displayName);
                    option.addEventListener("click", function () {
                      input.value = entity.logical;
                      results.textContent = "";
                    });
                    results.appendChild(option);
                  });
                })
                .catch(function () {
                  /* entity search failed; leave results empty */
                });
            }, ENTITY_SEARCH_DEBOUNCE_MS);
          });
        }

        box.appendChild(field);
        inputs.push({ name: spec.name, el: input });
      });

      var foot = document.createElement("div");
      foot.className = "foot";
      var cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", close);
      var ok = document.createElement("button");
      ok.className = "primary";
      ok.textContent = "Run";
      ok.addEventListener("click", function () {
        var args = {};
        inputs.forEach(function (field) {
          args[field.name] = field.el.value;
        });
        close();
        submit(args);
      });
      foot.appendChild(cancel);
      foot.appendChild(ok);
      box.appendChild(foot);
    });
  }

  /* ------------------------------------------------------------------ *
   * Impersonation badge (owned here because it mutates core DOM)
   * ------------------------------------------------------------------ */

  /**
   * Reflect the current impersonation state onto the pane badge and the
   * injected navigation button.
   * @param {{user: {fullname: string}}|null} entry
   */
  function renderImpersonation(entry) {
    state.impersonation = entry || null;
    if (entry && entry.user) {
      pill.hidden = false;
      pill.textContent = "Impersonating: " + entry.user.fullname;
      toggleBtn.classList.add("imp");
      toggleBtn.title = PP.SHORT_NAME + " - impersonating " + entry.user.fullname;
    } else {
      pill.hidden = true;
      pill.textContent = "";
      toggleBtn.classList.remove("imp");
      toggleBtn.title = PP.SHORT_NAME + " (Alt+P)";
    }
    if (pageBtn) {
      pageBtn.style.color = entry && entry.user ? "#f59e0b" : "";
      pageBtn.title =
        entry && entry.user ? PP.SHORT_NAME + " - impersonating " + entry.user.fullname : PP.SHORT_NAME + " (Alt+P)";
    }
  }

  /* ------------------------------------------------------------------ *
   * Local handler + mount-hook registry
   * ------------------------------------------------------------------ */

  /** Local (non-bridge) action handlers; feature sections register into this. */
  var localHandlers = {};
  /** One-time hooks run at the end of mount(); feature sections register here. */
  var onMountHooks = [];

  function registerLocal(command, handler) {
    localHandlers[command] = handler;
  }

  function onMount(hook) {
    onMountHooks.push(hook);
  }

  // Trivial local action kept in core.
  registerLocal("advancedSettingsUsers", function () {
    localSet(PP.LOCAL.AUTO_OPEN_USERS, Date.now());
    window.open(location.origin + "/main.aspx?settingsonly=true", PP.LOCAL.AUTO_OPEN_USERS);
    toast("Opening Advanced Settings > Users...", "success");
  });

  function runAction(action, button) {
    function execute(args) {
      if (action.local && localHandlers[action.command]) {
        localHandlers[action.command]();
        return;
      }
      button.disabled = true;
      send(action.command, args)
        .then(function (result) {
          if (result && result.output) showOutput(result.output);
          if (result && result.table) showTable(result.table);
          if (result && result.message) toast(result.message, result.level);
        })
        .catch(function (err) {
          toast(err.message, "error");
        })
        .finally(function () {
          button.disabled = false;
        });
    }

    if (action.inputs && action.inputs.length) {
      var needsCurrent = action.inputs.some(function (input) {
        return input.defaultCurrent;
      });
      if (needsCurrent) {
        send("currentContext", {})
          .then(function (ctx) {
            promptInputs(action, execute, ctx || {});
          })
          .catch(function () {
            promptInputs(action, execute, {});
          });
      } else {
        promptInputs(action, execute, {});
      }
    } else {
      execute({});
    }
  }

  /* ------------------------------------------------------------------ *
   * Drag & resize
   * ------------------------------------------------------------------ */

  var dragState = null;
  var panelHeader = panel.querySelector(".hd");
  panelHeader.addEventListener("mousedown", function (event) {
    if (event.target.closest("button")) return;
    var rect = panel.getBoundingClientRect();
    dragState = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    panel.style.left = rect.left + "px";
    panel.style.top = rect.top + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    event.preventDefault();
  });
  document.addEventListener("mousemove", function (event) {
    if (!dragState) return;
    panel.style.left = Math.max(0, event.clientX - dragState.dx) + "px";
    panel.style.top = Math.max(headerBottom(), event.clientY - dragState.dy) + "px";
  });
  document.addEventListener("mouseup", function () {
    if (!dragState) return;
    dragState = null;
    saveLayout();
  });

  var resizeObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(function () {
          if (!dragState) saveLayout();
        })
      : null;
  if (resizeObserver) resizeObserver.observe(panel);

  function saveLayout() {
    var rect = panel.getBoundingClientRect();
    state.layout = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    localSet(PP.LOCAL.LAYOUT, state.layout);
  }

  function applyLayout() {
    var layout = state.layout;
    if (!layout) return;
    if (layout.left != null) {
      panel.style.left = Math.max(0, layout.left) + "px";
      panel.style.right = "auto";
    }
    if (layout.top != null) {
      panel.style.top = Math.max(headerBottom(), layout.top) + "px";
      panel.style.bottom = "auto";
    }
    if (layout.width) panel.style.width = layout.width + "px";
    if (layout.height) panel.style.height = layout.height + "px";
  }

  /* ------------------------------------------------------------------ *
   * Keyboard shortcuts
   * ------------------------------------------------------------------ */

  function matchCombo(event, combo) {
    if (!combo) return false;
    var parts = combo.split("+");
    var key = parts.pop().toLowerCase();
    var needAlt = parts.indexOf("Alt") > -1;
    var needCtrl = parts.indexOf("Ctrl") > -1;
    var needShift = parts.indexOf("Shift") > -1;
    var needMeta = parts.indexOf("Meta") > -1;
    if (event.altKey !== needAlt || event.ctrlKey !== needCtrl || event.shiftKey !== needShift || event.metaKey !== needMeta) {
      return false;
    }
    var pressed = (event.key || "").toLowerCase();
    return pressed === key || pressed === " " + key;
  }

  document.addEventListener("keydown", function (event) {
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "p" || event.key === "P")) {
      event.preventDefault();
      togglePanel();
      return;
    }
    var target = event.target;
    var typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if (typing) return;
    for (var id in state.shortcuts) {
      if (matchCombo(event, state.shortcuts[id])) {
        var action = ACTIONS.filter(function (candidate) {
          return candidate.id === id && state.settings[candidate.id] !== false;
        })[0];
        if (action) {
          event.preventDefault();
          runAction(action, { disabled: false });
        }
        return;
      }
    }
  });

  /* ------------------------------------------------------------------ *
   * Service-worker toolbar toggle
   * ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener(function (message) {
    if (message && message.type === PP.MSG.PANE_TOGGLE) togglePanel();
  });

  /* ------------------------------------------------------------------ *
   * Storage change propagation
   * ------------------------------------------------------------------ */

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "sync") {
        if (changes[PP.SYNC.SETTINGS]) state.settings = changes[PP.SYNC.SETTINGS].newValue || {};
        if (changes[PP.SYNC.ORDER]) state.order = changes[PP.SYNC.ORDER].newValue || [];
        if (changes[PP.SYNC.SHORTCUTS]) state.shortcuts = changes[PP.SYNC.SHORTCUTS].newValue || {};
        if (changes[PP.SYNC.THEME]) setTheme(changes[PP.SYNC.THEME].newValue || PP.THEME.DARK, false);
        if (changes[PP.SYNC.SETTINGS] || changes[PP.SYNC.ORDER]) renderList();
      }
      if (area === "local" && changes[PP.LOCAL.LAYOUT]) {
        state.layout = changes[PP.LOCAL.LAYOUT].newValue || null;
        if (state.layout) {
          applyLayout();
        } else {
          panel.style.left = "";
          panel.style.top = "";
          panel.style.right = "8px";
          panel.style.width = "";
          panel.style.height = "";
          layoutPanelTop();
          placeButton();
        }
      }
    });
  } catch (e) {
    /* storage.onChanged unavailable; live updates are disabled */
  }

  /* ------------------------------------------------------------------ *
   * Dismissal (outside click / Escape / pointer leave)
   * ------------------------------------------------------------------ */

  document.addEventListener(
    "mousedown",
    function (event) {
      if (panel.classList.contains("hidden")) return;
      var path = event.composedPath ? event.composedPath() : [];
      if (path.indexOf(host) > -1) return;
      panel.classList.add("hidden");
    },
    true
  );
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !panel.classList.contains("hidden")) panel.classList.add("hidden");
  });
  panel.addEventListener("mouseleave", function () {
    if (wrap.querySelector(".modal")) return;
    panel.classList.add("hidden");
  });

  /* ------------------------------------------------------------------ *
   * App-shell detection & navigation-button placement
   * ------------------------------------------------------------------ */

  function hasAppShell() {
    try {
      return !!(
        document.querySelector('div[data-id="topBar"]') ||
        document.querySelector('body[scroll="no"]') ||
        document.querySelector("#crmMasthead") ||
        document.querySelector("nav[aria-label]") ||
        document.querySelector('[data-id="AppLandingPage"]')
      );
    } catch (e) {
      return false;
    }
  }

  function headerBottom() {
    var header =
      document.querySelector('div[data-id="topBar"]') ||
      document.querySelector("#crmMasthead") ||
      document.querySelector("#navBar") ||
      document.querySelector("header");
    if (!header) return 8;
    return Math.round(header.getBoundingClientRect().bottom) + 6;
  }

  function ensurePageStyle() {
    if (document.getElementById("pp-inline-style")) return;
    var styleEl = document.createElement("style");
    styleEl.id = "pp-inline-style";
    styleEl.textContent =
      ".pp-inline-btn{float:left;display:flex;align-items:center;justify-content:center;width:44px;border:none;background:transparent;cursor:pointer;color:#ffffff;opacity:.92;padding:0;margin:0;box-sizing:border-box}" +
      ".pp-inline-btn.abs{position:absolute;left:0;top:0}" +
      ".pp-inline-btn:hover{background:rgba(255,255,255,.18);opacity:1}" +
      ".pp-inline-btn svg{width:24px;height:24px}";
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function findNavTarget() {
    var topBar = document.querySelector('div[data-id="topBar"]');
    if (topBar) return { parent: topBar, prepend: true };
    var navBar = document.querySelector("#navBar");
    if (navBar) return { parent: navBar, prepend: true };
    return null;
  }

  function realClick(element) {
    try {
      var opts = { bubbles: true, cancelable: true, view: window };
      element.dispatchEvent(new PointerEvent("pointerdown", opts));
      element.dispatchEvent(new MouseEvent("mousedown", opts));
      element.dispatchEvent(new PointerEvent("pointerup", opts));
      element.dispatchEvent(new MouseEvent("mouseup", opts));
      element.dispatchEvent(new MouseEvent("click", opts));
    } catch (e) {
      try {
        element.click();
      } catch (e2) {
        /* ignore */
      }
    }
  }

  function placeButton() {
    ensurePageStyle();
    var target = findNavTarget();
    if (!target) {
      if (pageBtn) {
        pageBtn.remove();
        pageBtn = null;
      }
      toggleBtn.style.display = "none";
      return;
    }
    if (!pageBtn) {
      pageBtn = document.createElement("span");
      pageBtn.className = "pp-inline-btn";
      pageBtn.setAttribute("role", "button");
      pageBtn.title = PP.SHORT_NAME + " (Alt+P)";
      pageBtn.innerHTML = bolt;
      pageBtn.addEventListener("click", function (event) {
        event.stopPropagation();
        togglePanel();
      });
    }
    var needsMove =
      pageBtn.parentElement !== target.parent ||
      (target.prepend && target.parent.firstElementChild !== pageBtn);
    if (needsMove) {
      if (target.prepend) target.parent.insertBefore(pageBtn, target.parent.firstChild);
      else target.parent.appendChild(pageBtn);
    }
    pageBtn.classList.remove("abs");
    var height = target.parent.getBoundingClientRect().height;
    var navTabGroup = document.getElementById("navTabGroupDiv");
    if (navTabGroup && target.parent.contains(navTabGroup)) height = navTabGroup.getBoundingClientRect().height;
    try {
      pageBtn.style.height = Math.round(height) + "px";
    } catch (e) {
      /* ignore */
    }
    pageBtn.style.color = state.impersonation && state.impersonation.user ? "#ffcf4d" : "#ffffff";
    toggleBtn.style.display = "none";
  }

  function layoutPanelTop() {
    if (state.layout) return;
    var top = headerBottom();
    panel.style.top = top + "px";
    panel.style.left = "8px";
    panel.style.right = "8px";
  }

  function updateVisibility() {
    try {
      var shell = hasAppShell();
      host.style.display = shell ? "" : "none";
      if (shell) placeButton();
      layoutPanelTop();
    } catch (e) {
      /* ignore */
    }
  }

  window.addEventListener("resize", function () {
    placeButton();
    layoutPanelTop();
  });

  // Auto-navigate classic Advanced Settings to Security > Users when opened via
  // the "Advanced Settings - Users" action (flagged in extension storage).
  function autoOpenUsers() {
    var byName = window.name === PP.LOCAL.AUTO_OPEN_USERS;
    localGet(PP.LOCAL.AUTO_OPEN_USERS, 0).then(function (timestamp) {
      var byStore = timestamp && Date.now() - timestamp < 120000;
      if (!byName && !byStore) return;
      if (byName) {
        try {
          window.name = "";
        } catch (e) {
          /* ignore */
        }
      }
      localSet(PP.LOCAL.AUTO_OPEN_USERS, 0);
      var step = 0;
      var tries = 0;
      var timer = setInterval(function () {
        tries++;
        if (tries > 90) {
          clearInterval(timer);
          return;
        }
        var labels = [].slice.call(document.querySelectorAll('button,[role="button"],a,span'));
        if (step === 0) {
          var settingsTab = document.getElementById("TabSettings-main");
          var area =
            settingsTab ||
            labels.filter(function (node) {
              var lab =
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
          var security = labels.filter(function (node) {
            return (node.textContent || "").trim() === "Security" && node.offsetParent !== null;
          })[0];
          if (security) {
            realClick(security);
            step = 2;
          }
        } else if (step === 2) {
          var doc = document;
          try {
            var frame = document.getElementById("contentIFrame0");
            if (frame && frame.contentDocument) doc = frame.contentDocument;
          } catch (e) {
            /* cross-origin frame */
          }
          var users = [].slice.call(doc.querySelectorAll("a,span,td,div")).filter(function (node) {
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
      .catch(function () {
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
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var key = localStorage.key(i);
        if (/^Form:(userquery|savedquery)$/i.test(key) || /savedquery|viewcache/i.test(key)) {
          localStorage.removeItem(key);
        }
      }
    } catch (e) {
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
        var rules = (response && response.rules) || [];
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
    var id = user && user.systemuserid;
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

  /** Build a single user row (meta + pin + impersonate). */
  function userRow(user, onPinChanged) {
    var row = document.createElement("div");
    row.className = "user";

    var meta = document.createElement("div");
    meta.className = "meta";
    var name = document.createElement("div");
    name.className = "nm";
    name.textContent = user.fullname || "(no name)";
    var email = document.createElement("div");
    email.className = "em";
    email.textContent = user.internalemailaddress || user.domainname || "";
    meta.appendChild(name);
    meta.appendChild(email);

    var pinButton = document.createElement("button");
    pinButton.className = "mini";
    pinButton.title = isPinned(user) ? "Unpin" : "Pin";
    pinButton.textContent = isPinned(user) ? "\u2605" : "\u2606";
    pinButton.addEventListener("click", function () {
      togglePin(user);
      if (onPinChanged) onPinChanged();
    });

    var impersonateButton = document.createElement("button");
    impersonateButton.className = "mini primary";
    impersonateButton.textContent = "Impersonate";
    impersonateButton.addEventListener("click", function () {
      startImpersonate(user);
    });

    row.appendChild(meta);
    row.appendChild(pinButton);
    row.appendChild(impersonateButton);
    return row;
  }

  function buildImpersonateModal() {
    openModal(function (box, close) {
      var heading = document.createElement("h3");
      heading.textContent = "Impersonate User";
      box.appendChild(heading);
      var description = document.createElement("p");
      description.className = "desc";
      description.textContent = "Search by name, email or domain. Requires prvActOnBehalfOfAnotherUser.";
      box.appendChild(description);

      if (state.impersonation && state.impersonation.user) {
        var bar = document.createElement("div");
        bar.className = "impbar";
        var activeName = document.createElement("span");
        activeName.className = "nm";
        activeName.textContent = "Active: " + state.impersonation.user.fullname;
        var stop = document.createElement("button");
        stop.className = "mini";
        stop.textContent = "Stop";
        stop.addEventListener("click", stopImpersonate);
        bar.appendChild(activeName);
        bar.appendChild(stop);
        box.appendChild(bar);
      }

      var quick = document.createElement("div");
      box.appendChild(quick);

      var search = document.createElement("input");
      search.className = "filter";
      search.placeholder = "Name, email or domain (min 2 chars)";
      box.appendChild(search);

      var results = document.createElement("div");
      box.appendChild(results);

      function renderQuick() {
        quick.textContent = "";
        if (state.pinned.length) {
          var pinnedTitle = document.createElement("div");
          pinnedTitle.className = "sect";
          pinnedTitle.textContent = "Pinned";
          quick.appendChild(pinnedTitle);
          state.pinned.forEach(function (user) {
            quick.appendChild(userRow(user, renderQuick));
          });
        }
        var recentOnly = state.recent.filter(function (user) {
          return !isPinned(user);
        });
        if (recentOnly.length) {
          var recentTitle = document.createElement("div");
          recentTitle.className = "sect";
          recentTitle.textContent = "Recent";
          quick.appendChild(recentTitle);
          recentOnly.forEach(function (user) {
            quick.appendChild(userRow(user, renderQuick));
          });
        }
      }
      renderQuick();

      var timer = null;
      function doSearch() {
        var query = search.value.trim();
        if (query.length < MIN_USER_SEARCH_LENGTH) {
          results.textContent = "";
          return;
        }
        results.textContent = "";
        var loading = document.createElement("div");
        loading.className = "muted";
        loading.textContent = "Searching...";
        results.appendChild(loading);

        send("searchUsers", { query: query })
          .then(function (response) {
            var users = (response && response.users) || [];
            results.textContent = "";
            var title = document.createElement("div");
            title.className = "sect";
            title.textContent = "Search Results";
            results.appendChild(title);
            if (!users.length) {
              var none = document.createElement("div");
              none.className = "empty";
              none.textContent = "No users found.";
              results.appendChild(none);
              return;
            }
            users.forEach(function (user) {
              results.appendChild(userRow(user, function () {}));
            });
          })
          .catch(function (err) {
            results.textContent = "";
            var error = document.createElement("div");
            error.className = "empty";
            error.textContent = err.message;
            results.appendChild(error);
          });
      }
      search.addEventListener("input", function () {
        clearTimeout(timer);
        timer = setTimeout(doSearch, USER_SEARCH_DEBOUNCE_MS);
      });

      var foot = document.createElement("div");
      foot.className = "foot";
      var closeButton = document.createElement("button");
      closeButton.textContent = "Close";
      closeButton.addEventListener("click", close);
      foot.appendChild(closeButton);
      box.appendChild(foot);
    });
  }

  registerLocal("impersonate", openImpersonate);
  registerLocal("impersonateStop", stopImpersonate);
  registerLocal("dnrRules", openDnrRules);
  onMount(refreshImpersonation);

  /* ------------------------------------------------------------------ *
   * Feature: user permissions
   * ------------------------------------------------------------------ */

  /** Multi-term matcher: comma/; /newline separated terms, any-of match. */
  function matches(text, query) {
    if (!query) return true;
    var terms = String(query)
      .toLowerCase()
      .split(/[,;\n]+/)
      .map(function (term) {
        return term.trim();
      })
      .filter(Boolean);
    if (!terms.length) return true;
    var lowerText = String(text || "").toLowerCase();
    return terms.some(function (term) {
      return lowerText.indexOf(term) > -1;
    });
  }

  function openUserAccess() {
    openModal(
      function (box, close) {
        var heading = document.createElement("h3");
        heading.textContent = "User Permissions";
        box.appendChild(heading);
        var description = document.createElement("p");
        description.className = "desc";
        description.textContent = "View and modify a user's roles, teams and business unit. Changes apply immediately.";
        box.appendChild(description);

        var search = document.createElement("input");
        search.className = "filter";
        search.placeholder = "Search user by name or email (min 2 chars)";
        box.appendChild(search);
        var results = document.createElement("div");
        box.appendChild(results);
        var detail = document.createElement("div");
        box.appendChild(detail);

        var allRoles = [];
        var allTeams = [];
        var allBusinessUnits = [];

        var metaReady = Promise.all([
          send("getAllRoles", {}),
          send("getAllTeams", {}),
          send("getBusinessUnits", {})
        ])
          .then(function (data) {
            allRoles = (data[0] && data[0].items) || [];
            allTeams = (data[1] && data[1].items) || [];
            allBusinessUnits = (data[2] && data[2].items) || [];
          })
          .catch(function () {
            /* metadata unavailable; the editor degrades gracefully */
          });

        function loadUser(user) {
          detail.textContent = "";
          var loading = document.createElement("div");
          loading.className = "muted";
          loading.textContent = "Loading access...";
          detail.appendChild(loading);
          Promise.all([send("getUserAccess", { userid: user.systemuserid }), metaReady])
            .then(function (data) {
              detail.textContent = "";
              renderUser(data[0]);
            })
            .catch(function (err) {
              detail.textContent = "";
              var error = document.createElement("div");
              error.className = "empty";
              error.textContent = err.message;
              detail.appendChild(error);
            });
        }

        function renderUser(access) {
          var roleNameMap = {};
          allRoles.forEach(function (role) {
            roleNameMap[role.id.toLowerCase()] = role.name;
          });
          access.roles.forEach(function (role) {
            roleNameMap[role.id.toLowerCase()] = role.name;
          });
          var teamNameMap = {};
          allTeams.forEach(function (team) {
            teamNameMap[team.id.toLowerCase()] = team.name;
          });
          access.teams.forEach(function (team) {
            teamNameMap[team.id.toLowerCase()] = team.name;
          });

          var originalRoles = {};
          access.roles.forEach(function (role) {
            originalRoles[role.id.toLowerCase()] = true;
          });
          var currentRoles = Object.assign({}, originalRoles);
          var originalTeams = {};
          access.teams.forEach(function (team) {
            originalTeams[team.id.toLowerCase()] = true;
          });
          var currentTeams = Object.assign({}, originalTeams);
          var originalBusinessUnit = access.businessUnit ? access.businessUnit.id.toLowerCase() : "";
          var currentBusinessUnit = originalBusinessUnit;

          // Header: user name + email.
          var head = document.createElement("div");
          head.className = "ua-head";
          var nameEl = document.createElement("b");
          nameEl.textContent = access.user.name;
          var emailEl = document.createElement("div");
          emailEl.className = "muted";
          emailEl.textContent = access.user.email || "";
          head.appendChild(nameEl);
          head.appendChild(emailEl);
          detail.appendChild(head);

          // Business unit selector.
          var buRow = document.createElement("div");
          buRow.className = "ua-row";
          var buLabel = document.createElement("div");
          buLabel.className = "ua-k";
          buLabel.textContent = "Business Unit";
          var buValue = document.createElement("div");
          buValue.className = "ua-v";
          var buSelect = document.createElement("select");
          allBusinessUnits.forEach(function (businessUnit) {
            var option = document.createElement("option");
            option.value = businessUnit.id;
            option.textContent = businessUnit.name;
            if (businessUnit.id.toLowerCase() === currentBusinessUnit) option.selected = true;
            buSelect.appendChild(option);
          });
          buSelect.addEventListener("change", function () {
            currentBusinessUnit = buSelect.value.toLowerCase();
            updateDirty();
          });
          buValue.appendChild(buSelect);
          buRow.appendChild(buLabel);
          buRow.appendChild(buValue);
          detail.appendChild(buRow);

          // Assigned roles chips.
          var assignedRolesTitle = document.createElement("div");
          assignedRolesTitle.className = "sect";
          detail.appendChild(assignedRolesTitle);
          var assignedRolesChips = document.createElement("div");
          assignedRolesChips.className = "ua-chips";
          detail.appendChild(assignedRolesChips);
          function renderAssignedRoles() {
            assignedRolesChips.textContent = "";
            var ids = Object.keys(currentRoles);
            assignedRolesTitle.textContent = "Assigned Roles (" + ids.length + ")";
            ids.sort().forEach(function (id) {
              var chip = document.createElement("span");
              chip.className = "chip";
              chip.appendChild(document.createTextNode((roleNameMap[id] || id) + " "));
              var remove = document.createElement("span");
              remove.textContent = "\u00d7";
              remove.style.cssText = "cursor:pointer;opacity:.7";
              remove.addEventListener("click", function () {
                delete currentRoles[id];
                renderAssignedRoles();
                renderRoles();
                updateDirty();
              });
              chip.appendChild(remove);
              assignedRolesChips.appendChild(chip);
            });
            if (!ids.length) {
              var none = document.createElement("span");
              none.className = "muted";
              none.textContent = "None";
              assignedRolesChips.appendChild(none);
            }
          }

          // All roles (this BU) list with filter.
          var rolesTitle = document.createElement("div");
          rolesTitle.className = "sect";
          rolesTitle.textContent = "All Roles (this BU)";
          detail.appendChild(rolesTitle);
          var roleSearch = document.createElement("input");
          roleSearch.className = "filter";
          roleSearch.placeholder = "Filter roles (comma = multiple)";
          detail.appendChild(roleSearch);
          var rolesList = document.createElement("div");
          rolesList.className = "ua-list";
          detail.appendChild(rolesList);

          var roleSourceMap = {};
          allRoles
            .filter(function (role) {
              return !currentBusinessUnit || !role.buId || String(role.buId).toLowerCase() === currentBusinessUnit;
            })
            .forEach(function (role) {
              roleSourceMap[role.id.toLowerCase()] = role;
            });
          access.roles.forEach(function (role) {
            if (!roleSourceMap[role.id.toLowerCase()]) roleSourceMap[role.id.toLowerCase()] = role;
          });
          var roleSource = Object.keys(roleSourceMap).map(function (key) {
            return roleSourceMap[key];
          });

          function renderRoles() {
            rolesList.textContent = "";
            roleSource
              .filter(function (role) {
                return matches(role.name, roleSearch.value);
              })
              .sort(function (a, b) {
                return a.name.localeCompare(b.name);
              })
              .forEach(function (role) {
                var label = document.createElement("label");
                label.className = "ua-item";
                var checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.checked = !!currentRoles[role.id.toLowerCase()];
                checkbox.addEventListener("change", function () {
                  if (checkbox.checked) currentRoles[role.id.toLowerCase()] = true;
                  else delete currentRoles[role.id.toLowerCase()];
                  renderAssignedRoles();
                  updateDirty();
                });
                label.appendChild(checkbox);
                label.appendChild(document.createTextNode(role.name));
                rolesList.appendChild(label);
              });
          }
          roleSearch.addEventListener("input", renderRoles);

          // Assigned teams chips.
          var assignedTeamsTitle = document.createElement("div");
          assignedTeamsTitle.className = "sect";
          detail.appendChild(assignedTeamsTitle);
          var assignedTeamsChips = document.createElement("div");
          assignedTeamsChips.className = "ua-chips";
          detail.appendChild(assignedTeamsChips);
          function renderAssignedTeams() {
            assignedTeamsChips.textContent = "";
            var ids = Object.keys(currentTeams);
            assignedTeamsTitle.textContent = "Teams (" + ids.length + ")";
            ids.sort().forEach(function (id) {
              var chip = document.createElement("span");
              chip.className = "chip";
              chip.appendChild(document.createTextNode((teamNameMap[id] || id) + " "));
              var remove = document.createElement("span");
              remove.textContent = "\u00d7";
              remove.style.cssText = "cursor:pointer;opacity:.7";
              remove.addEventListener("click", function () {
                delete currentTeams[id];
                renderAssignedTeams();
                renderTeams();
                updateDirty();
              });
              chip.appendChild(remove);
              assignedTeamsChips.appendChild(chip);
            });
            if (!ids.length) {
              var none = document.createElement("span");
              none.className = "muted";
              none.textContent = "None";
              assignedTeamsChips.appendChild(none);
            }
          }

          // Team picker (search + add).
          var teamSearch = document.createElement("input");
          teamSearch.className = "filter";
          teamSearch.placeholder = "Search teams to add (comma = multiple)";
          detail.appendChild(teamSearch);
          var teamsList = document.createElement("div");
          teamsList.className = "ua-list";
          detail.appendChild(teamsList);
          function renderTeams() {
            teamsList.textContent = "";
            allTeams
              .filter(function (team) {
                return !currentTeams[team.id.toLowerCase()];
              })
              .filter(function (team) {
                return matches(team.name, teamSearch.value);
              })
              .sort(function (a, b) {
                return a.name.localeCompare(b.name);
              })
              .slice(0, TEAM_LIST_LIMIT)
              .forEach(function (team) {
                var row = document.createElement("div");
                row.className = "ua-item";
                var name = document.createElement("span");
                name.style.flex = "1";
                name.textContent = team.name;
                var add = document.createElement("button");
                add.className = "mini";
                add.textContent = "Add";
                add.addEventListener("click", function () {
                  currentTeams[team.id.toLowerCase()] = true;
                  teamNameMap[team.id.toLowerCase()] = team.name;
                  renderAssignedTeams();
                  renderTeams();
                  updateDirty();
                });
                row.appendChild(name);
                row.appendChild(add);
                teamsList.appendChild(row);
              });
          }
          teamSearch.addEventListener("input", renderTeams);

          // Save footer with staged diff.
          var saveRow = document.createElement("div");
          saveRow.className = "foot split";
          detail.appendChild(saveRow);
          var info = document.createElement("span");
          info.className = "muted";
          saveRow.appendChild(info);
          var saveButton = document.createElement("button");
          saveButton.className = "primary";
          saveButton.textContent = "Save";
          saveRow.appendChild(saveButton);

          function diff() {
            var operations = [];
            Object.keys(currentRoles).forEach(function (id) {
              if (!originalRoles[id]) operations.push({ type: "assignRole", id: id });
            });
            Object.keys(originalRoles).forEach(function (id) {
              if (!currentRoles[id]) operations.push({ type: "removeRole", id: id });
            });
            Object.keys(currentTeams).forEach(function (id) {
              if (!originalTeams[id]) operations.push({ type: "addTeam", id: id });
            });
            Object.keys(originalTeams).forEach(function (id) {
              if (!currentTeams[id]) operations.push({ type: "removeTeam", id: id });
            });
            if (currentBusinessUnit && currentBusinessUnit !== originalBusinessUnit) {
              operations.push({ type: "bu", id: currentBusinessUnit });
            }
            return operations;
          }

          function updateDirty() {
            var count = diff().length;
            info.textContent = count ? count + " pending change(s)" : "No changes";
            saveButton.disabled = !count;
          }

          saveButton.addEventListener("click", function () {
            var operations = diff();
            if (!operations.length) return;
            saveButton.disabled = true;
            var calls = operations.map(function (operation) {
              if (operation.type === "assignRole") {
                return send("assignRole", { userid: access.user.id, roleid: operation.id });
              }
              if (operation.type === "removeRole") {
                return send("removeRole", { userid: access.user.id, roleid: operation.id });
              }
              if (operation.type === "addTeam") {
                return send("addTeam", { userid: access.user.id, teamid: operation.id });
              }
              if (operation.type === "removeTeam") {
                return send("removeTeam", { userid: access.user.id, teamid: operation.id });
              }
              if (operation.type === "bu") {
                return send("setBusinessUnit", { userid: access.user.id, buid: operation.id });
              }
              return Promise.resolve();
            });
            Promise.all(calls)
              .then(function () {
                toast("Saved " + operations.length + " change(s).", "success");
                loadUser(access.user);
              })
              .catch(function (err) {
                toast(err.message, "error");
                saveButton.disabled = false;
              });
          });

          renderAssignedRoles();
          renderRoles();
          renderAssignedTeams();
          renderTeams();
          updateDirty();
        }

        var timer = null;
        search.addEventListener("input", function () {
          clearTimeout(timer);
          var query = search.value.trim();
          if (query.length < MIN_USER_SEARCH_LENGTH) {
            results.textContent = "";
            return;
          }
          timer = setTimeout(function () {
            send("searchUsers", { query: query })
              .then(function (response) {
                results.textContent = "";
                ((response && response.users) || []).slice(0, USER_SEARCH_RESULT_LIMIT).forEach(function (user) {
                  var row = document.createElement("div");
                  row.className = "user";
                  var meta = document.createElement("div");
                  meta.className = "meta";
                  var name = document.createElement("div");
                  name.className = "nm";
                  name.textContent = user.fullname || "(no name)";
                  var email = document.createElement("div");
                  email.className = "em";
                  email.textContent = user.internalemailaddress || "";
                  meta.appendChild(name);
                  meta.appendChild(email);
                  var openButton = document.createElement("button");
                  openButton.className = "mini primary";
                  openButton.textContent = "Open";
                  openButton.addEventListener("click", function () {
                    results.textContent = "";
                    loadUser(user);
                  });
                  row.appendChild(meta);
                  row.appendChild(openButton);
                  results.appendChild(row);
                });
              })
              .catch(function () {
                /* search failed; leave results empty */
              });
          }, USER_SEARCH_DEBOUNCE_MS);
        });

        var foot = document.createElement("div");
        foot.className = "foot";
        var closeButton = document.createElement("button");
        closeButton.textContent = "Close";
        closeButton.addEventListener("click", close);
        foot.appendChild(closeButton);
        box.appendChild(foot);
      },
      { wide: true }
    );
  }

  registerLocal("userAccess", openUserAccess);

  /* ------------------------------------------------------------------ *
   * Feature: FetchXML snippets
   * ------------------------------------------------------------------ */

  function openSnippets() {
    openModal(function (box, close) {
      function render() {
        box.textContent = "";
        var heading = document.createElement("h3");
        heading.textContent = "FetchXML Snippets";
        box.appendChild(heading);
        var description = document.createElement("p");
        description.className = "desc";
        description.textContent = "Save and reuse FetchXML queries.";
        box.appendChild(description);

        if (!state.snippets.length) {
          var empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "No snippets yet.";
          box.appendChild(empty);
        }

        state.snippets.forEach(function (snippet, index) {
          var row = document.createElement("div");
          row.className = "srow";
          var name = document.createElement("span");
          name.className = "nm";
          name.textContent = snippet.name;
          row.appendChild(name);

          var runButton = document.createElement("button");
          runButton.className = "mini";
          runButton.textContent = "Run";
          runButton.addEventListener("click", function () {
            close();
            send("executeFetchXml", { xml: snippet.xml })
              .then(function (result) {
                if (result && result.output) showOutput(result.output);
                if (result && result.message) toast(result.message, result.level);
              })
              .catch(function (err) {
                toast(err.message, "error");
              });
          });
          var editButton = document.createElement("button");
          editButton.className = "mini";
          editButton.textContent = "Edit";
          editButton.addEventListener("click", function () {
            form(snippet, index);
          });
          var deleteButton = document.createElement("button");
          deleteButton.className = "mini";
          deleteButton.textContent = "Del";
          deleteButton.addEventListener("click", function () {
            state.snippets.splice(index, 1);
            syncSet({ [PP.SYNC.SNIPPETS]: state.snippets }).then(render);
          });

          row.appendChild(runButton);
          row.appendChild(editButton);
          row.appendChild(deleteButton);
          box.appendChild(row);
        });

        var foot = document.createElement("div");
        foot.className = "foot";
        var addButton = document.createElement("button");
        addButton.className = "primary";
        addButton.textContent = "New";
        addButton.addEventListener("click", function () {
          form(null, -1);
        });
        var closeButton = document.createElement("button");
        closeButton.textContent = "Close";
        closeButton.addEventListener("click", close);
        foot.appendChild(addButton);
        foot.appendChild(closeButton);
        box.appendChild(foot);
      }

      function form(snippet, index) {
        box.textContent = "";
        var heading = document.createElement("h3");
        heading.textContent = index >= 0 ? "Edit Snippet" : "New Snippet";
        box.appendChild(heading);

        var nameField = document.createElement("div");
        nameField.className = "field";
        var nameLabel = document.createElement("label");
        nameLabel.textContent = "Name";
        var nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.value = snippet ? snippet.name : "";
        nameField.appendChild(nameLabel);
        nameField.appendChild(nameInput);
        box.appendChild(nameField);

        var xmlField = document.createElement("div");
        xmlField.className = "field";
        var xmlLabel = document.createElement("label");
        xmlLabel.textContent = "FetchXML";
        var xmlArea = document.createElement("textarea");
        xmlArea.value = snippet ? snippet.xml : "";
        xmlField.appendChild(xmlLabel);
        xmlField.appendChild(xmlArea);
        box.appendChild(xmlField);

        var foot = document.createElement("div");
        foot.className = "foot";
        var backButton = document.createElement("button");
        backButton.textContent = "Back";
        backButton.addEventListener("click", render);
        var saveButton = document.createElement("button");
        saveButton.className = "primary";
        saveButton.textContent = "Save";
        saveButton.addEventListener("click", function () {
          var name = nameInput.value.trim() || "Untitled";
          if (index >= 0) state.snippets[index] = { name: name, xml: xmlArea.value };
          else state.snippets.push({ name: name, xml: xmlArea.value });
          syncSet({ [PP.SYNC.SNIPPETS]: state.snippets }).then(render);
        });
        foot.appendChild(backButton);
        foot.appendChild(saveButton);
        box.appendChild(foot);
        nameInput.focus();
      }

      render();
    });
  }

  registerLocal("snippets", openSnippets);

  /* ------------------------------------------------------------------ *
   * Mount
   * ------------------------------------------------------------------ */

  async function mount() {
    (document.body || document.documentElement).appendChild(host);
    updateVisibility();
    autoOpenUsers();

    var visibilityTimer = null;
    try {
      new MutationObserver(function () {
        clearTimeout(visibilityTimer);
        visibilityTimer = setTimeout(updateVisibility, 80);
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      /* observer unavailable */
    }

    var fastTries = 0;
    var fastTimer = setInterval(function () {
      updateVisibility();
      fastTries++;
      if (fastTries > 40) clearInterval(fastTimer);
    }, 150);

    renderList();

    var syncDefaults = {};
    syncDefaults[PP.SYNC.SETTINGS] = {};
    syncDefaults[PP.SYNC.THEME] = PP.THEME.DARK;
    syncDefaults[PP.SYNC.SHORTCUTS] = {};
    syncDefaults[PP.SYNC.SNIPPETS] = [];
    syncDefaults[PP.SYNC.ORDER] = [];
    var syncData = await syncGet(syncDefaults);
    state.settings = syncData[PP.SYNC.SETTINGS] || {};
    state.snippets = syncData[PP.SYNC.SNIPPETS] || [];
    state.shortcuts = syncData[PP.SYNC.SHORTCUTS] || {};
    state.order = syncData[PP.SYNC.ORDER] || [];
    setTheme(syncData[PP.SYNC.THEME] || PP.THEME.DARK, false);
    renderList();

    state.layout = await localGet(PP.LOCAL.LAYOUT, null);
    applyLayout();

    var users = await Promise.all([
      localGet(PP.LOCAL.RECENT_USERS, []),
      localGet(PP.LOCAL.PINNED_USERS, [])
    ]);
    state.recent = users[0] || [];
    state.pinned = users[1] || [];

    onMountHooks.forEach(function (hook) {
      try {
        hook();
      } catch (e) {
        /* a feature hook must never break the pane */
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
