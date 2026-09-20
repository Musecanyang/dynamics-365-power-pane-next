# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Musecanyang/dynamics-365-power-pane-next/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/Musecanyang/dynamics-365-power-pane-next/releases/tag/v1.0.2
[1.0.1]: https://github.com/Musecanyang/dynamics-365-power-pane-next/releases/tag/v1.0.1
[1.0.0]: https://github.com/Musecanyang/dynamics-365-power-pane-next/releases/tag/v1.0.0
