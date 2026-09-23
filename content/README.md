# content/ — injected page scripts (directory map)

The two `content_scripts` entries in the manifest load these files in
**dependency order**. The two worlds never share a JS context, so know which
world you are editing before reading the code:

```
ISOLATED world (the pane UI — cannot see page variables)
  core.js                  pane core: Shadow DOM scaffolding, modals / tables /
                           toasts, runAction scheduling, shortcuts,
                           preferences → exports window.PPPane
  features/                feature editors, registered as local actions via PPPane
    impersonation.js       user search, impersonation start/stop, DNR debug dialog
    user-access.js         User Permissions editor (BU / roles / teams / copy)
    snippets.js            FetchXML / JS snippet library (import/export)
  boot.js                  calls PPPane.boot() after every module loads

==================== ↑ ISOLATED ·  the bridge ▼ MAIN ============================

MAIN world (the page's own world — direct Xrm access)
  main-world.js            bridge entry: Xrm / Web API plumbing, SOAP parser,
                           command registry → exports window.PPMain (frozen)
  commands/                one file per domain: exactly what an action DOES
    general.js  runcode.js  records.js  forms.js
    navigation.js  security.js  debug.js
```

Rules that matter in this folder:

- ISOLATED reaches MAIN **only** through `PPPane.send(command, args)`;
  MAIN answers with `{ message | output | table }`.
- Do not reference `shared/*.js` globals from MAIN-world files
  (crbug.com/324096753): `main-world.js` keeps its own copy of the bridge
  markers; `tests/guardrails.test.js` asserts the copies in CI.
- `tests/contract.test.js` fails CI when `commands/*.js` destructures a key
  that is missing from `window.PPMain` — add the key to the PPMain contract in
  the same commit as the move.

Full developer guide: `docs/DEVELOPING.md`.
