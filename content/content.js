/**
 * Dynamics 365 Power Pane Next - in-page UI (isolated world content script).
 *
 * Responsibilities:
 *   - Render the action pane (Shadow DOM so host page styles never leak in).
 *   - Persist/apply user preferences (visibility, order, theme, shortcuts).
 *   - Forward action commands to the MAIN-world bridge and render results.
 *   - Drive the impersonation UX (search/select, status, cache handling).
 *   - Host the in-app "User Permissions" editor.
 *
 * Dependencies: src/constants.js (PP), src/actions.js (POWER_PANE_ACTIONS).
 * The MAIN-world bridge is content/main-world.js.
 */
(function () {
  "use strict";
  if (window.__ppNextUiLoaded) return;
  window.__ppNextUiLoaded = true;

  var PP =
    window.PP ||
    {
      NAME: "Dynamics 365 Power Pane Next",
      SHORT_NAME: "Power Pane Next",
      SYNC: {
        SETTINGS: "ppSettings",
        THEME: "ppTheme",
        SHORTCUTS: "ppShortcuts",
        SNIPPETS: "ppSnippets",
        ORDER: "ppOrder"
      },
      LOCAL: {
        RECENT_USERS: "ppRecentUsers",
        PINNED_USERS: "ppPinnedUsers",
        LAYOUT: "ppLayout3",
        AUTO_OPEN_USERS: "ppAutoUsers"
      },
      MSG: {
        IMP_START: "pp:imp-start",
        IMP_STOP: "pp:imp-stop",
        IMP_STATUS: "pp:imp-status",
        IMP_RULES: "pp:imp-rules",
        RELOAD_TAB: "pp:reload",
        OPEN_OPTIONS: "pp-open-options",
        PANE_TOGGLE: "pp-toggle"
      },
      BRIDGE: { REQUEST: "req", RESPONSE: "res" }
    };
  var ACTIONS = window.POWER_PANE_ACTIONS || [];
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
  var pending = new Map();
  var seq = 0;

  var state = {
    settings: {},
    theme: "dark",
    layout: null,
    shortcuts: {},
    snippets: [],
    impersonation: null,
    recent: [],
    pinned: [],
    order: []
  };

  // ---- bridge ----------------------------------------------------------
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var msg = ev.data;
    if (!msg || msg.__pp !== "res") return;
    var entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error || "Action failed"));
  });

  function send(command, args) {
    return new Promise(function (resolve, reject) {
      var id = "pp-" + ++seq;
      var timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error("Timed out waiting for the page."));
      }, 30000);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      window.postMessage({ __pp: "req", id: id, command: command, args: args || {} }, "*");
    });
  }

  // ---- storage ---------------------------------------------------------
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
        chrome.storage.local.get({ [key]: fallback }, function (d) {
          resolve(d[key]);
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

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {}
    ta.remove();
  }

  // ---- styles ----------------------------------------------------------
  var CSS = [
    ":host{all:initial}",
    ".pp{--bg:#171a21;--fg:#e6e8ee;--sub:#8b93a7;--bd:#2c313c;--hover:#232836;--field:#0f1218;--accent:#3a63ff}",
    ".pp.light{--bg:#ffffff;--fg:#1c1f26;--sub:#6b7280;--bd:#e5e7eb;--hover:#f3f4f6;--field:#ffffff;--accent:#3a63ff}",
    ".pp *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
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
    ".pp .modal .box.wide{width:620px}",
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
    ".pp .foot button,.pp .mini{border:1px solid var(--bd);background:var(--hover);color:var(--fg);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer}",
    ".pp .foot button.primary{background:var(--accent);border-color:var(--accent);color:#fff}",
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
  var itemButtons = [];
  var activeIndex = -1;

  function visibleActions() {
    var q = (searchEl.value || "").toLowerCase();
    return ACTIONS.filter(function (a) {
      if (state.settings[a.id] === false) return false;
      if (q && a.label.toLowerCase().indexOf(q) === -1 && a.group.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  function renderList() {
    var list = visibleActions();
    listEl.textContent = "";
    itemButtons = [];
    activeIndex = -1;
    if (!list.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No matching actions.";
      listEl.appendChild(empty);
      return;
    }
    var groups = [];
    list.forEach(function (a) {
      var g = groups.filter(function (x) {
        return x.name === a.group;
      })[0];
      if (!g) {
        g = { name: a.group, items: [] };
        groups.push(g);
      }
      g.items.push(a);
    });
    groups.forEach(function (g) {
      if (state.order && state.order.length) {
        g.items.sort(function (a, b) {
          var ia = state.order.indexOf(a.id);
          var ib = state.order.indexOf(b.id);
          if (ia === -1) ia = 9999;
          if (ib === -1) ib = 9999;
          return ia - ib;
        });
      }
    });
    groups.forEach(function (g) {
      var blocks = document.createElement("div");
      blocks.className = "grp";
      var h = document.createElement("h4");
      h.textContent = g.name;
      h.style.color = groupColor(g.name);
      blocks.appendChild(h);
      g.items.forEach(function (a) {
        var b = document.createElement("button");
        b.className = "item";
        b.innerHTML = '<span class="dot" style="background:' + groupColor(g.name) + '"></span><span>' + a.label + "</span>";
        b.addEventListener("click", function () {
          // Close the pane first; any input/output modal is shown independently.
          panel.classList.add("hidden");
          runAction(a, b);
        });
        blocks.appendChild(b);
        itemButtons.push(b);
      });
      listEl.appendChild(blocks);
    });
  }

  function setActive(i) {
    if (!itemButtons.length) return;
    activeIndex = (i + itemButtons.length) % itemButtons.length;
    itemButtons.forEach(function (b, idx) {
      b.classList.toggle("active", idx === activeIndex);
    });
    itemButtons[activeIndex].scrollIntoView({ block: "nearest" });
  }

  function openPanel() {
    panel.classList.remove("hidden");
    panel.classList.remove("opening");
    void panel.offsetWidth;
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
    setTheme(state.theme === "dark" ? "light" : "dark", true);
  });
  panel.querySelector('[data-act="options"]').addEventListener("click", function () {
    bgSend({ type: PP.MSG.OPEN_OPTIONS }).catch(function () {
      try {
        chrome.runtime.openOptionsPage();
      } catch (e) {}
    });
  });
  searchEl.addEventListener("input", renderList);
  searchEl.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(activeIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(activeIndex - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && itemButtons[activeIndex]) itemButtons[activeIndex].click();
      else if (itemButtons[0]) itemButtons[0].click();
    } else if (e.key === "Escape") {
      panel.classList.add("hidden");
    }
  });

  // ---- theme -----------------------------------------------------------
  function setTheme(theme, persist) {
    state.theme = theme === "light" ? "light" : "dark";
    wrap.classList.toggle("light", state.theme === "light");
    panel.querySelector('[data-act="theme"]').innerHTML = state.theme === "light" ? "&#9790;" : "&#9788;";
    if (persist) syncSet({ [PP.SYNC.THEME]: state.theme });
  }

  // ---- toast -----------------------------------------------------------
  function toast(message, level) {
    var old = toastLayer.querySelector(".toast");
    if (old) old.remove();
    var t = document.createElement("div");
    t.className = "toast " + (level || "info");
    t.textContent = message;
    toastLayer.appendChild(t);
    setTimeout(function () {
      t.remove();
    }, 5000);
  }

  // ---- modals ----------------------------------------------------------
  function openModal(buildBody, opts) {
    opts = opts || {};
    var modal = document.createElement("div");
    modal.className = "modal";
    var box = document.createElement("div");
    box.className = "box" + (opts.wide ? " wide" : "");
    modal.appendChild(box);

    var ctl = document.createElement("div");
    ctl.className = "modalctl";
    var pin = document.createElement("button");
    pin.type = "button";
    pin.title = "Pin: keep open when clicking outside";
    pin.textContent = "Pin";
    var pop = document.createElement("button");
    pop.type = "button";
    pop.title = "Pop out: float over the page without blocking it";
    pop.textContent = "Pop";
    ctl.appendChild(pin);
    ctl.appendChild(pop);
    box.appendChild(ctl);

    var content = document.createElement("div");
    content.className = "modal-content";
    box.appendChild(content);

    pin.addEventListener("click", function () {
      var on = modal.classList.toggle("pinned");
      pin.textContent = on ? "Pinned" : "Pin";
    });
    pop.addEventListener("click", function () {
      var on = modal.classList.toggle("popped");
      pop.textContent = on ? "Dock" : "Pop";
      if (on) {
        var r = box.getBoundingClientRect();
        box.style.left = Math.max(8, r.left) + "px";
        box.style.top = Math.max(8, r.top) + "px";
      } else {
        box.style.left = "";
        box.style.top = "";
      }
    });

    var drag = null;
    box.addEventListener("mousedown", function (e) {
      if (!modal.classList.contains("popped")) return;
      var tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea" || tag === "button" || tag === "a" || tag === "label") {
        return;
      }
      var r = box.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!drag) return;
      box.style.left = Math.max(0, e.clientX - drag.dx) + "px";
      box.style.top = Math.max(0, e.clientY - drag.dy) + "px";
    });
    document.addEventListener("mouseup", function () {
      drag = null;
    });

    modal.addEventListener("click", function (e) {
      if (
        e.target === modal &&
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

  function valueNode(value) {
    var v = document.createElement("div");
    v.className = "v";
    if (Array.isArray(value)) {
      if (!value.length) v.textContent = "(none)";
      else
        value.forEach(function (item) {
          var chip = document.createElement("span");
          chip.className = "chip";
          chip.textContent = item;
          v.appendChild(chip);
        });
    } else if (typeof value === "string" && value.length > 400) {
      var pre = document.createElement("pre");
      pre.textContent = value;
      v.appendChild(pre);
    } else {
      v.textContent = value == null ? "" : String(value);
    }
    return v;
  }

  function copyBtn(text) {
    var c = document.createElement("span");
    c.className = "cp";
    c.textContent = "copy";
    c.addEventListener("click", function () {
      copyText(String(text)).then(function () {
        toast("Copied to clipboard.", "success");
      });
    });
    return c;
  }

  function showOutput(output) {
    openModal(function (box, close) {
      var h = document.createElement("h3");
      h.textContent = output.title || "Result";
      box.appendChild(h);
      if (output.description) {
        var d = document.createElement("p");
        d.className = "desc";
        d.textContent = output.description;
        box.appendChild(d);
      }
      (output.items || []).forEach(function (item) {
        var row = document.createElement("div");
        row.className = "out";
        var k = document.createElement("div");
        k.className = "k";
        k.appendChild(document.createTextNode(item.label));
        if (!Array.isArray(item.value) && typeof item.value !== "object") {
          k.appendChild(copyBtn(item.value == null ? "" : item.value));
        }
        row.appendChild(k);
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

  function showTable(table) {
    openModal(
      function (box, close) {
        var h = document.createElement("h3");
        h.textContent = table.title || "Result";
        box.appendChild(h);
        if (table.description) {
          var d = document.createElement("p");
          d.className = "desc";
          d.textContent = table.description;
          box.appendChild(d);
        }
        var filter = null;
        if (table.searchable) {
          filter = document.createElement("input");
          filter.className = "filter";
          filter.placeholder = "Filter...";
          box.appendChild(filter);
        }
        var tbl = document.createElement("table");
        var hasUrl = (table.rows || []).some(function (r) {
          return r.url;
        });
        var thead = document.createElement("thead");
        var htr = document.createElement("tr");
        (table.columns || []).forEach(function (col) {
          var th = document.createElement("th");
          th.textContent = col.label;
          htr.appendChild(th);
        });
        if (hasUrl) {
          var thx = document.createElement("th");
          htr.appendChild(thx);
        }
        thead.appendChild(htr);
        tbl.appendChild(thead);
        var tbody = document.createElement("tbody");
        tbl.appendChild(tbody);

        function renderRows() {
          var q = filter ? (filter.value || "").toLowerCase() : "";
          var lastGroup = null;
          tbody.textContent = "";
          (table.rows || []).forEach(function (row) {
            var text = (table.columns || [])
              .map(function (c) {
                return row[c.key] == null ? "" : String(row[c.key]);
              })
              .join(" ");
            if (table.groupBy) text += " " + (row[table.groupBy] == null ? "" : String(row[table.groupBy]));
            if (q && text.toLowerCase().indexOf(q) === -1) return;
            if (table.groupBy) {
              var g = row[table.groupBy];
              if (g !== lastGroup) {
                lastGroup = g;
                var gtr = document.createElement("tr");
                var gtd = document.createElement("td");
                gtd.className = "grouphead";
                gtd.colSpan = (table.columns || []).length + (hasUrl ? 1 : 0);
                gtd.textContent = g;
                gtr.appendChild(gtd);
                tbody.appendChild(gtr);
              }
            }
            var tr = document.createElement("tr");
            (table.columns || []).forEach(function (col) {
              var td = document.createElement("td");
              td.textContent = row[col.key] == null ? "" : String(row[col.key]);
              if (table.copyKey === col.key) {
                td.className = "copy";
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
              var tdo = document.createElement("td");
              if (row.url) {
                var ob = document.createElement("button");
                ob.className = "mini";
                ob.textContent = "Open";
                ob.addEventListener("click", function () {
                  send("openUrl", { url: row.url }).catch(function (err) {
                    toast(err.message, "error");
                  });
                });
                tdo.appendChild(ob);
              }
              tr.appendChild(tdo);
            }
            if (table.rowDetail && row._detail) {
              tr.style.cursor = "pointer";
              tr.title = "Click for details";
              tr.addEventListener("click", function (ev) {
                if (ev.target.closest && ev.target.closest("button")) return;
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

        var foot = document.createElement("div");
        foot.className = "foot split";
        var count = document.createElement("span");
        count.className = "muted";
        count.textContent = (table.rows || []).length + " row(s)";
        var right = document.createElement("span");
        var csvBtn = document.createElement("button");
        csvBtn.textContent = "CSV";
        csvBtn.addEventListener("click", function () {
          function q(v) {
            v = v == null ? "" : String(v);
            return '"' + v.replace(/"/g, '""') + '"';
          }
          var lines = [
            (table.columns || [])
              .map(function (c) {
                return q(c.label);
              })
              .join(",")
          ];
          [].slice.call(tbody.querySelectorAll("tr")).forEach(function (tr) {
            var cells = [].slice.call(tr.querySelectorAll("td"));
            if (hasUrl) cells.pop();
            lines.push(
              cells
                .map(function (td) {
                  return q(td.textContent);
                })
                .join(",")
            );
          });
          var blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
          var a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "power-pane-export.csv";
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () {
            URL.revokeObjectURL(a.href);
          }, 1500);
        });
        right.appendChild(csvBtn);
        var copyAll = document.createElement("button");
        copyAll.textContent = "Copy table";
        copyAll.addEventListener("click", function () {
          var lines = [];
          lines.push(
            (table.columns || [])
              .map(function (c) {
                return c.label;
              })
              .join("\t")
          );
          var trs = [].slice.call(tbody.querySelectorAll("tr"));
          trs.forEach(function (tr) {
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
            toast("Copied " + trs.length + " row(s) to clipboard.", "success");
          });
        });
        right.appendChild(copyAll);
        var ok = document.createElement("button");
        ok.className = "primary";
        ok.textContent = "Close";
        ok.addEventListener("click", close);
        right.appendChild(ok);
        foot.appendChild(count);
        foot.appendChild(right);
        box.appendChild(foot);
      },
      { wide: true }
    );
  }

  function promptInputs(action, submit, ctx) {
    openModal(function (box, close) {
      var h = document.createElement("h3");
      h.textContent = action.label;
      box.appendChild(h);
      var d = document.createElement("p");
      d.className = "desc";
      d.textContent = "Fill the inputs and run.";
      box.appendChild(d);
      var inputs = [];
      (action.inputs || []).forEach(function (spec) {
        var field = document.createElement("div");
        field.className = "field";
        var label = document.createElement("label");
        label.textContent = spec.label;
        field.appendChild(label);
        var el = document.createElement(spec.type === "textarea" ? "textarea" : "input");
        if (spec.type !== "textarea") el.type = "text";
        if (spec.placeholder) el.placeholder = spec.placeholder;
        if (spec.defaultCurrent && ctx && ctx.entityName) el.value = ctx.entityName;
        field.appendChild(el);
        if (spec.entity) {
          el.setAttribute("autocomplete", "off");
          var results = document.createElement("div");
          results.className = "entity-results";
          field.appendChild(results);
          var etimer = null;
          el.addEventListener("input", function () {
            clearTimeout(etimer);
            var q = el.value.trim();
            if (q.length < 2) {
              results.textContent = "";
              return;
            }
            etimer = setTimeout(function () {
              send("searchEntities", { query: q })
                .then(function (r) {
                  results.textContent = "";
                  ((r && r.entities) || []).forEach(function (ent) {
                    var b = document.createElement("button");
                    b.type = "button";
                    b.className = "entity-opt";
                    b.innerHTML =
                      "<span class='lname'>" +
                      ent.logical +
                      "</span><span class='dname'>" +
                      ent.display +
                      "</span>";
                    b.addEventListener("click", function () {
                      el.value = ent.logical;
                      results.textContent = "";
                    });
                    results.appendChild(b);
                  });
                })
                .catch(function () {});
            }, 250);
          });
        }
        box.appendChild(field);
        inputs.push({ name: spec.name, el: el });
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
        inputs.forEach(function (i) {
          args[i.name] = i.el.value;
        });
        close();
        submit(args);
      });
      foot.appendChild(cancel);
      foot.appendChild(ok);
      box.appendChild(foot);
    });
  }

  // ---- user permissions (in-app) --------------------------------------
  function openUserAccess() {
    openModal(
      function (box, close) {
        function esc(s) {
          return String(s == null ? "" : s).replace(/[&<>]/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
          });
        }
        var h = document.createElement("h3");
        h.textContent = "User Permissions";
        box.appendChild(h);
        var d = document.createElement("p");
        d.className = "desc";
        d.textContent = "View and modify a user's roles, teams and business unit. Changes apply immediately.";
        box.appendChild(d);

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
        var allBus = [];
        var metaReady = Promise.all([
          send("getAllRoles", {}),
          send("getAllTeams", {}),
          send("getBusinessUnits", {})
        ])
          .then(function (a) {
            allRoles = (a[0] && a[0].items) || [];
            allTeams = (a[1] && a[1].items) || [];
            allBus = (a[2] && a[2].items) || [];
          })
          .catch(function () {});

        function matches(text, query) {
          if (!query) return true;
          var terms = String(query)
            .toLowerCase()
            .split(/[,;\n]+/)
            .map(function (t) {
              return t.trim();
            })
            .filter(Boolean);
          if (!terms.length) return true;
          var lt = String(text || "").toLowerCase();
          return terms.some(function (t) {
            return lt.indexOf(t) > -1;
          });
        }

        function loadUser(u) {
          detail.textContent = "";
          var loading = document.createElement("div");
          loading.className = "muted";
          loading.textContent = "Loading access...";
          detail.appendChild(loading);
          Promise.all([send("getUserAccess", { userid: u.systemuserid }), metaReady])
            .then(function (a) {
              detail.textContent = "";
              renderUser(a[0]);
            })
            .catch(function (err) {
              detail.textContent = "";
              var e = document.createElement("div");
              e.className = "empty";
              e.textContent = err.message;
              detail.appendChild(e);
            });
        }

        function renderUser(res) {
          var userNameMap = {};
          allRoles.forEach(function (r) {
            userNameMap[r.id.toLowerCase()] = r.name;
          });
          res.roles.forEach(function (r) {
            userNameMap[r.id.toLowerCase()] = r.name;
          });
          var teamNameMap = {};
          allTeams.forEach(function (t) {
            teamNameMap[t.id.toLowerCase()] = t.name;
          });
          res.teams.forEach(function (t) {
            teamNameMap[t.id.toLowerCase()] = t.name;
          });

          var origRoles = {};
          res.roles.forEach(function (r) {
            origRoles[r.id.toLowerCase()] = true;
          });
          var curRoles = Object.assign({}, origRoles);
          var origTeams = {};
          res.teams.forEach(function (t) {
            origTeams[t.id.toLowerCase()] = true;
          });
          var curTeams = Object.assign({}, origTeams);
          var origBu = res.businessUnit ? res.businessUnit.id.toLowerCase() : "";
          var curBu = origBu;

          var head = document.createElement("div");
          head.className = "ua-head";
          head.innerHTML =
            "<b>" + esc(res.user.name) + "</b><div class='muted'>" + esc(res.user.email || "") + "</div>";
          detail.appendChild(head);

          var buRow = document.createElement("div");
          buRow.className = "ua-row";
          var buK = document.createElement("div");
          buK.className = "ua-k";
          buK.textContent = "Business Unit";
          var buV = document.createElement("div");
          buV.className = "ua-v";
          var buSel = document.createElement("select");
          allBus.forEach(function (b) {
            var o = document.createElement("option");
            o.value = b.id;
            o.textContent = b.name;
            if (b.id.toLowerCase() === curBu) o.selected = true;
            buSel.appendChild(o);
          });
          buSel.addEventListener("change", function () {
            curBu = buSel.value.toLowerCase();
            updateDirty();
          });
          buV.appendChild(buSel);
          buRow.appendChild(buK);
          buRow.appendChild(buV);
          detail.appendChild(buRow);

          var arTitle = document.createElement("div");
          arTitle.className = "sect";
          detail.appendChild(arTitle);
          var arChips = document.createElement("div");
          arChips.className = "ua-chips";
          detail.appendChild(arChips);
          function renderAssignedRoles() {
            arChips.textContent = "";
            var ids = Object.keys(curRoles);
            arTitle.textContent = "Assigned Roles (" + ids.length + ")";
            ids.sort().forEach(function (id) {
              var chip = document.createElement("span");
              chip.className = "chip";
              chip.appendChild(document.createTextNode((userNameMap[id] || id) + " "));
              var x = document.createElement("span");
              x.textContent = "\u00d7";
              x.style.cssText = "cursor:pointer;opacity:.7";
              x.addEventListener("click", function () {
                delete curRoles[id];
                renderAssignedRoles();
                renderRoles();
                updateDirty();
              });
              chip.appendChild(x);
              arChips.appendChild(chip);
            });
            if (!ids.length) {
              var m = document.createElement("span");
              m.className = "muted";
              m.textContent = "None";
              arChips.appendChild(m);
            }
          }

          var rt = document.createElement("div");
          rt.className = "sect";
          rt.textContent = "All Roles (this BU)";
          detail.appendChild(rt);
          var rsearch = document.createElement("input");
          rsearch.className = "filter";
          rsearch.placeholder = "Filter roles (comma = multiple)";
          detail.appendChild(rsearch);
          var rl = document.createElement("div");
          rl.className = "ua-list";
          detail.appendChild(rl);
          var roleSrcMap = {};
          allRoles
            .filter(function (r) {
              return !curBu || !r.buId || String(r.buId).toLowerCase() === curBu;
            })
            .forEach(function (r) {
              roleSrcMap[r.id.toLowerCase()] = r;
            });
          res.roles.forEach(function (r) {
            if (!roleSrcMap[r.id.toLowerCase()]) roleSrcMap[r.id.toLowerCase()] = r;
          });
          var roleSrc = Object.keys(roleSrcMap).map(function (k) {
            return roleSrcMap[k];
          });
          function renderRoles() {
            rl.textContent = "";
            roleSrc
              .filter(function (r) {
                return matches(r.name, rsearch.value);
              })
              .sort(function (a, b) {
                return a.name.localeCompare(b.name);
              })
              .forEach(function (r) {
                var lab = document.createElement("label");
                lab.className = "ua-item";
                var cb = document.createElement("input");
                cb.type = "checkbox";
                cb.checked = !!curRoles[r.id.toLowerCase()];
                cb.addEventListener("change", function () {
                  if (cb.checked) curRoles[r.id.toLowerCase()] = true;
                  else delete curRoles[r.id.toLowerCase()];
                  renderAssignedRoles();
                  updateDirty();
                });
                lab.appendChild(cb);
                lab.appendChild(document.createTextNode(r.name));
                rl.appendChild(lab);
              });
          }
          rsearch.addEventListener("input", renderRoles);

          var atTitle = document.createElement("div");
          atTitle.className = "sect";
          detail.appendChild(atTitle);
          var atChips = document.createElement("div");
          atChips.className = "ua-chips";
          detail.appendChild(atChips);
          function renderAssignedTeams() {
            atChips.textContent = "";
            var ids = Object.keys(curTeams);
            atTitle.textContent = "Teams (" + ids.length + ")";
            ids.sort().forEach(function (id) {
              var chip = document.createElement("span");
              chip.className = "chip";
              chip.appendChild(document.createTextNode((teamNameMap[id] || id) + " "));
              var x = document.createElement("span");
              x.textContent = "\u00d7";
              x.style.cssText = "cursor:pointer;opacity:.7";
              x.addEventListener("click", function () {
                delete curTeams[id];
                renderAssignedTeams();
                renderTeams();
                updateDirty();
              });
              chip.appendChild(x);
              atChips.appendChild(chip);
            });
            if (!ids.length) {
              var m = document.createElement("span");
              m.className = "muted";
              m.textContent = "None";
              atChips.appendChild(m);
            }
          }

          var tsearch = document.createElement("input");
          tsearch.className = "filter";
          tsearch.placeholder = "Search teams to add (comma = multiple)";
          detail.appendChild(tsearch);
          var tlist = document.createElement("div");
          tlist.className = "ua-list";
          detail.appendChild(tlist);
          function renderTeams() {
            tlist.textContent = "";
            allTeams
              .filter(function (t) {
                return !curTeams[t.id.toLowerCase()];
              })
              .filter(function (t) {
                return matches(t.name, tsearch.value);
              })
              .sort(function (a, b) {
                return a.name.localeCompare(b.name);
              })
              .slice(0, 200)
              .forEach(function (t) {
                var row = document.createElement("div");
                row.className = "ua-item";
                var nm = document.createElement("span");
                nm.style.flex = "1";
                nm.textContent = t.name;
                var add = document.createElement("button");
                add.className = "mini";
                add.textContent = "Add";
                add.addEventListener("click", function () {
                  curTeams[t.id.toLowerCase()] = true;
                  teamNameMap[t.id.toLowerCase()] = t.name;
                  renderAssignedTeams();
                  renderTeams();
                  updateDirty();
                });
                row.appendChild(nm);
                row.appendChild(add);
                tlist.appendChild(row);
              });
          }
          tsearch.addEventListener("input", renderTeams);

          var saveRow = document.createElement("div");
          saveRow.className = "foot split";
          detail.appendChild(saveRow);
          var info = document.createElement("span");
          info.className = "muted";
          saveRow.appendChild(info);
          var saveBtn = document.createElement("button");
          saveBtn.className = "primary";
          saveBtn.textContent = "Save";
          saveRow.appendChild(saveBtn);

          function diff() {
            var ops = [];
            Object.keys(curRoles).forEach(function (id) {
              if (!origRoles[id]) ops.push({ t: "assignRole", id: id });
            });
            Object.keys(origRoles).forEach(function (id) {
              if (!curRoles[id]) ops.push({ t: "removeRole", id: id });
            });
            Object.keys(curTeams).forEach(function (id) {
              if (!origTeams[id]) ops.push({ t: "addTeam", id: id });
            });
            Object.keys(origTeams).forEach(function (id) {
              if (!curTeams[id]) ops.push({ t: "removeTeam", id: id });
            });
            if (curBu && curBu !== origBu) ops.push({ t: "bu", id: curBu });
            return ops;
          }
          function updateDirty() {
            var n = diff().length;
            info.textContent = n ? n + " pending change(s)" : "No changes";
            saveBtn.disabled = !n;
          }
          saveBtn.addEventListener("click", function () {
            var ops = diff();
            if (!ops.length) return;
            saveBtn.disabled = true;
            var calls = ops.map(function (op) {
              if (op.t === "assignRole") return send("assignRole", { userid: res.user.id, roleid: op.id });
              if (op.t === "removeRole") return send("removeRole", { userid: res.user.id, roleid: op.id });
              if (op.t === "addTeam") return send("addTeam", { userid: res.user.id, teamid: op.id });
              if (op.t === "removeTeam") return send("removeTeam", { userid: res.user.id, teamid: op.id });
              if (op.t === "bu") return send("setBusinessUnit", { userid: res.user.id, buid: op.id });
              return Promise.resolve();
            });
            Promise.all(calls)
              .then(function () {
                toast("Saved " + ops.length + " change(s).", "success");
                loadUser(res.user);
              })
              .catch(function (err) {
                toast(err.message, "error");
                saveBtn.disabled = false;
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
          var q = search.value.trim();
          if (q.length < 2) {
            results.textContent = "";
            return;
          }
          timer = setTimeout(function () {
            send("searchUsers", { query: q })
              .then(function (r) {
                results.textContent = "";
                ((r && r.users) || []).slice(0, 15).forEach(function (u) {
                  var row = document.createElement("div");
                  row.className = "user";
                  var meta = document.createElement("div");
                  meta.className = "meta";
                  var nm = document.createElement("div");
                  nm.className = "nm";
                  nm.textContent = u.fullname || "(no name)";
                  var em = document.createElement("div");
                  em.className = "em";
                  em.textContent = u.internalemailaddress || "";
                  meta.appendChild(nm);
                  meta.appendChild(em);
                  var btn = document.createElement("button");
                  btn.className = "mini primary";
                  btn.textContent = "Open";
                  btn.addEventListener("click", function () {
                    results.textContent = "";
                    loadUser(u);
                  });
                  row.appendChild(meta);
                  row.appendChild(btn);
                  results.appendChild(row);
                });
              })
              .catch(function () {});
          }, 350);
        });

        var foot = document.createElement("div");
        foot.className = "foot";
        var cl = document.createElement("button");
        cl.textContent = "Close";
        cl.addEventListener("click", close);
        foot.appendChild(cl);
        box.appendChild(foot);
      },
      { wide: true }
    );
  }

  // ---- fetchxml snippets ----------------------------------------------
  function openSnippets() {
    openModal(function (box, close) {
      function render() {
        box.textContent = "";
        var h = document.createElement("h3");
        h.textContent = "FetchXML Snippets";
        box.appendChild(h);
        var d = document.createElement("p");
        d.className = "desc";
        d.textContent = "Save and reuse FetchXML queries.";
        box.appendChild(d);

        if (!state.snippets.length) {
          var e = document.createElement("div");
          e.className = "empty";
          e.textContent = "No snippets yet.";
          box.appendChild(e);
        }
        state.snippets.forEach(function (s, i) {
          var row = document.createElement("div");
          row.className = "srow";
          var nm = document.createElement("span");
          nm.className = "nm";
          nm.textContent = s.name;
          row.appendChild(nm);
          var run = document.createElement("button");
          run.className = "mini";
          run.textContent = "Run";
          run.addEventListener("click", function () {
            close();
            send("executeFetchXml", { xml: s.xml })
              .then(function (r) {
                if (r && r.output) showOutput(r.output);
                if (r && r.message) toast(r.message, r.level);
              })
              .catch(function (err) {
                toast(err.message, "error");
              });
          });
          var edit = document.createElement("button");
          edit.className = "mini";
          edit.textContent = "Edit";
          edit.addEventListener("click", function () {
            form(s, i);
          });
          var del = document.createElement("button");
          del.className = "mini";
          del.textContent = "Del";
          del.addEventListener("click", function () {
            state.snippets.splice(i, 1);
            syncSet({ [PP.SYNC.SNIPPETS]: state.snippets }).then(render);
          });
          row.appendChild(run);
          row.appendChild(edit);
          row.appendChild(del);
          box.appendChild(row);
        });

        var foot = document.createElement("div");
        foot.className = "foot";
        var add = document.createElement("button");
        add.className = "primary";
        add.textContent = "New";
        add.addEventListener("click", function () {
          form(null, -1);
        });
        var cl = document.createElement("button");
        cl.textContent = "Close";
        cl.addEventListener("click", close);
        foot.appendChild(add);
        foot.appendChild(cl);
        box.appendChild(foot);
      }

      function form(snippet, index) {
        box.textContent = "";
        var h = document.createElement("h3");
        h.textContent = index >= 0 ? "Edit Snippet" : "New Snippet";
        box.appendChild(h);
        var nameField = document.createElement("div");
        nameField.className = "field";
        var nl = document.createElement("label");
        nl.textContent = "Name";
        var nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.value = snippet ? snippet.name : "";
        nameField.appendChild(nl);
        nameField.appendChild(nameInput);
        box.appendChild(nameField);
        var xmlField = document.createElement("div");
        xmlField.className = "field";
        var xl = document.createElement("label");
        xl.textContent = "FetchXML";
        var xmlArea = document.createElement("textarea");
        xmlArea.value = snippet ? snippet.xml : "";
        xmlField.appendChild(xl);
        xmlField.appendChild(xmlArea);
        box.appendChild(xmlField);
        var foot = document.createElement("div");
        foot.className = "foot";
        var back = document.createElement("button");
        back.textContent = "Back";
        back.addEventListener("click", render);
        var save = document.createElement("button");
        save.className = "primary";
        save.textContent = "Save";
        save.addEventListener("click", function () {
          var name = nameInput.value.trim() || "Untitled";
          if (index >= 0) state.snippets[index] = { name: name, xml: xmlArea.value };
          else state.snippets.push({ name: name, xml: xmlArea.value });
          syncSet({ [PP.SYNC.SNIPPETS]: state.snippets }).then(render);
        });
        foot.appendChild(back);
        foot.appendChild(save);
        box.appendChild(foot);
        nameInput.focus();
      }

      render();
    });
  }

  // ---- impersonation ---------------------------------------------------
  var pill = panel.querySelector(".imp-pill");

  function bgSend(message) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(message, function (res) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!res || !res.ok) {
            reject(new Error((res && res.error) || "Background request failed."));
            return;
          }
          resolve(res);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

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

  function refreshImpersonation() {
    return bgSend({ type: PP.MSG.IMP_STATUS, hostname: location.hostname })
      .then(function (res) {
        renderImpersonation(res.impersonation);
        return res.impersonation;
      })
      .catch(function () {
        return null;
      });
  }

  function openImpersonate() {
    refreshImpersonation().then(buildImpersonateModal);
  }

  function userRow(u, onPinChanged) {
    var row = document.createElement("div");
    row.className = "user";
    var meta = document.createElement("div");
    meta.className = "meta";
    var nm = document.createElement("div");
    nm.className = "nm";
    nm.textContent = u.fullname || "(no name)";
    var em = document.createElement("div");
    em.className = "em";
    em.textContent = u.internalemailaddress || u.domainname || "";
    meta.appendChild(nm);
    meta.appendChild(em);

    var pinBtn = document.createElement("button");
    pinBtn.className = "mini";
    pinBtn.title = isPinned(u) ? "Unpin" : "Pin";
    pinBtn.textContent = isPinned(u) ? "\u2605" : "\u2606";
    pinBtn.addEventListener("click", function () {
      togglePin(u);
      if (onPinChanged) onPinChanged();
    });

    var btn = document.createElement("button");
    btn.className = "mini primary";
    btn.textContent = "Impersonate";
    btn.addEventListener("click", function () {
      startImpersonate(u);
    });

    row.appendChild(meta);
    row.appendChild(pinBtn);
    row.appendChild(btn);
    return row;
  }

  function buildImpersonateModal() {
    openModal(function (box, close) {
      var h = document.createElement("h3");
      h.textContent = "Impersonate User";
      box.appendChild(h);
      var d = document.createElement("p");
      d.className = "desc";
      d.textContent = "Search by name, email or domain. Requires prvActOnBehalfOfAnotherUser.";
      box.appendChild(d);

      if (state.impersonation && state.impersonation.user) {
        var bar = document.createElement("div");
        bar.className = "impbar";
        var nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = "Active: " + state.impersonation.user.fullname;
        var stop = document.createElement("button");
        stop.className = "mini";
        stop.textContent = "Stop";
        stop.addEventListener("click", stopImpersonate);
        bar.appendChild(nm);
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
          var t1 = document.createElement("div");
          t1.className = "sect";
          t1.textContent = "Pinned";
          quick.appendChild(t1);
          state.pinned.forEach(function (u) {
            quick.appendChild(userRow(u, renderQuick));
          });
        }
        var recentOnly = state.recent.filter(function (u) {
          return !isPinned(u);
        });
        if (recentOnly.length) {
          var t2 = document.createElement("div");
          t2.className = "sect";
          t2.textContent = "Recent";
          quick.appendChild(t2);
          recentOnly.forEach(function (u) {
            quick.appendChild(userRow(u, renderQuick));
          });
        }
      }
      renderQuick();

      var timer = null;
      function doSearch() {
        var q = search.value.trim();
        if (q.length < 2) {
          results.textContent = "";
          return;
        }
        results.textContent = "";
        var loading = document.createElement("div");
        loading.className = "muted";
        loading.textContent = "Searching...";
        results.appendChild(loading);
        send("searchUsers", { query: q })
          .then(function (res) {
            var users = (res && res.users) || [];
            results.textContent = "";
            var t = document.createElement("div");
            t.className = "sect";
            t.textContent = "Search Results";
            results.appendChild(t);
            if (!users.length) {
              var none = document.createElement("div");
              none.className = "empty";
              none.textContent = "No users found.";
              results.appendChild(none);
              return;
            }
            users.forEach(function (u) {
              results.appendChild(userRow(u, function () {}));
            });
          })
          .catch(function (err) {
            results.textContent = "";
            var e = document.createElement("div");
            e.className = "empty";
            e.textContent = err.message;
            results.appendChild(e);
          });
      }
      search.addEventListener("input", function () {
        clearTimeout(timer);
        timer = setTimeout(doSearch, 350);
      });

      var foot = document.createElement("div");
      foot.className = "foot";
      var cl = document.createElement("button");
      cl.textContent = "Close";
      cl.addEventListener("click", close);
      foot.appendChild(cl);
      box.appendChild(foot);
    });
  }

  function slimUser(u) {
    return {
      systemuserid: u.systemuserid,
      fullname: u.fullname,
      internalemailaddress: u.internalemailaddress,
      domainname: u.domainname,
      azureactivedirectoryobjectid: u.azureactivedirectoryobjectid
    };
  }

  function isPinned(user) {
    var id = user && user.systemuserid;
    return !!id && state.pinned.some(function (p) {
      return p.systemuserid === id;
    });
  }

  function togglePin(user) {
    if (!user || !user.systemuserid) return;
    if (isPinned(user)) {
      state.pinned = state.pinned.filter(function (p) {
        return p.systemuserid !== user.systemuserid;
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
        state.recent.filter(function (u) {
          return u.systemuserid !== user.systemuserid;
        })
      )
      .slice(0, 3);
    localSet(PP.LOCAL.RECENT_USERS, state.recent);
  }

  // Drop the cached identity key so a bypass-cache reload rebuilds it.
  // NOTE: intentionally does NOT wipe Cache Storage / IndexedDB - doing so
  // corrupts the D365 client's local store and leaves it stuck on "Loading...".
  function clearIdentityCaches() {
    try {
      localStorage.removeItem("Microsoft.Crm.BusinessProcessClientCache");
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (/^Form:(userquery|savedquery)$/i.test(k) || /savedquery|viewcache/i.test(k)) {
          localStorage.removeItem(k);
        }
      }
    } catch (e) {}
    return Promise.resolve();
  }

  function applyImpersonation(user) {
    return bgSend({ type: PP.MSG.IMP_START, hostname: location.hostname, user: user })
      .then(function () {
        renderImpersonation({ user: user });
        addRecent(user);
        return clearIdentityCaches();
      })
      .then(function () {
        return new Promise(function (r) {
          setTimeout(r, 300);
        });
      })
      .then(function () {
        return bgSend({ type: PP.MSG.RELOAD_TAB });
      })
      .then(function () {
        toast("Impersonating " + (user.fullname || "user") + ". Reloading...", "success");
      });
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

  function stopImpersonate() {
    bgSend({ type: PP.MSG.IMP_STOP, hostname: location.hostname })
      .then(function () {
        renderImpersonation(null);
        return clearIdentityCaches();
      })
      .then(function () {
        return new Promise(function (r) {
          setTimeout(r, 300);
        });
      })
      .then(function () {
        return bgSend({ type: PP.MSG.RELOAD_TAB });
      })
      .then(function () {
        toast("Impersonation stopped. Reloading...", "success");
      })
      .catch(function (err) {
        toast(err.message, "error");
      });
  }

  function openDnrRules() {
    bgSend({ type: PP.MSG.IMP_RULES })
      .then(function (res) {
        var rules = (res && res.rules) || [];
        showOutput({
          title: "Impersonation Debug",
          description: rules.length + " session rule(s)",
          items: [
            { label: "Rules", value: JSON.stringify(rules, null, 2) },
            { label: "Hosts", value: JSON.stringify((res && res.hosts) || {}, null, 2) },
            { label: "Tabs", value: JSON.stringify((res && res.tabs) || {}, null, 2) }
          ]
        });
      })
      .catch(function (err) {
        toast(err.message, "error");
      });
  }

  var localHandlers = {
    snippets: openSnippets,
    impersonate: openImpersonate,
    impersonateStop: stopImpersonate,
    dnrRules: openDnrRules,
    userAccess: openUserAccess,
    advancedSettingsUsers: function () {
      localSet(PP.LOCAL.AUTO_OPEN_USERS, Date.now());
      window.open(location.origin + "/main.aspx?settingsonly=true", PP.LOCAL.AUTO_OPEN_USERS);
      toast("Opening Advanced Settings > Users...", "success");
    }
  };

  // ---- run -------------------------------------------------------------
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
      var needsCurrent = action.inputs.some(function (i) {
        return i.defaultCurrent;
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
    } else execute({});
  }

  // ---- drag & resize ---------------------------------------------------
  var dragState = null;
  var hd = panel.querySelector(".hd");
  hd.addEventListener("mousedown", function (e) {
    if (e.target.closest("button")) return;
    var rect = panel.getBoundingClientRect();
    dragState = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    panel.style.left = rect.left + "px";
    panel.style.top = rect.top + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    e.preventDefault();
  });
  document.addEventListener("mousemove", function (e) {
    if (!dragState) return;
    panel.style.left = Math.max(0, e.clientX - dragState.dx) + "px";
    panel.style.top = Math.max(minPanelTop(), e.clientY - dragState.dy) + "px";
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
  function minPanelTop() {
    return headerBottom();
  }

  function applyLayout() {
    var L = state.layout;
    if (!L) return;
    if (L.left != null) {
      panel.style.left = Math.max(0, L.left) + "px";
      panel.style.right = "auto";
    }
    if (L.top != null) {
      panel.style.top = Math.max(minPanelTop(), L.top) + "px";
      panel.style.bottom = "auto";
    }
    if (L.width) panel.style.width = L.width + "px";
    if (L.height) panel.style.height = L.height + "px";
  }

  // ---- shortcuts -------------------------------------------------------
  function matchCombo(e, combo) {
    if (!combo) return false;
    var parts = combo.split("+");
    var key = parts.pop().toLowerCase();
    var needAlt = parts.indexOf("Alt") > -1;
    var needCtrl = parts.indexOf("Ctrl") > -1;
    var needShift = parts.indexOf("Shift") > -1;
    var needMeta = parts.indexOf("Meta") > -1;
    if (e.altKey !== needAlt || e.ctrlKey !== needCtrl || e.shiftKey !== needShift || e.metaKey !== needMeta) return false;
    var k = (e.key || "").toLowerCase();
    return k === key || k === " " + key;
  }

  document.addEventListener("keydown", function (e) {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "p" || e.key === "P")) {
      e.preventDefault();
      togglePanel();
      return;
    }
    var target = e.target;
    var typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if (typing) return;
    for (var id in state.shortcuts) {
      if (matchCombo(e, state.shortcuts[id])) {
        var action = ACTIONS.filter(function (a) {
          return a.id === id && state.settings[a.id] !== false;
        })[0];
        if (action) {
          e.preventDefault();
          runAction(action, { disabled: false });
        }
        return;
      }
    }
  });

  // ---- toolbar ---------------------------------------------------------
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === PP.MSG.PANE_TOGGLE) togglePanel();
  });

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "sync") {
        if (changes[PP.SYNC.SETTINGS]) state.settings = changes[PP.SYNC.SETTINGS].newValue || {};
        if (changes[PP.SYNC.ORDER]) state.order = changes[PP.SYNC.ORDER].newValue || [];
        if (changes[PP.SYNC.SHORTCUTS]) state.shortcuts = changes[PP.SYNC.SHORTCUTS].newValue || {};
        if (changes[PP.SYNC.THEME]) setTheme(changes[PP.SYNC.THEME].newValue || "dark", false);
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
  } catch (e) {}

  // ---- close on outside click / Escape --------------------------------
  document.addEventListener(
    "mousedown",
    function (e) {
      if (panel.classList.contains("hidden")) return;
      var path = e.composedPath ? e.composedPath() : [];
      if (path.indexOf(host) > -1) return;
      panel.classList.add("hidden");
    },
    true
  );
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !panel.classList.contains("hidden")) panel.classList.add("hidden");
  });
  // Close when the pointer leaves the pane (unless a modal is open).
  panel.addEventListener("mouseleave", function () {
    if (wrap.querySelector(".modal")) return;
    panel.classList.add("hidden");
  });

  // ---- mount -----------------------------------------------------------
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
    var hdr =
      document.querySelector('div[data-id="topBar"]') ||
      document.querySelector("#crmMasthead") ||
      document.querySelector("#navBar") ||
      document.querySelector("header");
    if (!hdr) return 8;
    return Math.round(hdr.getBoundingClientRect().bottom) + 6;
  }

  var pageBtn = null;
  function ensurePageStyle() {
    if (document.getElementById("pp-inline-style")) return;
    var s = document.createElement("style");
    s.id = "pp-inline-style";
    s.textContent =
      ".pp-inline-btn{float:left;display:flex;align-items:center;justify-content:center;width:44px;border:none;background:transparent;cursor:pointer;color:#ffffff;opacity:.92;padding:0;margin:0;box-sizing:border-box}" +
      ".pp-inline-btn.abs{position:absolute;left:0;top:0}" +
      ".pp-inline-btn:hover{background:rgba(255,255,255,.18);opacity:1}" +
      ".pp-inline-btn svg{width:24px;height:24px}";
    (document.head || document.documentElement).appendChild(s);
  }

  function findNavTarget() {
    var topBar = document.querySelector('div[data-id="topBar"]');
    if (topBar) return { parent: topBar, prepend: true };
    var navBar = document.querySelector("#navBar");
    if (navBar) return { parent: navBar, prepend: true };
    return null;
  }

  function realClick(el) {
    try {
      var opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
    } catch (e) {
      try {
        el.click();
      } catch (e2) {}
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
      pageBtn.addEventListener("click", function (e) {
        e.stopPropagation();
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
    var h = target.parent.getBoundingClientRect().height;
    var tg = document.getElementById("navTabGroupDiv");
    if (tg && target.parent.contains(tg)) h = tg.getBoundingClientRect().height;
    try {
      pageBtn.style.height = Math.round(h) + "px";
    } catch (e) {}
    pageBtn.style.color =
      state.impersonation && state.impersonation.user ? "#ffcf4d" : "#ffffff";
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
    } catch (e) {}
  }

  window.addEventListener("resize", function () {
    placeButton();
    layoutPanelTop();
  });

  // Auto-navigate classic Advanced Settings to Security > Users when opened via
  // the "Advanced Settings - Users" action (flagged in extension storage).
  function autoOpenUsers() {
    var byName = window.name === PP.LOCAL.AUTO_OPEN_USERS;
    localGet(PP.LOCAL.AUTO_OPEN_USERS, 0).then(function (ts) {
      var byStore = ts && Date.now() - ts < 120000;
      if (!byName && !byStore) return;
      if (byName) {
        try {
          window.name = "";
        } catch (e) {}
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
          var sw = document.getElementById("TabSettings-main");
          var area =
            sw ||
            labels.filter(function (b) {
              var lab =
                (b.getAttribute("aria-label") || "") +
                " " +
                (b.getAttribute("title") || "") +
                " " +
                (b.textContent || "");
              return /settings area/i.test(lab) || /settings.*go to/i.test(lab);
            })[0];
          if (area) {
            realClick(area);
            step = 1;
          }
        } else if (step === 1) {
          var sec = labels.filter(function (e) {
            return (e.textContent || "").trim() === "Security" && e.offsetParent !== null;
          })[0];
          if (sec) {
            realClick(sec);
            step = 2;
          }
        } else if (step === 2) {
          var doc = document;
          try {
            var fr = document.getElementById("contentIFrame0");
            if (fr && fr.contentDocument) doc = fr.contentDocument;
          } catch (e) {}
          var u = [].slice.call(doc.querySelectorAll("a,span,td,div")).filter(function (e) {
            return (e.textContent || "").trim() === "Users" && e.offsetParent !== null;
          })[0];
          if (u) {
            realClick(u);
            clearInterval(timer);
          }
        }
      }, 800);
    });
  }

  function mount() {
    (document.body || document.documentElement).appendChild(host);
    updateVisibility();
    autoOpenUsers();
    var visTimer = null;
    try {
      new MutationObserver(function () {
        clearTimeout(visTimer);
        visTimer = setTimeout(updateVisibility, 80);
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    var fastTries = 0;
    var fast = setInterval(function () {
      updateVisibility();
      fastTries++;
      if (fastTries > 40) clearInterval(fast);
    }, 150);
    applyLayout();
    renderList();
    var syncDefaults = {};
    syncDefaults[PP.SYNC.SETTINGS] = {};
    syncDefaults[PP.SYNC.THEME] = "dark";
    syncDefaults[PP.SYNC.SHORTCUTS] = {};
    syncDefaults[PP.SYNC.SNIPPETS] = [];
    syncDefaults[PP.SYNC.ORDER] = [];
    syncGet(syncDefaults).then(function (data) {
      state.settings = data[PP.SYNC.SETTINGS] || {};
      state.snippets = data[PP.SYNC.SNIPPETS] || [];
      state.shortcuts = data[PP.SYNC.SHORTCUTS] || {};
      state.order = data[PP.SYNC.ORDER] || [];
      setTheme(data[PP.SYNC.THEME] || "dark", false);
      renderList();
    });
    localGet(PP.LOCAL.LAYOUT, null).then(function (layout) {
      state.layout = layout;
      applyLayout();
    });
    Promise.all([localGet(PP.LOCAL.RECENT_USERS, []), localGet(PP.LOCAL.PINNED_USERS, [])]).then(function (vals) {
      state.recent = vals[0] || [];
      state.pinned = vals[1] || [];
    });
    refreshImpersonation();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
