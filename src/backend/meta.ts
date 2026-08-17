import type {
  ColumnDescriptor,
  ColumnDisplay,
  ColumnInfo,
  DisplayType,
  SavedView,
  SqlValue,
  SummaryFunction,
  ViewConfig,
} from '../shared/protocol.js'
import { ROWID_COLUMN, CREATED_COLUMN, MODIFIED_COLUMN } from '../shared/protocol.js'
import type { Db } from './db.js'
import { ProtocolError, mapSqliteError } from './errors.js'
import { quoteIdent } from './filter.js'

// Configuration lives inside the database file, in four `_airsqlite_*` tables created on first
// open. No sidecar config, no application-support directory: copy the .db somewhere else and
// the views, display types, and primary fields go with it.
//
// `Db.tables()` filters `_airsqlite_%` out of the table list, so these never appear as tabs —
// configuration cannot be browsed as if it were data.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS _airsqlite_tables (
  table_name    TEXT PRIMARY KEY,
  primary_field TEXT NOT NULL,
  sort_order    INTEGER,
  description   TEXT,
  last_view_id  INTEGER,
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
);

CREATE TABLE IF NOT EXISTS _airsqlite_columns (
  table_name   TEXT NOT NULL,
  column_name  TEXT NOT NULL,
  display_type TEXT DEFAULT 'text',
  options      TEXT,
  description  TEXT,
  PRIMARY KEY (table_name, column_name)
);

CREATE TABLE IF NOT EXISTS _airsqlite_views (
  id          INTEGER PRIMARY KEY,
  table_name  TEXT NOT NULL,
  name        TEXT NOT NULL,
  config      TEXT NOT NULL,
  description TEXT,
  is_default  INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
);

CREATE TABLE IF NOT EXISTS _airsqlite_actions (
  id             INTEGER PRIMARY KEY,
  table_name     TEXT NOT NULL,
  label          TEXT NOT NULL,
  icon           TEXT,
  style          TEXT DEFAULT 'default',
  action_type    TEXT NOT NULL,
  config         TEXT NOT NULL,
  show_in_grid   INTEGER DEFAULT 0,
  show_in_detail INTEGER DEFAULT 1
);
`

/** How many rows to look at when guessing what a column holds. */
const SAMPLE_SIZE = 200

/**
 * The four configuration tables under their pre-branding names, paired with the current ones.
 *
 * Kept as data rather than derived by string substitution so the set is enumerable and the
 * migration cannot accidentally rename a user table that happens to start with `_meta_`.
 */
const LEGACY_TABLES: Array<[string, string]> = [
  ['_meta_tables', '_airsqlite_tables'],
  ['_meta_columns', '_airsqlite_columns'],
  ['_meta_views', '_airsqlite_views'],
  ['_meta_actions', '_airsqlite_actions'],
]

/** What a table's first view is called when the tool creates it rather than the user. */
const DEFAULT_VIEW_NAME = 'Default view'

interface ViewRow {
  id: number
  table_name: string
  name: string
  config: string
  description: string | null
  is_default: number
  created_at: string
  updated_at: string
}

function toSavedView(row: ViewRow): SavedView {
  return {
    id: row.id,
    tableName: row.table_name,
    name: row.name,
    config: parseViewConfig(row.config),
    description: row.description,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const DISPLAY_TYPES = new Set<DisplayType>([
  'text',
  'number',
  'currency',
  'checkbox',
  'toggle',
  'single_select',
  'multi_select',
  'date',
  'url',
  'phone',
  'email',
  'long_text',
  'percent',
  'duration',
  'rating',
])

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URL = /^https?:\/\/\S+$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/
// Deliberately strict: seven digits minimum, or every zip code and order number in the
// database turns into a phone link.
const PHONE = /^\+?[\d][\d\s().-]{6,}$/

const LONG_TEXT_THRESHOLD = 120

const SUMMARY_FUNCTIONS = new Set<SummaryFunction>([
  'sum',
  'average',
  'count',
  'min',
  'max',
  'count_empty',
  'count_not_empty',
  'percent_empty',
])

/**
 * What `_airsqlite_columns` holds for one column. Display config may be absent — a row can exist to
 * carry nothing but a description.
 */
type StoredColumn = Partial<ColumnDisplay> & {
  description: string | null
}

export type ConfigSink = () => void

export class Meta {
  #db: Db
  #available: boolean
  onConfigChange: ConfigSink | null = null

  constructor(db: Db) {
    this.#db = db
    this.#available = this.#ensureSchema()
  }

  /**
   * Create the tables if they are missing. A read-only file cannot be written to, so
   * configuration degrades to inference rather than failing the open — being unable to save
   * a column's display type is not a reason to refuse to show the data.
   */
  #ensureSchema(): boolean {
    if (this.#db.readonly) return this.#metaTablesExist()

    try {
      // Rename first, and this ordering is the whole trick.
      //
      // `CREATE TABLE IF NOT EXISTS _airsqlite_views` on a file that still holds `_meta_views`
      // succeeds — the new name does not exist — and creates an empty table. The rename would
      // then fail because its target now exists, and the file would be left with the user's
      // real configuration stranded under the old name and an empty table shadowing it. Every
      // view, action, and field type would appear to have vanished.
      this.#renameLegacyTables()
      this.#db.connection.exec(SCHEMA)
      this.#migrate()
      this.#db.invalidateSchema()
      return true
    } catch {
      return false
    }
  }

  /**
   * `_meta_*` → `_airsqlite_*`.
   *
   * The configuration tables carry the tool's name so that somebody opening the raw file can
   * see what wrote them. `_meta_columns` reads as a convention somebody happened to pick;
   * `_airsqlite_columns` says where it came from.
   *
   * One transaction, so a file is never half-renamed. Skipped per table when the new name
   * already exists, which makes a second open a no-op — and covers the case where an older
   * build created some of them after a partial migration.
   */
  #renameLegacyTables(): void {
    const present = new Set(
      (
        this.#db.connection
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    )

    const pending = LEGACY_TABLES.filter(
      ([from, to]) => present.has(from) && !present.has(to),
    )
    if (pending.length === 0) return

    this.#db.connection.transaction(() => {
      for (const [from, to] of pending) {
        this.#db.connection.exec(`ALTER TABLE "${from}" RENAME TO "${to}"`)
      }
    })()
  }

  /**
   * Additive migrations for databases created by an earlier build.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a column added
   * to SCHEMA never reaches a file that has been opened before — which is every real database
   * after the first run. Adding it here is safe to repeat: the column list is checked first, and
   * ALTER TABLE ADD COLUMN rewrites no rows.
   */
  #migrate(): void {
    this.#addColumn('_airsqlite_tables', 'sort_order', 'INTEGER')
    this.#addColumn('_airsqlite_tables', 'description', 'TEXT')
    this.#addColumn('_airsqlite_tables', 'last_view_id', 'INTEGER')
    this.#addColumn('_airsqlite_columns', 'description', 'TEXT')
    this.#addColumn('_airsqlite_views', 'description', 'TEXT')
    this.#foldColumnLayoutIntoViews()
  }

  /**
   * Move width and summary out of `_airsqlite_columns` and into each table's default view.
   *
   * They used to live per column, per *table*, so that dragging a column wider survived without
   * a view ever being saved. That reasoning held only while a table could have no view. Now one
   * always exists and auto-saves, so two places store the same property — and a width written to
   * both reverts on a view switch and comes back on switching away.
   *
   * A straight `DROP COLUMN` would discard widths people already set, so the values are folded
   * into the default view first. View config wins on conflict: it is the newer of the two.
   *
   * Runs once. After the columns are gone `#hasColumn` is false and this is a no-op.
   */
  #foldColumnLayoutIntoViews(): void {
    const hasWidth = this.#hasColumn('_airsqlite_columns', 'width')
    const hasSummary = this.#hasColumn('_airsqlite_columns', 'summary')
    if (!hasWidth && !hasSummary) return

    const select = [
      'table_name',
      'column_name',
      hasWidth ? 'width' : 'NULL AS width',
      hasSummary ? 'summary' : 'NULL AS summary',
    ].join(', ')

    const stored = this.#db.connection
      .prepare(`SELECT ${select} FROM _airsqlite_columns`)
      .all() as Array<{
      table_name: string
      column_name: string
      width: number | null
      summary: string | null
    }>

    const byTable = new Map<string, typeof stored>()
    for (const row of stored) {
      if (row.width === null && row.summary === null) continue
      const list = byTable.get(row.table_name) ?? []
      list.push(row)
      byTable.set(row.table_name, list)
    }

    this.#db.connection.transaction(() => {
      for (const [table, rows] of byTable) {
        const view = this.#defaultViewRow(table) ?? this.#insertDefaultView(table)
        const config = parseViewConfig(view.config)
        const widths = { ...(config.columnWidths ?? {}) }
        const summaries = { ...(config.summary ?? {}) }

        for (const row of rows) {
          if (row.width !== null && widths[row.column_name] === undefined) {
            widths[row.column_name] = row.width
          }
          if (
            row.summary !== null &&
            SUMMARY_FUNCTIONS.has(row.summary as SummaryFunction) &&
            summaries[row.column_name] === undefined
          ) {
            summaries[row.column_name] = row.summary as SummaryFunction
          }
        }

        const next: ViewConfig = { ...config, version: 1 }
        if (Object.keys(widths).length > 0) next.columnWidths = widths
        if (Object.keys(summaries).length > 0) next.summary = summaries

        this.#db.connection
          .prepare('UPDATE _airsqlite_views SET config = ? WHERE id = ?')
          .run(JSON.stringify(next), view.id)
      }

      if (hasWidth) this.#db.connection.exec('ALTER TABLE _airsqlite_columns DROP COLUMN width')
      if (hasSummary) this.#db.connection.exec('ALTER TABLE _airsqlite_columns DROP COLUMN summary')
    })()
  }

  #hasColumn(table: string, column: string): boolean {
    const existing = this.#db.connection
      .prepare('SELECT name FROM pragma_table_info(?)')
      .all(table) as Array<{ name: string }>
    return existing.some((c) => c.name === column)
  }

  #addColumn(table: string, column: string, type: string): void {
    if (!this.#hasColumn(table, column)) {
      this.#db.connection.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    }
  }

  #metaTablesExist(): boolean {
    const row = this.#db.connection
      .prepare(
        `SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN
         ('_airsqlite_tables','_airsqlite_columns','_airsqlite_views','_airsqlite_actions')`,
      )
      .get() as { n: number }
    return row.n === 4
  }

  /** False when configuration cannot be persisted — a read-only file with no meta tables. */
  get writable(): boolean {
    return this.#available && !this.#db.readonly
  }

  // -------------------------------------------------------------------------
  // Primary field
  // -------------------------------------------------------------------------

  /**
   * The column used as a record's display value — what a linked-record chip shows instead of
   * a foreign key integer. Stored per table, seeded from a guess on first open because
   * `_airsqlite_tables.primary_field` cannot be null.
   */
  primaryField(table: string): string {
    if (this.#available) {
      const row = this.#db.connection
        .prepare('SELECT primary_field FROM _airsqlite_tables WHERE table_name = ?')
        .get(table) as { primary_field: string } | undefined

      // Only trust a stored value that still names a real column — schemas change.
      if (row && this.#db.columns(table).some((c) => c.name === row.primary_field)) {
        return row.primary_field
      }
    }

    const guess = guessPrimaryField(this.#db.columns(table))
    if (this.writable) {
      try {
        this.#db.connection
          .prepare(
            // Not INSERT OR REPLACE: that deletes the row and re-inserts it, silently
            // discarding sort_order. Only the primary field is being decided here.
            `INSERT INTO _airsqlite_tables (table_name, primary_field) VALUES (?, ?)
               ON CONFLICT(table_name) DO UPDATE SET primary_field = excluded.primary_field`,
          )
          .run(table, guess)
      } catch {
        // Seeding is a convenience, never a reason to fail a read.
      }
    }
    return guess
  }

  setPrimaryField(table: string, column: string): void {
    this.#requireWritable()
    if (!this.#db.columns(table).some((c) => c.name === column)) {
      throw new ProtocolError(`There is no column named "${column}" in "${table}".`)
    }
    this.#db.connection
      .prepare(
        `INSERT INTO _airsqlite_tables (table_name, primary_field) VALUES (?, ?)
           ON CONFLICT(table_name) DO UPDATE SET primary_field = excluded.primary_field`,
      )
      .run(table, column)
    this.onConfigChange?.()
  }

  // -------------------------------------------------------------------------
  // Tab order
  // -------------------------------------------------------------------------

  /**
   * The user's tab order, as a rank per table. Tables with no stored rank are absent, and the
   * caller leaves them where the alphabetical listing put them.
   */
  /**
   * Remember which view was last open for a table, so reopening the file lands where you left.
   *
   * Stored in the database rather than in browser storage, for the same reason everything else
   * here is: copy the file somewhere else and it should still be the tool you configured. It
   * also means the VS Code webview and browser mode agree, which two separate local stores
   * would not.
   */
  setLastView(table: string, viewId: number): void {
    this.#requireWritable()
    this.#db.connection
      .prepare(
        `INSERT INTO _airsqlite_tables (table_name, primary_field, last_view_id)
         VALUES (?, ?, ?)
         ON CONFLICT(table_name) DO UPDATE SET last_view_id = excluded.last_view_id`,
      )
      .run(table, this.primaryField(table), viewId)
  }

  #lastViewId(table: string): number | null {
    try {
      const row = this.#db.connection
        .prepare('SELECT last_view_id FROM _airsqlite_tables WHERE table_name = ?')
        .get(table) as { last_view_id: number | null } | undefined
      return row?.last_view_id ?? null
    } catch {
      // Written before the column existed and opened read-only, so the migration could not run.
      return null
    }
  }

  /** Free text shown behind an info icon on the tab, the same affordance columns have. */
  setTableDescription(table: string, description: string | null): void {
    this.#requireWritable()
    const value = description?.trim() ? description.trim() : null
    this.#db.connection
      .prepare(
        `INSERT INTO _airsqlite_tables (table_name, primary_field, description)
         VALUES (?, ?, ?)
         ON CONFLICT(table_name) DO UPDATE SET description = excluded.description`,
      )
      .run(table, this.primaryField(table), value)
    this.onConfigChange?.()
  }

  /** Descriptions for every configured table, so the tab strip needs one round trip, not N. */
  tableDescriptions(): Map<string, string> {
    const map = new Map<string, string>()
    if (!this.#available) return map
    try {
      const rows = this.#db.connection
        .prepare('SELECT table_name, description FROM _airsqlite_tables WHERE description IS NOT NULL')
        .all() as Array<{ table_name: string; description: string }>
      for (const row of rows) map.set(row.table_name, row.description)
    } catch {
      // Written before the column existed and opened read-only, so the migration could not run.
    }
    return map
  }

  tableOrder(): Map<string, number> {
    const order = new Map<string, number>()
    if (!this.#available) return order
    try {
      const rows = this.#db.connection
        .prepare('SELECT table_name, sort_order FROM _airsqlite_tables WHERE sort_order IS NOT NULL')
        .all() as Array<{ table_name: string; sort_order: number }>
      for (const row of rows) order.set(row.table_name, row.sort_order)
    } catch {
      // A database written before sort_order existed and opened read-only, so the migration
      // could not run. Alphabetical is a fine answer.
    }
    return order
  }

  /**
   * Store a complete tab order. Written in one transaction so a half-applied order — which
   * would read as tabs jumping to arbitrary places — cannot survive a failure partway through.
   *
   * A row must exist before it can be ranked, and `primary_field` is NOT NULL, so any table not
   * yet seeded gets its primary field guessed here. That is the same guess opening the tab
   * would have made a moment later.
   */
  setTableOrder(names: string[]): void {
    this.#requireWritable()
    const known = new Set(this.#db.tables().map((t) => t.name))
    for (const name of names) {
      if (!known.has(name)) throw new ProtocolError(`There is no table named "${name}".`)
    }

    this.#db.connection.transaction(() => {
      names.forEach((name, index) => {
        this.#db.connection
          .prepare(
            `INSERT INTO _airsqlite_tables (table_name, primary_field, sort_order) VALUES (?, ?, ?)
               ON CONFLICT(table_name) DO UPDATE SET sort_order = excluded.sort_order`,
          )
          .run(name, guessPrimaryField(this.#db.columns(name)), index)
      })
    })()
    this.onConfigChange?.()
  }

  // -------------------------------------------------------------------------
  // Column display types
  // -------------------------------------------------------------------------

  /** Stored display config only — no inference. Empty when nothing has been configured. */
  storedDisplays(table: string): Map<string, StoredColumn> {
    const map = new Map<string, StoredColumn>()
    if (!this.#available) return map

    const rows = this.#db.connection
      .prepare(
        'SELECT column_name, display_type, options, description FROM _airsqlite_columns WHERE table_name = ?',
      )
      .all(table) as Array<{
      column_name: string
      display_type: string
      options: string | null
      description: string | null
    }>

    for (const row of rows) {
      // A row may exist purely to hold a description, with no display type ever chosen. Falling
      // back to 'text' there would silently overwrite inference with a decision nobody made.
      const configured = DISPLAY_TYPES.has(row.display_type as DisplayType)
      map.set(row.column_name, {
        ...(configured
          ? {
              displayType: row.display_type as DisplayType,
              displayTypeInferred: false,
              options: parseJsonObject(row.options),
            }
          : {}),
        description: row.description,
      } as StoredColumn)
    }
    return map
  }

  /**
   * Introspection merged with display config: stored where the user has chosen, inferred
   * everywhere else. Inference is never written back — a guess recorded as a decision is a
   * guess nobody can tell they are allowed to change.
   */
  describeColumns(table: string): ColumnDescriptor[] {
    const columns = this.#db.columns(table)
    const stored = this.storedDisplays(table)
    const samples = this.#sample(table, columns)
    const physicalNames = new Set(columns.map((c) => c.name))

    const described: ColumnDescriptor[] = columns.map((column) => {
      const configured = stored.get(column.name)
      const description = configured?.description ?? null

      if (configured?.displayType) return { ...column, ...configured, description }

      return {
        ...column,
        displayType: inferDisplayType(column, samples.get(column.name) ?? []),
        displayTypeInferred: true,
        options: null,
        description,
      }
    })

    for (const [name, cfg] of stored) {
      if (physicalNames.has(name)) continue
      const opts = cfg.options as Record<string, unknown> | null
      if (!opts?.computed) continue

      const formula = opts.formula as string | undefined
      if (!formula) continue

      let formulaError: string | undefined
      try {
        this.#db.connection.prepare(`SELECT (${formula}) FROM ${quoteIdent(table)} LIMIT 0`).run()
      } catch (err) {
        formulaError = (err as Error).message
      }

      described.push({
        name,
        declaredType: '',
        affinity: 'TEXT',
        notNull: false,
        defaultValue: null,
        primaryKeyIndex: 0,
        displayType: cfg.displayType ?? 'text',
        displayTypeInferred: !cfg.displayType,
        options: opts,
        description: cfg.description,
        computed: true,
        formula,
        formulaError,
      })
    }

    return [...described, ...systemColumns(columns, stored)]
  }

  setColumnDisplay(table: string, column: string, display: Partial<ColumnDisplay>): void {
    this.#requireWritable()
    const isPhysical = this.#db.columns(table).some((c) => c.name === column)
    const isSystem = SYSTEM_COLUMNS.has(column)
    if (!isPhysical && !isSystem) {
      const existing = this.storedDisplays(table).get(column)
      if (!existing?.options || !(existing.options as Record<string, unknown>)['computed']) {
        throw new ProtocolError(`There is no column named "${column}" in "${table}".`)
      }
    }
    const type = display.displayType ?? 'text'
    if (!DISPLAY_TYPES.has(type)) {
      throw new ProtocolError(`"${type}" is not a field type this tool knows about.`)
    }

    let options = display.options
    if (!isSystem && !isPhysical) {
      const stored = this.storedDisplays(table).get(column)
      const storedOpts = stored?.options as Record<string, unknown> | null
      if (storedOpts?.computed) {
        options = { ...options, computed: storedOpts.computed, formula: storedOpts.formula }
      }
    }

    this.#db.connection
      .prepare(
        `INSERT INTO _airsqlite_columns (table_name, column_name, display_type, options)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (table_name, column_name)
         DO UPDATE SET display_type = excluded.display_type, options = excluded.options`,
      )
      .run(table, column, type, options ? JSON.stringify(options) : null)
    this.onConfigChange?.()
  }

  /**
   * Store a column's description — the text behind the info icon in its header.
   *
   * Separate from `setColumnDisplay` for the same reason the old layout writer was: the upsert
   * names only the column it was given, so describing a field cannot write `'text'` over a type
   * that was inferred.
   *
   * An empty string clears it, so a description can be taken back.
   *
   * `display_type` is written as an explicit NULL on insert, not left to the column default.
   * That default is `'text'`, and `storedDisplays` treats any known type as a decision the user
   * made — so omitting it would create a row that silently reports "text, not inferred" for a
   * column whose type had been correctly guessed as email or date. The old width writer had
   * exactly this flaw, and its comment claimed otherwise; folding widths into the view removed
   * the last other caller that created a row this way.
   */
  setColumnDescription(table: string, column: string, description: string | null): void {
    this.#requireWritable()
    const isPhysical = this.#db.columns(table).some((c) => c.name === column)
    if (!isPhysical) {
      const existing = this.storedDisplays(table).get(column)
      if (!existing?.options || !(existing.options as Record<string, unknown>)['computed']) {
        throw new ProtocolError(`There is no column named "${column}" in "${table}".`)
      }
    }

    const value = description?.trim() ? description.trim() : null
    this.#db.connection
      .prepare(
        `INSERT INTO _airsqlite_columns (table_name, column_name, display_type, description)
         VALUES (?, ?, NULL, ?)
         ON CONFLICT (table_name, column_name) DO UPDATE SET description = excluded.description`,
      )
      .run(table, column, value)
    this.onConfigChange?.()
  }

  #sample(table: string, columns: ColumnInfo[]): Map<string, SqlValue[]> {
    const map = new Map<string, SqlValue[]>()
    for (const column of columns) map.set(column.name, [])

    let rows: Array<Record<string, SqlValue>> = []
    try {
      rows = this.#db.connection
        .prepare(`SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT ${SAMPLE_SIZE}`)
        .all() as Array<Record<string, SqlValue>>
    } catch {
      return map
    }

    for (const row of rows) {
      for (const column of columns) {
        const value = row[column.name]
        if (value === null || value === undefined) continue
        map.get(column.name)?.push(value)
      }
    }
    return map
  }

  // -------------------------------------------------------------------------
  // Saved views
  // -------------------------------------------------------------------------

  /**
   * Every table has at least one view, and the first one is the default.
   *
   * A table with no views used to be the normal state — views were an overlay you opted into by
   * saving one. They are not any more: layout, filters, sorting and grouping all live in a view
   * and save themselves, so "no view" would mean nowhere to put a column width.
   *
   * The default is therefore minted on demand rather than during migration, which also covers
   * tables that did not exist when the file was opened. A read-only file cannot have one written,
   * so it returns an empty list and the client synthesises an ephemeral view instead — the one
   * case where the invariant holds only in memory.
   */
  views(table: string): SavedView[] {
    if (!this.#available) return []

    const rows = this.#viewRows(table)
    const materialised =
      rows.length === 0 && this.writable
        ? (this.#insertDefaultView(table), this.#viewRows(table))
        : rows

    // `isLast` is resolved here rather than by the client so a stale id — the remembered view
    // was deleted — simply marks nothing, and the client falls through to the default.
    const last = this.#lastViewId(table)
    return materialised.map((row) => ({ ...toSavedView(row), isLast: row.id === last }))
  }

  #viewRows(table: string): ViewRow[] {
    return this.#db.connection
      .prepare(
        `SELECT id, table_name, name, config, description, is_default, created_at, updated_at
           FROM _airsqlite_views WHERE table_name = ? ORDER BY is_default DESC, id`,
      )
      .all(table) as ViewRow[]
  }

  #defaultViewRow(table: string): ViewRow | undefined {
    return this.#viewRows(table)[0]
  }

  #insertDefaultView(table: string): ViewRow {
    const info = this.#db.connection
      .prepare(
        'INSERT INTO _airsqlite_views (table_name, name, config, is_default) VALUES (?, ?, ?, 1)',
      )
      .run(table, DEFAULT_VIEW_NAME, JSON.stringify({ version: 1 }))
    this.#clearOtherDefaults(table, Number(info.lastInsertRowid))
    const row = this.#defaultViewRow(table)
    if (!row) throw new ProtocolError('The default view could not be created.')
    return row
  }

  /**
   * Insert a view, or update one in place.
   *
   * **On update this is a partial patch**: only the fields actually present are written. That
   * matters because renaming a view and marking one as default both have to leave the saved
   * config alone — the working config in the UI is usually *ahead* of it, and writing that as
   * a side effect of a rename would silently save changes the user never asked to save. An
   * earlier version required `name` and defaulted `config` to `{}`, so any partial call
   * quietly wiped the view's settings.
   */
  saveView(table: string, view: Partial<SavedView>): SavedView {
    this.#requireWritable()

    const name = view.name === undefined ? undefined : view.name.trim()
    if (name !== undefined && !name) throw new ProtocolError('A view needs a name.')

    try {
      if (view.id === undefined) {
        if (!name) throw new ProtocolError('A view needs a name.')
        const config = JSON.stringify({ version: 1, ...(view.config ?? {}) })
        const created = this.#db.connection.transaction(() => {
          const info = this.#db.connection
            .prepare(
              `INSERT INTO _airsqlite_views (table_name, name, config, description, is_default)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(table, name, config, view.description ?? null, view.isDefault ? 1 : 0)
          const id = Number(info.lastInsertRowid)
          if (view.isDefault) this.#clearOtherDefaults(table, id)
          return id
        })()
        this.onConfigChange?.()
        return this.#view(created)
      }

      const sets: string[] = []
      const params: Array<string | number | null> = []
      if (name !== undefined) {
        sets.push('name = ?')
        params.push(name)
      }
      if (view.config !== undefined) {
        // `version` is typed as required but arrives over the wire, where an agent writing a
        // view by hand can leave it out. Defaulting after the spread keeps whatever it sent.
        const config = { ...view.config }
        if (config.version === undefined) config.version = 1
        sets.push('config = ?')
        params.push(JSON.stringify(config))
      }
      // A null clears the description rather than being ignored, matching how a summary is
      // removed — otherwise a description could be written but never taken back.
      if (view.description !== undefined) {
        sets.push('description = ?')
        params.push(view.description)
      }
      if (view.isDefault !== undefined) {
        sets.push('is_default = ?')
        params.push(view.isDefault ? 1 : 0)
      }
      if (sets.length === 0) throw new ProtocolError('There is nothing to change about that view.')

      sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')")
      params.push(view.id)

      const id = view.id
      this.#db.connection.transaction(() => {
        const info = this.#db.connection
          .prepare(`UPDATE _airsqlite_views SET ${sets.join(', ')} WHERE id = ?`)
          .run(...params)
        if (info.changes === 0) throw new ProtocolError('That view no longer exists.')
        // Exactly one default per table. Without this, `views()` orders by is_default and the
        // client takes the first — so a second default makes which view opens depend on rowid.
        if (view.isDefault) this.#clearOtherDefaults(table, id)
      })()

      this.onConfigChange?.()
      return this.#view(view.id)
    } catch (err) {
      throw mapSqliteError(err, { table })
    }
  }

  #clearOtherDefaults(table: string, keepId: number): void {
    this.#db.connection
      .prepare('UPDATE _airsqlite_views SET is_default = 0 WHERE table_name = ? AND id != ?')
      .run(table, keepId)
  }

  deleteView(viewId: number): void {
    this.#requireWritable()
    this.#db.connection.transaction(() => {
      const info = this.#db.connection
        .prepare('DELETE FROM _airsqlite_views WHERE id = ?')
        .run(viewId)
      if (info.changes === 0) throw new ProtocolError('That view no longer exists.')

      // Forget it as the last-opened, in the same transaction.
      //
      // `_airsqlite_views.id` is an INTEGER PRIMARY KEY with no AUTOINCREMENT, so SQLite hands
      // the freed rowid to the next view created — including the default this very delete
      // causes to be minted. A dangling `last_view_id` would then resolve to a *different*
      // view that happens to have inherited the number, and the file would reopen somewhere
      // nobody chose.
      this.#db.connection
        .prepare('UPDATE _airsqlite_tables SET last_view_id = NULL WHERE last_view_id = ?')
        .run(viewId)
    })()
    this.onConfigChange?.()
  }

  #view(id: number): SavedView {
    const row = this.#db.connection
      .prepare(
        `SELECT id, table_name, name, config, description, is_default, created_at, updated_at
           FROM _airsqlite_views WHERE id = ?`,
      )
      .get(id) as ViewRow | undefined

    if (!row) throw new ProtocolError('That view no longer exists.')
    return toSavedView(row)
  }

  #requireWritable(): void {
    if (!this.writable) {
      throw new ProtocolError(
        'This database is read-only, so its configuration can’t be changed here.',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

const NAME_HINTS = ['name', 'title', 'label', 'display_name', 'full_name', 'subject']

/**
 * Pick a sensible display column: a recognisable name column if one exists, otherwise the
 * first text column that is not the primary key, otherwise the primary key.
 */
export function guessPrimaryField(columns: ColumnInfo[]): string {
  if (columns.length === 0) return 'rowid'

  const named = columns.find(
    (c) => NAME_HINTS.includes(c.name.toLowerCase()) && c.affinity === 'TEXT',
  )
  if (named) return named.name

  const text = columns.find((c) => c.affinity === 'TEXT' && c.primaryKeyIndex === 0)
  if (text) return text.name

  const pk = columns.find((c) => c.primaryKeyIndex === 1)
  return pk?.name ?? columns[0]?.name ?? 'rowid'
}

/**
 * Guess what a column holds from its affinity and a sample of its values. Kept conservative:
 * a wrong guess shows an editor that cannot represent the data, which is worse than a plain
 * text box. Notably absent is single_select — a column with few distinct values might be a
 * select, or might just be a small table, and the user configures that one.
 */
export function inferDisplayType(column: ColumnInfo, samples: SqlValue[]): DisplayType {
  const values = samples.filter((v) => v !== null && v !== undefined)

  if (column.affinity === 'INTEGER') {
    const allBoolean =
      values.length > 0 && values.every((v) => v === 0 || v === 1 || v === '0' || v === '1')
    return allBoolean ? 'checkbox' : 'number'
  }

  if (column.affinity === 'REAL' || column.affinity === 'NUMERIC') return 'number'

  const strings = values.filter((v): v is string => typeof v === 'string' && v !== '')
  if (strings.length === 0) return 'text'

  const every = (test: (value: string) => boolean) => strings.every(test)

  if (every((v) => EMAIL.test(v))) return 'email'
  if (every((v) => URL.test(v))) return 'url'
  if (every((v) => ISO_DATE.test(v))) return 'date'
  if (every(isJsonArray)) return 'multi_select'
  if (every((v) => PHONE.test(v))) return 'phone'

  const longest = strings.reduce((max, v) => Math.max(max, v.length), 0)
  if (longest > LONG_TEXT_THRESHOLD || strings.some((v) => v.includes('\n'))) return 'long_text'

  return 'text'
}

/** Multi-select has one canonical storage format: a JSON array in a TEXT column. */
function isJsonArray(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return false
  try {
    return Array.isArray(JSON.parse(trimmed))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// JSON helpers — defensive, because these columns are editable by anything
// ---------------------------------------------------------------------------

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Unknown keys are preserved rather than stripped, so a view written by a newer version of
 * this tool survives a round trip through an older one.
 */
function parseViewConfig(text: string): ViewConfig {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { version: 1, ...(parsed as Record<string, unknown>) } as ViewConfig
    }
  } catch {
    // A corrupt config should cost the user their layout, not their data.
  }
  return { version: 1 }
}

/**
 * The virtual Created and Modified columns, derived from the changelog rather than stored in
 * any SQLite table.
 *
 * They are deliberately *not* written into `_airsqlite_columns`. That table configures columns the
 * user can change the display type of; these two are non-editable timestamps with nothing to
 * configure, and rows in there describing columns that do not exist would make every reader
 * of that table handle a case that never has an answer.
 *
 * Skipped entirely when the table already has a column by either name — a real column always
 * wins over a derived one.
 */
const SYSTEM_COLUMNS = new Set([ROWID_COLUMN, CREATED_COLUMN, MODIFIED_COLUMN])

function systemColumns(columns: ColumnInfo[], stored: Map<string, StoredColumn>): ColumnDescriptor[] {
  const names = new Set(columns.map((c) => c.name))
  if (names.has(ROWID_COLUMN) || names.has(CREATED_COLUMN) || names.has(MODIFIED_COLUMN)) return []

  const base = {
    declaredType: 'TEXT',
    affinity: 'TEXT',
    notNull: false,
    defaultValue: null,
    primaryKeyIndex: 0,
    displayType: 'text',
    displayTypeInferred: false,
    options: null,
    virtual: true,
  } as const

  const dateDefaults = { showTime: true }
  const dateCol = (name: string) => {
    const cfg = stored.get(name)
    return {
      ...base,
      name,
      displayType: 'date' as const,
      options: cfg?.options ? { ...dateDefaults, ...cfg.options } : dateDefaults,
    }
  }

  return [
    { ...base, name: ROWID_COLUMN, declaredType: 'INTEGER', affinity: 'INTEGER' as const, displayType: 'number' as const },
    dateCol(CREATED_COLUMN),
    dateCol(MODIFIED_COLUMN),
  ]
}
