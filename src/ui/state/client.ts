import type {
  ActionDefinition,
  ActionResult,
  ChangeEntry,
  ColumnDescriptor,
  FilterNode,
  ForeignKeyInfo,
  GroupInfo,
  LinkLabels,
  ProtocolEvent,
  QueryRequest,
  QueryResult,
  RecordLocator,
  RelatedGroup,
  ReverseForeignKey,
  Row,
  SavedView,
  SqlValue,
  SummaryFunction,
  SummaryResult,
  TableInfo,
  TableMeta,
  WriteResult,
} from '../../shared/protocol.js'
import type { Transport } from './transport.js'

// A typed face over the transport. Components call `client.query(...)`, not
// `transport.request({type: 'query', ...})` — so the request shape stays in one place and
// a component never has to know the wire format exists.

export interface ForeignKeyReport {
  outbound: ForeignKeyInfo[]
  inbound: ReverseForeignKey[]
}

export class Client {
  #transport: Transport

  constructor(transport: Transport) {
    this.#transport = transport
  }

  ping(): Promise<{ pong: boolean; dbPath: string }> {
    return this.#transport.request({ type: 'ping' })
  }

  /** Unsolicited backend events — currently just `db-changed`. Returns an unsubscribe. */
  onEvent(listener: (event: ProtocolEvent) => void): () => void {
    return this.#transport.onEvent(listener)
  }

  actions(table: string): Promise<ActionDefinition[]> {
    return this.#transport.request({ type: 'get-actions', table })
  }

  saveAction(table: string, action: Partial<ActionDefinition>): Promise<ActionDefinition> {
    return this.#transport.request({ type: 'save-action', table, action })
  }

  deleteAction(actionId: number): Promise<{ deleted: number }> {
    return this.#transport.request({ type: 'delete-action', actionId })
  }

  /**
   * Scripts and webhooks do nothing on the first call — they come back with what they *would*
   * do, and the same call with `confirmed` carries it out.
   */
  runAction(actionId: number, row: Row, confirmed = false): Promise<ActionResult> {
    return this.#transport.request({ type: 'run-action', actionId, row, confirmed })
  }

  history(table: string, rowid: number): Promise<ChangeEntry[]> {
    return this.#transport.request({ type: 'history', table, rowid })
  }

  tables(): Promise<TableInfo[]> {
    return this.#transport.request({ type: 'tables' })
  }

  columns(table: string): Promise<ColumnDescriptor[]> {
    return this.#transport.request({ type: 'columns', table })
  }

  foreignKeys(table: string): Promise<ForeignKeyReport> {
    return this.#transport.request({ type: 'foreign-keys', table })
  }

  query(request: Omit<QueryRequest, 'type'>): Promise<QueryResult> {
    return this.#transport.request({ type: 'query', ...request })
  }

  groups(
    table: string,
    columns: string[],
    scope: { filter?: FilterNode | null; search?: string | null; searchColumns?: string[] } = {},
  ): Promise<GroupInfo[]> {
    return this.#transport.request({ type: 'groups', table, columns, ...scope })
  }

  summary(
    table: string,
    columns: Record<string, SummaryFunction>,
    scope: { filter?: FilterNode | null; search?: string | null; searchColumns?: string[] } = {},
  ): Promise<SummaryResult> {
    return this.#transport.request({ type: 'summary', table, columns, ...scope })
  }

  record(table: string, locator: RecordLocator): Promise<Row | null> {
    return this.#transport.request({ type: 'record', table, locator })
  }

  related(table: string, rowid: number, limit?: number): Promise<RelatedGroup[]> {
    return this.#transport.request({
      type: 'related',
      table,
      rowid,
      ...(limit === undefined ? {} : { limit }),
    })
  }

  linkLabels(table: string, column: string, values: SqlValue[]): Promise<LinkLabels> {
    return this.#transport.request({ type: 'link-labels', table, column, values })
  }

  update(table: string, rowid: number, field: string, value: SqlValue): Promise<WriteResult> {
    return this.#transport.request({ type: 'update', table, rowid, field, value })
  }

  /** `rowid` restores a deleted record under its original identity — undo, and only undo. */
  insert(
    table: string,
    values: Record<string, SqlValue> = {},
    rowid?: number,
  ): Promise<WriteResult> {
    return this.#transport.request({
      type: 'insert',
      table,
      values,
      ...(rowid === undefined ? {} : { rowid }),
    })
  }

  delete(table: string, rowids: number[]): Promise<WriteResult> {
    return this.#transport.request({ type: 'delete', table, rowids })
  }

  bulkUpdate(
    table: string,
    rowids: number[],
    field: string,
    value: SqlValue,
  ): Promise<WriteResult> {
    return this.#transport.request({ type: 'bulk-update', table, rowids, field, value })
  }

  views(table: string): Promise<SavedView[]> {
    return this.#transport.request({ type: 'get-views', table })
  }

  setTableOrder(order: string[]): Promise<{ ok: true }> {
    return this.#transport.request({ type: 'set-table-order', order })
  }

  saveView(table: string, view: Partial<SavedView>): Promise<SavedView> {
    return this.#transport.request({ type: 'save-view', table, view })
  }

  deleteView(viewId: number): Promise<{ deleted: number }> {
    return this.#transport.request({ type: 'delete-view', viewId })
  }

  meta(table: string): Promise<TableMeta> {
    return this.#transport.request({ type: 'get-meta', table })
  }

  setMeta(table: string, config: Record<string, unknown>): Promise<TableMeta> {
    return this.#transport.request({ type: 'set-meta', table, config })
  }

  splitCommaValues(table: string, column: string): Promise<number> {
    return this.#transport.request({ type: 'split-comma-values', table, column })
  }

  /** What a drop would break: the SQL views reading from this table, or naming this column. */
  dependents(table: string, column?: string): Promise<Array<{ name: string; namesColumn: boolean }>> {
    return this.#transport.request({ type: 'dependents', table, ...(column ? { column } : {}) })
  }

  createTable(name: string): Promise<{ name: string }> {
    return this.#transport.request({ type: 'create-table', name })
  }

  /** Remember which view a table was left on, so reopening the file lands there. */
  setLastView(table: string, viewId: number): Promise<unknown> {
    return this.#transport.request({ type: 'set-last-view', table, viewId })
  }

  renameTable(table: string, name: string): Promise<{ name: string }> {
    return this.#transport.request({ type: 'rename-table', table, name })
  }

  describeTable(table: string, description: string | null): Promise<unknown> {
    return this.#transport.request({ type: 'describe-table', table, description })
  }

  dropTable(table: string): Promise<unknown> {
    return this.#transport.request({ type: 'drop-table', table })
  }

  addColumn(table: string, name: string, columnType: string): Promise<{ name: string }> {
    return this.#transport.request({ type: 'add-column', table, name, columnType })
  }

  dropColumn(table: string, column: string): Promise<unknown> {
    return this.#transport.request({ type: 'drop-column', table, column })
  }

  duplicateColumn(
    table: string,
    column: string,
    name: string,
    copyValues: boolean,
  ): Promise<{ name: string }> {
    return this.#transport.request({ type: 'duplicate-column', table, column, name, copyValues })
  }

  /** Distinct non-empty values of one column, for seeding a select field's options. */
  distinctValues(table: string, column: string, limit?: number): Promise<SqlValue[]> {
    return this.#transport.request({ type: 'distinct-values', table, column, limit })
  }
}
