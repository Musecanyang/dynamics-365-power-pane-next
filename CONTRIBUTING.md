# Contributing

Thanks for taking the time to improve **Dynamics 365 Power Pane Next**.
This document explains how to set up, where things live, and how to get a change
merged.

## Ways to contribute

- Report bugs and request features via the issue templates.
- Improve the action set, fix bugs, or refine the UI/UX.
- Improve the documentation (README, this file, code comments).

## Development setup

There is **no build step**. The extension is plain, dependency-free JavaScript
(Manifest V3).

1. Fork and clone the repository.
2. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
3. Enable **Developer mode** → **Load unpacked** → select the repository folder.
4. Open a model-driven app, open the pane, and test your change.
   After editing content scripts or the service worker, click **Reload** on the
   extension card and refresh the Dynamics tab.

### Useful checks

Syntax check all scripts (no tooling required):

```sh
node --check background.js
node --check content/content.js
node --check content/main-world.js
node --check src/actions.js
node --check src/constants.js
node --check options/options.js
```

Validate the manifest and message shapes by loading the extension and using
**Debug → DNR Rules (debug)** and the browser console.

## Project layout

```
manifest.json                  MV3 manifest
background.js                  service worker: toolbar toggle + impersonation
src/constants.js               shared constants (name, storage keys, message types)
src/actions.js                 action registry (single source of truth)
content/content.js             isolated-world UI (pane, modals, prefs, impersonation,
                               user-access + snippets editors)
content/main-world.js          MAIN-world bridge (Xrm + Web API command handlers)
options/                       options page (visibility, order, shortcuts, theme)
icons/                         toolbar icons
```

## Adding an action

1. **Implement a handler** in `content/main-world.js`. Handlers are async and
   return one of:
   - `{ message, level }` — toast only;
   - `{ output: { title, items } }` — key/value dialog;
   - `{ table: { title, columns, rows } }` — table (searchable, exportable);
   - `{ users: [...] }` / `{ items: [...] }` — data consumed by the UI.

   Use the existing helpers (`requireForm`, `webApiGet`, `webApiGetAll`,
   `applyUrlParam`, `webAssoc`/`webDisassoc`, `webPatch`) rather than re-inventing
   them.

2. **Register the action** in `src/actions.js` with a **stable `id`**, a `group`,
   a `label` and the `command` name. Add `local: true` for actions handled
   entirely in `content/content.js` (register the command via `registerLocal`).
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
- Keep `src/constants.js` the only place for storage keys, message types and
  bridge markers; never re-declare them elsewhere.
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
- Make sure the syntax checks above pass and the extension loads without errors.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
