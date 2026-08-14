# Changelog

All notable changes to AirSQLite will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.4] - 2026-08-14

### Added
- **Computed fields** — agent-authored SQL formula columns stored in column metadata, evaluated at query time. Filterable, sortable, and summarizable. Read-only in grid and detail panel with a braces badge; formula visible in the column header menu.
- **Column rename** — rename columns from the header menu. Cascades to all saved views (sort, filter, grouping, column order/widths/visibility, summaries) and the primary field setting.
- **Per-group summaries** — group headers now display inline aggregate values matching the summary bar functions.
- **Group sort direction** — each grouping column has an asc/desc toggle; direction is saved with the view.
- **Drag-and-drop group reordering** — reorder active grouping columns by dragging in the group menu.
- **Decimal places selector** — number and percent columns gain a header-menu control for 0–5 decimal places (or Auto).
- **Currency cents toggle** — show or hide cents from the currency column header menu.
- **Field type icons in menus** — filter, sort, column picker, and group menus show the column's type icon.
- **Custom column pickers** — filter and sort menus use styled dropdown pickers with type icons, replacing native `<select>` elements.
- **Filtered empty state** — "No matching records" replaces the generic empty message when filters exclude all rows.

### Changed
- Percent fields now store raw fractions and display ×100 (e.g. `0.42` → `42%`), with the editor converting in both directions.
- Group row labels use the actual grouping column name and format values by display type (checkbox → Checked/Unchecked, currency, percent, date).
- All UI icons are now Lucide SVGs — no more Unicode symbols, emoji, or HTML entities.
- Column and group menus restructured: action buttons sit above the search bar as a horizontal icon toolbar.
- Active table tab and group collapse/expand state persist across webview reloads.
- New columns added by an external process appear immediately via live reload, without manual refresh.

### Fixed
- SVG icon vertical alignment (display and vertical-align baked into generation)
- Checkbox group rows now look up the column descriptor from the full schema
- Group summary cells align to their column offsets
- Create-view button layout in the views panel

## [0.1.3] - 2026-08-13

### Fixed
- Databases open again. Releases up to and including 0.1.2 were packaged without the SQLite engine the extension depends on, so the extension failed to start and every `.db`, `.sqlite`, and `.sqlite3` file opened to a tab that never finished loading. Anyone on an affected version should upgrade.
- Percent, duration, and rating can be selected as column display types. They were offered in the column menu but rejected when applied.

## [0.1.2] - 2026-08-10

### Fixed
- Changelog now displays on the Visual Studio Marketplace

## [0.1.1] - 2026-08-10

### Fixed
- README and images now display correctly on the Visual Studio Marketplace

## [0.1.0] - 2026-08-10

Initial public release.

### Added
- Airtable-style data grid for `.db`, `.sqlite`, and `.sqlite3` files
- Inline editing with draft preservation during conflicts
- 16 field types: text, long text, number, currency, percent, duration, rating, checkbox, toggle, single select, multi-select, date, URL, email, phone, and linked records
- Automatic type inference from column affinity and data sampling
- Saved views with column visibility, order, widths, frozen columns, sort, grouping, and summary functions
- Nested AND/OR filter builder with type-aware operators
- Grouping by one or more columns with collapsible headers
- Substring search across all visible columns
- Detail panel with linked records derived from foreign keys
- Live reload via directory watching and `PRAGMA data_version`
- Changed-cell flash and draft survival on external writes
- Audit trail as per-table NDJSON sidecar files
- `__created` and `__modified` virtual columns from the audit trail
- History tab powered by the audit trail
- Action buttons: webhook, URL, script, Claude CLI, and clipboard
- Configuration stored in `_airsqlite_*` tables inside the database (views travel with the file)
- Read-only mode with graceful degradation when the file is not writable

[Unreleased]: https://github.com/AirSQLite/AirSQLite/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/AirSQLite/AirSQLite/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/AirSQLite/AirSQLite/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/AirSQLite/AirSQLite/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/AirSQLite/AirSQLite/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/AirSQLite/AirSQLite/releases/tag/v0.1.0
