import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type {
  ActionDefinition,
  ColumnDescriptor,
  DisplayType,
  Row,
  SortSpec,
  SqlValue,
  SummaryFunction,
} from '../../shared/protocol.js'
import type { Client } from '../state/client.js'
import { fieldTypeIcon, menuIcon } from './FieldTypeIcons.js'
import { useReorder } from '../state/reorder.js'
import type { GridView, GroupNode } from '../state/grouping.js'
import {
  fromTsv,
  inRange,
  moveCursor,
  rangeOf,
  tabCursor,
  toTsv,
  type CellCursor,
  type CellRange,
} from '../state/selection.js'
import type { Links } from '../state/links.js'
import { changeKey, type TableData } from '../state/store.js'
import type { LaidOutColumn } from '../state/views.js'
import { ActionButtons } from './ActionButtons.js'
import { CellEditor } from './CellEditor.js'
import { CellValue, formatCurrency, formatValue, isTruthy } from './CellValue.js'
import { ColumnHeaderMenu } from './ColumnHeaderMenu.js'
import { LinkedRecordChip } from './LinkedRecordChip.js'
import { LinkedRecordEditor } from './LinkedRecordEditor.js'

// The grid renders a window, never a table.
//
// With 100k rows the DOM can hold about a screenful; everything else is a scroll offset and
// arithmetic. Uniform row height turns "which rows are visible" into one division, a spacer
// of `rowCount * ROW_HEIGHT` gives the scrollbar the right size, and a transform moves the
// rendered window into place. Nothing here loops over all rows.

export const ROW_HEIGHT = 28
export const HEADER_HEIGHT = 30
const OVERSCAN = 8
// Wide enough for the row number, the checkbox, and the expand affordance side by side.
// Airtable puts the row-expand control here too, and it needs to be reachable without opening
// anything first. Widened from 56 when the ordinal landed — the three would otherwise overlap,
// and `chromeWidth` feeds the summary bar's offset, so getting it wrong misaligns every total.
const SELECT_COLUMN_WIDTH = 80
const MIN_COLUMN_WIDTH = 60
/** Below this a value fits a default-width cell, so expanding it would only cover other rows. */
const PEEK_MIN_LENGTH = 48
/** A single 4KB description should not produce a column wider than the window. */
const AUTOFIT_MAX_WIDTH = 600
const ACTION_BUTTON_WIDTH = 84
const ACTION_COLUMN_MAX = 320

/**
 * How much chrome sits left of the first data column. The summary bar needs it to line its
 * cells up with the grid's — a total that does not sit under the column it totals is a number
 * the reader has to match up by hand.
 */
/** Does a column's own name match what is in the search box? Case-insensitive substring. */
function headerMatches(name: string, search: string | undefined): boolean {
  const needle = search?.trim().toLowerCase()
  return !!needle && name.toLowerCase().includes(needle)
}

export function chromeWidth(editable: boolean): number {
  return editable ? SELECT_COLUMN_WIDTH : 0
}

export function trailingWidth(actionCount: number, canAddColumn: boolean): number {
  let w = 0
  if (actionCount > 0) w += Math.min(ACTION_COLUMN_MAX, 24 + actionCount * ACTION_BUTTON_WIDTH)
  if (canAddColumn) w += ADD_COLUMN_WIDTH
  return w
}

export interface ActiveCell {
  rowid: number
  column: string
}

export interface GridProps {
  data: TableData
  /** Ordered, visible columns with their widths — see layOutColumns in state/views.ts. */
  layout: LaidOutColumn[]
  /** WITHOUT ROWID tables have no row identity, so they cannot be selected or edited. */
  editable: boolean
  sort: SortSpec[]
  selected: Set<number>
  canConfigure: boolean
  /** How many *data* columns are frozen, on top of the always-frozen chrome columns. */
  frozenCount: number
  client: Client
  links: Links
  /**
   * What occupies each display slot. Ungrouped this is one row per slot; grouped it
   * interleaves headers, and display index stops equalling row index — see state/grouping.ts.
   */
  view: GridView
  grouping: string[]
  allColumns: ColumnDescriptor[]
  summaryConfig: Record<string, import('../../shared/protocol.js').SummaryFunction>
  onToggleGroup: (values: SqlValue[]) => void
  /** Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z. The stack itself lives in state/history.ts. */
  onUndo: () => void
  onRedo: () => void
  /**
   * A TSV block dropped on the grid at `cursor`. The grid does not write it itself: pasting
   * past the last row creates records, and deciding that is the app's business, not the
   * renderer's.
   */
  onPaste: (cursor: CellCursor, cells: string[][]) => void
  /** Actions with show_in_grid set. Rendered in a trailing column, one set per row. */
  rowActions: ActionDefinition[]
  runningAction: number | null
  onRunAction: (action: ActionDefinition, row: Row) => void
  /** The row the detail panel is showing, highlighted so the two surfaces stay connected. */
  activeRowid: number | null
  /** A cell click focuses its row; the expand control opens it outright. */
  onFocusRow: (rowid: number) => void
  /** Reports horizontal scroll so the summary bar can follow the columns.
   *  scrollbarWidth: space consumed by the vertical scrollbar gutter. */
  onHorizontalScroll?: (left: number, scrollbarWidth: number) => void
  /**
   * The active table search. Rows are filtered by the backend; this is only used to mark the
   * *headers* that match, which is how you find one column among forty without hiding anything.
   */
  search?: string
  onExpandRow: (rowid: number) => void
  onNavigateLink: (column: string, value: SqlValue) => void
  onSort: (column: string, direction: 'asc' | 'desc' | null, additive: boolean) => void
  onToggleRow: (rowid: number) => void
  onToggleAll: () => void
  onEdit: (rowid: number, field: string, value: SqlValue) => void
  onSetDisplayType: (
    column: string,
    type: DisplayType,
    options: Record<string, unknown> | null,
  ) => void
  /** A field-level property, so it does not close the menu — you may want to keep editing. */
  onSetDescription: (column: string, description: string | null) => void
  /** Distinct values of a column, for seeding a select field's options on conversion. */
  onHarvestValues: (column: string) => Promise<string[]>
  /** The table's primary field. It labels linked records and is pinned leftmost. */
  primaryField: string
  onSetPrimary: (column: string) => void
  onRenameColumn: (column: string) => void
  onDuplicateColumn: (column: string) => void
  onDeleteColumn: (column: string) => void
  /** Add a field. `beside` places it in the *view*, since SQLite can only append to the table. */
  onAddColumn: (beside?: { column: string; side: 'left' | 'right' }) => void
  onHideColumn: (column: string) => void
  onResizeColumn: (column: string, width: number) => void
  onReorderColumns: (order: string[]) => void
  /** How many data columns should be frozen. 0 unfreezes. */
  onFreezeCount: (count: number) => void
  allDateColumns: string[]
  onSetAllTimezones: (tz: string) => void
  onSplitCommaValues: (column: string) => Promise<number>
  onConfirmCommaSplit: (column: string, values: string[], applyType: () => void) => void
}

interface RenderColumn {
  key: string
  label: string
  width: number
  kind: 'select' | 'data' | 'actions' | 'add'
  descriptor: ColumnDescriptor | null
}

/** Width of the trailing add-field header. Wide enough to be a target, narrow enough to ignore. */
const ADD_COLUMN_WIDTH = 44

function toRenderColumns(
  layout: LaidOutColumn[],
  editable: boolean,
  frozenDataColumns: number,
  actionCount: number,
  canAddColumn: boolean,
): { rendered: RenderColumn[]; frozenCount: number; chromeCount: number } {
  const data: RenderColumn[] = layout.map(({ descriptor, width }) => ({
    key: descriptor.name,
    label: descriptor.name,
    width,
    kind: 'data',
    descriptor,
  }))

  // Actions sit in a trailing column rather than over the data. It is last, so it changes no
  // frozen offset and no cursor column index — the cursor addresses data columns only.
  const trailing: RenderColumn[] = []
  if (actionCount > 0) {
    trailing.push({
      key: '__actions',
      label: '',
      width: Math.min(ACTION_COLUMN_MAX, 24 + actionCount * ACTION_BUTTON_WIDTH),
      kind: 'actions',
      descriptor: null,
    })
  }
  // Last of all, so scrolling to the end of the columns lands on it. It has a header and no
  // cells — the body renders nothing for this column, which is what keeps it out of the
  // cursor's way and out of copy.
  if (canAddColumn) {
    trailing.push({ key: '__add', label: '', width: ADD_COLUMN_WIDTH, kind: 'add', descriptor: null })
  }

  // The primary field is always first (pinPrimary) and always frozen.
  const effectiveFrozen = Math.max(frozenDataColumns, data.length > 0 ? 1 : 0)

  if (!editable) {
    return { rendered: [...data, ...trailing], frozenCount: effectiveFrozen, chromeCount: 0 }
  }

  return {
    rendered: [
      { key: '__select', label: '', width: SELECT_COLUMN_WIDTH, kind: 'select', descriptor: null },
      ...data,
      ...trailing,
    ],
    frozenCount: 1 + effectiveFrozen,
    chromeCount: 1,
  }
}

export function Grid({
  data,
  layout,
  editable,
  sort,
  selected,
  canConfigure,
  frozenCount: frozenDataColumns,
  client,
  links,
  view,
  grouping,
  allColumns,
  summaryConfig,
  onToggleGroup,
  onUndo,
  onRedo,
  onPaste,
  rowActions,
  runningAction,
  onRunAction,
  activeRowid,
  onFocusRow,
  onHorizontalScroll,
  search,
  onExpandRow,
  onNavigateLink,
  onSort,
  onToggleRow,
  onToggleAll,
  onEdit,
  onSetDisplayType,
  onSetDescription,
  onHarvestValues,
  primaryField,
  onSetPrimary,
  onRenameColumn,
  onDuplicateColumn,
  onDeleteColumn,
  onAddColumn,
  onHideColumn,
  onResizeColumn,
  onReorderColumns,
  onFreezeCount,
  allDateColumns,
  onSetAllTimezones,
  onSplitCommaValues,
  onConfirmCommaSplit,
}: GridProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)
  const [editing, setEditing] = useState<ActiveCell | null>(null)
  const [cursor, setCursor] = useState<CellCursor | null>(null)
  /** Where a shift-extended range started. Null when the cursor is a single cell. */
  const [anchor, setAnchor] = useState<CellCursor | null>(null)
  const [menuColumn, setMenuColumn] = useState<string | null>(null)

  const {
    rendered: columns,
    frozenCount,
    chromeCount,
  } = toRenderColumns(layout, editable, frozenDataColumns, rowActions.length, canConfigure)

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return

    const measure = () => setViewportHeight(element.clientHeight)
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Still one division. Grouping changes what a slot *contains*, never that every slot is
  // exactly ROW_HEIGHT tall — group headers are the same height as rows for this reason.
  const visibleCount = Math.ceil((viewportHeight - HEADER_HEIGHT) / ROW_HEIGHT) + 1
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const endIndex = Math.min(view.length, startIndex + visibleCount + OVERSCAN * 2)

  useEffect(() => {
    if (view.length > 0) view.ensure(startIndex, endIndex)
  }, [view, startIndex, endIndex])

  const indices: number[] = []
  for (let i = startIndex; i < endIndex; i++) indices.push(i)

  const frozenOffsets: number[] = []
  let runningOffset = 0
  for (let i = 0; i < frozenCount; i++) {
    frozenOffsets.push(runningOffset)
    runningOffset += columns[i]?.width ?? 0
  }
  const freezeEdgeLeft = runningOffset

  const columnStyle = (column: RenderColumn, index: number) => {
    const style: Record<string, string> = {
      width: `${column.width}px`,
      minWidth: `${column.width}px`,
    }
    if (index < frozenCount) style['left'] = `${frozenOffsets[index] ?? 0}px`
    return style
  }

  const frozenClass = (index: number, base: string) =>
    index < frozenCount
      ? `${base} ${base}--frozen${index === frozenCount - 1 ? ` ${base}--frozen-edge` : ''}`
      : base

  const sortFor = (name: string) => sort.find((s) => s.column === name)?.direction ?? null

  const commit = (rowid: number, column: string, next: SqlValue) => {
    setEditing(null)
    onEdit(rowid, column, next)
    // "Enter again to commit and move down" — the cursor follows the edit, so a column of
    // values can be typed without reaching for the mouse.
    setCursor((prev) =>
      prev ? moveCursor(prev, view, dataColumns.length, { rows: 1 }) : prev,
    )
  }

  /**
   * Resize with pointer capture rather than window listeners: capture keeps the drag alive
   * when the pointer leaves the 4px handle, which it does immediately on any real drag.
   */
  const startResize = (event: PointerEvent, column: RenderColumn) => {
    event.preventDefault()
    event.stopPropagation()
    const handle = event.currentTarget as HTMLElement
    const startX = event.clientX
    const startWidth = column.width
    handle.setPointerCapture(event.pointerId)

    const move = (moveEvent: PointerEvent) => {
      const next = Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + (moveEvent.clientX - startX)))
      onResizeColumn(column.key, next)
    }
    const up = () => {
      handle.releasePointerCapture(event.pointerId)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }

  /**
   * Double-click a divider to size the column to its contents, as a spreadsheet does.
   *
   * Measured from what is currently rendered, which for a virtualised grid is a screenful —
   * not all 100k rows. That is the honest trade: measuring everything would mean fetching
   * everything, and a column sized to a value scrolled far out of sight is not what anybody
   * means by "fit". Sizing to what you can see is also what you can check.
   *
   * `scrollWidth` on the cell's inner span is the untruncated text width; the cell itself is
   * already clipped to the current column width, so measuring the cell would just return the
   * width it already has.
   */
  const autoFit = (column: RenderColumn) => {
    const root = scroller.current
    if (!root) return

    const header = root.querySelector(`.afs-head[data-column="${CSS.escape(column.key)}"]`) as HTMLElement | null
    let headerWidth = 0
    if (header) {
      // The header is a flex row with a fixed inline width and overflow:hidden, so its own
      // scrollWidth returns the clamped value. Measure each child individually instead:
      // non-label children (icon, sort, caret) are flex:0 0 auto so offsetWidth is natural;
      // the label has overflow:hidden but scrollWidth still reports the full text width.
      const style = getComputedStyle(header)
      const gap = parseFloat(style.gap || '0')
      const pad = parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0')
      let childCount = 0
      for (const child of header.children) {
        const el = child as HTMLElement
        if (el.classList.contains('afs-head__resize')) continue
        if (el.classList.contains('afs-head__label')) {
          headerWidth += el.scrollWidth
        } else {
          headerWidth += el.offsetWidth
        }
        childCount++
      }
      headerWidth += gap * Math.max(0, childCount - 1) + pad
    }

    if (headerWidth === 0) return

    onResizeColumn(
      column.key,
      Math.min(AUTOFIT_MAX_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.ceil(headerWidth) + 8)),
    )
  }

  const dataOrder = () => columns.filter((c) => c.kind === 'data').map((c) => c.key)

  const columnReorder = useReorder({
    items: dataOrder().filter((key) => key !== primaryField),
    onReorder: (next) => onReorderColumns(primaryField ? [primaryField, ...next] : next),
  })

  /**
   * Drag the freeze boundary. Snaps to whichever column edge the pointer is nearest, which
   * is the only sensible behaviour for a pane that can only sit between columns.
   */
  const startFreezeDrag = (event: PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const handle = event.currentTarget as HTMLElement
    const header = handle.closest('.afs-grid__header') as HTMLElement | null
    if (!header) return
    handle.setPointerCapture(event.pointerId)

    const dataColumns = columns.filter((c) => c.kind === 'data')
    const chromeWidth = columns
      .slice(0, chromeCount)
      .reduce((sum, c) => sum + c.width, 0)

    const move = (moveEvent: PointerEvent) => {
      const x = moveEvent.clientX - header.getBoundingClientRect().left - chromeWidth
      let edge = 0
      let count = 0
      for (const column of dataColumns) {
        if (x < edge + column.width / 2) break
        edge += column.width
        count += 1
      }
      onFreezeCount(count)
    }
    const up = () => {
      handle.releasePointerCapture(event.pointerId)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }

  const dataColumns = columns.filter((c) => c.kind === 'data')
  const range = anchor && cursor ? rangeOf(anchor, cursor) : null

  /** The rows and columns a copy would take: the range, or just the cursor cell. */
  const selectedRect = (): CellRange | null => {
    if (range) return range
    if (!cursor) return null
    return { top: cursor.display, bottom: cursor.display, left: cursor.column, right: cursor.column }
  }

  /**
   * Keep the cursor on screen. The grid renders a window, so a cursor moved past its edge is
   * not merely off-view — the element does not exist, and scrolling to it has to be done by
   * arithmetic rather than by asking the DOM.
   */
  useEffect(() => {
    const element = scroller.current
    if (!element || !cursor) return
    const top = cursor.display * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    const viewTop = element.scrollTop
    const viewBottom = viewTop + element.clientHeight - HEADER_HEIGHT

    if (top < viewTop) element.scrollTop = top
    else if (bottom > viewBottom) element.scrollTop = bottom - (element.clientHeight - HEADER_HEIGHT)
  }, [cursor])

  const move = (delta: { rows?: number; columns?: number }, extend: boolean) => {
    // With no cursor yet, the first arrow key places it on the first cell rather than
    // stepping off an imaginary one — pressing Down should select the top row, not skip it.
    if (!cursor) {
      setCursor({ display: 0, column: 0 })
      setAnchor(null)
      return
    }
    const next = moveCursor(cursor, view, dataColumns.length, delta)
    setCursor(next)
    setAnchor(extend ? (anchor ?? cursor) : null)
  }

  /**
   * An open panel follows the cursor.
   *
   * Only when it is *already* open: arrowing around a grid should not summon a panel nobody
   * asked for, but once one is on screen it showing a different record than the one under the
   * cursor is just two views disagreeing about where you are. `activeRowid` is the test for
   * "open", so this needs no new state.
   *
   * Driven off the cursor rather than the key handler so it covers every way the cursor moves
   * — arrows, Tab, and the commit-and-move-down on Enter.
   */
  useEffect(() => {
    if (activeRowid === null || !cursor) return
    const item = view.at(cursor.display)
    if (item?.kind !== 'row') return
    const row = data.getRow(item.rowIndex)
    if (row?.rowid != null && row.rowid !== activeRowid) onFocusRow(row.rowid)
  }, [cursor, activeRowid, view, data, onFocusRow])

  /**
   * Scroll the first header that matches the search into view.
   *
   * Highlighting a header thirty columns to the right answers the question without helping —
   * you still have to go and find it. This does the going.
   *
   * Two things it deliberately does not do. It does not scroll when the column is already
   * visible, because yanking the grid sideways while somebody is reading is worse than leaving
   * it alone. And it targets the right edge of the frozen pane rather than the viewport's left
   * edge, or the column would land underneath the frozen columns and be just as invisible.
   */
  useEffect(() => {
    const root = scroller.current
    if (!root || !search?.trim()) return

    let offset = 0
    let frozenWidth = 0
    let target: { left: number; width: number } | null = null
    columns.forEach((column, index) => {
      if (index < frozenCount) frozenWidth += column.width
      if (!target && column.kind === 'data' && headerMatches(column.key, search)) {
        target = { left: offset, width: column.width }
      }
      offset += column.width
    })
    if (!target) return

    const { left, width } = target
    const visibleLeft = root.scrollLeft + frozenWidth
    const visibleRight = root.scrollLeft + root.clientWidth
    if (left >= visibleLeft && left + width <= visibleRight) return

    // Snap, not smooth. A search is a jump, and animating it means watching thirty columns
    // stream past on the way to the one you asked for.
    root.scrollLeft = Math.max(0, left - frozenWidth)
  }, [search, columns, frozenCount])

  const onKeyDown = (event: KeyboardEvent) => {
    // Escape is handled before the editing check, and deliberately.
    //
    // When focus is inside an editor, CellEditor stops propagation and this never runs. When
    // it is not — the editor is still mounting, or focus was moved away — the grid is the
    // only thing that can cancel, and swallowing Escape here would leave the grid stuck in
    // edit mode with no key that gets it out.
    if (event.key === 'Escape') {
      setEditing(null)
      setAnchor(null)
      return
    }

    // Otherwise an open editor owns its keys — Enter commits, arrows move the caret inside
    // the text. Stealing those would make the editor unusable.
    if (editing) return

    const target = event.target as HTMLElement | null
    if (target?.closest('input, textarea, select, .afs-menu')) return

    const meta = event.metaKey || event.ctrlKey
    if (meta && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) onRedo()
      else onUndo()
      return
    }
    if (meta && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      onToggleAll()
      return
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        return move({ rows: 1 }, event.shiftKey)
      case 'ArrowUp':
        event.preventDefault()
        return move({ rows: -1 }, event.shiftKey)
      case 'ArrowRight':
        event.preventDefault()
        return move({ columns: 1 }, event.shiftKey)
      case 'ArrowLeft':
        event.preventDefault()
        return move({ columns: -1 }, event.shiftKey)
      case 'Tab': {
        event.preventDefault()
        const from = cursor ?? { display: 0, column: 0 }
        setCursor(tabCursor(from, view, dataColumns.length, event.shiftKey))
        setAnchor(null)
        return
      }
      case 'Enter': {
        if (!cursor) return
        event.preventDefault()
        const item = view.at(cursor.display)
        // On a header, Enter is the twisty. Anywhere else it opens the editor.
        if (item?.kind === 'header') return onToggleGroup(item.node.values)
        const row = item ? data.getRow(item.rowIndex) : undefined
        const column = dataColumns[cursor.column]
        if (!row || row.rowid === null || !column || column.descriptor?.virtual || column.descriptor?.computed) return
        if (editable) setEditing({ rowid: row.rowid, column: column.key })
        return
      }
    }
  }

  /**
   * Copy and paste go through the browser's own clipboard events rather than
   * `navigator.clipboard`.
   *
   * That is not a style choice. In a VS Code webview the async clipboard API needs a
   * permission the host does not grant — `readText()` in particular is simply unavailable —
   * whereas a ClipboardEvent carries its data synchronously with no permission at all.
   */
  const clipboard = useRef<{ copy: (e: ClipboardEvent) => void; paste: (e: ClipboardEvent) => void }>({
    copy: () => undefined,
    paste: () => undefined,
  })

  clipboard.current = {
    copy: (event: ClipboardEvent) => {
      const rect = selectedRect()
      if (!rect || editing) return
      const rows: SqlValue[][] = []
      for (let display = rect.top; display <= rect.bottom; display++) {
        const item = view.at(display)
        if (item?.kind !== 'row') continue
        const row = data.getRow(item.rowIndex)
        if (!row) continue
        rows.push(
          dataColumns.slice(rect.left, rect.right + 1).map((column) => row[column.key] ?? null),
        )
      }
      if (rows.length === 0) return
      event.preventDefault()
      event.clipboardData?.setData('text/plain', toTsv(rows))
    },
    paste: (event: ClipboardEvent) => {
      if (editing || !cursor) return
      const text = event.clipboardData?.getData('text/plain')
      if (!text) return
      const cells = fromTsv(text)
      if (cells.length === 0) return
      event.preventDefault()
      onPaste(cursor, cells)
    },
  }

  /**
   * Attached once, dispatching through a ref.
   *
   * The obvious version re-registers these on every render so the closures stay current —
   * and that leaves a window between the render commit and the effect running in which the
   * grid has no clipboard listeners at all. A copy landing in that window silently does
   * nothing, which is exactly the kind of intermittent failure nobody can reproduce.
   */
  useEffect(() => {
    const element = scroller.current
    if (!element) return

    const onCopy = (event: Event) => clipboard.current.copy(event as ClipboardEvent)
    const onPasteEvent = (event: Event) => clipboard.current.paste(event as ClipboardEvent)

    element.addEventListener('copy', onCopy)
    element.addEventListener('paste', onPasteEvent)
    return () => {
      element.removeEventListener('copy', onCopy)
      element.removeEventListener('paste', onPasteEvent)
    }
  }, [])

  return (
    <div
      class="afs-grid"
      data-testid="grid"
      ref={scroller}
      // Focusable so it can receive keys at all — the grid has never been reachable from the
      // keyboard before this.
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(event) => {
        const el = event.currentTarget as HTMLDivElement
        setScrollTop(el.scrollTop)
        onHorizontalScroll?.(el.scrollLeft, el.offsetWidth - el.clientWidth)
      }}
    >
      <div class="afs-grid__header" role="row">
        {columns.map((column, index) => {
          const direction = sortFor(column.key)
          return (
            <div
              key={column.key}
              class={
                frozenClass(index, 'afs-head') +
                (menuColumn === column.key ? ' afs-head--menu-open' : '') +
                (column.kind === 'data' && headerMatches(column.key, search)
                  ? ' afs-head--match'
                  : '') +
                (columnReorder.dragging === column.key ? ' afs-head--dragging' : '') +
                (columnReorder.edge(column.key) ? ` afs-head--drop-${columnReorder.edge(column.key)}` : '')
              }
              style={columnStyle(column, index)}
              role="columnheader"
              data-column={column.key}
              onContextMenu={(event) => {
                // The caret is the discoverable route; this is the one people reach for. Only
                // on data columns — the chrome columns have no menu to open.
                if (column.kind !== 'data') return
                event.preventDefault()
                setMenuColumn(column.key)
              }}
              title={
                column.descriptor
                  ? `${column.label} — ${column.descriptor.displayType ?? 'text'}`
                  : column.label
              }
              {...(column.kind === 'data' && column.key !== primaryField
                ? {
                    ...columnReorder.itemProps(column.key),
                    draggable: menuColumn !== column.key,
                  }
                : {})}
            >
              {column.kind === 'add' ? (
                <button
                  type="button"
                  class="afs-head__add"
                  data-testid="column-add-trailing"
                  title="Add a field"
                  aria-label="Add a field"
                  onClick={() => onAddColumn()}
                >
                  +
                </button>
              ) : column.kind === 'select' ? (
                <input
                  type="checkbox"
                  class="afs-checkbox"
                  data-testid="select-all"
                  checked={selected.size > 0 && selected.size === data.rowCount}
                  onClick={onToggleAll}
                />
              ) : (
                <>
                  {column.descriptor ? (
                    <span
                      class="afs-head__type-icon"
                      dangerouslySetInnerHTML={{ __html: fieldTypeIcon(column.descriptor.displayType, { size: 14 }) ?? '' }}
                    />
                  ) : null}
                  {column.descriptor?.computed ? (
                    <span
                      class="afs-head__computed-badge"
                      title="Computed field"
                      dangerouslySetInnerHTML={{ __html: menuIcon('braces', { size: 12 }) }}
                    />
                  ) : null}
                  <span class="afs-head__label">{column.label}</span>
                  {/* Only when there is one. An icon on every header would be forty pieces of
                      chrome saying nothing, and the point of the icon is that its presence is
                      the signal. */}
                  {column.descriptor?.description ? (
                    <span
                      class="afs-head__info"
                      data-testid={`description-${column.key}`}
                      title={column.descriptor.description}
                      dangerouslySetInnerHTML={{ __html: menuIcon('info', { size: 12 }) }}
                    />
                  ) : null}
                  {direction ? (
                    <span class="afs-head__sort" data-testid={`sort-${column.key}`}
                      dangerouslySetInnerHTML={{ __html: menuIcon(direction === 'asc' ? 'arrow_up' : 'arrow_down', { size: 12 }) }}
                    />
                  ) : null}
                  {column.kind === 'data' ? (
                    <button
                      type="button"
                      class="afs-head__menu"
                      data-testid={`menu-open-${column.key}`}
                      title={`Configure ${column.label}`}
                      // Opens on mousedown, not click, and stops there.
                      //
                      // The menu dismisses itself on any document mousedown outside it. The
                      // trigger is a *sibling* of the menu, not inside it, so a click here used
                      // to dismiss on mousedown and then re-open on click — the caret could
                      // open the menu but never close it, which reads as the control being
                      // dead. Stopping propagation keeps the dismiss handler out of it.
                      //
                      // preventDefault also stops the draggable header from starting a column
                      // drag from a press on the button, the same guard the resize and freeze
                      // handles use.
                      onMouseDown={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        setMenuColumn((prev) => (prev === column.key ? null : column.key))
                      }}
                    >
                      <span dangerouslySetInnerHTML={{ __html: menuIcon('chevron_down', { size: 14 }) }} />
                    </button>
                  ) : null}
                </>
              )}

              {menuColumn === column.key && column.descriptor ? (
                <ColumnHeaderMenu
                  column={column.descriptor}
                  sortDirection={direction}
                  canConfigure={canConfigure}
                  onSort={(next, additive) => {
                    onSort(column.key, next, additive)
                    setMenuColumn(null)
                  }}
                  onSetDescription={(description) => onSetDescription(column.key, description)}
                  onHarvestValues={() => onHarvestValues(column.key)}
                  isPrimary={column.key === primaryField}
                  onSetPrimary={() => onSetPrimary(column.key)}
                  onRename={() => onRenameColumn(column.key)}
                  onDuplicate={() => onDuplicateColumn(column.key)}
                  onDelete={() => onDeleteColumn(column.key)}
                  onInsert={(side) => onAddColumn({ column: column.key, side })}
                  onSetDisplayType={(type, options) => {
                    onSetDisplayType(column.key, type, options)
                    setMenuColumn(null)
                  }}
                  frozen={index < frozenCount}
                  onHide={() => {
                    onHideColumn(column.key)
                    setMenuColumn(null)
                  }}
                  onFreezeThrough={() => {
                    // "Freeze up to this column" means everything through it, so the count
                    // is its position among the data columns, one-based.
                    const position = index - chromeCount + 1
                    onFreezeCount(index < frozenCount ? 0 : position)
                    setMenuColumn(null)
                  }}
                  onClose={() => setMenuColumn(null)}
                  allDateColumns={allDateColumns}
                  onSetAllTimezones={onSetAllTimezones}
                  onSplitCommaValues={onSplitCommaValues}
                  onConfirmCommaSplit={onConfirmCommaSplit}
                />
              ) : null}

              {column.kind === 'data' ? (
                <span
                  class="afs-head__resize"
                  data-testid={`resize-${column.key}`}
                  title="Drag to resize, double-click to fit"
                  onPointerDown={(event) => startResize(event as PointerEvent, column)}
                  onDblClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    autoFit(column)
                  }}
                />
              ) : null}

            </div>
          )
        })}
      </div>

      {/* The spacer gives the scrollbar its true length without rendering a single row. */}
      <div class="afs-grid__canvas" style={{ height: `${view.length * ROW_HEIGHT}px` }}>
        <div
          class="afs-grid__window"
          data-testid="grid-window"
          style={{ transform: `translateY(${startIndex * ROW_HEIGHT}px)` }}
        >
          {indices.map((index) => {
            const item = view.at(index)
            if (item?.kind === 'header') {
              return (
                <GroupHeader
                  key={`g${index}`}
                  node={item.node}
                  collapsed={item.collapsed}
                  columns={layout}
                  allColumns={allColumns}
                  grouping={grouping}
                  summaryConfig={summaryConfig}
                  leadingWidth={chromeWidth(editable)}
                  onToggle={onToggleGroup}
                />
              )
            }

            const row = item ? data.getRow(item.rowIndex) : undefined
            const rowid = row?.rowid ?? null
            return (
              <div
                class={`afs-row${rowid !== null && selected.has(rowid) ? ' afs-row--selected' : ''}${
                  rowid !== null && rowid === activeRowid ? ' afs-row--active' : ''
                }${rowid !== null && data.changes.added.has(rowid) ? ' afs-row--added' : ''}`}
                key={index}
                role="row"
                data-row-index={index}
              >
                {columns.map((column, columnIndex) => {
                  const isEditing =
                    editing !== null && rowid === editing.rowid && column.key === editing.column
                  const externallyChanged =
                    rowid !== null && data.changes.cells.has(changeKey(rowid, column.key))
                  // The cursor addresses data columns; chrome columns cannot be landed on.
                  const dataIndex = columnIndex - chromeCount

                  return (
                  <GridCell
                    key={column.key}
                    rowNumber={(item?.rowIndex ?? index) + 1}
                    client={client}
                    links={links}
                    rowActions={rowActions}
                    runningAction={runningAction}
                    onRunAction={onRunAction}
                    column={column}
                    row={row}
                    editable={editable}
                    selected={rowid !== null && selected.has(rowid)}
                    editing={isEditing}
                    cursor={
                      cursor !== null && cursor.display === index && cursor.column === dataIndex
                    }
                    inSelection={dataIndex >= 0 && inRange(range, index, dataIndex)}
                    onFocusCell={() => {
                      if (dataIndex >= 0) {
                        setCursor({ display: index, column: dataIndex })
                        setAnchor(null)
                        // Selecting a cell has to leave the keyboard pointed at the grid, or
                        // the arrow keys go wherever focus happened to be. preventScroll
                        // because focusing a scroller otherwise yanks it back to the top.
                        scroller.current?.focus({ preventScroll: true })
                      }
                    }}
                    changed={externallyChanged}
                    // Somebody else wrote to the very cell being edited. The draft is safe —
                    // the editor holds its own state — but the user has to be told the ground
                    // moved, or they will overwrite a change they never saw.
                    conflicted={isEditing && externallyChanged}
                    className={frozenClass(columnIndex, 'afs-cell')}
                    style={columnStyle(column, columnIndex)}
                    onToggleRow={onToggleRow}
                    onExpandRow={onExpandRow}
                    onFocusRow={onFocusRow}
                    onNavigateLink={onNavigateLink}
                    onStartEdit={setEditing}
                    onCommit={commit}
                    onCancelEdit={() => setEditing(null)}
                  />
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      {frozenCount > 0 ? (
        <div
          class="afs-freeze-bar"
          data-testid="freeze-separator"
          title="Drag to move the frozen pane"
          style={{ left: `${freezeEdgeLeft}px` }}
          onPointerDown={startFreezeDrag}
        />
      ) : null}
    </div>
  )
}

interface GridCellProps {
  client: Client
  links: Links
  rowActions: ActionDefinition[]
  runningAction: number | null
  onRunAction: (action: ActionDefinition, row: Row) => void
  column: RenderColumn
  row: Row | undefined
  editable: boolean
  selected: boolean
  editing: boolean
  /** This is the keyboard cursor. */
  cursor: boolean
  /** Part of a shift-extended range, which is what copy takes. */
  inSelection: boolean
  onFocusCell: () => void
  /** An external write moved this value in the last couple of seconds. */
  changed: boolean
  /** ...and the user is mid-edit on it. */
  conflicted: boolean
  className: string
  style: Record<string, string>
  onToggleRow: (rowid: number) => void
  onExpandRow: (rowid: number) => void
  onFocusRow: (rowid: number) => void
  onNavigateLink: (column: string, value: SqlValue) => void
  onStartEdit: (cell: ActiveCell) => void
  onCommit: (rowid: number, column: string, value: SqlValue) => void
  onCancelEdit: () => void
  /** 1-based position of this row within the view. Display only — see the select cell. */
  rowNumber: number
}

function GridCell({
  client,
  links,
  rowActions,
  runningAction,
  onRunAction,
  column,
  row,
  editable,
  selected,
  editing,
  cursor,
  inSelection,
  onFocusCell,
  changed,
  conflicted,
  className,
  style,
  onToggleRow,
  onExpandRow,
  onFocusRow,
  onNavigateLink,
  onStartEdit,
  onCommit,
  onCancelEdit,
  rowNumber,
}: GridCellProps) {
  const rowid = row?.rowid ?? null

  if (column.kind === 'select') {
    return (
      <div class={`${className} afs-cell--select`} style={style} role="cell" data-column="__select">
        {/* A UI ordinal, never a field value.
            It counts positions in the view — so it renumbers when you sort, filter, or group,
            and it is emphatically not the rowid, which sits in its own column right next to it
            and does not move. Rendered for pending rows too, since the number is known from the
            index whether or not the chunk holding the row has arrived. */}
        <span class="afs-rownum" data-testid={`row-number-${rowNumber}`} aria-hidden="true">
          {rowNumber}
        </span>
        {rowid !== null ? (
          <>
            <input
              type="checkbox"
              class="afs-checkbox"
              data-testid={`select-row-${rowid}`}
              checked={selected}
              onClick={() => onToggleRow(rowid)}
            />
            {/* The discoverable way to open a record. Clicking a cell opens the panel too,
                but only for a row that is not already the one showing — otherwise closing
                the panel would be undone by the next click anywhere in that row. */}
            <button
              type="button"
              class="afs-expand"
              title="Open record"
              data-testid={`expand-row-${rowid}`}
              onClick={(event) => {
                event.stopPropagation()
                onExpandRow(rowid)
              }}
            >
              <span dangerouslySetInnerHTML={{ __html: menuIcon('expand', { size: 14 }) }} />
            </button>
          </>
        ) : null}
      </div>
    )
  }

  if (column.kind === 'actions') {
    return (
      <div class={`${className} afs-cell--actions`} style={style} role="cell" data-column="__actions">
        {row ? (
          <ActionButtons
            actions={rowActions}
            row={row}
            running={runningAction}
            inline
            onRun={onRunAction}
          />
        ) : null}
      </div>
    )
  }

  const descriptor = column.descriptor
  if (!descriptor) return null

  const value = row?.[column.key]
  const text = formatValue(value)
  const type = descriptor.displayType ?? 'text'

  /**
   * A selected cell whose text does not fit shows the whole thing in place.
   *
   * The grid truncates by design — uniform row height is what makes virtual scroll a single
   * division — so a long description reads as "Responsible for the…" and the only way to see it
   * was to open the panel or start editing. Selecting it now expands it over the rows below.
   *
   * It is scrollable, and it does not need `pointer-events: none` to stay out of the way: it is
   * a *child* of the cell, so a click on it bubbles to the cell's own handler and opens the
   * editor exactly as a click on the cell would. (An earlier version disabled pointer events to
   * "let the click through", which was solving a problem the DOM had already solved — and it
   * cost the ability to scroll.)
   */
  const overflows = text.includes('\n') || text.length > PEEK_MIN_LENGTH
  const peeking = cursor && !editing && overflows && type !== 'checkbox' && type !== 'toggle'

  /**
   * A popout on a right-hand column runs past the grid's edge and is clipped there, which is
   * worse than not expanding at all — it reads as the text simply stopping. So it flips to grow
   * leftward from the cell's right edge instead.
   *
   * Two things this has to get right. It is **state**, not a class poked onto the node: Preact
   * owns the `class` attribute and resets it on the next render, which silently undid a direct
   * `classList.add`. And the predicate measures the cell's left edge plus the popout's width
   * rather than the popout's current right edge — the latter becomes false the moment it flips,
   * so it would flip back, then forward, forever.
   */
  const popout = useRef<HTMLDivElement>(null)
  const [flip, setFlip] = useState(false)
  useLayoutEffect(() => {
    const el = popout.current
    if (!el) {
      if (flip) setFlip(false)
      return
    }
    const cell = el.parentElement
    const grid = el.closest('.afs-grid')
    if (!cell || !grid) return
    const wouldOverflow =
      cell.getBoundingClientRect().left + el.offsetWidth >
      grid.getBoundingClientRect().right
    if (wouldOverflow !== flip) setFlip(wouldOverflow)
  }, [peeking, text, flip])

  const classes = [className]
  if (type === 'number' || type === 'currency') classes.push('afs-cell--number')
  if (!row) classes.push('afs-cell--pending')
  else if (text === '' && type !== 'checkbox' && type !== 'toggle') classes.push('afs-cell--empty')
  if (editing) classes.push('afs-cell--editing')
  if (peeking) classes.push('afs-cell--peek')
  if (cursor) classes.push('afs-cell--cursor')
  if (inSelection) classes.push('afs-cell--range')
  if (descriptor.virtual) classes.push('afs-cell--system')
  if (changed) classes.push('afs-cell--changed')
  if (conflicted) classes.push('afs-cell--conflict')

  // Created and Modified come from the changelog; there is no column behind them to write to.
  const canEdit = editable && rowid !== null && !descriptor.virtual && !descriptor.computed
  const target = links.target(column.key)

  return (
    <div
      class={classes.join(' ')}
      style={style}
      role="cell"
      data-column={column.key}
      title={!editing && text.length > 24 ? text : undefined}
      // Select first, edit second — the spreadsheet convention.
      //
      // This reverses the original single-click-to-edit reading of the requirements, because
      // opening an editor on every click made the grid impossible to navigate: the editor's
      // input takes focus, so the arrow keys moved a text caret inside one cell instead of
      // moving between cells. Selecting first means a click leaves focus on the grid, which is
      // what makes the keyboard work at all.
      //
      // Checkboxes, toggles, chips, and links stop propagation themselves, so clicking those
      // still acts on the control rather than the cell.
      onClick={() => {
        if (cursor && canEdit && !editing) {
          onStartEdit({ rowid, column: column.key })
          return
        }
        onFocusCell()
        if (rowid !== null) onFocusRow(rowid)
      }}
    >
      {peeking ? (
        <div
          class={`afs-cell__popout${flip ? ' afs-cell__popout--flip' : ''}`}
          data-testid="cell-popout"
          ref={popout}
        >
          {text}
        </div>
      ) : null}
      {conflicted ? (
        <span
          class="afs-conflict"
          data-testid="cell-conflict"
          title={`Changed elsewhere while you were editing — now ${text || '(blank)'}. Your edit will overwrite it.`}
        >
          <span dangerouslySetInnerHTML={{ __html: menuIcon('alert_triangle', { size: 14 }) }} />
        </span>
      ) : null}
      {editing && rowid !== null && target ? (
        <LinkedRecordEditor
          client={client}
          target={target}
          value={value}
          label={links.label(column.key, value ?? null)}
          onCommit={(next) => onCommit(rowid, column.key, next)}
          onCancel={onCancelEdit}
        />
      ) : editing && rowid !== null ? (
        <CellEditor
          column={descriptor}
          value={value}
          onCommit={(next) => onCommit(rowid, column.key, next)}
          onCancel={onCancelEdit}
        />
      ) : row && target ? (
        <LinkedRecordChip
          value={value}
          label={links.label(column.key, value ?? null)}
          onNavigate={() => onNavigateLink(column.key, value ?? null)}
        />
      ) : row ? (
        <CellValue
          column={descriptor}
          value={value}
          readOnly={!canEdit}
          onToggle={(next) => {
            if (canEdit) onCommit(rowid, column.key, next)
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * Format a group value according to its column's display type.
 */
interface GroupLabel { text: string; html?: string }

function formatGroupValue(value: SqlValue | undefined, descriptor?: ColumnDescriptor): GroupLabel {
  if (value === null || value === undefined) return { text: '' }
  const type = descriptor?.displayType
  if (type === 'checkbox' || type === 'toggle') {
    const checked = isTruthy(value)
    return {
      text: checked ? 'Checked' : 'Unchecked',
      html: menuIcon(checked ? 'checkbox' : 'square', { size: 14 }),
    }
  }
  if (type === 'currency') return { text: formatCurrency(value, (descriptor?.options?.showCents as boolean) ?? true) ?? formatValue(value) }
  if (type === 'percent') {
    const n = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(n)) {
      const decimals = (descriptor?.options?.decimals as number) ?? 2
      return { text: `${(n * 100).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}%` }
    }
  }
  if (type === 'date') {
    const text = formatValue(value)
    const ts = typeof value === 'number' ? value : Date.parse(text)
    if (Number.isFinite(ts)) {
      const d = new Date(ts)
      const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }
      const tz = (descriptor?.options?.timezone as string) || undefined
      if (tz) opts.timeZone = tz
      return { text: d.toLocaleDateString(undefined, opts) }
    }
  }
  return { text: formatValue(value) }
}

/**
 * A group header. Exactly one row tall, because the scroll arithmetic upstream divides by a
 * single row height — a taller header would need a measured-offset table, which is the thing
 * virtual scroll exists to avoid.
 *
 * It sticks to the left edge rather than scrolling with the columns: the label is what tells
 * you which group you are inside, and losing it when you scroll right defeats the point.
 */
const SUMMARY_LABELS: Record<string, string> = {
  sum: 'Sum', average: 'Avg', count: 'Count', min: 'Min', max: 'Max',
  count_empty: 'Empty', count_not_empty: 'Filled', percent_empty: '% empty',
}

const MONETARY_FNS = new Set<SummaryFunction>(['sum', 'average', 'min', 'max'])

function formatSummaryValue(value: SqlValue | undefined, type?: DisplayType, fn?: SummaryFunction, options?: Record<string, unknown> | null): string {
  if (value === null || value === undefined) return '—'
  if (type === 'currency' && fn && MONETARY_FNS.has(fn)) {
    const showCents = (options?.showCents as boolean) ?? true
    const money = formatCurrency(value, showCents)
    if (money !== null) return money
  }
  if (type === 'percent' && fn && MONETARY_FNS.has(fn)) {
    const n = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(n)) return `${(n * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
  }
  if (typeof value === 'number' && !Number.isInteger(value)) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  }
  if (typeof value === 'number') return value.toLocaleString()
  return formatValue(value)
}

function GroupHeader({
  node,
  collapsed,
  columns,
  allColumns,
  grouping,
  summaryConfig,
  leadingWidth,
  onToggle,
}: {
  node: GroupNode
  collapsed: boolean
  columns: LaidOutColumn[]
  allColumns: ColumnDescriptor[]
  grouping: string[]
  summaryConfig: Record<string, SummaryFunction>
  leadingWidth: number
  onToggle: (values: SqlValue[]) => void
}) {
  const groupColumn = grouping[node.depth]
  const descriptor = allColumns.find((c) => c.name === groupColumn)
  const value = node.values[node.values.length - 1]
  const label = formatGroupValue(value, descriptor)

  let colOffset = leadingWidth
  const cellPositions: Array<{ name: string; left: number; width: number; displayType?: DisplayType; options?: Record<string, unknown> | null }> = []
  for (const { descriptor: colDesc, width } of columns) {
    const fn = summaryConfig[colDesc.name] as SummaryFunction | undefined
    const val = node.summary?.[colDesc.name]
    if (fn && val !== null && val !== undefined) {
      cellPositions.push({ name: colDesc.name, left: colOffset, width, displayType: colDesc.displayType, options: colDesc.options })
    }
    colOffset += width
  }

  return (
    <div
      class={`afs-row afs-group${collapsed ? ' afs-group--collapsed' : ''}`}
      role="row"
      data-testid="group-header"
      data-group-depth={node.depth}
      data-group-value={label.text}
    >
      <button
        type="button"
        class="afs-group__toggle"
        style={{ paddingLeft: `${8 + node.depth * 16}px` }}
        aria-expanded={!collapsed}
        data-testid={`group-toggle-${label.text}`}
        onClick={() => onToggle(node.values)}
      >
        <span class="afs-group__chevron" dangerouslySetInnerHTML={{ __html: menuIcon(collapsed ? 'chevron_right' : 'chevron_down', { size: 14 }) }} />
        {groupColumn ? <span class="afs-group__column">{groupColumn}</span> : null}
        {label.html ? (
          <span class="afs-group__value" dangerouslySetInnerHTML={{ __html: label.html }} />
        ) : (
          <span class="afs-group__value">{label.text === '' ? '(empty)' : label.text}</span>
        )}
        <span class="afs-group__count" data-testid="group-count">
          {node.count}
        </span>
      </button>
      {cellPositions.map((cell) => {
        const fn = summaryConfig[cell.name]!
        const val = node.summary![cell.name]
        return (
          <span
            key={cell.name}
            class="afs-group__cell"
            style={{ position: 'absolute', left: `${cell.left}px`, width: `${cell.width}px` }}
            data-testid={`group-summary-${cell.name}`}
          >
            <span class="afs-group__summary-label">{SUMMARY_LABELS[fn] ?? fn}</span>
            {' '}
            {formatSummaryValue(val, cell.displayType, fn, cell.options)}
          </span>
        )
      })}
    </div>
  )
}
