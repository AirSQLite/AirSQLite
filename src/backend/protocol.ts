import type {
  ActionDefinition,
  ProtocolEvent,
  ProtocolRequest,
  ResponseEnvelope,
  Row,
  SavedView,
  TableMeta,
  SummaryFunction,
} from '../shared/protocol.js'
import { Actions, type ActionHost } from './actions.js'
import { Changelog } from './changelog.js'
import { Db, type ComputedColumn } from './db.js'
import { ProtocolError, mapSqliteError } from './errors.js'
import type { LinkTarget } from './filter.js'
import { Meta } from './meta.js'
import { Schema, type ColumnType } from './schema.js'
import { Watcher } from './watcher.js'

// The single request router. Transport-agnostic on purpose: it takes a request object and
// returns a response object, knowing nothing about postMessage, WebSockets, or VS Code.
// Both entry points — src/extension.ts and src/server.ts — hand their messages to this.

export { ProtocolError }

export interface HandlerContext {
  /** Absolute path to the database file this session is bound to. */
  dbPath: string
  /** Open the file read-only. Used by tests that must not mutate a shared fixture. */
  readonly?: boolean
  /** Skip the filesystem watcher. Tests that drive changes directly do not want the noise. */
  watch?: boolean
  /** Injectable clock for the changelog, so tests can predict timestamps. */
  now?: () => string
  /**
   * What the host can do on an action's behalf. Opening a URL or a terminal only exists
   * inside VS Code; the script and HTTP paths have Node defaults and are injectable so tests
   * can assert on side effects without actually causing them.
   */
  host?: ActionHost
}

export interface Session {
  handle(request: ProtocolRequest): Promise<unknown>
  /** Subscribe to unsolicited backend events. Returns an unsubscribe function. */
  onEvent(listener: (event: ProtocolEvent) => void): () => void
  close(): void
  readonly db: Db
  readonly meta: Meta
  readonly changelog: Changelog
  readonly actions: Actions
}

export type Handler = Session['handle']

/**
 * Open the database and return a handler bound to it. The connection is opened eagerly so a
 * bad path fails at connect time with a readable message, rather than on the first query.
 */
export function createSession(ctx: HandlerContext): Session {
  const db = Db.open(ctx.dbPath, { readonly: ctx.readonly ?? false })
  const meta = new Meta(db)
  const schema = new Schema(db)

  const changelog = Changelog.open(ctx.dbPath, ctx.now ? { now: ctx.now } : {})
  if (!ctx.readonly) changelog.reconcile(db.connection)
  db.changelog = (op, table, rowid, before, after) =>
    changelog.append(op, table, rowid, before, after)
  db.stampResolver = (table, rowid) => changelog.stamps(table, rowid)

  const actions = new Actions(db, ctx.host ?? {})

  const listeners = new Set<(event: ProtocolEvent) => void>()
  const emit = (event: ProtocolEvent): void => {
    for (const listener of listeners) listener(event)
  }

  // Baseline data_version, so the first check compares against where we started rather than
  // reporting the very first external commit as though nothing had happened before it.
  let lastVersion = db.dataVersion()
  const watcher =
    ctx.watch === false
      ? null
      : Watcher.start(ctx.dbPath, {
          hasExternalChange: () => {
            const version = db.dataVersion()
            if (version === lastVersion) return false
            lastVersion = version
            return true
          },
          onChange: () => {
            // Another process wrote, so anything cached about the file is suspect: the
            // schema may have changed and the changelog may have grown behind our back.
            db.invalidateSchema()
            changelog.refresh()
            emit({ type: 'db-changed' })
          },
        })

  // Teach the query path how to reach a linked record's display value. Db owns SQL and Meta
  // owns primary fields; this is the seam rather than a dependency in either direction.
  db.linkResolver = (table: string): Map<string, LinkTarget> => {
    const links = new Map<string, LinkTarget>()
    for (const fk of db.foreignKeys(table)) {
      // Composite keys have no single display column, so linked-record filtering skips them.
      if (fk.fromColumns.length !== 1) continue
      const from = fk.fromColumns[0]
      const to = fk.toColumns[0]
      if (!from || !to) continue
      links.set(from, {
        table: fk.toTable,
        keyColumn: to,
        primaryField: meta.primaryField(fk.toTable),
      })
    }
    return links
  }

  async function handle(request: ProtocolRequest): Promise<unknown> {
    switch (request.type) {
      case 'ping':
        return { pong: true, dbPath: ctx.dbPath }

      // --- schema ---------------------------------------------------------
      case 'tables': {
        // Alphabetical from SQLite, then the user's stored tab order applied on top. Tables
        // with no stored rank keep their alphabetical position at the end, so a table created
        // after the order was set appears rather than vanishing.
        const order = meta.tableOrder()
        const descriptions = meta.tableDescriptions()
        const ranked = db.tables().map((table, index) => ({
          table: { ...table, description: descriptions.get(table.name) ?? null },
          rank: order.get(table.name) ?? Number.MAX_SAFE_INTEGER,
          index,
        }))
        ranked.sort((a, b) => a.rank - b.rank || a.index - b.index)
        return ranked.map((entry) => entry.table)
      }
      case 'columns':
        // Introspection merged with display config — the UI wants one answer, not two.
        return meta.describeColumns(request.table)
      case 'foreign-keys':
        return {
          outbound: db.foreignKeys(request.table),
          inbound: db.reverseForeignKeys(request.table),
        }

      // --- grouping and summaries -------------------------------------------
      case 'groups':
        return db.groups(request.table, request.columns, request, validComputed(meta, request.table))

      case 'summary':
        return db.summary(request.table, request.columns, request, validComputed(meta, request.table))

      // --- linked records --------------------------------------------------
      case 'record':
        return db.record(request.table, request.locator, validComputed(meta, request.table))

      case 'related':
        // Db leaves primaryField empty because it has no business knowing about display
        // columns. This is where Db and Meta already meet, so this is where it is filled in.
        return db
          .related(request.table, request.rowid, request.limit ?? undefined)
          .map((group) => ({ ...group, primaryField: meta.primaryField(group.fromTable) }))

      case 'link-labels':
        return db.linkLabels(request.table, request.column, request.values)

      // --- reads ----------------------------------------------------------
      case 'query':
        return db.query(request, validComputed(meta, request.table))
      case 'search':
        return db.query({
          type: 'query',
          table: request.table,
          search: request.query,
        })

      // --- writes ---------------------------------------------------------
      case 'update':
        return db.update(request.table, request.rowid, request.field, request.value)
      case 'insert':
        return db.insert(request.table, request.values, request.rowid)
      case 'delete':
        return db.delete(request.table, request.rowids)
      case 'bulk-update':
        return db.bulkUpdate(request.table, request.rowids, request.field, request.value)

      // --- metadata -------------------------------------------------------
      case 'distinct-values':
        return db.distinctValues(request.table, request.column, request.limit)

      case 'dependents':
        return schema.dependents(request.table, request.column)

      case 'create-table':
        return { name: schema.createTable(request.name) }

      case 'rename-table':
        return { name: schema.renameTable(request.table, request.name) }

      case 'describe-table':
        meta.setTableDescription(request.table, request.description)
        return { ok: true }

      case 'set-last-view':
        meta.setLastView(request.table, request.viewId)
        return { ok: true }

      case 'drop-table':
        schema.dropTable(request.table)
        return { ok: true }

      case 'add-column':
        return { name: schema.addColumn(request.table, request.name, request.columnType as ColumnType) }

      case 'drop-column':
        schema.dropColumn(request.table, request.column)
        return { ok: true }

      case 'rename-column':
        return { name: schema.renameColumn(request.table, request.column, request.name) }

      case 'duplicate-column':
        return {
          name: schema.duplicateColumn(
            request.table,
            request.column,
            request.name,
            request.copyValues,
          ),
        }

      case 'get-meta':
        return {
          table: request.table,
          primaryField: meta.primaryField(request.table),
          columns: meta.describeColumns(request.table),
          writable: meta.writable,
        } satisfies TableMeta

      case 'set-table-order':
        meta.setTableOrder(request.order)
        return { ok: true }

      case 'set-meta': {
        const config = request.config as {
          primaryField?: string
          columns?: Record<
            string,
            {
              displayType?: string
              options?: Record<string, unknown>
              description?: string | null
            }
          >
        }
        if (config.primaryField) meta.setPrimaryField(request.table, config.primaryField)
        for (const [column, display] of Object.entries(config.columns ?? {})) {
          // Description first, and only when asked for. It must not carry a display type with
          // it, or describing a field would freeze whatever type inference had guessed.
          if (display.description !== undefined) {
            meta.setColumnDescription(request.table, column, display.description)
          }
          if (display.displayType === undefined) continue
          meta.setColumnDisplay(request.table, column, {
            ...(display.displayType
              ? { displayType: display.displayType as TableMeta['columns'][number]['displayType'] }
              : {}),
            ...(display.options ? { options: display.options } : {}),
          })
        }
        return {
          table: request.table,
          primaryField: meta.primaryField(request.table),
          columns: meta.describeColumns(request.table),
          writable: meta.writable,
        } satisfies TableMeta
      }

      case 'get-views':
        return meta.views(request.table)

      case 'save-view':
        return meta.saveView(request.table, request.view as Partial<SavedView>)

      case 'delete-view':
        meta.deleteView(request.viewId)
        return { deleted: request.viewId }

      // --- audit trail -----------------------------------------------------
      case 'history':
        return changelog.history(request.table, request.rowid)

      // --- actions ----------------------------------------------------------
      case 'get-actions':
        return actions.list(request.table)

      case 'save-action':
        return actions.save(request.table, request.action as Partial<ActionDefinition>)

      case 'delete-action':
        actions.remove(request.actionId)
        return { deleted: request.actionId }

      case 'run-action':
        return actions.run(
          request.actionId,
          request.row as Row,
          request.confirmed === true,
        )

      case 'split-comma-values':
        return db.splitCommaValues(request.table, request.column)

      default: {
        const unreachable: never = request
        throw new ProtocolError(
          `Unknown request type "${String((unreachable as { type: string }).type)}".`,
        )
      }
    }
  }

  return {
    handle,
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      watcher?.close()
      listeners.clear()
      if (!ctx.readonly) {
        changelog.writeAllSnapshots(
          db.connection,
          db.tables().map((t) => t.name),
        )
      }
      db.close()
    },
    db,
    meta,
    changelog,
    actions,
  }
}


function validComputed(meta: Meta, table: string): ComputedColumn[] {
  return meta
    .describeColumns(table)
    .filter((c) => c.computed && c.formula && !c.formulaError)
    .map((c) => ({ name: c.name, formula: c.formula! }))
}

/**
 * Wrap a handler call in the response envelope. Every thrown error becomes a readable
 * message rather than a stack trace — the UI renders `error` straight into a toast, so an
 * unmapped internal error is a user-facing bug, not just a log line.
 */
export async function respond(
  handler: Handler,
  id: string,
  request: ProtocolRequest,
): Promise<ResponseEnvelope> {
  try {
    return { id, ok: true, data: await handler(request) }
  } catch (err) {
    return { id, ok: false, error: mapSqliteError(err).message }
  }
}
