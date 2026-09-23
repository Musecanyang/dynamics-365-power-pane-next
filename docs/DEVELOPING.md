# Dynamics 365 Power Pane Next — Developer & Deployment Guide

> The complete path for "build it yourself, deploy it yourself":
> environment setup, project layout, the daily dev loop, testing, quality
> gates, and the three ways to distribute the extension (personal use /
> private distribution / enterprise deployment).
> Contribution rules & etiquette (commit style, PR norms) live in
> **[CONTRIBUTING.md](../CONTRIBUTING.md)**.
> Quick links: architecture → §2 · daily dev loop → §4 · adding an action → §5
> · deployment → §7 · known pitfalls → §9 · release checklist → §10.

---

## 1. Prerequisites

| Software | Version | Purpose |
| --- | --- | --- |
| Chrome or Edge | 111+ (needs `world: "MAIN"` content scripts) | running / debugging |
| Node.js | ≥ 22 (local tooling only) | ESLint / syntax checks / unit tests |
| Git | any recent version | commits & releases (CI runs on GitHub Actions) |

- **The extension itself has zero dependencies and zero build step**: the
  runtime files are the JS files you see; load the folder and edit them.
- The Node toolchain is only guardrails (lint / tests); it never runs
  as part of the extension.
- First time: `npm install` (devDependencies only: eslint, globals,
  @xmldom/xmldom).

---

## 2. 30-minute layout & the "three worlds"

### 2.1 Directory map

```
manifest.json                 MV3 manifest: background / content_scripts / options
background.js                 Service worker: toolbar toggle + impersonation (DNR)

shared/                       readable by all three worlds - the shared layer
  constants.js                PP.* constants namespace (frozen): storage keys /
                              message types / bridge markers
  util.js                     PPUtil.*: pure helpers (matches / el / userRow / debugLog…)
  actions.js                  POWER_PANE_ACTIONS: the one action list

content/                      injected page scripts (see 2.2; the folder's own
                              README.md maps the world split)
options/                      options page (html + js)
icons/                        toolbar icons

tests/                        unit tests (node --test) + guardrails (syntax,
                              manifest, bridge/debug markers)
.github/workflows/            ci.yml (every push), release.yml (tag vX.Y.Z → auto
                              Release with an extension-only zip asset)

README.md                     user-facing documentation
CONTRIBUTING.md               contribution rules (commit style, code style)
CHANGELOG.md                  Keep a Changelog record (source of Release notes)
docs/DEVELOPING.md            this guide
```

### 2.2 Key concept: one feature, three execution worlds

A browser extension runs in two isolated compartments plus a background
service worker; understanding them is the prerequisite for reading the code:

| World | Files | What it can do | How it talks |
| --- | --- | --- | --- |
| **ISOLATED** | `content/core.js` + `content/features/*` | draws the UI (Shadow DOM); cannot see page variables | `window.postMessage` (PP.BRIDGE) to MAIN |
| **MAIN** | `content/main-world.js` + `content/commands/*` | reads/writes the page's own `Xrm` (Dynamics API), issues Web API / SOAP requests | bridge returns results |
| **Service worker** | `background.js` | never touches pages; `declarativeNetRequest` rewrites request headers (impersonation) | `chrome.runtime` messages (PP.MSG) |

Three **contract surfaces** are the public API whitelists between files, all
`Object.freeze`d:

- `window.PPMain` — MAIN world capabilities (command registry + Xrm/Web API
  plumbing + the SOAP parser)
- `window.PPPane` — ISOLATED world sharing (state, openModal/showTable/
  showOutput, toast…)
- `window.PP` / `window.PPUtil` — constants bus and pure helpers

**Iron rules** (violating them has produced real incidents; the notes live in
the code):

1. The MAIN world must **not** load `shared/constants.js`
   (crbug.com/324096753: a file listed in both a MAIN-world and an
   ISOLATED-world entry loses its globals). The bridge markers therefore have
   their own copy in `main-world.js`, and the guardrail test
   (`tests/guardrails.test.js`) asserts both copies stay identical in CI.
2. Every key destructured from `PPmain` in `content/commands/*.js` must
   actually exist on the contract — `tests/contract.test.js` fails CI on a
   missing key. This class of drift shipped two real incidents before the
   test existed ("FetchXML always rendered the raw XML dialog" and "form
   actions crashed silently").
3. Load order = dependency order:
   `shared/constants → shared/util → shared/actions → content/core →
   content/features/* → content/boot` (fixed in the manifest).

---

## 3. Quick start (5 steps)

```sh
# 1) clone
git clone https://github.com/Musecanyang/dynamics-365-power-pane-next.git
cd dynamics-365-power-pane-next

# 2) local tooling only (the extension stays dependency-free)
npm install

# 3) full local self-check (equals CI)
npm run ci        # = lint → test (30 cases incl. parse/manifest/marker guardrails)

# 4) load into the browser
#    chrome://extensions → enable Developer mode → "Load unpacked" → select this folder
#    (Edge: edge://extensions, same steps)

# 5) test
#    open any model-driven Dynamics app; the pane button appears in the nav bar (or Alt+P)
```

**Refresh loop after code changes** (mandatory for content/background files):
1. On the extension card in `chrome://extensions`, click **Reload**;
2. Refresh the Dynamics tab (F5; a hard refresh is safest after MAIN-world
   changes).

---

## 4. Daily development loop

### 4.1 The loop

```
edit code → npm run ci green → Reload the extension → retest in Dynamics → log it in CHANGELOG (Unreleased)
```

```sh
npm run lint    # eslint (hazard rules: undefined refs, duplicate declarations…)
npm test        # contract snapshots + SOAP parser + helpers + parse/manifest/marker guardrails
npm run ci      # lint + test (run before every commit)
```

### 4.2 Debugging entry points

| What | Where |
| --- | --- |
| **MAIN world** (bridge, Xrm calls, SOAP) | DevTools console of the Dynamics page itself; set `localStorage.setItem("__ppNextDebug", "1")` and every deliberately-swallowed failure emits a `[Power Pane Next][…]` console.debug breadcrumb |
| **ISOLATED world** (pane UI) | DevTools → Console context dropdown → pick the extension's entry; the UI lives under the `pp-host` element's shadow root |
| **Service worker** | `chrome://extensions` → card → "service worker" link opens a dedicated DevTools |
| **storage contents** | open the options page → DevTools → Application → Storage (chrome.sync / local separately) |
| **DNR rules (impersonation)** | pane: `Impersonation → DNR Rules (debug)` — shows the active session rules |
| **network requests** | page DevTools → Network, filter `XRMServices` / `api/data` |

> NOTE: `console.debug` lines are hidden by default — enable the **Verbose**
> level in the DevTools console filter or you will see nothing.

### 4.3 Contract guardrails (read before any architectural refactor)

Any change that moves functions **into or out of `PPMain` / `PPPane` /
`PPUtil`** must update, in the same commit:

1. the `PPMain` object in `content/main-world.js`;
2. the **`EXPECTED_PPMAIN_KEYS` snapshot in `tests/contract.test.js`** — a
   missing or extra key turns CI red;
3. any copied `__ppNext*` marker literal: `shared/constants.js` and
   `content/main-world.js` must stay in sync — the guardrail test
   (`tests/guardrails.test.js`) compares them.

---

## 5. Adding an action (standard 3 steps)

Example: "Environment Info" (full path):

1) **Write the handler** in the matching `content/commands/<domain>.js`:

```js
// helper is destructured at the top of the command file: `const { webApiGet } = PPmain;`
PPmain.register("envInfo", async function () {
  const data = await webApiGet("RetrieveCurrentOrganization");  // helper destructure
  return { output: { title: "Environment Info",
    items: [ { label: "Org", value: data.UniqueName } ] } };
});
```

Four response shapes; `core.js runAction` renders them uniformly:

| Shape | Rendered as |
| --- | --- |
| `{ message, level }` | toast |
| `{ output: { title, description?, items: [{label, value}] } }` | key/value dialog (pin / pop / copy) |
| `{ table: { title, columns, rows, rawJson?, description? } }` | results table (search, copy, CSV) |
| `{ users: [...] }` / `{ items: [...] }` | data consumed by a feature editor |

2) **Register the entry** in `shared/actions.js`:

```js
{ id: "env-info",             // STABLE id: never rename (persistence key for
                              // visibility / order / shortcuts)
  group: "Admin",             // General / Impersonation / Record / Form / Navigation / Debug / Admin
  label: "Environment Info",
  command: "envInfo" }        // or `local: true` handled by a feature module
```

3) **Inputs** (optional):
   `inputs: [{ name, label, type("select"|"textarea"), options, entity, defaultCurrent }]`.

Build all UI with `PPUtil.el(tag, attrs, children)` instead of the
createElement triple.

The contract test exists exactly for this step: a wrong or missing `PPmain`
key turns CI red instead of silently crashing the action for users.

---

## 6. Tests & quality gates

- `tests/contract.test.js` — PPMain key snapshot + every destructured consumer key
- `tests/parseRetrieveMultiple.test.js` — SOAP parser (with realistic, sanitized production-shaped fixtures)
- `tests/util.test.js` — `PPUtil` pure helpers (el / userRow / matches / normalizeSnippets…)
- `tests/guardrails.test.js` — two guardrails in one file: (1) `node --check`
  on every shipped script + manifest JSON parse; (2) constants ↔ MAIN-world
  bridge/debug-marker sync
- ESLint hazard rules (mapped in the eslint.config.mjs header to the incidents
  they prevent)

Commit style: Conventional Commits — `fix:` / `feat:` / `refactor:` / `docs:` /
`chore:` (see the git log for examples).

---

## 7. Deployment

The repository ships two pipelines; everything runs on **GitHub Actions** (no
CI to host yourself):

### 7.1 release.yml (already configured)

```sh
# 1) Turn CHANGELOG.md's Unreleased section into "## [X.Y.Z] - YYYY-MM-DD"
# 2) Sync the version in manifest.json / package.json / the README badge
# 3) Commit + tag
git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z - summary"
git push origin vX.Y.Z
# The Release workflow extracts the CHANGELOG [X.Y.Z] section as release notes,
# packages ONLY the files the extension needs, and creates the GitHub Release.
```

### 7.2 Deployment modes

| Mode | Steps | Fits |
| --- | --- | --- |
| **Personal (dev)** | Load-unpacked from the repo folder (§3); code changes take effect after Reload | personal use, tracks the code |
| **Private distribution (zip / .crx)** | 1) Build a zip with only `manifest.json`, `background.js`, `shared/`, `content/`, `options/`, `icons/`, `LICENSE` (exclude `node_modules`, `tests`, `scripts`, `.github`); 2) self-signed .crx: `chrome://extensions` → "Pack extension" → get `.crx` + `.pem` (KEEP the `.pem`: changing it changes the extension ID and forces every user to reinstall); 3) sideloading a .crx outside the store requires enterprise policy | small teams / off-store |

Disclosure checklist for internal deployments:

- **Permissions**: only `storage` / `tabs` /
  `declarativeNetRequestWithHostAccess` + host `https://*.dynamics.com/*`.
- **No telemetry, no backend** — all computation happens in the browser and
  reuses the user's existing authenticated session.
- Impersonation / User Permissions / write operations require
  `prvActOnBehalfOfAnotherUser` (Delegate / System Administrator include it);
  recommended for **test / UAT environments only** — see the README
  disclaimer.

---

## 8. Troubleshooting quick reference

| Symptom | Where to look |
| --- | --- |
| An action clicked but no table appears | every action goes through `PPPane.send()`; verify the command with `PPmain.get("commandName")({...})` directly from MAIN-world console |
| Edited constants → scripts stopped recognizing | theoretically impossible (the guardrail test blocks it); manually compare the BRIDGE constants at the top of `content/main-world.js` |
| Panel does not show | enable `localStorage.setItem("__ppNextDebug", "1")`, then enable **Verbose** in the DevTools console filter; confirm manifest matches `*.dynamics.com` |
| Paged listing (`webApiGetAll`) | follows `@odata.nextLink`, max 40 pages, sends `Prefer: odata.include-annotations=*` |
| Mysterious failures | all degraded catches leave `debugLog` breadcrumbs; business errors surface Dataverse's real `error.message` |

---

## 9. Known pitfalls (historical incidents, anti-recurrence)

| Symptom | Root cause (real case in this repo) | Fix |
| --- | --- | --- |
| Execute FetchXML always rendered the raw XML dialog | `parseRetrieveMultipleResponse` missing from the PPMain contract face | expose it + `tests/contract.test.js` snapshot guard |
| Save to Snippets / New Snippet broke, or Type lost its default | destructured `this` (`snippetTypeField` called `this.el`) + `PPUtil.el` ignored `value` | shared helpers must reference `PPUtil.el` explicitly, never rely on `this` |
| User Permissions save → HTTP 400 | role belongs to another business unit (Dataverse `0x80041409`) | role picker strictly scoped to the user's own BU; cross-BU moves go through "Change BU" |
| Bare "HTTP 400" everywhere | old error path only surfaced the status code | `webPatch / webAssoc / webDisassoc / webApiGet` now parse and throw the OData `error.message` |
| Empty query showed raw XML | empty result treated as a parse failure | `findEntityCollectionWrapper` detects the empty Execute/EntityCollection wrapper and renders the success result dialog |
| Testing against production | transient writes on production orgs | always validate in a sandbox/UAT first; the README disclaimer applies to write operations |

---

## 10. Release checklist (manual)

1. [ ] `npm run ci` fully green;
2. [ ] `CHANGELOG.md`: [Unreleased] → [X.Y.Z] - date, and the `[X.Y.Z]` link
       reference added at the bottom;
3. [ ] version synced in three places: `manifest.json` / `package.json` /
       README badge;
4. [ ] Conventional Commits style history;
5. [ ] push `main` + tag `vX.Y.Z`;
6. [ ] on GitHub: CI green, Release auto-published, zip asset attached, notes
       correct;
7. [ ] smoke-test the core paths on a target browser (General → Run Code +
       Snippets, Admin → User Permissions, Impersonation search/start).

---

*Last verified 2026-09-23. Code style & contribution rules live in
`CONTRIBUTING.md`; when this document disagrees with the code, verify with §6
(`npm run ci`) and trust the code.*
