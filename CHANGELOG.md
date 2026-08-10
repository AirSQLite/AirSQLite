# Changelog

All notable changes to AirSQLite will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/AirSQLite/AirSQLite/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/AirSQLite/AirSQLite/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/AirSQLite/AirSQLite/releases/tag/v0.1.0
