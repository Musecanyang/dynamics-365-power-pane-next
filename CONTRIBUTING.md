# Contributing

Thanks for taking the time to improve **Dynamics 365 Power Pane Next**.
This document explains how to set up, where things live, and how to get a change
merged. For the full how-to development guide (architecture, debugging,
deployment), see **[docs/DEVELOPING.md](docs/DEVELOPING.md)**.

## Ways to contribute

- Report bugs and request features via the issue templates.
- Improve the action set, fix bugs, or refine the UI/UX.
- Improve the documentation (README, this file, `docs/DEVELOPING.md`, code comments).

## Development setup

The extension itself is plain, dependency-free JavaScript (Manifest V3) with
**no build step** - runtime sources never change behaviour. A small Node
toolchain exists purely as guardrails: ESLint, plus unit tests that include
the guardrails (in `tests/guardrails.test.js`: a parse check on every shipped
script, manifest JSON validation, and the constants <-> MAIN-world
bridge/debug-marker assertion), the contract surfaces
(`tests/contract.test.js` - every key `content/commands/*.js` destructures
must exist on `window.PPMain`), the SOAP parser
(`tests/parseRetrieveMultiple.test.js`) and the shared pure helpers in
`shared/util.js` (`tests/util.test.js`). CI (`.github/workflows/ci.yml`) runs
all of it on every push.

1. Fork and clone the repository.
2. Run `npm install` once (dev tooling only; the extension stays dependency-free).
3. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
4. Enable **Developer mode** → **Load unpacked** → select the repository folder.
5. Open a model-driven app, open the pane, and test your change.
   After editing content scripts or the service worker, click **Reload** on the
   extension card and refresh the Dynamics tab.

### Useful checks

Everything at once (same as CI):

```sh
npm run ci
```

Individually:

```sh
npm run lint    # eslint (hazard rules; catches undefined refs early)
npm test        # contract snapshots + SOAP parser + helpers + syntax/manifest/marker guardrails (30 cases)
```

Validate the manifest and message shapes by loading the extension and using
**Debug → DNR Rules (debug)** and the browser console.

## Project layout

```
manifest.json                  MV3 manifest
background.js                  service worker: toolbar toggle + impersonation
shared/constants.js            shared constants (name, storage keys, message types)
shared/util.js                 shared pure helpers (matcher, downloads, debugLog)
shared/actions.js              action registry (single source of truth)
content/core.js                isolated-world UI core (pane, modals, result
                               renderers, prefs, bridge plumbing, PPPane surface)
content/features/*.js          feature editors: impersonation, user-access
                               (User Permissions), snippets (FetchXML / JS)
content/boot.js                calls PPPane.boot() after all modules loaded
content/main-world.js          MAIN-world entry: Xrm / Web API plumbing + command
                               registry (frozen as window.PPMain)
content/commands/*.js          command handlers per domain (general / runcode /
                               records / forms / navigation / security / debug)
options/                       options page (visibility, order, shortcuts, theme)
icons/                         toolbar icons
tests/                         unit tests: contract snapshot, SOAP parser,
                               helpers + syntax/manifest/marker guardrails
.github/workflows/ci.yml       CI: lint + tests on every push
.github/workflows/release.yml  wraps the extension files and creates a GitHub
                               Release on version tags
docs/DEVELOPING.md             developer guide (architecture, workflow, deployment)
```

## Adding an action

1. **Implement a handler** in the matching `content/commands/<domain>.js`
   file (`general`, `runcode`, `records`, `forms`, `navigation`, `security`,
   `debug`), registering it with `PPmain.register`. Handlers are async and
   return one of:
   - `{ message, level }` — toast only;
   - `{ output: { title, items } }` — key/value dialog;
   - `{ table: { title, columns, rows } }` — table (searchable, exportable);
   - `{ users: [...] }` / `{ items: [...] }` — data consumed by the UI.

   Use the existing helpers (destructured from `PPmain`: `requireForm`,
   `webApiGet`, `webApiGetAll`, `applyUrlParam`, `webAssoc`/`webDisassoc`,
   `webPatch`, `parseRetrieveMultipleResponse`, `findContainer`) rather than
   re-inventing them.
   For the UI markup use `PPUtil.el(tag, attrs, children)` (see `shared/util.js`)
   instead of the `createElement` + `className` + `textContent` triple.

2. **Register the action** in `shared/actions.js` with a **stable `id`**, a `group`,
   a `label` and the `command` name. Add `local: true` for actions handled
   inside the UI (register the command via `PPPane.registerLocal` from the
   matching `content/features/*.js` module).
   Use the `inputs` array for form fields (`entity: true` for the entity picker,
   `defaultCurrent: true` to pre-fill the current entity).

> **Keep action `id`s stable.** They are the keys used for saved visibility,
> ordering and shortcuts. Renaming an id resets those for existing users.

## Code style

- Plain, unbundled JavaScript. `async`/`await` is used throughout for any
  asynchronous flow (the minimum Chrome version is 111, so there is no need to
  stick to ES5 promises).
- File header + JSDoc on exported/non-trivial functions.
- Prefer early returns and small, single-purpose functions.
- No external dependencies and no build tooling.
- Keep `shared/constants.js` the only place for storage keys, message types and
  bridge markers; never re-declare them elsewhere (the sole exception is the
  MAIN world, which cannot load that file - there the markers are duplicated
  on purpose and the guardrail test (`tests/guardrails.test.js`) asserts they stay in sync).
- Two-space indentation; double quotes.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add "Export to Excel" action
fix: impersonation header not applied to Advanced Find window
docs: clarify impersonation privilege requirement
chore: bump version to 1.1.0
```

## Pull requests

- Keep PRs focused; one logical change per PR.
- Update the **README** (feature list) and **CHANGELOG** when behaviour changes.
- Describe how you tested it (environment, steps, screenshots for UI changes).
- Make sure `npm run ci` passes and the extension loads without errors.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
