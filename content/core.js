/**
 * Dynamics 365 Power Pane Next - core of the in-page UI (isolated world).
 *
 * Responsibilities:
 *   - Render the action pane (Shadow DOM so host page styles never leak in).
 *   - Persist/apply user preferences (visibility, order, theme, shortcuts).
 *   - Forward action commands to the MAIN-world bridge and render results.
 *   - Own the bridge plumbing (request/response with a nonce id) and the shared
 *     UI primitives (modals, toasts, output/table renderers, action bar,
 *     input-dialog builder, storage wrappers, entity auto-navigation).
 *   - Export the feature-module surface `window.PPPane` (state, helpers and
 *     the mount registry the feature files wire themselves into).
 *
 * Feature modules live in content/features/*.js (impersonation, user
 * permissions, FetchXML/JS snippets) - see each file for its scope. They
 * register their local actions and mount hooks through `PPPane` and receive
 * nothing else from the core. content/boot.js calls `PPPane.boot()` last.
 *
 * Load order (the manifest ISOLATED-world entry): src/constants.js,
 * src/util.js, src/actions.js, content/core.js, content/features/*.js,
 * content/boot.js.
 *
 * Dependencies: src/constants.js (PP), src/util.js (PPUtil),
 * src/actions.js (POWER_PANE_ACTIONS). The MAIN-world bridge is
 * content/main-world.js.
 */
(function () {
  "use strict";
  if (window.__ppNextUiLoaded) return;
  window.__ppNextUiLoaded = true;

  const PP = window.PP;
  const ACTIONS = window.POWER_PANE_ACTIONS || [];
  /* Shared pure helpers (src/util.js). Single implementations shared with the
   * options page - local copies must not re-emerge. */
  const debugLog = window.PPUtil.debugLog;
  const downloadTextFile = window.PPUtil.downloadTextFile;
  const snippetTypeField = window.PPUtil.snippetTypeField;

  /* --- Tunables (named to avoid magic numbers) -------------------------- */
  const BRIDGE_TIMEOUT_MS = 30000;
  const TOAST_DURATION_MS = 5000;
  const ENTITY_SEARCH_DEBOUNCE_MS = 250;
  const LONG_VALUE_THRESHOLD = 400;
  const ORDER_UNSET_INDEX = 9999;
  /** Minimum characters before a user search fires. */
  const MIN_USER_SEARCH_LENGTH = 2;
  /** Debounce for the user search inputs. */
  const USER_SEARCH_DEBOUNCE_MS = 350;
  /** Number of recent users retained. */
  const RECENT_USERS_LIMIT = 3;
  /** Delay before reloading after applying/clearing the impersonated identity. */
  const RELOAD_DELAY_MS = 300;
  /** Guard slightly longer than the .16s opening animation; rects measured
   *  during the keyframe translateY are shifted and must not be persisted. */
  const OPEN_ANIMATION_MS = 200;
  /** Cap on user search results shown in the permissions editor. */
  const USER_SEARCH_RESULT_LIMIT = 15;
  /** Cap on teams listed in the "add team" picker. */
  const TEAM_LIST_LIMIT = 200;

  /** Group header colour by group name; unknown groups fall back to accent. */
  const GROUP_COLORS = {
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
  const state = {
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

  const pending = new Map();

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
      const bytes = new Uint8Array(16);
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
    const message = event.data;
    if (!message || message[PP.BRIDGE.KEY] !== PP.BRIDGE.RESPONSE) return;
    if (typeof message.id !== "string") return;

    const entry = pending.get(message.id);
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
      const id = newMessageId();
      const timer = setTimeout(function () {
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
  function syncRemove(keys) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.remove(keys, resolve);
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
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.cssText = "position:fixed;top:-9999px;left:-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } catch (e) {
      debugLog("pane.clipboardFallback", e);
    }
    textarea.remove();
  }

  /* ------------------------------------------------------------------ *
   * Styles + DOM scaffold (Shadow DOM)
   * ------------------------------------------------------------------ */

  const CSS = [
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
    ".pp .panel{position:fixed;top:42px;left:8px;z-index:2147483646;width:max-content;max-width:calc(100vw - 16px);height:auto;max-height:72vh;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.45);overflow:hidden;resize:both;transform-origin:top center}",
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
    ".pp .modal .box{width:430px;max-width:92vw;max-height:84vh;overflow:auto;background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.5);padding:14px;overflow-x:auto}",
    ".pp .modal .box.wide{width:min(1000px,94vw)}",
    ".pp .modal .box{position:relative}",
    ".pp .modalctl{position:sticky;top:5px;right:7px;margin:-6px -7px 0 auto;width:max-content;display:flex;gap:4px;z-index:6;cursor:move}",
    ".pp .modalctl button{border:1px solid var(--bd);background:var(--hover);color:var(--fg);border-radius:6px;font-size:10.5px;padding:2px 7px;cursor:pointer}",
    // Wide dialogs: the content stretches to the table's full width (min. the
    // visible width) so the filter, action bar and sticky controls all track
    // the horizontal scroll area.
    ".pp .box.wide .modal-content{width:max-content;min-width:100%}",
    ".pp .box.fixedw{width:min(1000px,94vw)}",
    ".pp .box.fixedw .modal-content{width:100%}",
    ".pp .modalctl button:hover{filter:brightness(1.15)}",
    ".pp .modal.popped{background:transparent;pointer-events:none;display:block}",
    ".pp .modal.popped .box{pointer-events:auto;position:fixed;margin:0;max-height:82vh;overflow:auto}",
    ".pp .modal h3{margin:0 0 4px;font-size:13px}",
    ".pp .modal p.desc{margin:0 0 10px;font-size:11.5px;color:var(--sub)}",
    ".pp .field{margin-bottom:9px;display:flex;flex-direction:column;gap:4px}",
    ".pp .field label{font-size:11.5px;color:var(--sub)}",
    ".pp .field input,.pp .field textarea,.pp .field select,.pp .modal input.filter{background:var(--field);border:1px solid var(--bd);color:var(--fg);border-radius:8px;padding:7px 9px;font-size:12px;outline:none;font-family:inherit}",
    ".pp .field textarea{min-height:150px;resize:vertical;font-family:ui-monospace,Consolas,monospace}",
    ".pp .field input:focus,.pp .field textarea:focus,.pp .field select:focus,.pp .modal input.filter:focus{border-color:var(--accent)}",
    ".pp input.filter{width:100%;margin-bottom:8px}",
    ".pp table{border-collapse:collapse;width:100%;font-size:11.5px}",
    ".pp td.grouphead{background:var(--hover);font-weight:700;color:var(--fg);padding:6px 8px;border-bottom:1px solid var(--bd)}",
    // Sticky table headers park below the floating Pin/Pop controls so the
    // two never overlap after scrolling (controls row height ~23px).
    ".pp th{position:sticky;top:26px;background:var(--bg);text-align:left;color:var(--sub);font-weight:600;padding:5px 6px;border-bottom:1px solid var(--bd);white-space:nowrap}",
    ".pp td{padding:4px 6px;border-bottom:1px solid var(--bd);vertical-align:top;word-break:break-word}",
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
    ".pp button.running{opacity:.75;cursor:default}",
    ".pp button.running::before{content:'';display:inline-block;width:10px;height:10px;margin-right:6px;border:2px solid rgba(127,127,127,.4);border-top-color:currentColor;border-radius:50%;vertical-align:-2px;animation:pp-spin .7s linear infinite}",
    ".pp .foot button.primary.running::before{border-color:rgba(255,255,255,.35);border-top-color:#fff}",
    "@keyframes pp-spin{to{transform:rotate(360deg)}}",
    ".pp .actions{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:8px 0 10px;min-width:100%}",
    ".pp .actions-buttons{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-left:auto;position:sticky;right:0}",
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
    ".pp .ua-chips{display:flex;flex-wrap:wrap;margin-bottom:6px}",
    // Roles and teams editors side by side; footer pinned to the dialog bottom.
    ".pp .ua-cols{display:flex;gap:14px;align-items:flex-start}",
    ".pp .ua-col{flex:1;min-width:0;display:flex;flex-direction:column}",
    ".pp .ua-foot{position:sticky;bottom:0;z-index:5;background:var(--bg);border-top:1px solid var(--bd);margin:10px -14px 0;padding:10px 14px 0}",
    // Footer notes bar: disclaimer + project link (mirrors the original pane's
    // "crm-power-pane-notes" bar from onurmenal/crm-power-pane).
    ".pp .ft{display:flex;align-items:center;gap:8px;padding:5px 20px 5px 9px;border-top:1px solid var(--bd)}",
    ".pp .ft .note{flex:1;min-width:0;font-size:10.5px;line-height:1.35;color:var(--sub)}",
    ".pp .ft a{display:inline-flex;align-items:center;gap:4px;flex:none;font-size:10.5px;color:var(--accent);text-decoration:none}",
    ".pp .ft a:hover{text-decoration:underline}",
    ".pp .ft a svg{width:12px;height:12px;fill:currentColor}"
  ].join("");

  const host = document.createElement("div");
  host.id = "pp-host";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  root.appendChild(style);

  const wrap = document.createElement("div");
  wrap.className = "pp";
  root.appendChild(wrap);

  const bolt =
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13l1-8z"/></svg>';

  /** GitHub mark (octicon) for the pane footer link. */
  const githubMark =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "btn";
  toggleBtn.title = PP.SHORT_NAME + " (Alt+P)";
  toggleBtn.innerHTML = bolt;

  const panel = document.createElement("div");
  panel.className = "panel hidden";
  panel.innerHTML =
    '<div class="hd"><b>' + PP.SHORT_NAME + '</b><span class="imp-pill" hidden></span><span class="sp"></span>' +
    '<button data-act="theme" title="Toggle theme">&#9788;</button>' +
    '<button data-act="options" title="Options">&#9881;</button>' +
    '<button data-act="close" title="Close">&times;</button></div>' +
    '<div class="search"><input type="text" placeholder="Search actions... (Alt+P)"/></div>' +
    '<div class="list"></div>' +
    '<div class="ft">' +
    '<span class="note">Developed for developers, testers and power users; not recommended for end-users or production use.</span>' +
    '<a href="https://github.com/Musecanyang/dynamics-365-power-pane-next" target="_blank" rel="noopener noreferrer" title="Dynamics 365 Power Pane Next on GitHub">' +
    githubMark +
    "GitHub</a>" +
    "</div>";

  const toastLayer = document.createElement("div");

  wrap.appendChild(toggleBtn);
  wrap.appendChild(panel);
  wrap.appendChild(toastLayer);

  const listEl = panel.querySelector(".list");
  const searchEl = panel.querySelector(".search input");
  const pill = panel.querySelector(".imp-pill");
  let itemButtons = [];
  let activeIndex = -1;
  let pageBtn = null;

  /* ------------------------------------------------------------------ *
   * Action list rendering
   * ------------------------------------------------------------------ */

  /** Actions that pass the visibility + search filter, in declaration order. */
  function visibleActions() {
    const query = (searchEl.value || "").toLowerCase();
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
    const actions = visibleActions();
    listEl.textContent = "";
    itemButtons = [];
    activeIndex = -1;
    if (!actions.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No matching actions.";
      listEl.appendChild(empty);
      return;
    }

    // Group by declaration order.
    const groups = [];
    actions.forEach(function (action) {
      let group = groups.filter(function (candidate) {
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
          let indexA = state.order.indexOf(a.id);
          let indexB = state.order.indexOf(b.id);
          if (indexA === -1) indexA = ORDER_UNSET_INDEX;
          if (indexB === -1) indexB = ORDER_UNSET_INDEX;
          return indexA - indexB;
        });
      }
    });

    groups.forEach(function (group) {
      const block = document.createElement("div");
      block.className = "grp";
      const heading = document.createElement("h4");
      heading.textContent = group.name;
      heading.style.color = groupColor(group.name);
      block.appendChild(heading);

      group.items.forEach(function (action) {
        const button = document.createElement("button");
        button.className = "item";

        const dot = document.createElement("span");
        dot.className = "dot";
        dot.style.background = groupColor(group.name);
        const label = document.createElement("span");
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
    lastOpenAt = Date.now();
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
        debugLog("pane.optionsOpen", e);
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
    const existing = toastLayer.querySelector(".toast");
    if (existing) existing.remove();
    const node = document.createElement("div");
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
   * @param {{wide?: boolean, pinned?: boolean}} [opts] `pinned` defaults the
   *        dialog to the pinned state (immune to backdrop clicks).
   * @returns {HTMLElement} the modal element
   */
  function openModal(buildBody, opts) {
    opts = opts || {};
    const modal = document.createElement("div");
    modal.className = "modal";
    const box = document.createElement("div");
    box.className =
      "box" +
      (opts.wide ? " wide" : "") +
      (opts.fixedWidth ? " fixedw" : "");
    modal.appendChild(box);

    const controls = document.createElement("div");
    controls.className = "modalctl";
    const pinButton = document.createElement("button");
    pinButton.type = "button";
    pinButton.title = "Pin: keep open when clicking outside";
    pinButton.textContent = "Pin";
    const popButton = document.createElement("button");
    popButton.type = "button";
    popButton.title = "Pop out: float over the page without blocking it";
    popButton.textContent = "Pop";
    controls.appendChild(pinButton);
    controls.appendChild(popButton);

    const content = document.createElement("div");
    content.className = "modal-content";
    // The controls live inside the content flow (sticky, right-aligned) so
    // they follow wide dialogs horizontally instead of staying put while the
    // table scrolls under them.
    content.appendChild(controls);
    box.appendChild(content);

    pinButton.addEventListener("click", function () {
      setPinned(!modal.classList.contains("pinned"));
    });
    /**
     * Toggle the pinned state programmatically (also used to default-pin
     * dialogs that must not be dismissed by an accidental backdrop click).
     * Exposed on the modal for callers that pin from outside.
     * @param {boolean} on
     */
    function setPinned(on) {
      modal.classList.toggle("pinned", !!on);
      pinButton.textContent = on ? "Pinned" : "Pin";
    }
    if (opts.pinned) setPinned(true);
    modal._setPinned = setPinned;
    popButton.addEventListener("click", function () {
      const on = modal.classList.toggle("popped");
      popButton.textContent = on ? "Dock" : "Pop";
      if (on) {
        const rect = box.getBoundingClientRect();
        box.style.left = Math.max(8, rect.left) + "px";
        box.style.top = Math.max(8, rect.top) + "px";
      } else {
        box.style.left = "";
        box.style.top = "";
      }
    });

    let drag = null;
    box.addEventListener("mousedown", function (event) {
      if (!modal.classList.contains("popped")) return;
      const tag = (event.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea" || tag === "button" || tag === "a" || tag === "label") {
        return;
      }
      const rect = box.getBoundingClientRect();
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
    const first = content.querySelector("input,textarea");
    // preventScroll: with wide dialogs the filter spans the full scroll
    // width; focusing it would otherwise auto-scroll the dialog sideways
    // (columns would not start at the left edge).
    if (first) first.focus({ preventScroll: true });
    return modal;
  }

  /**
   * Shared floating action bar for result dialogs: `[count] …spacer…
   * [buttons]`. The row spans the dialog's content width while the sticky
   * button group stays pinned to the visible top-right, so the controls track
   * wide dialogs horizontally instead of scrolling out of view. Buttons are
   * rendered in the given order; each dialog passes only the ones that apply.
   * @param {{count?: string, buttons: Array<{label: string, className?: string, title?: string, onClick: function}>}} spec
   * @returns {{bar: HTMLElement, buttons: HTMLElement}}
   */
  function buildActionBar(spec) {
    const bar = document.createElement("div");
    bar.className = "actions";
    if (spec.count) {
      const count = document.createElement("span");
      count.className = "muted";
      count.textContent = spec.count;
      bar.appendChild(count);
    }
    const buttons = document.createElement("div");
    buttons.className = "actions-buttons";
    (spec.buttons || []).forEach(function (button) {
      const el = document.createElement("button");
      if (button.className) el.className = button.className;
      el.textContent = button.label;
      if (button.title) el.title = button.title;
      el.addEventListener("click", button.onClick);
      buttons.appendChild(el);
    });
    bar.appendChild(buttons);
    return { bar: bar, buttons: buttons };
  }

  /** Render a value as a chip list / <pre> / plain text node. */
  function valueNode(value) {
    const container = document.createElement("div");
    container.className = "v";
    if (Array.isArray(value)) {
      if (!value.length) {
        container.textContent = "(none)";
      } else {
        value.forEach(function (item) {
          const chip = document.createElement("span");
          chip.className = "chip";
          chip.textContent = item;
          container.appendChild(chip);
        });
      }
    } else if (typeof value === "string" && value.length > LONG_VALUE_THRESHOLD) {
      const pre = document.createElement("pre");
      pre.textContent = value;
      container.appendChild(pre);
    } else {
      container.textContent = value == null ? "" : String(value);
    }
    return container;
  }

  /** A small "copy" affordance bound to a value. */
  function copyBtn(text) {
    const button = document.createElement("span");
    button.className = "cp";
    button.textContent = "copy";
    button.addEventListener("click", function () {
      copyText(String(text)).then(function () {
        toast("Copied to clipboard.", "success");
      });
    });
    return button;
  }

  /**
   * Render a `{ title, description, items }` result dialog.
   * @param {Object} output
   * @param {{pinned?: boolean, source?: {type: string, xml: string}}} [opts]
   *        `source` enables the "Save to Snippets" action for the content
   *        that produced this output.
   */
  function showOutput(output, opts) {
    opts = opts || {};
    openModal(function (box, close) {
      const heading = document.createElement("h3");
      heading.textContent = output.title || "Result";
      box.appendChild(heading);
      if (output.description) {
        const description = document.createElement("p");
        description.className = "desc";
        description.textContent = output.description;
        box.appendChild(description);
      }
      // Optional top action bar (kept above the content like the table
      // dialog's action bar). Close lives there too, matching the table
      // dialog layout.
      if (opts.source && opts.source.xml) {
        const action = buildActionBar({
          buttons: [
            {
              label: "Save to Snippets",
              onClick: function () {
                saveSnippetDialog(opts.source, close);
              }
            },
            {
              label: "Close",
              className: "primary",
              onClick: close
            }
          ]
        });
        box.appendChild(action.bar);
      }
      (output.items || []).forEach(function (item) {
        const row = document.createElement("div");
        row.className = "out";
        const key = document.createElement("div");
        key.className = "k";
        key.appendChild(document.createTextNode(item.label));
        if (!Array.isArray(item.value) && typeof item.value !== "object") {
          key.appendChild(copyBtn(item.value == null ? "" : item.value));
        }
        row.appendChild(key);
        row.appendChild(valueNode(item.value));
        box.appendChild(row);
      });
      // Without a top action bar fall back to the classic bottom Close
      // button.
      if (!(opts.source && opts.source.xml)) {
        const foot = document.createElement("div");
        foot.className = "foot";
        const closeButton = document.createElement("button");
        closeButton.className = "primary";
        closeButton.textContent = "Close";
        closeButton.addEventListener("click", close);
        foot.appendChild(closeButton);
        box.appendChild(foot);
      }
    }, { pinned: !!opts.pinned });
  }

  /**
   * Prompt for a name and save content as a snippet, then close the given
   * result dialog (when provided) so the flow feels complete.
   * @param {{type: string, xml: string}} source snippet content
   * @param {function} [closeResult] closes the result dialog after saving
   */
  function saveSnippetDialog(source, closeResult) {
    openModal(function (box, close) {
      const heading = document.createElement("h3");
      heading.textContent = "Save to Snippets";
      box.appendChild(heading);
      const description = document.createElement("p");
      description.className = "desc";
      description.textContent = "Saved in this browser only (chrome.storage.local).";
      box.appendChild(description);

      const typeField = snippetTypeField();
      typeField.select.value = source.type === "js" ? "js" : "fetchxml";
      box.appendChild(typeField.root);

      const nameField = document.createElement("div");
      nameField.className = "field";
      const nameLabel = document.createElement("label");
      nameLabel.textContent = "Name";
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.placeholder = "Snippet name";
      nameField.appendChild(nameLabel);
      nameField.appendChild(nameInput);
      box.appendChild(nameField);

      const foot = document.createElement("div");
      foot.className = "foot";
      const cancelButton = document.createElement("button");
      cancelButton.textContent = "Cancel";
      cancelButton.addEventListener("click", close);
      const saveButton = document.createElement("button");
      saveButton.className = "primary";
      saveButton.textContent = "Save";
      saveButton.addEventListener("click", function () {
        const name = nameInput.value.trim() || "Untitled";
        state.snippets.push({ name: name, xml: source.xml, type: typeField.select.value });
        localSet(PP.LOCAL.SNIPPETS, state.snippets).then(function () {
          toast('Saved snippet "' + name + '".', "success");
          close();
          if (typeof closeResult === "function") closeResult();
        });
      });
      foot.appendChild(cancelButton);
      foot.appendChild(saveButton);
      box.appendChild(foot);
      nameInput.focus();
    }, { pinned: true });
  }

  /**
   * Render a `{ title, columns, rows }` table dialog (filter/CSV/copy).
   * @param {Object} table
   * @param {{pinned?: boolean, source?: {type: string, xml: string}}} [opts]
   *        `source` enables the "Save to Snippets" action for the content
   *        that produced this table.
   */
  function showTable(table, opts) {
    opts = opts || {};
    openModal(
      function (box, close) {
        const heading = document.createElement("h3");
        heading.textContent = table.title || "Result";
        box.appendChild(heading);
        if (table.description) {
          const description = document.createElement("p");
          description.className = "desc";
          description.textContent = table.description;
          box.appendChild(description);
        }

        let filter = null;
        if (table.searchable) {
          filter = document.createElement("input");
          filter.className = "filter";
          filter.placeholder = "Filter...";
          box.appendChild(filter);
        }

        const tbl = document.createElement("table");
        const hasUrl = (table.rows || []).some(function (row) {
          return row.url;
        });

        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        (table.columns || []).forEach(function (column) {
          const th = document.createElement("th");
          th.textContent = column.label;
          headRow.appendChild(th);
        });
        if (hasUrl) {
          headRow.appendChild(document.createElement("th"));
        }
        thead.appendChild(headRow);
        tbl.appendChild(thead);

        const tbody = document.createElement("tbody");
        tbl.appendChild(tbody);

        function renderRows() {
          const query = filter ? (filter.value || "").toLowerCase() : "";
          let lastGroup = null;
          tbody.textContent = "";
          (table.rows || []).forEach(function (row) {
            let text = (table.columns || [])
              .map(function (column) {
                return row[column.key] == null ? "" : String(row[column.key]);
              })
              .join(" ");
            if (table.groupBy) {
              text += " " + (row[table.groupBy] == null ? "" : String(row[table.groupBy]));
            }
            if (query && text.toLowerCase().indexOf(query) === -1) return;

            if (table.groupBy) {
              const groupValue = row[table.groupBy];
              if (groupValue !== lastGroup) {
                lastGroup = groupValue;
                const groupRow = document.createElement("tr");
                const groupCell = document.createElement("td");
                groupCell.className = "grouphead";
                groupCell.colSpan = (table.columns || []).length + (hasUrl ? 1 : 0);
                groupCell.textContent = groupValue;
                groupRow.appendChild(groupCell);
                tbody.appendChild(groupRow);
              }
            }

            const tr = document.createElement("tr");
            (table.columns || []).forEach(function (column) {
              const td = document.createElement("td");
              td.className = "col-" + column.key;
              // The text lives in a span so a column can cap its own width.
              // `max-width` on the `td` itself is unreliable with
              // `table-layout:auto`, whereas the inline-block span honours it.
              const cell = document.createElement("span");
              cell.className = "cell";
              const cellText = row[column.key] == null ? "" : String(row[column.key]);
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
              const urlCell = document.createElement("td");
              if (row.url) {
                const openButton = document.createElement("button");
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

        // Shared floating action bar. The `.box.wide` content spans the
        // table's full width (see CSS), so the sticky button group tracks the
        // horizontal scroll and stays pinned at the visible top-right.
        const actionRows = [];
        // Optional "Save to Snippets" for the source that produced this
        // table (Run Code flow); shown first, before the copy buttons.
        if (opts.source && opts.source.xml) {
          actionRows.push({
            label: "Save to Snippets",
            onClick: function () {
              saveSnippetDialog(opts.source, close);
            }
          });
        }

        const action = buildActionBar({
          count: (table.rows || []).length + " row(s)",
          buttons: actionRows
            .concat(
              // Optional one-click copy of the raw data (e.g. the Web API
              // JSON for "All Fields"); only when the table carries it.
              table.rawJson
                ? [
                    {
                      label: "Copy JSON",
                      onClick: function () {
                        copyText(table.rawJson).then(function () {
                          toast("Copied raw JSON to clipboard.", "success");
                        });
                      }
                    }
                  ]
                : []
            )
            .concat([
              {
                label: "CSV",
                onClick: function () {
                  function quote(value) {
                    value = value == null ? "" : String(value);
                    return '"' + value.replace(/"/g, '""') + '"';
                  }
                  const lines = [
                    (table.columns || [])
                      .map(function (column) {
                        return quote(column.label);
                      })
                      .join(",")
                  ];
                  [].slice.call(tbody.querySelectorAll("tr")).forEach(function (tr) {
                    const cells = [].slice.call(tr.querySelectorAll("td"));
                    if (hasUrl) cells.pop();
                    lines.push(
                      cells
                        .map(function (td) {
                          return quote(td.textContent);
                        })
                        .join(",")
                    );
                  });
                  downloadTextFile(
                    "power-pane-export.csv",
                    "\ufeff" + lines.join("\r\n"),
                    "text/csv;charset=utf-8;"
                  );
                }
              },
              {
                label: "Copy table",
                onClick: function () {
                  const lines = [];
                  lines.push(
                    (table.columns || [])
                      .map(function (column) {
                        return column.label;
                      })
                      .join("\t")
                  );
                  const rows = [].slice.call(tbody.querySelectorAll("tr"));
                  rows.forEach(function (tr) {
                    const cells = [].slice.call(tr.querySelectorAll("td"));
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
                }
              },
              {
                label: "Close",
                className: "primary",
                onClick: close
              }
            ])
        });
        // Keep the action bar at the top of the dialog so copy/export are
        // reachable without scrolling to the bottom of a long table.
        box.insertBefore(action.bar, filter || tbl);
      },
      { wide: true, pinned: !!opts.pinned }
    );
  }

  /**
   * Prompt for an action's inputs, then call `submit(args, done)`. The dialog
   * stays open with a running state until the submit callback reports the
   * outcome (`done(true)` closes it, `done(false)` restores the buttons).
   */
  function promptInputs(action, submit, ctx) {
    // The Run handler below fires only after openModal() has returned, so
    // capturing the modal element here is safe (and gives us programmatic
    // pin control for the running state).
    const modalRef = openModal(function (box, close) {
      const heading = document.createElement("h3");
      heading.textContent = action.label;
      box.appendChild(heading);
      const description = document.createElement("p");
      description.className = "desc";
      description.textContent = "Fill the inputs and run.";
      box.appendChild(description);

      const inputs = [];
      (action.inputs || []).forEach(function (spec) {
        const field = document.createElement("div");
        field.className = "field";
        const label = document.createElement("label");
        label.textContent = spec.label;
        field.appendChild(label);
        const input =
          spec.type === "textarea"
            ? document.createElement("textarea")
            : spec.type === "select"
            ? document.createElement("select")
            : document.createElement("input");
        if (spec.type === "input" || !spec.type) input.type = "text";
        if (spec.type === "select" && Array.isArray(spec.options)) {
          spec.options.forEach(function (pair) {
            const option = document.createElement("option");
            option.value = pair[0];
            option.textContent = pair[1];
            input.appendChild(option);
          });
        }
        if (spec.placeholder) input.placeholder = spec.placeholder;
        if (spec.defaultCurrent && ctx && ctx.entityName) input.value = ctx.entityName;
        field.appendChild(input);

        if (spec.entity) {
          input.setAttribute("autocomplete", "off");
          const results = document.createElement("div");
          results.className = "entity-results";
          field.appendChild(results);
          let debounceTimer = null;
          input.addEventListener("input", function () {
            clearTimeout(debounceTimer);
            const query = input.value.trim();
            if (query.length < MIN_USER_SEARCH_LENGTH) {
              results.textContent = "";
              return;
            }
            debounceTimer = setTimeout(function () {
              send("searchEntities", { query: query })
                .then(function (response) {
                  results.textContent = "";
                  ((response && response.entities) || []).forEach(function (entity) {
                    const option = document.createElement("button");
                    option.type = "button";
                    option.className = "entity-opt";
                    const logicalName = document.createElement("span");
                    logicalName.className = "lname";
                    logicalName.textContent = entity.logical;
                    const displayName = document.createElement("span");
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
                .catch(function (error) {
                  /* entity search failed; leave results empty (breadcrumbs via debugLog) */
                  debugLog("pane.entitySearch", error);
                });
            }, ENTITY_SEARCH_DEBOUNCE_MS);
          });
        }

        box.appendChild(field);
        inputs.push({ name: spec.name, el: input, spec: spec, labelEl: label });
      });

      // "Run Code" language select: sync the source field's label
      // and placeholder with the chosen language.
      const modeSelect = inputs.find(function (field) {
        return field.spec && field.spec.name === "mode" && field.spec.type === "select";
      });
      const sourceField = inputs.find(function (field) {
        return field.spec && field.spec.name === "xml" && field.spec.type === "textarea";
      });
      if (modeSelect && sourceField) {
        const syncLanguage = function () {
          const isJs = modeSelect.el.value === "js";
          sourceField.labelEl.textContent = isJs ? "JavaScript" : "FetchXML";
          sourceField.el.placeholder = isJs
            ? "// JavaScript runs in the page world.\n// Use `return` to produce output. `xrm` is in scope."
            : "<fetch>...</fetch>";
        };
        modeSelect.el.addEventListener("change", syncLanguage);
        syncLanguage();
        // Auto-detected language on paste: data that starts with an XML tag
        // (a query pasted from Advanced Find / MarkMpn.SQL4CDS while the JS
        // default is selected) flips the select to FetchXML immediately, so
        // the visible mode always matches what the dispatch will execute.
        sourceField.el.addEventListener("input", function () {
          if (!modeSelect.el.disabled && /^\s*<(\?xml|fetch|entity)\b/i.test(sourceField.el.value)) {
            modeSelect.el.value = "fetchxml";
            syncLanguage();
          }
        });
      }

      const foot = document.createElement("div");
      foot.className = "foot";
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", close);
      const runButton = document.createElement("button");
      runButton.className = "primary";
      runButton.textContent = "Run";
      runButton.addEventListener("click", function () {
        const args = {};
        inputs.forEach(function (field) {
          args[field.name] = field.el.value;
        });
        // Keep the dialog open while the request runs; show a running state
        // on the Run button. Pin it so a stray backdrop click cannot dismiss
        // a running request. The callback closes the dialog on success and
        // restores the buttons on failure so the user can retry.
        if (modalRef && modalRef._setPinned) modalRef._setPinned(true);
        runButton.classList.add("running");
        runButton.textContent = "Running...";
        runButton.disabled = true;
        cancel.disabled = true;
        submit(args, function (success) {
          if (success) {
            close();
          } else {
            runButton.classList.remove("running");
            runButton.textContent = "Run";
            runButton.disabled = false;
            cancel.disabled = false;
          }
        });
      });
      foot.appendChild(cancel);
      foot.appendChild(runButton);
      box.appendChild(foot);
    });
    return modalRef;
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
  const localHandlers = {};
  /** One-time hooks run at the end of mount(); feature sections register here. */
  const onMountHooks = [];

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
    function execute(args, done) {
      if (action.local && localHandlers[action.command]) {
        localHandlers[action.command]();
        return;
      }
      button.disabled = true;

      // "Run Code" runs FetchXML or JavaScript: the Language select picks the
      // initial mode, but the CONTENT wins the dispatch - anything starting
      // with an XML tag (fetch / entity / an XML declaration, e.g. a query
      // pasted from MarkMpn.SQL4CDS) is always treated as FetchXML even while
      // the JS default is selected. Everything else routes to its own handler.
      let command = action.command;
      let executedType = "fetchxml";
      if (action.id === "fetch-xml") {
        const looksLikeXml = /^\s*<(\?xml|fetch|entity)\b/i.test(args.xml || "");
        const executed = looksLikeXml || args.mode !== "js" ? "fetchxml" : "js";
        command = executed === "js" ? "runScript" : "executeFetchXml";
        executedType = executed;
      }

      // Only the "Run Code" flow pins its result dialog (the source is kept
      // around too, so the result offers "Save to Snippets"). Other actions
      // keep the default dismissible behavior.
      const isRunCode = action.id === "fetch-xml";
      const source = isRunCode
        ? { type: executedType, xml: args.xml }
        : null;

      const resultOptions = { source: source, pinned: isRunCode };

      send(command, args)
        .then(function (result) {
          // Close the input dialog only now, so it stays open (with its
          // running state) for the whole request.
          if (typeof done === "function") done(true);
          if (result && result.output) showOutput(result.output, resultOptions);
          if (result && result.table) showTable(result.table, resultOptions);
          if (result && result.message) toast(result.message, result.level);
        })
        .catch(function (err) {
          // On error keep the dialog open so the user can fix the input and
          // retry; just surface the error as a toast.
          if (typeof done === "function") done(false);
          toast(err.message, "error");
        })
        .finally(function () {
          button.disabled = false;
        });
    }

    if (action.inputs && action.inputs.length) {
      const needsCurrent = action.inputs.some(function (input) {
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

  let dragState = null;
  /** Timestamp of the last openPanel(), used by saveLayout's animation guard. */
  let lastOpenAt = 0;
  const panelHeader = panel.querySelector(".hd");
  panelHeader.addEventListener("mousedown", function (event) {
    if (event.target.closest("button")) return;
    const rect = panel.getBoundingClientRect();
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

  const resizeObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(function () {
          if (!dragState) saveLayout();
        })
      : null;
  if (resizeObserver) resizeObserver.observe(panel);

  function saveLayout() {
    // ResizeObserver also fires when the panel is shown/hidden; a hidden
    // element measures 0x0 and persisting that corrupts the saved layout
    // (it made the panel open shrink-to-fit at left:0 after every refresh).
    if (panel.classList.contains("hidden")) return;
    if (Date.now() - lastOpenAt < OPEN_ANIMATION_MS) return; // mid-animation rect is shifted by the keyframe translateY
    const rect = panel.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    state.layout = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    localSet(PP.LOCAL.LAYOUT, state.layout);
  }

  function applyLayout() {
    const layout = state.layout;
    // Heal degenerate layouts persisted by older builds (0x0 rects measured
    // while the panel was display:none): fall back to the default position
    // instead of pinning the panel to left:0 with a shrink-to-fit width.
    if (!layout || !(layout.width > 0) || !(layout.height > 0)) {
      state.layout = null;
      panel.style.left = "";
      panel.style.top = "";
      panel.style.right = "";
      panel.style.bottom = "";
      panel.style.width = "";
      panel.style.height = "";
      layoutPanelTop();
      return;
    }
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
    const parts = combo.split("+");
    const key = parts.pop().toLowerCase();
    const needAlt = parts.indexOf("Alt") > -1;
    const needCtrl = parts.indexOf("Ctrl") > -1;
    const needShift = parts.indexOf("Shift") > -1;
    const needMeta = parts.indexOf("Meta") > -1;
    if (event.altKey !== needAlt || event.ctrlKey !== needCtrl || event.shiftKey !== needShift || event.metaKey !== needMeta) {
      return false;
    }
    const pressed = (event.key || "").toLowerCase();
    return pressed === key || pressed === " " + key;
  }

  document.addEventListener("keydown", function (event) {
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "p" || event.key === "P")) {
      event.preventDefault();
      togglePanel();
      return;
    }
    const target = event.target;
    const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if (typing) return;
    for (const id in state.shortcuts) {
      if (matchCombo(event, state.shortcuts[id])) {
        const action = ACTIONS.filter(function (candidate) {
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
          panel.style.right = "";
          panel.style.width = "";
          panel.style.height = "";
          layoutPanelTop();
          placeButton();
        }
      }
    });
  } catch (e) {
    debugLog("prefs.onChangedListener", e);
    /* storage.onChanged unavailable; live updates are disabled */
  }

  /* ------------------------------------------------------------------ *
   * Dismissal (outside click / Escape / pointer leave)
   * ------------------------------------------------------------------ */

  document.addEventListener(
    "mousedown",
    function (event) {
      if (panel.classList.contains("hidden")) return;
      const path = event.composedPath ? event.composedPath() : [];
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
    const header =
      document.querySelector('div[data-id="topBar"]') ||
      document.querySelector("#crmMasthead") ||
      document.querySelector("#navBar") ||
      document.querySelector("header");
    if (!header) return 8;
    return Math.round(header.getBoundingClientRect().bottom) + 6;
  }

  function ensurePageStyle() {
    if (document.getElementById("pp-inline-style")) return;
    const styleEl = document.createElement("style");
    styleEl.id = "pp-inline-style";
    styleEl.textContent =
      ".pp-inline-btn{float:left;display:flex;align-items:center;justify-content:center;width:44px;border:none;background:transparent;cursor:pointer;color:#ffffff;opacity:.92;padding:0;margin:0;box-sizing:border-box}" +
      ".pp-inline-btn.abs{position:absolute;left:0;top:0}" +
      ".pp-inline-btn:hover{background:rgba(255,255,255,.18);opacity:1}" +
      ".pp-inline-btn svg{width:24px;height:24px}";
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function findNavTarget() {
    const topBar = document.querySelector('div[data-id="topBar"]');
    if (topBar) return { parent: topBar, prepend: true };
    const navBar = document.querySelector("#navBar");
    if (navBar) return { parent: navBar, prepend: true };
    return null;
  }



  function placeButton() {
    ensurePageStyle();
    const target = findNavTarget();
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
    const needsMove =
      pageBtn.parentElement !== target.parent ||
      (target.prepend && target.parent.firstElementChild !== pageBtn);
    if (needsMove) {
      if (target.prepend) target.parent.insertBefore(pageBtn, target.parent.firstChild);
      else target.parent.appendChild(pageBtn);
    }
    pageBtn.classList.remove("abs");
    let height = target.parent.getBoundingClientRect().height;
    const navTabGroup = document.getElementById("navTabGroupDiv");
    if (navTabGroup && target.parent.contains(navTabGroup)) height = navTabGroup.getBoundingClientRect().height;
    try {
      pageBtn.style.height = Math.round(height) + "px";
    } catch (e) {
      debugLog("layout.buttonHeight", e);
    }
    pageBtn.style.color = state.impersonation && state.impersonation.user ? "#ffcf4d" : "#ffffff";
    toggleBtn.style.display = "none";
  }

  function layoutPanelTop() {
    // Initial placement only: while the panel is open, MutationObserver-driven
    // calls must not yank it back to the top (it also fought in-progress drags).
    if (state.layout || !panel.classList.contains("hidden")) return;
    panel.style.top = headerBottom() + "px";
    panel.style.left = "8px";
  }

  function updateVisibility() {
    try {
      const shell = hasAppShell();
      host.style.display = shell ? "" : "none";
      if (shell) placeButton();
      layoutPanelTop();
    } catch (e) {
      debugLog("layout.visibility", e);
    }
  }

  window.addEventListener("resize", function () {
    placeButton();
    layoutPanelTop();
  });



  /* ------------------------------------------------------------------ *
   * Mount
   * ------------------------------------------------------------------ */

  async function mount() {
    (document.body || document.documentElement).appendChild(host);
    updateVisibility();

    let visibilityTimer = null;
    try {
      new MutationObserver(function () {
        clearTimeout(visibilityTimer);
        visibilityTimer = setTimeout(updateVisibility, 80);
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      debugLog("pane.mutationObserver", e);
      /* observer unavailable */
    }

    let fastTries = 0;
    const fastTimer = setInterval(function () {
      updateVisibility();
      fastTries++;
      if (fastTries > 40) clearInterval(fastTimer);
    }, 150);

    renderList();

    const syncDefaults = {};
    syncDefaults[PP.SYNC.SETTINGS] = {};
    syncDefaults[PP.SYNC.THEME] = PP.THEME.DARK;
    syncDefaults[PP.SYNC.SHORTCUTS] = {};
    syncDefaults[PP.SYNC.ORDER] = [];
    const syncData = await syncGet(syncDefaults);
    state.settings = syncData[PP.SYNC.SETTINGS] || {};
    state.shortcuts = syncData[PP.SYNC.SHORTCUTS] || {};
    state.order = syncData[PP.SYNC.ORDER] || [];
    setTheme(syncData[PP.SYNC.THEME] || PP.THEME.DARK, false);

    // Snippets live in storage.local (10 MB quota) instead of storage.sync
    // (8 KB per key), so a FetchXML library can grow without silently hitting
    // the sync ceiling. One-time migration: move any legacy sync copy over and
    // drop it from sync. Harmless no-op when there is nothing to migrate.
    const snippetsLoaded = (await localGet(PP.LOCAL.SNIPPETS, [])) || [];
    if (!snippetsLoaded.length) {
      const legacy = await syncGet({ [PP.LOCAL.SNIPPETS]: [] });
      if (legacy[PP.LOCAL.SNIPPETS] && legacy[PP.LOCAL.SNIPPETS].length) {
        await localSet(PP.LOCAL.SNIPPETS, legacy[PP.LOCAL.SNIPPETS]);
        await syncRemove([PP.LOCAL.SNIPPETS]);
        state.snippets = legacy[PP.LOCAL.SNIPPETS];
      }
    } else {
      state.snippets = snippetsLoaded;
    }
    renderList();

    const layout = await localGet(PP.LOCAL.LAYOUT, null);
    state.layout = layout;
    applyLayout();

    const users = await Promise.all([
      localGet(PP.LOCAL.RECENT_USERS, []),
      localGet(PP.LOCAL.PINNED_USERS, [])
    ]);
    const recentUsers = users[0] || [];
    const pinnedUsers = users[1] || [];
    state.recent = recentUsers;
    state.pinned = pinnedUsers;

    onMountHooks.forEach(function (hook) {
      try {
        hook();
      } catch (e) {
        debugLog("features.onMount", e);
        /* a feature hook must never break the pane */
      }
    });
  }
  /* ------------------------------------------------------------------ *
   * Public surface for the feature modules (content/features/*.js).
   * ------------------------------------------------------------------ */

  /**
   * Boot the pane. Invoked exactly once by content/boot.js after every
   * feature module has registered its locals and mount hooks.
   */
  function boot() {
    if (window.__ppNextBooted) return;
    window.__ppNextBooted = true;
    mount();
  }

  /**
   * The surface a feature module is allowed to touch. Everything a feature
   * needs (state, helpers, constants) must be listed here on purpose - a
   * feature module reaching for a core-only identifier is a bug, not a
   * convenience. Frozen to keep the wiring contract fixed.
   */
  const PPPane = {
    state: state,
    send: send,
    bgSend: bgSend,
    toast: toast,
    openModal: openModal,
    showOutput: showOutput,
    showTable: showTable,
    renderImpersonation: renderImpersonation,
    registerLocal: registerLocal,
    onMount: onMount,
    localGet: localGet,
    localSet: localSet,
    MIN_USER_SEARCH_LENGTH: MIN_USER_SEARCH_LENGTH,
    USER_SEARCH_DEBOUNCE_MS: USER_SEARCH_DEBOUNCE_MS,
    USER_SEARCH_RESULT_LIMIT: USER_SEARCH_RESULT_LIMIT,
    TEAM_LIST_LIMIT: TEAM_LIST_LIMIT,
    RECENT_USERS_LIMIT: RECENT_USERS_LIMIT,
    RELOAD_DELAY_MS: RELOAD_DELAY_MS,
    boot: boot
  };

  try {
    Object.freeze(PPPane);
  } catch (e) {
    /* Older engines: freezing is best-effort only. */
  }

  window.PPPane = PPPane;
})();