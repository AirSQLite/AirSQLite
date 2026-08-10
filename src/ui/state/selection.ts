import type { SqlValue } from '../../shared/protocol.js'
import type { GridView } from './grouping.js'

// The cell cursor and the rectangle it can drag out behind it.
//
// The cursor addresses a *display* slot, not a row — since grouping, those are different
// numbers, and arrowing down off the last record of a group lands on the next group's header.
// Headers are reachable on purpose: a tree grid whose twisties can only be opened with a
// mouse is not keyboard-navigable, it just has keys that work in some places.

export interface CellCursor {
  /** Display slot, which is a row index only when nothing is grouped. */
  display: number
  /** Index into the *data* columns, so chrome columns cannot be landed on. */
  column: number
}

/** An inclusive rectangle in display × column space. */
export interface CellRange {
  top: number
  bottom: number
  left: number
  right: number
}

export function rangeOf(anchor: CellCursor, focus: CellCursor): CellRange {
  return {
    top: Math.min(anchor.display, focus.display),
    bottom: Math.max(anchor.display, focus.display),
    left: Math.min(anchor.column, focus.column),
    right: Math.max(anchor.column, focus.column),
  }
}

export function inRange(range: CellRange | null, display: number, column: number): boolean {
  if (!range) return false
  return (
    display >= range.top && display <= range.bottom && column >= range.left && column <= range.right
  )
}

/**
 * Move the cursor, clamped to the grid.
 *
 * Vertical movement steps through display slots, so it passes over group headers rather than
 * around them. Horizontal movement on a header does nothing — there are no columns on a
 * header row to move between.
 */
export function moveCursor(
  cursor: CellCursor,
  view: GridView,
  columnCount: number,
  delta: { rows?: number; columns?: number },
): CellCursor {
  const display = clamp(cursor.display + (delta.rows ?? 0), 0, Math.max(0, view.length - 1))
  const column = clamp(cursor.column + (delta.columns ?? 0), 0, Math.max(0, columnCount - 1))
  return { display, column }
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

/**
 * Tab wraps to the next line, the way it does in a spreadsheet. Landing on a header would
 * strand the cursor in a row with no columns, so tabbing skips them.
 */
export function tabCursor(
  cursor: CellCursor,
  view: GridView,
  columnCount: number,
  backwards: boolean,
): CellCursor {
  let column = cursor.column + (backwards ? -1 : 1)
  let display = cursor.display

  while (display >= 0 && display < view.length) {
    if (column < 0) {
      display -= 1
      column = columnCount - 1
    } else if (column >= columnCount) {
      display += 1
      column = 0
    }
    if (display < 0 || display >= view.length) break
    if (view.at(display)?.kind === 'row') return { display, column }
    display += backwards ? -1 : 1
    column = backwards ? columnCount - 1 : 0
  }

  return cursor
}

// ---------------------------------------------------------------------------
// TSV
// ---------------------------------------------------------------------------

/**
 * Serialise a rectangle as TSV, which is what a spreadsheet reads from the clipboard.
 *
 * Cells containing a tab, a newline, or a quote are quoted the way TSV/CSV readers expect,
 * so a long-text cell with a line break in it does not silently become two rows on paste.
 */
export function toTsv(rows: SqlValue[][]): string {
  return rows.map((row) => row.map(escapeCell).join('\t')).join('\n')
}

function escapeCell(value: SqlValue): string {
  const text =
    value === null || value === undefined
      ? ''
      : value instanceof Uint8Array
        ? `${value.byteLength} bytes`
        : String(value)
  if (!/[\t\n"\r]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

/**
 * Parse TSV back into a grid of strings.
 *
 * Hand-written rather than split-on-tab because a quoted cell may contain both tabs and
 * newlines, and splitting first destroys exactly the values that needed the quoting.
 */
export function fromTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let i = 0

  const endCell = () => {
    row.push(cell)
    cell = ''
  }
  const endRow = () => {
    endCell()
    rows.push(row)
    row = []
  }

  while (i < text.length) {
    const char = text[i]!

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      cell += char
      i++
      continue
    }

    if (char === '"' && cell === '') {
      quoted = true
      i++
    } else if (char === '\t') {
      endCell()
      i++
    } else if (char === '\r') {
      i++
    } else if (char === '\n') {
      endRow()
      i++
    } else {
      cell += char
      i++
    }
  }

  // A trailing newline is a line terminator, not an empty final row — spreadsheets emit one.
  if (cell !== '' || row.length > 0) endRow()
  return rows
}
