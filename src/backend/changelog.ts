import fs from 'node:fs'
import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import type { ChangeEntry, ChangeOp, RowStamps, SqlValue } from '../shared/protocol.js'

// The audit trail: per-table NDJSON sidecars inside a folder next to the database file.
//
// Layout:
//   mydb.db
//   mydb.airsqlite/
//     customers.changelog.ndjson   ← append-only change log
//     customers.snapshot.ndjson    ← full state at last close (Phase 2)
//     orders.changelog.ndjson
//     orders.snapshot.ndjson
//
// One file per table keeps git blame/diff scoped. The folder is created lazily on first
// write, so a database that has never been edited through AirSQLite produces no sidecar.

export interface ChangelogOptions {
  /** Injectable clock. Tests need timestamps they can predict. */
  now?: () => string
}

interface BaselineLine {
  ts: string
  op: 'baseline'
  table: string
  rows: number
}

type ChangelogLine = ChangeEntry | BaselineLine

/** Local time, matching the format the _airsqlite_* tables stamp their own rows with. */
function localNow(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

function key(table: string, row: number): string {
  return `${table} ${row}`
}

function parseLines(text: string): ChangelogLine[] {
  const lines: ChangelogLine[] = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    try {
      lines.push(JSON.parse(raw) as ChangelogLine)
    } catch {
      continue
    }
  }
  return lines
}

export class Changelog {
  /** The sidecar folder path (`mydb.airsqlite/`). */
  readonly dir: string
  /** False when the sidecar cannot be written — history degrades, the grid does not. */
  readonly writable: boolean

  #now: () => string
  /**
   * Created/Modified per row, held in memory. Built by scanning all per-table changelogs
   * on open and kept current on every append.
   */
  #stamps = new Map<string, RowStamps>()
  #folderCreated = false

  private constructor(dir: string, writable: boolean, options: ChangelogOptions) {
    this.dir = dir
    this.writable = writable
    this.#now = options.now ?? localNow
    this.#folderCreated = fs.existsSync(dir)
  }

  /** `mydb.db` → `mydb.airsqlite/` (the sidecar folder), alongside the database. */
  static dirFor(dbPath: string): string {
    const dir = path.dirname(dbPath)
    const base = path.basename(dbPath, path.extname(dbPath))
    return path.join(dir, `${base}.airsqlite`)
  }

  /** The changelog file for one table inside the sidecar folder. */
  static fileFor(sidecarDir: string, table: string): string {
    return path.join(sidecarDir, `${table}.changelog.ndjson`)
  }

  /** The snapshot file for one table inside the sidecar folder. */
  static snapshotFor(sidecarDir: string, table: string): string {
    return path.join(sidecarDir, `${table}.snapshot.ndjson`)
  }

  // -- Legacy paths (pre-folder consolidated format) --------------------------

  static legacyPathFor(dbPath: string): string {
    const dir = path.dirname(dbPath)
    const base = path.basename(dbPath, path.extname(dbPath))
    return path.join(dir, `${base}.airsqlite.ndjson`)
  }

  static legacyPathV1For(dbPath: string): string {
    const dir = path.dirname(dbPath)
    const base = path.basename(dbPath, path.extname(dbPath))
    return path.join(dir, `${base}.changes.ndjson`)
  }

  /**
   * Split a consolidated sidecar into per-table files inside the new folder.
   * The old file is renamed to `.migrated` as a backup.
   */
  static migrateLegacy(dbPath: string, sidecarDir: string): void {
    // Find the legacy file — v2 name first, then v1.
    let legacyPath = Changelog.legacyPathFor(dbPath)
    if (!fs.existsSync(legacyPath)) {
      legacyPath = Changelog.legacyPathV1For(dbPath)
    }
    if (!fs.existsSync(legacyPath)) return

    // Already migrated or folder already exists — skip.
    if (fs.existsSync(`${legacyPath}.migrated`)) return
    if (fs.existsSync(sidecarDir)) return

    let text: string
    try {
      text = fs.readFileSync(legacyPath, 'utf8')
    } catch {
      return
    }

    const lines = parseLines(text)
    if (lines.length === 0) return

    // Group lines by table. Baselines without a table field go to all tables.
    const byTable = new Map<string, ChangelogLine[]>()
    for (const line of lines) {
      const table = 'table' in line ? (line as { table?: string }).table : undefined
      if (!table) continue
      let bucket = byTable.get(table)
      if (!bucket) {
        bucket = []
        byTable.set(table, bucket)
      }
      bucket.push(line)
    }

    if (byTable.size === 0) {
      // Only baselines without table fields — rename and move on.
      try {
        fs.renameSync(legacyPath, `${legacyPath}.migrated`)
      } catch { /* best effort */ }
      return
    }

    try {
      fs.mkdirSync(sidecarDir, { recursive: true })
    } catch {
      return
    }

    for (const [table, tableLines] of byTable) {
      const filePath = Changelog.fileFor(sidecarDir, table)
      const content = tableLines.map((l) => JSON.stringify(l)).join('\n') + '\n'
      try {
        fs.writeFileSync(filePath, content, 'utf8')
      } catch { /* best effort */ }
    }

    try {
      fs.renameSync(legacyPath, `${legacyPath}.migrated`)
    } catch { /* best effort */ }
  }

  /**
   * Open the sidecar for a database, scanning existing per-table changelogs.
   */
  static open(dbPath: string, options: ChangelogOptions = {}): Changelog {
    const dir = Changelog.dirFor(dbPath)

    let writable = true
    try {
      fs.accessSync(path.dirname(dir), fs.constants.W_OK)
    } catch {
      writable = false
    }

    // Migrate consolidated sidecars before scanning.
    if (writable) {
      Changelog.migrateLegacy(dbPath, dir)
    }

    const log = new Changelog(dir, writable, options)
    log.#scan()
    return log
  }

  // -- Folder management ------------------------------------------------------

  #ensureFolder(): boolean {
    if (this.#folderCreated) return true
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      this.#folderCreated = true
      return true
    } catch {
      return false
    }
  }

  /** List all changelog files in the sidecar folder. */
  #changelogFiles(): string[] {
    if (!this.#folderCreated) return []
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.changelog.ndjson'))
        .map((f) => path.join(this.dir, f))
    } catch {
      return []
    }
  }

  // -- Reading ----------------------------------------------------------------

  #readFile(filePath: string): ChangelogLine[] {
    let text: string
    try {
      text = fs.readFileSync(filePath, 'utf8')
    } catch {
      return []
    }
    return parseLines(text)
  }

  #readTable(table: string): ChangelogLine[] {
    return this.#readFile(Changelog.fileFor(this.dir, table))
  }

  // -- Scanning (stamps) ------------------------------------------------------

  #scan(): void {
    this.#stamps = new Map()
    for (const file of this.#changelogFiles()) {
      for (const line of this.#readFile(file)) {
        if (line.op === 'baseline') continue
        this.#stamp(line as ChangeEntry)
      }
    }
  }

  #stamp(entry: ChangeEntry): void {
    const id = key(entry.table, entry.row)
    const existing = this.#stamps.get(id)

    if (entry.op === 'delete') {
      this.#stamps.delete(id)
      return
    }
    if (!existing) {
      this.#stamps.set(id, {
        created: entry.op === 'insert' ? entry.ts : null,
        modified: entry.ts,
      })
      return
    }
    existing.modified = entry.ts
    if (entry.op === 'insert') existing.created = entry.ts
  }

  // -- Writing ----------------------------------------------------------------

  #writeToFile(filePath: string, line: ChangelogLine): void {
    fs.appendFileSync(filePath, `${JSON.stringify(line)}\n`, 'utf8')
  }

  /**
   * Record one write. Routes the entry to the table's changelog file.
   *
   * Returns the timestamp it recorded, so the caller can report it back to the UI and move
   * the Modified column without another round trip. Null when nothing was written.
   */
  append(
    op: ChangeOp,
    table: string,
    row: number,
    before: Record<string, SqlValue>,
    after: Record<string, SqlValue>,
  ): string | null {
    if (!this.writable) return null

    const entry: ChangeEntry = { ts: this.#now(), op, table, row, before, after }
    try {
      if (!this.#ensureFolder()) return null
      const filePath = Changelog.fileFor(this.dir, table)
      this.#writeToFile(filePath, entry)
      this.#stamp(entry)
      return entry.ts
    } catch {
      return null
    }
  }

  // -- Queries ----------------------------------------------------------------

  /** Created/Modified for a row, both null when it predates the log. */
  stamps(table: string, row: number): RowStamps {
    return this.#stamps.get(key(table, row)) ?? { created: null, modified: null }
  }

  /**
   * Every recorded change to one record, oldest first. Reads only that table's file.
   */
  history(table: string, row: number): ChangeEntry[] {
    const found: ChangeEntry[] = []
    for (const line of this.#readTable(table)) {
      if (line.op === 'baseline') continue
      if ((line as ChangeEntry).table === table && (line as ChangeEntry).row === row) {
        found.push(line as ChangeEntry)
      }
    }
    return found
  }

  /** Re-read after an external process may have written. */
  refresh(): void {
    this.#folderCreated = fs.existsSync(this.dir)
    this.#scan()
  }

  /** Tables that have a changelog file in the sidecar folder. */
  trackedTables(): string[] {
    return this.#changelogFiles().map((f) => {
      const base = path.basename(f)
      return base.replace(/\.changelog\.ndjson$/, '')
    })
  }

  /** Tables that have a snapshot file in the sidecar folder. */
  snapshotTables(): string[] {
    if (!this.#folderCreated) return []
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.snapshot.ndjson'))
        .map((f) => f.replace(/\.snapshot\.ndjson$/, ''))
    } catch {
      return []
    }
  }

  // -- Snapshots --------------------------------------------------------------

  /**
   * Write a full-state snapshot for a table. One JSON line per row, sorted by rowid.
   * The snapshot enables between-session reconciliation — on next open, the current DB
   * state is diffed against it to detect external changes.
   */
  writeSnapshot(table: string, conn: BetterSqlite3.Database): void {
    if (!this.writable) return
    if (!this.#ensureFolder()) return

    const quoted = `"${table.replace(/"/g, '""')}"`
    let rows: Array<Record<string, SqlValue>>
    try {
      rows = conn.prepare(`SELECT rowid AS _rowid, * FROM ${quoted} ORDER BY rowid`).all() as Array<
        Record<string, SqlValue>
      >
    } catch {
      return
    }

    const filePath = Changelog.snapshotFor(this.dir, table)
    try {
      const content = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
      fs.writeFileSync(filePath, content, 'utf8')
    } catch {
      // Failing to snapshot must not break the session close.
    }
  }

  /**
   * Write snapshots for all tables that have a changelog or an existing snapshot.
   * Called on session close, before the DB connection is closed.
   */
  writeAllSnapshots(conn: BetterSqlite3.Database, tables: string[]): void {
    if (!this.writable) return
    const tracked = new Set([...this.trackedTables(), ...this.snapshotTables()])
    for (const table of tables) {
      if (tracked.has(table)) {
        this.writeSnapshot(table, conn)
      }
    }
  }

  // -- Reconciliation ---------------------------------------------------------

  /**
   * Read a snapshot file and return rows keyed by rowid.
   */
  #readSnapshot(table: string): Map<number, Record<string, SqlValue>> {
    const filePath = Changelog.snapshotFor(this.dir, table)
    const map = new Map<number, Record<string, SqlValue>>()
    let text: string
    try {
      text = fs.readFileSync(filePath, 'utf8')
    } catch {
      return map
    }
    for (const raw of text.split('\n')) {
      if (raw.trim() === '') continue
      try {
        const row = JSON.parse(raw) as Record<string, SqlValue>
        const rowid = row['_rowid'] as number
        if (typeof rowid === 'number') map.set(rowid, row)
      } catch {
        continue
      }
    }
    return map
  }

  /**
   * Detect changes made to a table between sessions by diffing current DB state
   * against the last snapshot. Appends reconciliation entries to the changelog.
   */
  reconcileTable(table: string, conn: BetterSqlite3.Database): void {
    if (!this.writable) return
    const snapshotPath = Changelog.snapshotFor(this.dir, table)
    if (!fs.existsSync(snapshotPath)) return

    const snapshot = this.#readSnapshot(table)
    if (snapshot.size === 0 && !fs.existsSync(snapshotPath)) return

    const quoted = `"${table.replace(/"/g, '""')}"`
    let currentRows: Array<Record<string, SqlValue>>
    try {
      currentRows = conn.prepare(`SELECT rowid AS _rowid, * FROM ${quoted} ORDER BY rowid`).all() as Array<
        Record<string, SqlValue>
      >
    } catch {
      return
    }

    const ts = this.#now()
    const currentByRowid = new Map<number, Record<string, SqlValue>>()
    for (const row of currentRows) {
      currentByRowid.set(row['_rowid'] as number, row)
    }

    // Detect inserts and updates
    for (const [rowid, current] of currentByRowid) {
      const old = snapshot.get(rowid)
      if (!old) {
        const after = { ...current }
        delete after['_rowid']
        const entry: ChangeEntry = { ts, op: 'insert', table, row: rowid, before: {}, after, source: 'reconcile' }
        this.#appendReconciliation(table, entry)
        continue
      }

      const before: Record<string, SqlValue> = {}
      const after: Record<string, SqlValue> = {}
      for (const k of new Set([...Object.keys(old), ...Object.keys(current)])) {
        if (k === '_rowid') continue
        const oldVal = old[k] ?? null
        const curVal = current[k] ?? null
        if (oldVal !== curVal) {
          before[k] = oldVal
          after[k] = curVal
        }
      }
      if (Object.keys(after).length > 0) {
        const entry: ChangeEntry = { ts, op: 'update', table, row: rowid, before, after, source: 'reconcile' }
        this.#appendReconciliation(table, entry)
      }
    }

    // Detect deletes
    for (const [rowid, old] of snapshot) {
      if (!currentByRowid.has(rowid)) {
        const before = { ...old }
        delete before['_rowid']
        const entry: ChangeEntry = { ts, op: 'delete', table, row: rowid, before, after: {}, source: 'reconcile' }
        this.#appendReconciliation(table, entry)
      }
    }
  }

  #appendReconciliation(table: string, entry: ChangeEntry): void {
    try {
      if (!this.#ensureFolder()) return
      this.#writeToFile(Changelog.fileFor(this.dir, table), entry)
      this.#stamp(entry)
    } catch {
      // Best effort — don't break open.
    }
  }

  /**
   * Reconcile all tables that have snapshots. Called on session open.
   */
  reconcile(conn: BetterSqlite3.Database): void {
    if (!this.writable) return
    for (const table of this.snapshotTables()) {
      this.reconcileTable(table, conn)
    }
  }
}
