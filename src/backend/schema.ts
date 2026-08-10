import type { Db } from './db.js'
import { ProtocolError, mapSqliteError } from './errors.js'
import { quoteIdent } from './filter.js'

// Changing the shape of the database, rather than its contents.
//
// This is the only module here that can lose data, and the difference between it and the rest
// of the backend is that SQLite will not stop you. Dropping a column a VIEW selects leaves the
// view in place and broken; it fails at next read, long after the action that broke it. So
// every destructive operation here can be *asked* about first — `dependents()` returns what a
// drop would break — and the UI is expected to put that in front of the user before calling.
//
// The configuration tables are cleaned up in the same transaction as the DDL. A dropped column
// that leaves its width behind in three view configs is a slow leak; worse, if the column is
// later recreated with the same name it silently inherits settings nobody chose.

/** A SQL VIEW that reads from something a drop is about to remove. */
export interface Dependent {
  name: string
  /** True when the view's SQL names the column specifically, not merely the table. */
  namesColumn: boolean
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The configuration tables that key rows on `table_name`, and so follow a rename. */
const META_TABLES = [
  '_airsqlite_tables',
  '_airsqlite_columns',
  '_airsqlite_views',
  '_airsqlite_actions',
] as const

/**
 * Column types offered when creating a column.
 *
 * Deliberately four, not the full SQLite vocabulary. Affinity is what actually matters and
 * these cover it; a `VARCHAR(255)` picker would imply a length limit SQLite does not enforce.
 */
export const COLUMN_TYPES = ['TEXT', 'INTEGER', 'REAL', 'BLOB'] as const
export type ColumnType = (typeof COLUMN_TYPES)[number]

function assertIdentifier(name: string, what: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new ProtocolError(`A ${what} needs a name.`)
  // Quoting would make almost anything legal, but a table called `drop table x--` is a name
  // nobody typed on purpose, and rejecting it is friendlier than storing it.
  if (!IDENTIFIER.test(trimmed)) {
    throw new ProtocolError(
      `"${trimmed}" is not a usable ${what} name. Use letters, numbers, and underscores, starting with a letter or underscore.`,
    )
  }
  if (trimmed.toLowerCase().startsWith('_airsqlite_') || trimmed.toLowerCase().startsWith('sqlite_')) {
    throw new ProtocolError(`Names starting with "${trimmed.split('_')[0]}_" are reserved.`)
  }
  return trimmed
}

export class Schema {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  /**
   * The SQL VIEWs that would break if this table, or this column, were dropped.
   *
   * Text matching on `sqlite_master.sql`, because SQLite records no column-level dependency
   * graph — there is nothing to query. That makes this a *conservative* check: it can name a
   * view that would have survived (the word appears in a string literal, say), and it will not
   * miss one that reads `SELECT *`, since that view names the table.
   *
   * Over-reporting is the right failure direction here. The output goes into a confirmation
   * dialog, where one extra name makes somebody look twice and a missing name makes them
   * destroy something silently.
   */
  dependents(table: string, column?: string): Dependent[] {
    const views = this.#db.connection
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'view' AND sql IS NOT NULL`)
      .all() as Array<{ name: string; sql: string }>

    const tableWord = new RegExp(`\\b${escapeRegExp(table)}\\b`, 'i')
    const columnWord = column ? new RegExp(`\\b${escapeRegExp(column)}\\b`, 'i') : null

    return views
      .filter((view) => tableWord.test(view.sql))
      .map((view) => ({
        name: view.name,
        namesColumn: columnWord ? columnWord.test(view.sql) : false,
      }))
  }

  createTable(name: string): string {
    const table = assertIdentifier(name, 'table')
    if (this.#db.connection.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(table)) {
      throw new ProtocolError(`Something called "${table}" already exists in this database.`)
    }

    try {
      // An `id INTEGER PRIMARY KEY` is the rowid under another name, which is what everything
      // above this depends on for row identity — selection, editing, the detail panel, and the
      // changelog all key on it. A table without one would open read-only, which is a strange
      // thing to have just created.
      this.#db.connection.exec(
        `CREATE TABLE ${quoteIdent(table)} (id INTEGER PRIMARY KEY, name TEXT)`,
      )
      this.#db.invalidateSchema()
      return table
    } catch (err) {
      throw mapSqliteError(err, { table })
    }
  }

  /**
   * Rename a table, and everything that refers to it by name.
   *
   * The four `_airsqlite_*` tables key their rows on `table_name`, so renaming the table alone
   * would leave it with its data intact and no views, field types, or buttons — they would
   * still be there, pointing at a name nothing answers to. One transaction, so a failure
   * halfway cannot produce exactly that state.
   *
   * SQLite rewrites references in other tables' foreign keys itself when `legacy_alter_table`
   * is off, which it is by default.
   */
  renameTable(table: string, name: string): string {
    this.#assertUserTable(table)
    const target = assertIdentifier(name, 'table')
    if (target === table) return table
    if (this.#db.connection.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(target)) {
      throw new ProtocolError(`Something called "${target}" already exists in this database.`)
    }

    try {
      this.#db.connection.transaction(() => {
        this.#db.connection.exec(
          `ALTER TABLE ${quoteIdent(table)} RENAME TO ${quoteIdent(target)}`,
        )
        for (const meta of META_TABLES) {
          this.#db.connection
            .prepare(`UPDATE ${meta} SET table_name = ? WHERE table_name = ?`)
            .run(target, table)
        }
      })()
      this.#db.invalidateSchema()
      return target
    } catch (err) {
      throw mapSqliteError(err, { table })
    }
  }

  dropTable(table: string): void {
    this.#assertUserTable(table)
    try {
      this.#db.connection.transaction(() => {
        this.#db.connection.exec(`DROP TABLE ${quoteIdent(table)}`)
        this.#forgetTable(table)
      })()
      this.#db.invalidateSchema()
    } catch (err) {
      throw mapSqliteError(err, { table })
    }
  }

  addColumn(table: string, name: string, type: ColumnType): string {
    this.#assertUserTable(table)
    const column = assertIdentifier(name, 'column')
    if (this.#db.columns(table).some((c) => c.name === column)) {
      throw new ProtocolError(`"${table}" already has a column called "${column}".`)
    }
    if (!COLUMN_TYPES.includes(type)) {
      throw new ProtocolError(`"${type}" is not a column type this tool knows about.`)
    }

    try {
      // No NOT NULL and no default: ALTER TABLE ADD COLUMN on a populated table would have to
      // invent a value for every existing row, and an invented value is indistinguishable from
      // one somebody meant.
      this.#db.connection.exec(
        `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(column)} ${type}`,
      )
      this.#db.invalidateSchema()
      return column
    } catch (err) {
      throw mapSqliteError(err, { table })
    }
  }

  /**
   * Drop a column, with the configuration that referenced it.
   *
   * SQLite refuses this outright for a column that is PRIMARY KEY, UNIQUE, indexed, or named
   * by a foreign key or generated column — there is no flag for it. The alternative would be
   * rebuilding the table, which is a far riskier operation than the one being asked for, so the
   * refusal is passed up as a sentence instead. The transaction means a refusal changes nothing.
   */
  dropColumn(table: string, column: string): void {
    this.#assertUserTable(table)
    this.#assertColumn(table, column)

    const remaining = this.#db.columns(table).filter((c) => c.name !== column)
    if (remaining.length === 0) {
      throw new ProtocolError(`"${column}" is the only column in "${table}".`)
    }

    try {
      this.#db.connection.transaction(() => {
        this.#db.connection.exec(
          `ALTER TABLE ${quoteIdent(table)} DROP COLUMN ${quoteIdent(column)}`,
        )
        this.#forgetColumn(table, column, remaining[0]?.name ?? null)
      })()
      this.#db.invalidateSchema()
    } catch (err) {
      throw mapSqliteError(err, { table })
    }
  }

  /**
   * Copy a column's definition, and optionally its values.
   *
   * Two separate questions the UI has to ask as one: a duplicate with values is a backup you
   * are about to edit, a duplicate without is a new field shaped like an old one. Guessing
   * either way is wrong half the time.
   */
  duplicateColumn(table: string, column: string, name: string, copyValues: boolean): string {
    this.#assertUserTable(table)
    this.#assertColumn(table, column)
    const target = assertIdentifier(name, 'column')
    if (this.#db.columns(table).some((c) => c.name === target)) {
      throw new ProtocolError(`"${table}" already has a column called "${target}".`)
    }

    const source = this.#db.columns(table).find((c) => c.name === column)
    const type = source?.declaredType?.trim() || 'TEXT'

    try {
      this.#db.connection.transaction(() => {
        this.#db.connection.exec(
          `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(target)} ${type}`,
        )
        if (copyValues) {
          this.#db.connection.exec(
            `UPDATE ${quoteIdent(table)} SET ${quoteIdent(target)} = ${quoteIdent(column)}`,
          )
        }
        // The copy inherits display type, options, and description — it is the same *kind* of
        // field, and re-choosing "currency" on a duplicate of a currency column is busywork.
        this.#db.connection
          .prepare(
            `INSERT INTO _airsqlite_columns (table_name, column_name, display_type, options, description)
             SELECT table_name, ?, display_type, options, description
               FROM _airsqlite_columns WHERE table_name = ? AND column_name = ?`,
          )
          .run(target, table, column)
      })()
      this.#db.invalidateSchema()
      return target
    } catch (err) {
      throw mapSqliteError(err, { table })
    }
  }

  #assertUserTable(table: string): void {
    if (!this.#db.tables().some((t) => t.name === table)) {
      throw new ProtocolError(`There is no table named "${table}" in this database.`)
    }
  }

  #assertColumn(table: string, column: string): void {
    if (!this.#db.columns(table).some((c) => c.name === column)) {
      throw new ProtocolError(`There is no column named "${column}" in "${table}".`)
    }
  }

  /** Every trace of a dropped table in the configuration tables. */
  #forgetTable(table: string): void {
    const conn = this.#db.connection
    conn.prepare('DELETE FROM _airsqlite_tables WHERE table_name = ?').run(table)
    conn.prepare('DELETE FROM _airsqlite_columns WHERE table_name = ?').run(table)
    conn.prepare('DELETE FROM _airsqlite_views WHERE table_name = ?').run(table)
    conn.prepare('DELETE FROM _airsqlite_actions WHERE table_name = ?').run(table)
  }

  /**
   * Every trace of a dropped column: its own config row, its entry in each of this table's
   * view configs, and its primary-field claim.
   *
   * The view configs are JSON blobs, so this is a read-modify-write per view rather than a
   * DELETE. Leaving them alone would be invisible until the column came back under the same
   * name and silently inherited a width, a summary, and a place in the column order.
   */
  #forgetColumn(table: string, column: string, fallbackPrimary: string | null): void {
    const conn = this.#db.connection
    conn
      .prepare('DELETE FROM _airsqlite_columns WHERE table_name = ? AND column_name = ?')
      .run(table, column)

    if (fallbackPrimary) {
      conn
        .prepare(
          `UPDATE _airsqlite_tables SET primary_field = ?
            WHERE table_name = ? AND primary_field = ?`,
        )
        .run(fallbackPrimary, table, column)
    }

    const views = conn
      .prepare('SELECT id, config FROM _airsqlite_views WHERE table_name = ?')
      .all(table) as Array<{ id: number; config: string }>

    const update = conn.prepare('UPDATE _airsqlite_views SET config = ? WHERE id = ?')
    for (const view of views) {
      let config: Record<string, unknown>
      try {
        config = JSON.parse(view.config) as Record<string, unknown>
      } catch {
        continue
      }
      const next = stripColumn(config, column)
      if (next) update.run(JSON.stringify(next), view.id)
    }
  }
}

/** Remove a column from one view config. Returns null when nothing referenced it. */
export function stripColumn(
  config: Record<string, unknown>,
  column: string,
): Record<string, unknown> | null {
  let touched = false
  const next: Record<string, unknown> = { ...config }

  for (const key of ['columnVisibility', 'columnWidths', 'summary']) {
    const map = next[key]
    if (map && typeof map === 'object' && column in (map as Record<string, unknown>)) {
      const copy = { ...(map as Record<string, unknown>) }
      delete copy[column]
      next[key] = copy
      touched = true
    }
  }

  if (Array.isArray(next['columnOrder']) && next['columnOrder'].includes(column)) {
    next['columnOrder'] = (next['columnOrder'] as string[]).filter((c) => c !== column)
    touched = true
  }

  if (Array.isArray(next['grouping']) && next['grouping'].includes(column)) {
    next['grouping'] = (next['grouping'] as string[]).filter((c) => c !== column)
    touched = true
  }

  if (Array.isArray(next['sort'])) {
    const sort = next['sort'] as Array<{ column?: string }>
    const kept = sort.filter((rule) => rule.column !== column)
    if (kept.length !== sort.length) {
      next['sort'] = kept
      touched = true
    }
  }

  // A filter referencing a dropped column would compile to SQL naming a column that no longer
  // exists, so every query against the view would fail. Pruning the condition is the only
  // option that leaves the view usable.
  const filter = next['filter']
  if (filter && typeof filter === 'object') {
    const pruned = pruneFilter(filter as Record<string, unknown>, column)
    if (pruned !== filter) {
      next['filter'] = pruned
      touched = true
    }
  }

  return touched ? next : null
}

function pruneFilter(node: Record<string, unknown>, column: string): unknown {
  if (node['kind'] === 'condition') return node['column'] === column ? null : node
  if (node['kind'] !== 'group' || !Array.isArray(node['children'])) return node

  const children = (node['children'] as Array<Record<string, unknown>>)
    .map((child) => pruneFilter(child, column))
    .filter((child) => child !== null)

  if (children.length === 0) return null
  if (children.length === (node['children'] as unknown[]).length) return node
  return { ...node, children }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
