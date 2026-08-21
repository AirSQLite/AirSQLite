import BetterSqlite3 from 'better-sqlite3'
import type {
  ChangeOp,
  ColumnInfo,
  FilterNode,
  ForeignKeyInfo,
  GroupInfo,
  LinkLabels,
  QueryRequest,
  QueryResult,
  RecordLocator,
  RelatedGroup,
  ReverseForeignKey,
  Row,
  RowStamps,
  SortSpec,
  SqlValue,
  SummaryFunction,
  SummaryResult,
  TableInfo,
  WriteResult,
} from '../shared/protocol.js'
import { ROWID_COLUMN, CREATED_COLUMN, MODIFIED_COLUMN } from '../shared/protocol.js'
import { ProtocolError, mapSqliteError } from './errors.js'
import { compileFilter, compileSearch, quoteIdent, type LinkTarget } from './filter.js'

// The only module in the project that touches SQLite. Everything above it works in terms of
// structured requests; nothing above it can construct SQL.
//
// The pragmas set on open are not incidental. The whole point of this tool is watching an AI
// agent write to a database while you look at it, which means two processes hold the file at
// once — WAL so a reader never blocks a writer, and busy_timeout so a brief collision waits
// instead of throwing.

export interface ComputedColumn {
  name: string
  formula: string
}

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 5_000
/** How many children a reverse-lookup section lists before it just reports the count. */
const DEFAULT_RELATED_LIMIT = 50
/** Bound-parameter batch size for label lookups. Well under SQLite's ceiling on every build. */
const LABEL_BATCH = 500

export interface OpenOptions {
  readonly?: boolean
}

/**
 * What Db calls when a write lands. Implemented by the changelog, which returns the
 * timestamp it recorded so the write result can carry it back to the UI.
 */
export type ChangeSink = (
  op: ChangeOp,
  table: string,
  rowid: number,
  before: Record<string, SqlValue>,
  after: Record<string, SqlValue>,
) => string | null

interface TableInfoRow {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

interface ForeignKeyRow {
  id: number
  seq: number
  table: string
  from: string
  to: string | null
}

/** SQLite's affinity rules, in the order the documentation specifies them. */
function pluralize(word: string): string[] {
  const candidates: string[] = []
  if (word.endsWith('y') && word.length > 1 && !/[aeiou]/i.test(word[word.length - 2]!)) {
    candidates.push(word.slice(0, -1) + 'ies')
  }
  if (/(?:s|x|z|ch|sh)$/.test(word)) {
    candidates.push(word + 'es')
  }
  candidates.push(word + 's')
  return candidates
}

function affinityOf(declaredType: string): ColumnInfo['affinity'] {
  const type = declaredType.toUpperCase()
  if (type.includes('INT')) return 'INTEGER'
  if (type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT')) return 'TEXT'
  if (type.includes('BLOB') || type === '') return 'BLOB'
  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 'REAL'
  return 'NUMERIC'
}

export class Db {
  #conn: BetterSqlite3.Database
  #tableCache: Map<string, TableInfo> | null = null

  private constructor(conn: BetterSqlite3.Database) {
    this.#conn = conn
  }

  static open(file: string, options: OpenOptions = {}): Db {
    let conn: BetterSqlite3.Database
    try {
      conn = new BetterSqlite3(file, { readonly: options.readonly ?? false, fileMustExist: true })
    } catch (err) {
      throw mapSqliteError(err)
    }

    if (!options.readonly) {
      // WAL lets an external writer and this reader coexist. It is also the mode the
      // requirements assume when they talk about watching the -wal sidecar for changes.
      conn.pragma('journal_mode = WAL')
    }
    conn.pragma('busy_timeout = 5000')
    conn.pragma('foreign_keys = ON')

    return new Db(conn)
  }

  close(): void {
    if (!this.#conn.readonly) {
      this.#conn.pragma('wal_checkpoint(TRUNCATE)')
    }
    this.#conn.close()
  }

  /** Escape hatch for the metadata layer and tests. Nothing in the UI path should use it. */
  get connection(): BetterSqlite3.Database {
    return this.#conn
  }

  get readonly(): boolean {
    return this.#conn.readonly
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /** User tables only — SQLite's own bookkeeping and our _airsqlite_* tables stay hidden. */
  tables(): TableInfo[] {
    return [...this.#tableMap().values()]
  }

  #tableMap(): Map<string, TableInfo> {
    if (this.#tableCache) return this.#tableCache

    const rows = this.#conn
      .prepare(
        // `meta` is excluded by exact name, not by pattern. It is the conventional name for a
        // key/value housekeeping table — schema version, last-run timestamps — and it is
        // bookkeeping about the database rather than data in it, so a tab for it is noise.
        // Exact match on purpose: `metadata`, `meta_events`, or anything else a user might
        // legitimately want to see stays visible.
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
            AND name NOT LIKE '\\_airsqlite\\_%' ESCAPE '\\'
            -- The old prefix stays excluded. A file that was opened by an earlier build and
            -- has not yet been through the rename migration -- a read-only one, say -- would
            -- otherwise show four config tables as browsable tabs.
            AND name NOT LIKE '\\_meta\\_%' ESCAPE '\\'
            AND name <> 'meta'
          ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string | null }>

    const map = new Map<string, TableInfo>()
    for (const row of rows) {
      map.set(row.name, {
        name: row.name,
        withoutRowid: /WITHOUT\s+ROWID/i.test(row.sql ?? ''),
        primaryField: null, // Phase 4 fills this in from _airsqlite_tables.
      })
    }

    this.#tableCache = map
    return map
  }

  /** Drop cached schema. Call after anything that could change the set of tables. */
  invalidateSchema(): void {
    this.#tableCache = null
  }

  #table(name: string): TableInfo {
    const info = this.#tableMap().get(name)
    if (!info) throw new ProtocolError(`There is no table named "${name}" in this database.`)
    return info
  }

  /**
   * The distinct non-empty values of a column, in order, capped.
   *
   * For turning an existing column into a select field: the options it should offer are the
   * values it already holds. NULL and the empty string are excluded because neither is a
   * category — a select field's "no value" is the absence of a chip, not a chip named "".
   *
   * The cap is a guard, not a page: a column with 40,000 distinct values is not a select field,
   * and returning the first 200 of them makes that obvious faster than returning all of them.
   */
  distinctValues(table: string, column: string, limit = 200, expression?: string): SqlValue[] {
    this.#table(table)
    if (!expression && !this.#columnNames(table).has(column)) {
      throw new ProtocolError(`There is no column named "${column}" in "${table}".`)
    }
    const expr = expression ? `(${expression})` : quoteIdent(column)
    const rows = this.#conn
      .prepare(
        `SELECT DISTINCT ${expr} AS v FROM ${quoteIdent(table)}
          WHERE ${expr} IS NOT NULL AND ${expr} != ''
          ORDER BY 1 LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 1000))) as Array<{ v: SqlValue }>
    return rows.map((row) => row.v)
  }

  columns(table: string): ColumnInfo[] {
    this.#table(table)
    const rows = this.#conn.pragma(`table_info(${quoteIdent(table)})`) as TableInfoRow[]
    return rows.map((row) => ({
      name: row.name,
      declaredType: row.type,
      affinity: affinityOf(row.type),
      notNull: row.notnull === 1,
      defaultValue: row.dflt_value,
      primaryKeyIndex: row.pk,
    }))
  }

  #columnNames(table: string): Set<string> {
    return new Set(this.columns(table).map((c) => c.name))
  }

  /**
   * Foreign keys declared *by* this table. Composite keys arrive from the pragma as several
   * rows sharing one id, so they are grouped back together here — code that assumes one row
   * per key silently mangles them.
   */
  foreignKeys(table: string): ForeignKeyInfo[] {
    this.#table(table)
    const rows = this.#conn.pragma(`foreign_key_list(${quoteIdent(table)})`) as ForeignKeyRow[]

    const grouped = new Map<number, ForeignKeyInfo>()
    for (const row of [...rows].sort((a, b) => a.id - b.id || a.seq - b.seq)) {
      let entry = grouped.get(row.id)
      if (!entry) {
        entry = { id: row.id, fromColumns: [], toTable: row.table, toColumns: [] }
        grouped.set(row.id, entry)
      }
      // `to` is null when the FK omits the target column and implicitly references the
      // target's primary key; seq then selects which part of a composite key this is.
      const target = row.to ?? this.#primaryKeyColumns(row.table)[row.seq] ?? 'rowid'
      entry.fromColumns.push(row.from)
      entry.toColumns.push(target)
    }

    return [...grouped.values()]
  }

  #primaryKeyColumns(table: string): string[] {
    if (!this.#tableMap().has(table)) return []
    return this.columns(table)
      .filter((c) => c.primaryKeyIndex > 0)
      .sort((a, b) => a.primaryKeyIndex - b.primaryKeyIndex)
      .map((c) => c.name)
  }

  #labelFallbacks(table: string, primaryField: string, keyColumn: string): string[] {
    if (!this.#tableMap().has(table)) return []
    const skip = new Set([primaryField.toLowerCase(), keyColumn.toLowerCase()])
    const cols = this.columns(table)
    const nameish: string[] = []
    const other: string[] = []
    for (const col of cols) {
      const lower = col.name.toLowerCase()
      if (skip.has(lower) || col.primaryKeyIndex > 0) continue
      if (col.affinity !== 'TEXT') continue
      if (/name|title|label|organization|subject/.test(lower)) nameish.push(quoteIdent(col.name))
      else other.push(quoteIdent(col.name))
    }
    return [...nameish, ...other.slice(0, 2)].map((c) => `NULLIF(${c}, '')`)
  }

  /**
   * Infer foreign keys from naming conventions (`_id` suffix) for columns that have no
   * declared FOREIGN KEY constraint. `company_id` matches a table named `company` or
   * `companies`; the match is case-insensitive.
   */
  inferredForeignKeys(table: string): ForeignKeyInfo[] {
    this.#table(table)
    const declared = new Set(
      this.foreignKeys(table).flatMap((fk) => fk.fromColumns.map((c) => c.toLowerCase())),
    )
    const tableNames = this.tables().map((t) => t.name)
    const tableByLower = new Map(tableNames.map((n) => [n.toLowerCase(), n]))

    const results: ForeignKeyInfo[] = []
    for (const col of this.columns(table)) {
      const lower = col.name.toLowerCase()
      if (!lower.endsWith('_id') || declared.has(lower)) continue
      const base = lower.slice(0, -3) // strip `_id`
      if (!base) continue

      const match = this.#matchTable(base, tableByLower)
      if (!match || match.toLowerCase() === table.toLowerCase()) continue

      const pk = this.#primaryKeyColumns(match)
      if (pk.length !== 1) continue

      results.push({
        id: -1,
        fromColumns: [col.name],
        toTable: match,
        toColumns: pk,
        inferred: true,
      })
    }
    return results
  }

  #matchTable(base: string, tableByLower: Map<string, string>): string | undefined {
    // Exact match first, then simple English plurals.
    if (tableByLower.has(base)) return tableByLower.get(base)

    for (const plural of pluralize(base)) {
      if (tableByLower.has(plural)) return tableByLower.get(plural)
    }
    return undefined
  }

  /**
   * Foreign keys pointing *at* this table, found by scanning every other table. This is what
   * makes the reverse-lookup section in the detail panel possible without any configuration:
   * if orders references customers, a customer record can list its orders.
   */
  reverseForeignKeys(table: string): ReverseForeignKey[] {
    this.#table(table)
    const found: ReverseForeignKey[] = []

    for (const other of this.tables()) {
      if (other.name === table) continue
      for (const fk of [...this.foreignKeys(other.name), ...this.inferredForeignKeys(other.name)]) {
        if (fk.toTable.toLowerCase() !== table.toLowerCase()) continue
        found.push({
          fromTable: other.name,
          fromColumns: fk.fromColumns,
          toColumns: fk.toColumns,
        })
      }
    }

    return found
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * How to resolve a linked-record filter to the value the user actually sees. Supplied by
   * the metadata layer, which owns primary fields; without it, filtering a foreign key
   * column can only compare raw key values.
   */
  linkResolver: ((table: string) => Map<string, LinkTarget>) | null = null

  /**
   * Where writes get recorded. Set by createSession. It has to be called from inside the
   * write methods rather than by the caller afterwards, because only here can the *before*
   * values still be read.
   */
  changelog: ChangeSink | null = null

  /**
   * Created/Modified for a row, supplied by the changelog. Rows carry these as virtual
   * columns so the grid can render them without a second round trip per row.
   */
  stampResolver: ((table: string, rowid: number) => RowStamps) | null = null

  /**
   * Has another connection committed since we last looked? SQLite bumps data_version on
   * external commits and leaves it alone for our own, which is exactly the question the file
   * watcher needs answered — a plain file-mtime check cannot tell our writes from theirs.
   */
  dataVersion(): number {
    return this.#conn.pragma('data_version', { simple: true }) as number
  }

  /** Attach the virtual system columns, unless the table already has a column by that name. */
  #withStamps(table: string, rows: Row[]): Row[] {
    const resolve = this.stampResolver
    if (!resolve || rows.length === 0) return rows

    const names = this.#columnNames(table)
    if (names.has(CREATED_COLUMN) || names.has(MODIFIED_COLUMN)) return rows

    return rows.map((row) => {
      if (row.rowid === null) return row
      const stamps = resolve(table, row.rowid)
      return { ...row, [ROWID_COLUMN]: row.rowid, [CREATED_COLUMN]: stamps.created, [MODIFIED_COLUMN]: stamps.modified }
    })
  }

  query(request: QueryRequest, computedColumns?: ComputedColumn[]): QueryResult {
    const table = this.#table(request.table)
    const columns = this.#columnNames(request.table)
    const quoted = quoteIdent(request.table)
    const compExprs = computedExprMap(computedColumns)

    const { sql: where, params } = this.#conditions(request.table, request, compExprs)

    // WITHOUT ROWID tables have no rowid to select — the UI shows them read-only.
    const base = table.withoutRowid ? '*' : 'rowid AS rowid, *'
    const selection = appendComputedSelect(base, computedColumns)
    const order = this.#orderBy(request.sort, columns, request.groupBy, compExprs, request.groupSort)
    const limit = Math.min(request.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
    const offset = Math.max(request.offset ?? 0, 0)

    try {
      const rows = this.#conn
        .prepare(`SELECT ${selection} FROM ${quoted} WHERE ${where}${order} LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as Row[]

      const filteredCount = (
        this.#conn.prepare(`SELECT COUNT(*) n FROM ${quoted} WHERE ${where}`).get(...params) as {
          n: number
        }
      ).n

      const totalCount = (
        this.#conn.prepare(`SELECT COUNT(*) n FROM ${quoted}`).get() as { n: number }
      ).n

      return {
        rows: this.#withStamps(
          request.table,
          rows.map((row) => (table.withoutRowid ? { ...row, rowid: null } : row)),
        ),
        filteredCount,
        totalCount,
      }
    } catch (err) {
      throw mapSqliteError(err, { table: request.table })
    }
  }

  /**
   * One row, located by rowid or by a key column value.
   *
   * The key-column form exists because a linked-record chip knows the foreign key value it
   * holds, not where that row sits in the target table.
   */
  record(table: string, locator: RecordLocator, computedColumns?: ComputedColumn[]): Row | null {
    const info = this.#table(table)

    let where: string
    let param: SqlValue
    if ('rowid' in locator) {
      if (info.withoutRowid) {
        throw new ProtocolError(
          `"${table}" is a WITHOUT ROWID table, so its rows cannot be looked up by rowid.`,
        )
      }
      where = 'rowid = ?'
      param = locator.rowid
    } else {
      this.#assertColumn(table, locator.keyColumn)
      where = `${quoteIdent(locator.keyColumn)} = ?`
      param = locator.keyValue
    }

    const base = info.withoutRowid ? '*' : 'rowid AS rowid, *'
    const selection = appendComputedSelect(base, computedColumns)
    try {
      const row = this.#conn
        .prepare(`SELECT ${selection} FROM ${quoteIdent(table)} WHERE ${where} LIMIT 1`)
        .get(normalize(param)) as Row | undefined
      if (!row) return null
      const resolved = info.withoutRowid ? { ...row, rowid: null } : row
      return this.#withStamps(table, [resolved])[0] ?? resolved
    } catch (err) {
      throw mapSqliteError(err, { table })
    }
  }

  /**
   * Every child record pointing at one parent row, grouped by inbound foreign key.
   *
   * This deliberately does not go through the filter compiler. Since Phase 6, `is` on a link
   * column resolves through the target's *display* value, so expressing "orders whose
   * customer_id is 5" as a filter would compile to a primary-field match and find nothing.
   * Here the raw key values are what matter, which also means composite keys work — the
   * filter path excludes them for want of a single display column.
   *
   * `primaryField` is left empty; the protocol router fills it in, because that is where Db
   * and Meta already meet and Db has no business knowing about display columns.
   */
  related(table: string, rowid: number, limit = DEFAULT_RELATED_LIMIT): RelatedGroup[] {
    const parent = this.record(table, { rowid })
    if (!parent) throw new ProtocolError(`That record no longer exists in "${table}".`)

    const capped = Math.min(Math.max(limit, 1), MAX_LIMIT)
    const groups: RelatedGroup[] = []

    for (const fk of this.reverseForeignKeys(table)) {
      const keys = fk.toColumns.map((column) => parent[column] ?? null)
      // NULL never matches in SQL, and a child row holding a NULL foreign key is not a
      // relationship — listing those would turn "this customer's orders" into "every
      // unassigned order".
      if (keys.some((key) => key === null)) continue

      const child = this.#tableMap().get(fk.fromTable)
      if (!child) continue

      const where = fk.fromColumns.map((column) => `${quoteIdent(column)} = ?`).join(' AND ')
      const quoted = quoteIdent(fk.fromTable)
      const selection = child.withoutRowid ? '*' : 'rowid AS rowid, *'

      try {
        const rows = this.#conn
          .prepare(`SELECT ${selection} FROM ${quoted} WHERE ${where} LIMIT ?`)
          .all(...keys, capped) as Row[]
        const count = (
          this.#conn.prepare(`SELECT COUNT(*) n FROM ${quoted} WHERE ${where}`).get(...keys) as {
            n: number
          }
        ).n

        groups.push({
          fromTable: fk.fromTable,
          fromColumns: fk.fromColumns,
          toColumns: fk.toColumns,
          primaryField: '',
          rows: rows.map((row) => (child.withoutRowid ? { ...row, rowid: null } : row)),
          count,
        })
      } catch (err) {
        throw mapSqliteError(err, { table: fk.fromTable })
      }
    }

    return groups
  }

  /**
   * Display labels for a batch of foreign key values, so a column of chips can be labelled
   * in one round trip instead of one per cell.
   */
  linkLabels(table: string, column: string, values: SqlValue[]): LinkLabels {
    this.#table(table)
    this.#assertColumn(table, column)

    const link = this.linkResolver?.(table).get(column)
    if (!link) {
      throw new ProtocolError(`"${column}" in "${table}" is not a linked-record column.`)
    }

    // Distinct, non-null, and keyed by string form: SQLite happily compares 5 to '5', and
    // sending both would ask for the same label twice.
    const wanted = new Map<string, SqlValue>()
    for (const value of values) {
      if (value === null || value === undefined) continue
      wanted.set(String(value), value)
    }

    const labels: LinkLabels['labels'] = []
    const key = quoteIdent(link.keyColumn)
    const display = quoteIdent(link.primaryField)
    const fallbacks = this.#labelFallbacks(link.table, link.primaryField, link.keyColumn)
    const labelExpr = fallbacks.length > 0
      ? `COALESCE(NULLIF(${display}, ''), ${fallbacks.join(', ')}, ${key})`
      : `COALESCE(NULLIF(${display}, ''), ${key})`
    const distinct = [...wanted.values()]

    try {
      for (let i = 0; i < distinct.length; i += LABEL_BATCH) {
        const batch = distinct.slice(i, i + LABEL_BATCH)
        const rows = this.#conn
          .prepare(
            `SELECT ${key} AS value, ${labelExpr} AS label FROM ${quoteIdent(link.table)}
              WHERE ${key} IN (${batch.map(() => '?').join(', ')})`,
          )
          .all(...batch.map(normalize)) as Array<{ value: SqlValue; label: SqlValue }>

        for (const row of rows) {
          labels.push({ value: row.value, label: row.label === null ? '' : String(row.label) })
        }
      }
    } catch (err) {
      throw mapSqliteError(err, { table: link.table })
    }

    return {
      table: link.table,
      keyColumn: link.keyColumn,
      primaryField: link.primaryField,
      labels,
    }
  }

  /**
   * The WHERE clause shared by every read that honours the current view — rows, group
   * counts, and summary aggregates all have to answer for the same set of records, or the
   * summary bar reports on rows the grid is not showing.
   */
  #conditions(
    table: string,
    request: { filter?: FilterNode | null; search?: string | null; searchColumns?: string[] },
    computedExprs?: Map<string, string>,
  ): { sql: string; params: SqlValue[] } {
    const columns = this.#columnNames(table)
    if (computedExprs) for (const name of computedExprs.keys()) columns.add(name)
    const filter = compileFilter(request.filter, {
      columns,
      links: this.linkResolver?.(table),
      computedExprs,
    })

    // Search spans the columns the user can actually see. Searching a hidden column produces
    // a result set the grid cannot explain — rows match, but nothing on screen says why.
    // BLOBs are excluded either way; matching a LIKE against binary data is noise.
    const allSearchable = this.columns(table)
      .filter((c) => c.affinity !== 'BLOB')
      .map((c) => c.name)
    const requested = request.searchColumns
    const searchable = requested
      ? allSearchable.filter((name) => requested.includes(name))
      : allSearchable
    const search = compileSearch(request.search ?? '', searchable, this.linkResolver?.(table))

    return {
      sql: `${filter.sql} AND ${search.sql}`,
      params: [...filter.params, ...search.params],
    }
  }

  /**
   * Grouping columns sort ahead of the user's own sort. That is what makes each group a
   * contiguous run of rows at a fixed absolute offset, which is in turn what lets the grid
   * collapse a group without refetching anything: collapsing removes display slots, and the
   * offsets underneath them never move.
   */
  #orderBy(sort: SortSpec[] | undefined, columns: Set<string>, groupBy?: string[], computedExprs?: Map<string, string>, groupSort?: Record<string, 'asc' | 'desc'>): string {
    const terms: string[] = []
    const ref = (name: string) => {
      const expr = computedExprs?.get(name)
      return expr ? `(${expr})` : quoteIdent(name)
    }

    for (const column of groupBy ?? []) {
      if (!columns.has(column) && !computedExprs?.has(column)) {
        throw new ProtocolError(`There is no column named "${column}" to group by.`)
      }
      const dir = groupSort?.[column] === 'desc' ? 'DESC' : 'ASC'
      terms.push(`${ref(column)} ${dir}`)
    }

    for (const spec of sort ?? []) {
      if (!columns.has(spec.column) && !computedExprs?.has(spec.column)) {
        throw new ProtocolError(`There is no column named "${spec.column}" to sort by.`)
      }
      // A column already ordered by the grouping would be a no-op second term.
      if (groupBy?.includes(spec.column)) continue
      terms.push(`${ref(spec.column)} ${spec.direction === 'desc' ? 'DESC' : 'ASC'}`)
    }

    return terms.length === 0 ? '' : ` ORDER BY ${terms.join(', ')}`
  }

  /**
   * Every leaf group under the current filter, with its size, in the same order the grouped
   * row query returns rows.
   *
   * Deliberately uncapped. Grouping by a near-unique column produces a header above almost
   * every row, which is visibly useless but not broken — and a cap would mean either a
   * refusal the user has to work around or an "Other" bucket whose contents nobody asked for.
   */
  groups(
    table: string,
    columns: string[],
    request: { summary?: Record<string, SummaryFunction>; filter?: FilterNode | null; search?: string | null; searchColumns?: string[]; groupSort?: Record<string, 'asc' | 'desc'> } = {},
    computedColumns?: ComputedColumn[],
  ): GroupInfo[] {
    this.#table(table)
    if (columns.length === 0) return []

    const names = this.#columnNames(table)
    const compExprs = computedExprMap(computedColumns)
    for (const column of columns) {
      if (!names.has(column) && !compExprs.has(column)) {
        throw new ProtocolError(`There is no column named "${column}" to group by.`)
      }
    }

    const { sql: where, params } = this.#conditions(table, request, compExprs)
    const quoted = columns.map((c) => {
      const expr = compExprs.get(c)
      return expr ? `(${expr})` : quoteIdent(c)
    })
    const selected = columns.map((c, i) => {
      return compExprs.has(c) ? `${quoted[i]} AS ${quoteIdent(c)}` : quoted[i]!
    })

    const summaryEntries = Object.entries(request.summary ?? {})
    const summarySelections = summaryEntries.map(([col, fn]) => {
      const expr = compExprs.get(col)
      const ref = expr ? `(${expr})` : quoteIdent(col)
      return `${aggregateSql(fn, ref)} AS ${quoteIdent('__s_' + col)}`
    })
    const allSelections = [...selected, 'COUNT(*) AS "__n"', ...summarySelections]

    try {
      const rows = this.#conn
        .prepare(
          `SELECT ${allSelections.join(', ')} FROM ${quoteIdent(table)}
            WHERE ${where}
            GROUP BY ${quoted.join(', ')}
            ORDER BY ${quoted.map((c, i) => `${c} ${request.groupSort?.[columns[i]!] === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`,
        )
        .all(...params) as Array<Record<string, SqlValue> & { __n: number }>

      return rows.map((row) => {
        const info: GroupInfo = {
          values: columns.map((column) => row[column] ?? null),
          count: row.__n,
        }
        if (summaryEntries.length > 0) {
          info.summary = {}
          for (const [col] of summaryEntries) {
            info.summary[col] = row['__s_' + col] ?? null
          }
        }
        return info
      })
    } catch (err) {
      throw mapSqliteError(err, { table })
    }
  }

  /**
   * Aggregates for the summary bar, over the same rows the grid is showing — the filter and
   * search are applied, so a summary never describes records the user has filtered out.
   */
  summary(
    table: string,
    spec: Record<string, SummaryFunction>,
    request: { filter?: FilterNode | null; search?: string | null; searchColumns?: string[] } = {},
    computedColumns?: ComputedColumn[],
  ): SummaryResult {
    this.#table(table)
    const entries = Object.entries(spec)
    if (entries.length === 0) return {}

    const names = this.#columnNames(table)
    const compExprs = computedExprMap(computedColumns)
    const selections: string[] = []
    for (const [column, fn] of entries) {
      const expr = compExprs.get(column)
      if (!expr && !names.has(column)) {
        throw new ProtocolError(`There is no column named "${column}" to summarise.`)
      }
      const ref = expr ? `(${expr})` : quoteIdent(column)
      selections.push(`${aggregateSql(fn, ref)} AS ${quoteIdent(column)}`)
    }

    const { sql: where, params } = this.#conditions(table, request, compExprs)
    try {
      const row = this.#conn
        .prepare(`SELECT ${selections.join(', ')} FROM ${quoteIdent(table)} WHERE ${where}`)
        .get(...params) as SummaryResult | undefined
      return row ?? {}
    } catch (err) {
      throw mapSqliteError(err, { table })
    }
  }

  splitCommaValues(table: string, column: string): number {
    this.#assertWritable(table)
    const col = quoteIdent(column)
    const tbl = quoteIdent(table)
    const rows = this.#conn
      .prepare(`SELECT rowid, ${col} AS v FROM ${tbl} WHERE ${col} LIKE '%,%'`)
      .all() as Array<{ rowid: number; v: string }>
    if (rows.length === 0) return 0
    const update = this.#conn.prepare(`UPDATE ${tbl} SET ${col} = ? WHERE rowid = ?`)
    this.#conn.transaction(() => {
      for (const row of rows) {
        const parts = row.v.split(',').map((s) => s.trim()).filter(Boolean)
        update.run(JSON.stringify(parts), row.rowid)
      }
    })()
    return rows.length
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  #assertWritable(table: string): TableInfo {
    const info = this.#table(table)
    if (info.withoutRowid) {
      throw new ProtocolError(
        `"${table}" is a WITHOUT ROWID table, so its rows have no stable identity to edit against. It is shown read-only.`,
      )
    }
    if (this.readonly) {
      throw new ProtocolError('This database file is read-only, so changes can’t be saved.')
    }
    return info
  }

  #assertColumn(table: string, field: string): void {
    if (!this.#columnNames(table).has(field)) {
      throw new ProtocolError(`There is no column named "${field}" in "${table}".`)
    }
  }

  update(table: string, rowid: number, field: string, value: SqlValue): WriteResult {
    this.#assertWritable(table)
    this.#assertColumn(table, field)

    // Read before writing, or the old value is gone. Only done when someone is listening.
    const before = this.changelog ? this.#rawValue(table, rowid, field) : null

    try {
      const normalized = normalize(value)
      const info = this.#conn
        .prepare(`UPDATE ${quoteIdent(table)} SET ${quoteIdent(field)} = ? WHERE rowid = ?`)
        .run(normalized, rowid)

      const ts =
        info.changes > 0
          ? this.changelog?.('update', table, rowid, { [field]: before }, { [field]: normalized })
          : null
      return { changes: info.changes, ...(ts ? { ts } : {}) }
    } catch (err) {
      throw mapSqliteError(err, { table, field, value })
    }
  }

  /** One column of one row, straight from SQLite — no stamps, no row wrapping. */
  #rawValue(table: string, rowid: number, field: string): SqlValue {
    const row = this.#conn
      .prepare(`SELECT ${quoteIdent(field)} AS v FROM ${quoteIdent(table)} WHERE rowid = ?`)
      .get(rowid) as { v: SqlValue } | undefined
    return row?.v ?? null
  }

  /** The whole row as stored, for recording what a delete removed. */
  #rawRow(table: string, rowid: number): Record<string, SqlValue> {
    const row = this.#conn
      .prepare(`SELECT * FROM ${quoteIdent(table)} WHERE rowid = ?`)
      .get(rowid) as Record<string, SqlValue> | undefined
    return row ?? {}
  }

  /**
   * `rowid` is for undo, and only for undo.
   *
   * Undoing a delete has to put the *same* record back, not an equivalent one. A fresh rowid
   * would orphan the record's history in the changelog and break anything that referenced it,
   * so the row goes back under the identity it had. SQLite lets rowid be written explicitly;
   * this is the one caller that does.
   */
  insert(table: string, values: Record<string, SqlValue>, rowid?: number): WriteResult {
    this.#assertWritable(table)
    for (const field of Object.keys(values)) this.#assertColumn(table, field)

    const filled = { ...this.#blankRequiredValues(table, values), ...values }
    const fields = Object.keys(filled)
    const columns = rowid === undefined ? fields : ['rowid', ...fields]
    const params = rowid === undefined ? fields.map((f) => normalize(filled[f])) : [rowid, ...fields.map((f) => normalize(filled[f]))]

    const sql =
      columns.length === 0
        ? `INSERT INTO ${quoteIdent(table)} DEFAULT VALUES`
        : `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES (${columns
            .map(() => '?')
            .join(', ')})`

    try {
      const info = this.#conn.prepare(sql).run(...params)
      const inserted = Number(info.lastInsertRowid)
      // `after` is the row as SQLite actually stored it, not what was asked for — defaults
      // and a generated primary key are part of what was created.
      const ts =
        info.changes > 0
          ? this.changelog?.('insert', table, inserted, {}, this.#rawRow(table, inserted))
          : null
      return { changes: info.changes, rowid: inserted, ...(ts ? { ts } : {}) }
    } catch (err) {
      // Report against the offending column when SQLite names one.
      const field = fields.find((f) => String((err as Error).message).includes(`.${f}`))
      throw mapSqliteError(err, { table, field, value: field ? filled[field] : undefined })
    }
  }

  /**
   * "Add row" has to produce a row. SQLite has no notion of blank-but-valid, so a NOT NULL
   * column with no default would reject an empty insert outright — which reads to the user
   * as the button being broken. Those columns get a type-appropriate empty value, matching
   * the rule that a blank cell holds an empty string rather than NULL.
   *
   * Deliberately skipped: primary key columns (INTEGER PRIMARY KEY is assigned by SQLite)
   * and anything the caller supplied.
   */
  #blankRequiredValues(table: string, supplied: Record<string, SqlValue>): Record<string, SqlValue> {
    const blanks: Record<string, SqlValue> = {}
    for (const column of this.columns(table)) {
      if (!column.notNull || column.primaryKeyIndex > 0) continue
      if (column.defaultValue !== null) continue
      if (column.name in supplied) continue
      blanks[column.name] =
        column.affinity === 'INTEGER' || column.affinity === 'REAL' || column.affinity === 'NUMERIC'
          ? 0
          : ''
    }
    return blanks
  }

  /** Deletes are one transaction: a partial delete is worse than a failed one. */
  delete(table: string, rowids: number[]): WriteResult {
    this.#assertWritable(table)
    if (rowids.length === 0) return { changes: 0 }

    const statement = this.#conn.prepare(`DELETE FROM ${quoteIdent(table)} WHERE rowid = ?`)
    try {
      // Collected inside the transaction, appended after it commits: a log line describing a
      // delete that then rolled back would be a lie about the file's contents.
      const removed: Array<[number, Record<string, SqlValue>]> = []
      const result = this.#conn.transaction(() => {
        let changes = 0
        for (const rowid of rowids) {
          const before = this.changelog ? this.#rawRow(table, rowid) : {}
          const affected = statement.run(rowid).changes
          if (affected > 0 && this.changelog) removed.push([rowid, before])
          changes += affected
        }
        return { changes }
      })()

      for (const [rowid, before] of removed) {
        this.changelog?.('delete', table, rowid, before, {})
      }
      return result
    } catch (err) {
      throw mapSqliteError(err, { table })
    }
  }

  bulkUpdate(table: string, rowids: number[], field: string, value: SqlValue): WriteResult {
    this.#assertWritable(table)
    this.#assertColumn(table, field)
    if (rowids.length === 0) return { changes: 0 }

    const statement = this.#conn.prepare(
      `UPDATE ${quoteIdent(table)} SET ${quoteIdent(field)} = ? WHERE rowid = ?`,
    )
    const normalized = normalize(value)
    try {
      const touched: Array<[number, SqlValue]> = []
      const result = this.#conn.transaction(() => {
        let changes = 0
        for (const rowid of rowids) {
          const before = this.changelog ? this.#rawValue(table, rowid, field) : null
          const affected = statement.run(normalized, rowid).changes
          if (affected > 0 && this.changelog) touched.push([rowid, before])
          changes += affected
        }
        return { changes }
      })()

      // One line per row, not one per bulk action. The audit trail answers "what happened to
      // this record", and a reader of that question does not care how it was batched.
      let ts: string | null = null
      for (const [rowid, before] of touched) {
        ts = this.changelog?.('update', table, rowid, { [field]: before }, { [field]: normalized }) ?? ts
      }
      return { ...result, ...(ts ? { ts } : {}) }
    } catch (err) {
      throw mapSqliteError(err, { table, field, value })
    }
  }
}

/**
 * SQL for one summary function.
 *
 * "Empty" means NULL or the empty string, matching the rule the rest of the app follows: a
 * blank cell holds `''`, and NULL and `''` render identically, so counting them apart here
 * would report a distinction the user cannot see.
 */
function aggregateSql(fn: SummaryFunction, column: string): string {
  const empty = `${column} IS NULL OR ${column} = ''`
  switch (fn) {
    case 'sum':
      return `SUM(${column})`
    case 'average':
      return `AVG(${column})`
    case 'count':
      return 'COUNT(*)'
    case 'min':
      return `MIN(${column})`
    case 'max':
      return `MAX(${column})`
    case 'count_empty':
      return `SUM(CASE WHEN ${empty} THEN 1 ELSE 0 END)`
    case 'count_not_empty':
      return `SUM(CASE WHEN ${empty} THEN 0 ELSE 1 END)`
    case 'percent_empty':
      // COUNT(*) is zero only when nothing matched, and 0/0 is not a percentage.
      return `CASE WHEN COUNT(*) = 0 THEN NULL ELSE
                ROUND(SUM(CASE WHEN ${empty} THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(*), 1) END`
    default: {
      const unreachable: never = fn
      throw new ProtocolError(`"${String(unreachable)}" is not a summary this tool knows about.`)
    }
  }
}

/**
 * better-sqlite3 refuses booleans outright. Converting here rather than at each call site
 * keeps checkbox and toggle columns working without every caller remembering.
 */
function computedExprMap(columns?: ComputedColumn[]): Map<string, string> {
  const map = new Map<string, string>()
  if (columns) for (const c of columns) map.set(c.name, c.formula)
  return map
}

function appendComputedSelect(base: string, columns?: ComputedColumn[]): string {
  if (!columns || columns.length === 0) return base
  const extras = columns.map((c) => `(${c.formula}) AS ${quoteIdent(c.name)}`)
  return `${base}, ${extras.join(', ')}`
}

function normalize(value: SqlValue | undefined): SqlValue {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}
