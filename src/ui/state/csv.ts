import type { QueryRequest, Row, SqlValue } from '../../shared/protocol.js'
import type { Client } from './client.js'
import type { HostServices } from './host.js'
import type { LaidOutColumn } from './views.js'

// Exporting a view to CSV.
//
// "The view" is the operative word: the columns it shows, in the order it shows them, filtered
// and sorted the way it is filtered and sorted. Exporting the underlying table instead would be
// easier and would ignore every decision the user made in the view they are exporting.
//
// This is the first caller of `HostServices`. Everything the UI wanted until now was a question
// about the database; where a file goes is a question about the host.

/** Rows per round trip. The grid windows to a screenful; an export has to walk the whole set. */
const PAGE_SIZE = 2000

/**
 * A ceiling, so a mistyped filter on a 10-million-row table cannot quietly try to build a
 * gigabyte of string in a webview. Hitting it is reported rather than silently truncating —
 * a short CSV that claims to be complete is worse than an error.
 */
const MAX_ROWS = 200_000

export class ExportTooLargeError extends Error {
  constructor(count: number) {
    super(
      `This view has ${count.toLocaleString()} rows, more than the ${MAX_ROWS.toLocaleString()}-row export limit. Filter it down first.`,
    )
  }
}

/**
 * Quote a field for RFC 4180.
 *
 * Quoting is conditional rather than unconditional so the common case stays readable, but the
 * leading-separator case is not about correctness: a value starting with `=`, `+`, `-` or `@`
 * is executed as a formula by Excel and Sheets on open. Prefixing a tab neutralises it without
 * changing what the cell reads as.
 */
export function csvField(value: SqlValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Uint8Array) return '(blob)'

  let text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `\t${text}`
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export function toCsv(columns: string[], rows: Row[]): string {
  const lines = [columns.map((c) => csvField(c)).join(',')]
  for (const row of rows) lines.push(columns.map((c) => csvField(row[c] ?? null)).join(','))
  // Trailing newline: POSIX text, and it stops the last row concatenating if the file is
  // appended to or catted with another.
  return `${lines.join('\r\n')}\r\n`
}

/** A filename that will survive every filesystem this could land on. */
export function csvFilename(table: string, view: string): string {
  const slug = (part: string) =>
    part
      .replace(/[^\w\-. ]+/g, '_')
      // Trim the replacements too, not just whitespace: a name made entirely of illegal
      // characters would otherwise come back as a row of underscores rather than falling back.
      .replace(/^[_\s.]+|[_\s.]+$/g, '')
      .slice(0, 60) || 'export'
  return `${slug(table)}-${slug(view)}.csv`
}

export interface ExportOptions {
  client: Client
  host: HostServices
  table: string
  viewName: string
  /** The laid-out columns of the active view — visible only, in view order. */
  layout: LaidOutColumn[]
  /** The same spec the grid queries with, so the export matches what is on screen. */
  spec: Omit<QueryRequest, 'type' | 'table' | 'offset' | 'limit'>
}

/**
 * Page the whole view out and hand it to the host.
 *
 * Sequential rather than parallel on purpose: SQLite is one connection, so concurrent pages
 * would queue behind each other anyway, and a serial walk keeps a stable offset while nothing
 * else is writing.
 */
export async function exportViewToCsv(options: ExportOptions): Promise<number> {
  const { client, host, table, viewName, layout, spec } = options
  // Virtual columns come from the changelog and have no column for SQL to name, but they do
  // have values on the rows the query returns, so they export like any other.
  const columns = layout.map((c) => c.descriptor.name)

  const first = await client.query({ ...spec, table, offset: 0, limit: PAGE_SIZE })
  if (first.filteredCount > MAX_ROWS) throw new ExportTooLargeError(first.filteredCount)

  const rows: Row[] = [...first.rows]
  while (rows.length < first.filteredCount) {
    const page = await client.query({ ...spec, table, offset: rows.length, limit: PAGE_SIZE })
    // A page that comes back empty means the row count moved under us — stop rather than loop.
    if (page.rows.length === 0) break
    rows.push(...page.rows)
  }

  await host.saveFile({
    suggestedName: csvFilename(table, viewName),
    mimeType: 'text/csv',
    data: toCsv(columns, rows),
  })

  return rows.length
}
