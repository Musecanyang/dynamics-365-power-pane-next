# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-09-22

### Fixed
- **Execute FetchXML never rendered a table** (always fell back to the raw
  "Fetch XML Result" XML dialog): the structural split of the MAIN-world bridge
  moved `parseRetrieveMultipleResponse` into `content/main-world.js` but never
  added it to the frozen `PPMain` contract face, so `content/commands/runcode.js`
  destructured `undefined` - the parse call threw (`undefined is not a
  function`) inside a `try { } catch { parsed = null }` and every successful
  response was silently treated as a parse failure. The parser itself was
  correct (the full unit suite, including the real Execute-style envelope,
  passes). It is now exposed on `PPMain`.
- **`Find Field in Form` / `Highlight Dirty Fields` / `Toggle Lookup Links`
  and the related form handlers crashed silently**: the structural split
  rewrote `content/commands/forms.js` against a `findContainer` helper that
  was never added to the `PPMain` contract (the old monolith never had it
  either). Implemented `PPMain.findContainer` (label cell `_c`, then the UCI
  `div[data-id]` / `[data-control-name]` shapes).
- Run Code (FetchXML) auto-detects pasted XML content: a query starting with
  an XML tag (fetch / entity / an XML declaration, e.g. a query pasted from
  MarkMpn.SQL4CDS) is executed as FetchXML even while the JS language mode is
  selected, and pasting switches the language selector automatically.
- Replaced the XSLT-based XML formatter with a small DOM walker: browsers have
  deprecated `XSLTProcessor` (a console warning appeared whenever Execute Fetch
  XML showed the raw-response view), and it will be removed. Output shape is
  unchanged; the raw XML view for SOAP faults keeps working.
- After a page refresh the first pane open could appear at the wrong size and
  pinned to the left edge. The saved pane layout was being overwritten with a
  0x0 rect whenever the pane was hidden (ResizeObserver fires for display:none
  elements too), and `applyLayout` then trusted that degenerate layout. The
  layout is no longer persisted while hidden / during the opening animation /
  for zero-size measurements, and degenerate saved layouts are healed back to
  the default position on load.

### Added
- **Contract guardrails**: `tests/contract.test.js` snapshots the frozen
  `PPMain` key set AND verifies every key destructured by
  `content/commands/*.js` exists on the loaded surface - the two contract
  drifts above now fail CI instead of the user's screen (25 unit tests total).
- `PPUtil.el(tag, attrs, children)` - a compact DOM factory standard for new
  pane UI code (safety: text goes through `textContent` only),
  `PPUtil.userRow(user, actions)` (shared `.user` result row used by the
  impersonation and User Permissions searches),
  `PPUtil.normalizeSnippets(raw)` (shared snippet validation, used by both
  importer implementations) and `PPUtil.snippetTypeField(opts)` (the shared
  JavaScript/FetchXML type selector used by the snippet editor form and the
  Save-to-Snippets dialog). el / userRow / normalizeSnippets carry unit
  tests (`tests/util.test.js`).
- **Silent-catch observability**: every deliberately-swallowed catch in
  `content/core.js`, `content/main-world.js` and the feature modules now
  emits a `debugLog` breadcrumb (visible with the `__ppNextDebug` gate)
  instead of only a code comment - clipboard copy, options open, storage
  change listener, layout observers, impersonation cache clears and the
  feature on-mount hooks among them. `PP.DEBUG` (`__ppNextDebug`) is a named
  constant in `src/constants.js`; the MAIN-world copy (`DEBUG_KEY`) joined
  the marker assertion in `scripts/check-bridge-sync.js`.
- Snippets dialog: shows where snippets are stored (local, not synced) and
  gained Import / Export buttons that back up the snippet library as JSON.
  Import merges into the existing library and skips exact duplicates.
- Options page: Export / Import settings buttons that back up and restore the
  full configuration (action visibility, order, theme, shortcuts and snippets)
  as a single `power-pane-settings.json` file. The pane position is excluded
  on purpose because it is specific to each machine's screen.
- Pane footer (mirroring the original pane's notes bar): a short disclaimer
  ("developed for developers, testers and power users; not recommended for
  end-users or production use") and a GitHub link to this project's
  repository ([`Musecanyang/dynamics-365-power-pane-next`](https://github.com/Musecanyang/dynamics-365-power-pane-next)).

### Changed
- **Execute Fetch XML now renders results as a table** instead of a raw SOAP
  blob: one row per record, platform formatted values preferred (option labels,
  localized dates, currency), column width caps with hover tooltips, and the
  first column click-to-copy. A **Copy JSON** button on top copies the raw
  records (raw values plus `@formatted` variants). SOAP faults still fall back
  to the raw envelope view, with the fault message as the description. The
  action no longer requires an open record form.
- **FetchXML Snippets moved from `chrome.storage.sync` to `chrome.storage.local`.**
  The whole snippet library previously shared a single 8 KB sync key; local
  storage raises the ceiling to 10 MB (Chrome 114+). Existing snippets are
  migrated automatically on the first pane load and the legacy sync copy is
  removed. Note the trade-off: snippets no longer sync across devices via the
  Chrome profile.
- The pane now defaults to hugging its content width (left-anchored, capped to
  the viewport) instead of stretching edge-to-edge, and is resizable in both
  directions; a manually resized size persists across sessions.
- UI options page layout: group cards now flow into a responsive grid, rows
  tightened and the action bar is sticky - density only, same behaviour.
- **Structural split of the 2150-line MAIN-world bridge** (the fixes above are
  its direct beneficiaries): `content/main-world.js` is now the entry (Xrm /
  Web API plumbing, the SOAP parser and the command registry, exported as the
  frozen `window.PPMain` surface) and the command handlers moved to
  `content/commands/*.js` grouped the same way as `src/actions.js` groups
  (`general`, `runcode`, `records`, `forms`, `navigation`, `security`,
  `debug`). `handlers.searchEntities` stays in the entry (it owns the
  module-local entity cache). Every handler registers via `PPmain.register`;
  cross-command reads go through `PPmain.get`.
- **Structural split of the 3000-line content script**: `content/core.js` is
  the pane core (Shadow DOM scaffold, shared UI primitives, bridge plumbing,
  preferences) and exports the feature-module surface `window.PPPane`; the
  feature editors moved to `content/features/` (`impersonation.js`,
  `user-access.js`, `snippets.js`) and register their local actions / mount
  hooks through that explicit surface instead of sharing one giant closure.
  `content/boot.js` boots the pane after every module has loaded. Startup
  order in the manifest reflects the dependency order; `state.recent/pinned/
  snippets/layout` storage reads now complete before feature hooks run
  (assign-then-publish pattern).

### Internal
- `npm run ci` collects a Node syntax check for every shipped script plus a
  manifest JSON parse (`scripts/check-syntax.js`), the constants <-> MAIN-world
  bridge and debug-marker assertion (`scripts/check-bridge-sync.js`), ESLint
  correctness rules (`eslint.config.mjs`) and the unit tests. Modernised all
  variable declarations to `const`/`let` (no remaining `var`).

## [1.1.0] - 2026-09-21

### Added
- `All Fields`: an **Entity** column resolving what each lookup points at.
- `All Fields`: a **Copy JSON** button for the raw Web API record payload.

### Changed
- `All Fields`: the **Entity** column sits directly after **Type**, and the
  Logical Name / Value / Entity columns are width-capped so a long value no
  longer stretches the dialog (hovering a truncated cell shows the full text).
- `All Fields`: the attributes, record and lookup-target requests are issued in
  parallel instead of one after the other; the table action bar sits above the
  table.
- `All Fields`: dropped the "(Web API)" suffix; platform companion columns
  (`*name` / `*yominame`) are hidden.
- The pane and every dialog now use a slim, theme-aware scrollbar instead of the
  browser's default one (thin thumb, transparent track, darkens on hover).

### Fixed
- `All Fields`: empty lookups now always show their target entity (the
  `lookuplogicalname` annotation is only returned for lookups that point at a
  record, so the metadata query is still needed as a source).

### Internal
- `src/constants.js` is the single source of truth for every cross-file literal;
  duplicated fallbacks removed and the MAIN-world bridge validates its markers
  and sender. CI checks that the bridge markers stay in sync.

## [1.0.2] - 2026-09-20

### Fixed
- `All Fields (Web API)`: the formatted name for **Lookup / Owner / Customer**
  fields is now read from `_<field>_value@OData...FormattedValue` (was empty).
- `OptionSet Values`: option values are no longer listed twice when an attribute
  exposes both `OptionSet` and `GlobalOptionSet`.

## [1.0.1] - 2026-09-20

### Added
- `All Fields (Web API)` — display name, logical name, type, value and formatted
  value for the current record.
- `Table Processes` — workflows, business rules, BPFs, actions and custom APIs
  for the entity, with row details and open actions.
- `User Permissions (view/edit)` — view and modify a user's business unit,
  security roles and teams in-app (staged changes + Save).
- `Role Check` — batch lookup of many users by name/email returning Name, Email,
  Business Unit, Roles and Teams.
- Debug URL flags: Forms Monitor, Command Checker, Perf Center, Disable Form
  Handlers/Business Rules/Form Libraries/Command Bar/Web Resource Controls/BPF,
  Disable Form Control, Disable All Components, Navbar Off, Dark Mode, Clear Flags.
- Options page: per-action visibility, drag-to-reorder (grouped), keyboard
  shortcuts, theme, reset pane position and restore defaults.
- FetchXML snippets, entity picker with search, output tables with copy/CSV export.

### Changed
- Rebranded to **Dynamics 365 Power Pane Next**; modularised shared constants
  (`src/constants.js`) and documented the codebase (JSDoc, file headers).
- Impersonation rules are applied host-wide (plus service-worker and per-tab) so
  the impersonated identity survives SPA navigation and Advanced Find windows.

### Fixed
- Impersonation no longer leaves stale client state (clears the cached identity
  key and forces a cache-bypassing reload).
- Pane position, theme pill and options button edge cases.

## [1.0.0] - 2026-09-19

### Added
- Initial public version: in-page Shadow-DOM pane with General, Record, Form,
  Navigation, Debug and Admin actions, plus real user impersonation.

[Unreleased]: https://github.com/Musecanyang/dynamics-365-power-pane-next/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/Musecanyang/dynamics-365-power-pane-next/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Musecanyang/dynamics-365-power-pane-next/releases/tag/v1.1.0
[1.0.2]: https://github.com/Musecanyang/dynamics-365-power-pane-next/releases/tag/v1.0.2
[1.0.1]: https://github.com/Musecanyang/dynamics-365-power-pane-next/releases/tag/v1.0.1
[1.0.0]: https://github.com/Musecanyang/dynamics-365-power-pane-next/releases/tag/v1.0.0
