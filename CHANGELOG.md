# Changelog

All notable changes to AirSQLite will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.6] - 2026-08-17

### Added
- **Config snapshot sidecar** — AirSQLite now writes an `airsqlite.snapshot.ndjson` file inside the sidecar folder (`<db>.airsqlite/`) that captures the full state of all `_airsqlite_*` configuration tables. Because it is a text file, changes to views, computed columns, display types, and primary fields surface as readable diffs in git and VS Code Source Control — solving the problem where configuration stored inside a binary `.db` file was invisible to version control.
- **Config restore from snapshot** — on session open, if the snapshot has views, computed columns, or display types that the database is missing (e.g. after pulling a repo onto a new machine), they are automatically restored into the `_airsqlite_*` tables. Natural keys are used for matching so config survives across machines where row IDs differ.
- **Type-to-jump in column pickers** — typing in sort and filter column dropdowns jumps to the first matching column name, like a native `<select>`

### Changed
- Collapse All in the group menu now collapses data rows while keeping all group headers visible at every nesting level
- Column header menu stays open when editing select options (sorting, reordering, changing colors, renaming, adding, or removing)
- Creating a new view skips the naming prompt and auto-names to "new view", "new view 2", etc.
- New tables and new views initialize column widths to fit the full header text instead of a fixed 160px

### Fixed
- Git-tracked databases no longer report "database disk image is malformed" when opened on another machine. The extension uses WAL mode for live-reload support, but previously left the WAL flag in the database header on close — so the `.db` file required companion `-wal`/`-shm` files that don't travel through git. The database is now checkpointed on close, making the `.db` self-contained at rest.
- Group summary values no longer scroll on top of frozen columns — frozen zone uses an opaque mask matching the pattern established for data row cells
- Column freeze drag line no longer appears in the header row, where it competed with column resize handles
- New columns arriving via live reload auto-size to fit their header label instead of defaulting to 160px
- Group header background extends to the right edge of the last column when scrolled horizontally
- Converting a computed field to single/multi-select now populates the option and color list from existing values
- Grouping by a computed column now shows the correct group values instead of "(empty)"
- "No records" message renders inside the grid area instead of below the horizontal scrollbar
- Single/multi-select values in the filter menu no longer display as `[object Object]`
- Sorted rows no longer appear in the wrong order across nested groups when chunks arrive out of sequence

## [0.1.5] - 2026-08-14

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

[Unreleased]: https://github.com/AirSQLite/AirSQLite/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/AirSQLite/AirSQLite/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/AirSQLite/AirSQLite/compare/v0.1.3...v0.1.5
[0.1.3]: https://github.com/AirSQLite/AirSQLite/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/AirSQLite/AirSQLite/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/AirSQLite/AirSQLite/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/AirSQLite/AirSQLite/releases/tag/v0.1.0
