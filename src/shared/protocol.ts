// The contract between the UI and the backend. Types, plus a couple of shared constants —
// no imports of any kind, because this file is consumed by both the Node backend and the
// browser bundle.
//
// The UI never sends SQL. Every request is a structured description of intent that the
// backend compiles into parameterized SQL itself. That is not a stylistic preference: it
// is the reason a malicious or buggy webview cannot reach the database directly.

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Anything SQLite can hold. BLOBs surface as Uint8Array. */
export type SqlValue = string | number | boolean | null | Uint8Array

/**
 * `rowid` is null only for WITHOUT ROWID tables, which have no stable row identity to
 * write against and are therefore surfaced read-only.
 */
export type Row = Record<string, SqlValue> & { rowid: number | null }

export type DisplayType =
  | 'text'
  | 'number'
  /** Money, formatted as USD. Stored as a plain number — no currency code, no minor units. */
  | 'currency'
  | 'checkbox'
  | 'toggle'
  | 'single_select'
  | 'multi_select'
  | 'date'
  | 'url'
  | 'phone'
  | 'email'
  | 'long_text'
  | 'percent'
  | 'duration'
  | 'rating'

// ---------------------------------------------------------------------------
// Sorting and filtering
// ---------------------------------------------------------------------------

export interface SortSpec {
  column: string
  direction: 'asc' | 'desc'
}

export type FilterOperator =
  // text
  | 'contains'
  | 'not_contains'
  | 'is'
  | 'is_not'
  | 'starts_with'
  | 'ends_with'
  // number
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  // universal
  | 'is_empty'
  | 'is_not_empty'

export interface FilterCondition {
  kind: 'condition'
  column: string
  operator: FilterOperator
  /** Absent for is_empty / is_not_empty; a two-element array for `between`. */
  value?: SqlValue | [SqlValue, SqlValue]
}

export interface FilterGroup {
  kind: 'group'
  conjunction: 'and' | 'or'
  children: FilterNode[]
}

export type FilterNode = FilterCondition | FilterGroup

// ---------------------------------------------------------------------------
// Schema introspection
// ---------------------------------------------------------------------------

/** What SQLite itself knows about a column. Pure introspection, no user configuration. */
export interface ColumnInfo {
  name: string
  /** Declared type as written in the schema, e.g. "INTEGER" or "" when omitted. */
  declaredType: string
  /** Type affinity SQLite resolves the declared type to. */
  affinity: 'INTEGER' | 'REAL' | 'NUMERIC' | 'TEXT' | 'BLOB'
  notNull: boolean
  defaultValue: string | null
  /** 0 when not part of the primary key; 1-based position within it otherwise. */
  primaryKeyIndex: number
}

/**
 * What the user (or inference) decided a column should look like. Owned by the metadata
 * layer in Phase 4 — kept separate from ColumnInfo so introspection never has to pretend
 * it knows about display concerns.
 */
export interface ColumnDisplay {
  displayType: DisplayType
  /** True when displayType came from inference rather than from _airsqlite_columns. */
  displayTypeInferred: boolean
  options: Record<string, unknown> | null
}

export type ColumnDescriptor = ColumnInfo &
  Partial<ColumnDisplay> & {
    /**
     * Free text shown behind an info icon in the column header. A property of the *field*, so
     * it is stored per table in `_airsqlite_columns` and is the same in every view — unlike width,
     * visibility, and order, which belong to the view looking at it.
     */
    description?: string | null
    /**
     * True for the Created/Modified columns, which are derived from the changelog and exist
     * in no SQLite table. They cannot be edited, sorted, or filtered — there is no column
     * behind them for SQL to name.
     */
    virtual?: boolean
    /** True for agent-authored formula columns that exist only at query time. */
    computed?: boolean
    /** The SQL expression for a computed column. */
    formula?: string
    /** Set when the formula fails validation (dry-run SELECT). */
    formulaError?: string
  }

export interface ForeignKeyInfo {
  /** SQLite groups composite keys under one id across multiple pragma rows. */
  id: number
  fromColumns: string[]
  toTable: string
  toColumns: string[]
}

/** A foreign key pointing *at* this table — the basis for Airtable-style reverse lookups. */
export interface ReverseForeignKey {
  fromTable: string
  fromColumns: string[]
  toColumns: string[]
}

export interface TableInfo {
  /** Free text behind an info icon on the tab. Null until somebody writes one. */
  description?: string | null
  name: string
  /** WITHOUT ROWID tables cannot be edited — there is no stable row identity to write against. */
  withoutRowid: boolean
  /** Null until the metadata layer lands in Phase 4. */
  primaryField: string | null
}

// ---------------------------------------------------------------------------
// Linked records
// ---------------------------------------------------------------------------

/**
 * How to find one row. Chip navigation knows a foreign key *value*, not a rowid —
 * `customers.id = 5` is not necessarily rowid 5 — so both forms have to exist.
 */
export type RecordLocator = { rowid: number } | { keyColumn: string; keyValue: SqlValue }

/**
 * Where the chips in one foreign key column point, plus display labels for a batch of key
 * values. Batched because a rendered 200-row chunk with two link columns needs 400 labels,
 * and resolving those one at a time is 400 round trips.
 */
export interface LinkLabels {
  /** The table a chip in this column navigates to. */
  table: string
  keyColumn: string
  primaryField: string
  /** One entry per requested value that matched a record. Unmatched values are absent. */
  labels: Array<{ value: SqlValue; label: string }>
}

/**
 * Child records pointing at one parent row — one group per inbound foreign key. This is the
 * reverse-lookup section in the detail panel, derived from `PRAGMA foreign_key_list` across
 * tables rather than from any configuration.
 */
export interface RelatedGroup {
  fromTable: string
  fromColumns: string[]
  toColumns: string[]
  /** The child table's display column, for labelling each listed record. */
  primaryField: string
  rows: Row[]
  /** Total matching children, which may exceed `rows.length` when the list is capped. */
  count: number
}

// ---------------------------------------------------------------------------
// Grouping and summaries
// ---------------------------------------------------------------------------

/**
 * One leaf group and how many rows are in it.
 *
 * Returned in the same order the grouped row query returns rows, which is what lets the grid
 * map a group to a fixed absolute row offset without fetching anything.
 */
export interface GroupInfo {
  /** One value per grouping column, outermost first. */
  values: SqlValue[]
  count: number
  /** Per-column aggregates for this leaf group, when summary functions were requested. */
  summary?: SummaryResult
}

/** Aggregate values for the summary bar, keyed by column name. */
export type SummaryResult = Record<string, SqlValue>

// ---------------------------------------------------------------------------
// Action buttons
// ---------------------------------------------------------------------------

export type ActionType = 'webhook' | 'url' | 'script' | 'claude' | 'clipboard'

/**
 * A button configured in `_airsqlite_actions`. Written by a coding agent, not by a GUI — so a row
 * that does not make sense arrives with `problem` set and renders as a disabled button
 * explaining itself, rather than as a missing feature.
 */
export interface ActionDefinition {
  id: number
  tableName: string
  label: string
  icon: string | null
  style: 'default' | 'primary' | 'danger'
  type: ActionType
  config: Record<string, unknown>
  showInGrid: boolean
  showInDetail: boolean
  problem: string | null
}

/**
 * Running an action either does it, or comes back asking. Scripts and webhooks reach outside
 * the database file, so the first call returns exactly what would happen and does nothing.
 */
export type ActionResult =
  | { status: 'needs-confirmation'; preview: string }
  | { status: 'done'; message: string }

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export type ChangeOp = 'insert' | 'update' | 'delete'

/** One line of the NDJSON changelog. `before`/`after` hold only the fields that changed. */
export interface ChangeEntry {
  ts: string
  op: ChangeOp
  table: string
  row: number
  before: Record<string, SqlValue>
  after: Record<string, SqlValue>
  source?: 'reconcile'
}

/**
 * The virtual Created/Modified columns, derived from the changelog. Both null for a row that
 * predates the log — we do not know when it was created, and saying so beats inventing a date.
 */
export interface RowStamps {
  created: string | null
  modified: string | null
}

/** Column names of the virtual system columns. Never present in the SQLite table. */
export const ROWID_COLUMN = '__rowid'
export const CREATED_COLUMN = '__created'
export const MODIFIED_COLUMN = '__modified'

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface QueryRequest {
  type: 'query'
  table: string
  offset?: number
  limit?: number
  sort?: SortSpec[]
  filter?: FilterNode | null
  search?: string | null
  /** Restrict search to these columns. Omitted means every non-BLOB column. */
  searchColumns?: string[]
  /**
   * Grouping columns, ordered outermost first. They sort ahead of the user's own sort, which
   * is what makes each group a contiguous run of rows at a fixed offset — the property the
   * grouped grid's index arithmetic depends on.
   */
  groupBy?: string[]
  /** Sort direction per grouping column. Absent keys default to 'asc'. */
  groupSort?: Record<string, 'asc' | 'desc'>
}

export interface QueryResult {
  rows: Row[]
  /** Rows matching the current filter. */
  filteredCount: number
  /** Rows in the table with no filter applied. */
  totalCount: number
}

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

export type SummaryFunction =
  | 'sum'
  | 'average'
  | 'count'
  | 'min'
  | 'max'
  | 'count_empty'
  | 'count_not_empty'
  | 'percent_empty'

/**
 * Everything a view remembers. Versioned, and read permissively: unknown keys are preserved
 * so a view written by a newer build survives a round trip through an older one.
 */
export interface ViewConfig {
  version: 1
  sort?: SortSpec[]
  filter?: FilterNode | null
  columnVisibility?: Record<string, boolean>
  columnOrder?: string[]
  columnWidths?: Record<string, number>
  frozenCount?: number
  grouping?: string[]
  /** Sort direction per grouping column. Absent keys default to 'asc'. */
  groupSort?: Record<string, 'asc' | 'desc'>
  /** null means "explicitly cleared", which has to outrank the value stored per column. */
  summary?: Record<string, SummaryFunction | null>
  [key: string]: unknown
}

export interface SavedView {
  id: number
  tableName: string
  name: string
  config: ViewConfig
  /** Free text shown in the views list and the view menu. Null until somebody writes one. */
  description?: string | null
  isDefault: boolean
  /**
   * The view this table was last looking at. Outranks `isDefault` when reopening: the default
   * is where a table starts, this is where you left it.
   */
  isLast?: boolean
  createdAt: string
  updatedAt: string
}

/** What `get-meta` returns: the per-table configuration in one round trip. */
export interface TableMeta {
  table: string
  primaryField: string
  columns: ColumnDescriptor[]
  /** False when the file is read-only — the UI should not offer to save configuration. */
  writable: boolean
}

export interface WriteResult {
  /** Rows actually affected. */
  changes: number
  /** Present for inserts. Null when the table is WITHOUT ROWID. */
  rowid?: number | null
  /**
   * The timestamp the changelog recorded for this write, so the caller can update the
   * Created/Modified columns without a second round trip. Absent when nothing was logged.
   */
  ts?: string
}

export type ProtocolRequest =
  | QueryRequest
  | { type: 'ping' }
  | { type: 'tables' }
  | { type: 'columns'; table: string }
  | { type: 'foreign-keys'; table: string }
  | {
      type: 'groups'
      table: string
      columns: string[]
      summary?: Record<string, SummaryFunction>
      filter?: FilterNode | null
      search?: string | null
      searchColumns?: string[]
      groupSort?: Record<string, 'asc' | 'desc'>
    }
  | {
      type: 'summary'
      table: string
      columns: Record<string, SummaryFunction>
      filter?: FilterNode | null
      search?: string | null
      searchColumns?: string[]
    }
  | { type: 'record'; table: string; locator: RecordLocator }
  | { type: 'related'; table: string; rowid: number; limit?: number }
  | { type: 'link-labels'; table: string; column: string; values: SqlValue[] }
  | { type: 'update'; table: string; rowid: number; field: string; value: SqlValue }
  | { type: 'insert'; table: string; values: Record<string, SqlValue>; rowid?: number }
  | { type: 'delete'; table: string; rowids: number[] }
  | { type: 'bulk-update'; table: string; rowids: number[]; field: string; value: SqlValue }
  | { type: 'get-meta'; table: string }
  /**
   * The distinct non-empty values of one column, capped.
   *
   * Exists so converting a column to a select type can offer the values it already holds.
   * Deliberately not folded into `columns`: it is a scan, and paying for it on every schema
   * read to serve the one column somebody is configuring would be the wrong trade.
   */
  | { type: 'distinct-values'; table: string; column: string; limit?: number }
  /**
   * What a drop would break. Asked before every destructive schema change so the confirmation
   * can name the SQL views that read from the thing being removed — SQLite drops it and reports
   * nothing, and the view fails at next read instead.
   */
  | { type: 'dependents'; table: string; column?: string }
  | { type: 'create-table'; name: string }
  | { type: 'rename-table'; table: string; name: string }
  | { type: 'describe-table'; table: string; description: string | null }
  | { type: 'set-last-view'; table: string; viewId: number }
  | { type: 'drop-table'; table: string }
  | { type: 'add-column'; table: string; name: string; columnType: string }
  | { type: 'drop-column'; table: string; column: string }
  | { type: 'rename-column'; table: string; column: string; name: string }
  | {
      type: 'duplicate-column'
      table: string
      column: string
      name: string
      /** False creates the column empty — a new field shaped like an old one, not a backup. */
      copyValues: boolean
    }
  | { type: 'set-meta'; table: string; config: Record<string, unknown> }
  | { type: 'get-views'; table: string }
  | { type: 'set-table-order'; order: string[] }
  | { type: 'save-view'; table: string; view: Record<string, unknown> }
  | { type: 'delete-view'; viewId: number }
  | { type: 'search'; table: string; query: string; columns?: string[] }
  | { type: 'history'; table: string; rowid: number }
  | { type: 'get-actions'; table: string }
  | { type: 'save-action'; table: string; action: Record<string, unknown> }
  | { type: 'delete-action'; actionId: number }
  | {
      type: 'run-action'
      actionId: number
      row: Record<string, SqlValue>
      /** Second call for a script or webhook, after the user saw what it would do. */
      confirmed?: boolean
    }
  | { type: 'split-comma-values'; table: string; column: string }

export type RequestType = ProtocolRequest['type']

// ---------------------------------------------------------------------------
// Events (backend -> UI, unsolicited)
// ---------------------------------------------------------------------------

export type ProtocolEvent = { type: 'db-changed'; tables?: string[] }

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface RequestEnvelope {
  id: string
  request: ProtocolRequest
}

export type ResponseEnvelope =
  | { id: string; ok: true; data: unknown }
  /** `error` is always human-readable — it is rendered straight into a toast. */
  | { id: string; ok: false; error: string }

export interface EventEnvelope {
  event: ProtocolEvent
}

export type OutboundMessage = ResponseEnvelope | EventEnvelope

export function isEventEnvelope(msg: OutboundMessage): msg is EventEnvelope {
  return 'event' in msg
}
