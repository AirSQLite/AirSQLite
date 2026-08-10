import type { SqlValue } from '../shared/protocol.js'

// SQLite's constraint messages are precise and useless to the target user. "UNIQUE
// constraint failed: customers.email" tells someone who never writes SQL nothing about
// what they did or how to undo it.
//
// Every message produced here goes straight into a toast, so it has to say what went wrong
// in terms of what the user just did. Anything that escapes unmapped is a user-facing bug,
// which is why mapSqliteError falls through to a plain sentence rather than a stack trace.

/** An error whose message is already fit for a user to read. */
export class ProtocolError extends Error {
  override name = 'ProtocolError'
}

export interface WriteContext {
  table?: string
  field?: string
  value?: SqlValue
}

interface SqliteError extends Error {
  code?: string
}

function quote(value: SqlValue | undefined): string {
  if (value === undefined || value === null) return 'that value'
  if (typeof value === 'string') return `'${value}'`
  if (value instanceof Uint8Array) return 'that binary value'
  return `'${String(value)}'`
}

/** "customers.email" -> "email"; falls back to whatever was there. */
function columnFrom(detail: string | undefined, fallback?: string): string | undefined {
  if (!detail) return fallback
  const parts = detail.trim().split('.')
  return parts.length > 1 ? parts[parts.length - 1] : (parts[0] ?? fallback)
}

/**
 * Turn a better-sqlite3 error into a sentence. `ctx` supplies the value the user typed,
 * which SQLite itself does not report back.
 */
export function mapSqliteError(err: unknown, ctx: WriteContext = {}): ProtocolError {
  if (err instanceof ProtocolError) return err

  const error = err as SqliteError
  const message = error?.message ?? String(err)
  const code = error?.code ?? ''

  // UNIQUE constraint failed: customers.email
  if (code.startsWith('SQLITE_CONSTRAINT_UNIQUE') || code.startsWith('SQLITE_CONSTRAINT_PRIMARYKEY')) {
    const detail = message.split(':')[1]
    const column = columnFrom(detail, ctx.field)
    return new ProtocolError(
      column
        ? `This value must be unique — another row already has ${quote(ctx.value)} in the ${column} column.`
        : `This value must be unique — another row already has ${quote(ctx.value)}.`,
    )
  }

  // NOT NULL constraint failed: customers.name
  if (code.startsWith('SQLITE_CONSTRAINT_NOTNULL')) {
    const column = columnFrom(message.split(':')[1], ctx.field)
    return new ProtocolError(
      column
        ? `The ${column} column can't be empty — every row needs a value here.`
        : `That column can't be empty — every row needs a value here.`,
    )
  }

  // FOREIGN KEY constraint failed  (SQLite names neither the column nor the table)
  if (code.startsWith('SQLITE_CONSTRAINT_FOREIGNKEY')) {
    return new ProtocolError(
      ctx.field
        ? `${quote(ctx.value)} doesn't match any record in the table that ${ctx.field} links to.`
        : `That value doesn't match any record in the linked table.`,
    )
  }

  // CHECK constraint failed: positive_total
  if (code.startsWith('SQLITE_CONSTRAINT_CHECK')) {
    const rule = message.split(':')[1]?.trim()
    return new ProtocolError(
      rule
        ? `${quote(ctx.value)} isn't allowed here — this table requires it to satisfy the "${rule}" rule.`
        : `${quote(ctx.value)} isn't allowed here — it breaks a rule this table enforces.`,
    )
  }

  if (code.startsWith('SQLITE_CONSTRAINT')) {
    return new ProtocolError(`${quote(ctx.value)} isn't allowed here — it breaks a rule this table enforces.`)
  }

  if (code === 'SQLITE_READONLY') {
    return new ProtocolError('This database file is read-only, so changes can’t be saved.')
  }

  if (code === 'SQLITE_BUSY') {
    return new ProtocolError(
      'The database is busy — another program is writing to it. Try again in a moment.',
    )
  }

  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') {
    return new ProtocolError('This file isn’t a valid SQLite database.')
  }

  return new ProtocolError(message)
}
