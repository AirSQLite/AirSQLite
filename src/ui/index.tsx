import type * as preact from 'preact'
import { render } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type {
  ActionDefinition,
  DisplayType,
  FilterNode,
  RecordLocator,
  Row,
  SortSpec,
  SqlValue,
  SummaryFunction,
} from '../shared/protocol.js'
import { MODIFIED_COLUMN } from '../shared/protocol.js'
import { ConfirmModal } from './components/ConfirmModal.js'
import { NewFieldDialog } from './components/NewFieldDialog.js'
import { DEFAULT_PANEL_WIDTH, DetailPanel } from './components/DetailPanel.js'
import { FilterBuilder } from './components/FilterBuilder.js'
import { Grid, chromeWidth, trailingWidth } from './components/Grid.js'
import { SearchBar } from './components/SearchBar.js'
import { SortMenu } from './components/SortMenu.js'
import { SelectionBar } from './components/SelectionBar.js'
import { SummaryBar } from './components/SummaryBar.js'
import { TableTabs } from './components/TableTabs.js'
import { ToastHost, useToasts } from './components/Toast.js'
import { ViewSwitcher, ViewsPanel } from './components/ViewSwitcher.js'
import { Client } from './state/client.js'
import { flatView, groupedView, layoutGroups, useGrouping } from './state/grouping.js'
import type { CellCursor } from './state/selection.js'
import { useHistory, type Step } from './state/history.js'
import { useLinks } from './state/links.js'
import {
  useActions,
  useRecord,
  useRelated,
  useTableColumns,
  useSummary,
  useTableData,
  useWorkspace,
  type ChangeSummary,
} from './state/store.js'
import { createTransport } from './state/transport.js'
import { createHostServices, type HostServices } from './state/host.js'
import { layOutColumns, useViews, type LaidOutColumn } from './state/views.js'
import { exportViewToCsv } from './state/csv.js'
import { useDismissOnOutside } from './state/dismiss.js'
import './styles/theme.css'
import './styles/grid.css'
import './styles/panel.css'

// The app shell. It knows nothing about VS Code, WebSockets, or SQLite — only that a Client
// answers questions. That is what lets this same bundle run in a webview, a browser tab, and
// headless Chromium under Playwright.

interface PendingConfirm {
  title: string
  detail?: string
  /** Verbatim evidence — the exact command or request an action would make. */
  preview?: string
  confirmLabel: string
  danger?: boolean
  run: () => void
  /**
   * A second affirmative answer, for questions with two valid ones — duplicating a column with
   * or without its values. Not a cancel; Cancel is always there and always does nothing.
   */
  secondaryLabel?: string
  onSecondary?: () => void
}

function pinPrimary(columns: LaidOutColumn[], primaryField: string): LaidOutColumn[] {
  if (!primaryField) return columns
  const index = columns.findIndex((c) => c.descriptor.name === primaryField)
  if (index <= 0) return columns
  const pinned = columns[index]
  if (!pinned) return columns
  return [pinned, ...columns.slice(0, index), ...columns.slice(index + 1)]
}

function App({ client, host }: { client: Client; host: HostServices }) {
  const workspace = useWorkspace(client)
  const toasts = useToasts()

  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const [canConfigure, setCanConfigure] = useState(true)
  const [primaryField, setPrimaryField] = useState('')
  /** Which action is mid-flight, so a slow webhook cannot be fired twice by an impatient click. */
  const [runningAction, setRunningAction] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  /** The views panel beside the grid. Owned here because the panel is a sibling of the grid. */
  const [showViews, setShowViews] = useState(false)
  /** Non-null while the new-field dialog is up; the value is where it will sit in the view. */
  const [newField, setNewField] = useState<{ beside?: { column: string; side: 'left' | 'right' } } | null>(null)

  /**
   * Which record the detail panel is showing. Carrying the *table* alongside the rowid is
   * what makes a table switch close the panel on its own — a rowid means nothing without
   * knowing which table it indexes — and lets a chip point somewhere else atomically.
   */
  const [openRecord, setOpenRecord] = useState<{ table: string; rowid: number } | null>(null)
  /**
   * The row whose panel was explicitly closed. Without this, closing the panel is undone by
   * the very next click anywhere in that row, since a cell click opens the record.
   */
  const dismissed = useRef<number | null>(null)

  const views = useViews(client, workspace.activeTable, canConfigure)
  const sort = useMemo(() => views.config.sort ?? [], [views.config.sort])

  // Columns are fetched per table, not per query, so deriving the search scope from them
  // cannot feed back into the query that produced them.
  const schema = useTableColumns(client, workspace.activeTable)
  const layout = useMemo(
    // The primary field is pinned leftmost, whatever the view's column order says. It is the
    // label a linked-record chip shows, so it is the column that identifies a row — and a row
    // identifier you have to scroll sideways to read is not identifying anything.
    () => pinPrimary(layOutColumns(schema.columns, views.config), primaryField),
    [schema.columns, views.config, primaryField],
  )
  const columnsKey = layout.map((c) => c.descriptor.name).join('\u0000')

  // Search spans what the user can see; a hidden column matching produces a result set the
  // grid cannot explain — rows match, but nothing on screen says why.
  const searchColumns = useMemo(
    () => (columnsKey === '' ? [] : columnsKey.split('\u0000')),
    [columnsKey],
  )

  /**
   * What an external write did, reported as a sentence. This is the payoff of the whole
   * phase: the user is watching an agent work, and this is how they find out it did
   * something without having to notice a cell change on their own.
   */
  const announceChange = useCallback(
    (summary: ChangeSummary) => {
      const parts: string[] = []
      if (summary.updated > 0) parts.push(`${summary.updated} updated`)
      if (summary.added > 0) parts.push(`${summary.added} added`)
      if (summary.deleted > 0) parts.push(`${summary.deleted} deleted`)
      if (parts.length === 0) return
      const total = summary.updated + summary.added + summary.deleted
      toasts.info(`${total === 1 ? 'Record' : 'Records'} changed elsewhere — ${parts.join(', ')}.`)
    },
    [toasts],
  )

  // Grouping columns sort ahead of the user's sort, so a group's rows are contiguous at a
  // fixed offset. Everything in state/grouping.ts depends on that.
  const groupColumns = useMemo(() => views.config.grouping ?? [], [views.config.grouping])
  /**
   * Which total sits under each column. One source now: the active view.
   *
   * There used to be two — a value stored per column in `_airsqlite_columns` with the session's
   * choices layered over it — and the layering existed because a table might have had no view
   * to keep the choice in. That is no longer possible, so the merge is gone and an explicit null
   * simply means "no total" rather than having to out-rank a stored value showing through.
   */
  const summaryConfig = useMemo(() => {
    const explicit = views.config.summary ?? {}
    const merged: Record<string, SummaryFunction> = {}
    for (const { descriptor } of layout) {
      if (descriptor.virtual) continue
      const dt = descriptor.displayType
      if (dt === 'number' || dt === 'currency') {
        merged[descriptor.name] = 'sum'
      }
    }
    for (const [column, fn] of Object.entries(explicit)) {
      if (fn) merged[column] = fn
      else delete merged[column]
    }
    return merged
  }, [views.config.summary, layout])

  const querySpec = useMemo(
    () => ({
      sort,
      filter: views.config.filter ?? null,
      search,
      ...(searchColumns.length > 0 ? { searchColumns } : {}),
      ...(groupColumns.length > 0 ? { groupBy: groupColumns } : {}),
    }),
    [sort, views.config.filter, search, searchColumns, groupColumns],
  )

  const data = useTableData(client, workspace.activeTable, querySpec, announceChange)
  const summaryValues = useSummary(client, workspace.activeTable, summaryConfig, querySpec)
  const grouping = useGrouping(client, workspace.activeTable, groupColumns, querySpec)

  /**
   * What the grid actually paints. Ungrouped, a display slot is a row and the numbers are the
   * same; grouped, headers take slots of their own and the mapping goes through the segment
   * table. The grid does not know which it has.
   */
  const view = useMemo(() => {
    if (groupColumns.length === 0 || grouping.tree.length === 0) return flatView(data)
    const { segments, length } = layoutGroups(grouping.tree, grouping.collapsed)
    return groupedView(data, segments, length, grouping.collapsed)
  }, [data, groupColumns.length, grouping.tree, grouping.collapsed])

  const activeTable = useMemo(
    () => workspace.tables.find((t) => t.name === workspace.activeTable) ?? null,
    [workspace.tables, workspace.activeTable],
  )
  const editable = !!activeTable && !activeTable.withoutRowid

  // Selection, search, and the filter panel are per-table: carrying a selection across a tab
  // switch would apply a bulk edit to rows the user never saw.
  //
  // Guarded against the *initial* table arriving, which is not a switch. Without the guard,
  // typing into search during the first load wipes what was typed — the reset fires when
  // activeTable goes null -> "customers", which happens after the input is already on screen.
  const previousTable = useRef<string | null>(null)
  useEffect(() => {
    const changed = previousTable.current !== null && previousTable.current !== workspace.activeTable
    previousTable.current = workspace.activeTable
    if (!changed) return

    setSelected(new Set())
    setSearch('')
    setShowFilters(false)
  }, [workspace.activeTable])

  // Foreign keys: which columns are links, where they point, and what each value is called.
  // Drives the filter builder's linked-record operators, the chips, and their editors.
  const links = useLinks(client, workspace.activeTable)
  const actions = useActions(client, workspace.activeTable)

  useEffect(() => {
    if (!workspace.activeTable) return
    let cancelled = false
    void client
      .meta(workspace.activeTable)
      .then((meta) => {
        if (cancelled) return
        setCanConfigure(meta.writable)
        setPrimaryField(meta.primaryField)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [client, workspace.activeTable])

  const table = workspace.activeTable
  const gridActions = useMemo(
    () => actions.filter((action) => action.showInGrid),
    [actions],
  )

  const panelTable = openRecord?.table ?? null
  const panelRowid = openRecord?.rowid ?? null
  const panelIsSameTable = panelTable === table
  const cachedRow = useMemo(
    () => (panelRowid === null || !panelIsSameTable ? undefined : findRow(data, panelRowid)),
    [data, panelRowid, panelIsSameTable],
  )
  const panelColumns = useTableColumns(client, panelIsSameTable ? null : panelTable)
  const [crossPrimaryField, setCrossPrimaryField] = useState('')
  useEffect(() => {
    if (panelIsSameTable || !panelTable) { setCrossPrimaryField(''); return }
    void client.meta(panelTable).then((m) => setCrossPrimaryField(m.primaryField)).catch(() => {})
  }, [client, panelTable, panelIsSameTable])
  const record = useRecord(client, panelTable, panelRowid, cachedRow)
  const related = useRelated(client, panelTable, panelRowid)

  /**
   * Undo/redo. The stack holds inverses captured when each mutation is issued; applying one
   * goes back through the same client calls, so an undone write is a write like any other —
   * it lands in the changelog, moves Modified, and shows up to anyone else watching the file.
   */
  const historyOps = useMemo(
    () => ({
      update: (t: string, rowid: number, field: string, value: SqlValue) =>
        client.update(t, rowid, field, value),
      bulkUpdate: (t: string, rowids: number[], field: string, value: SqlValue) =>
        client.bulkUpdate(t, rowids, field, value),
      insert: (t: string, values: Record<string, SqlValue>, rowid?: number) =>
        client.insert(t, values, rowid),
      remove: (t: string, rowids: number[]) => client.delete(t, rowids),
    }),
    [client],
  )
  const history = useHistory(historyOps)

  const runHistory = useCallback(
    (direction: 'undo' | 'redo') => {
      void (direction === 'undo' ? history.undo() : history.redo())
        .then((step) => {
          if (!step) return
          data.refresh()
          toasts.info(direction === 'undo' ? 'Undone.' : 'Redone.')
        })
        .catch((err: Error) => {
          // The step no longer applies — the row is gone, or a value it would restore now
          // collides with something written since. It has already been dropped from the
          // stack, which keeps the stack honest about what it can still do.
          data.refresh()
          toasts.error(`Could not ${direction} that — ${err.message}`)
        })
    },
    [history, data, toasts],
  )

  /**
   * Optimistic: the cached row updates immediately and rolls back if SQLite rejects it. The
   * toast carries the backend's message verbatim, which already names the column and echoes
   * the value that was typed.
   *
   * One handler serves both the grid and the detail panel. That is the whole of "two-way
   * binding": when the panel's record is in the grid's cache they are literally the same
   * object, and `record.patch` covers the case where it is not — a record reached by a chip
   * or excluded by the current filter.
   */
  const handleEdit = useCallback(
    (rowid: number, field: string, value: SqlValue) => {
      if (!table) return
      const previous = findValue(data, rowid, field) ?? record.row?.[field]
      if (previous === value) return

      // Recorded now rather than on success, for the same reason the patch is applied now:
      // the user may act again before the round trip finishes, and Cmd+Z has to see this.
      const step: Step = { kind: 'edit', table, rowid, field, before: previous ?? '', after: value }
      history.record(step)

      data.patchRow(rowid, field, value)
      record.patch(field, value)
      void client
        .update(table, rowid, field, value)
        .then((result) => {
          // Move the Modified column to the timestamp the changelog actually recorded. The
          // write result carries it, so the alternative would be re-reading the row purely
          // to learn a value the backend already knew.
          if (!result.ts) return
          data.patchRow(rowid, MODIFIED_COLUMN, result.ts)
          record.patch(MODIFIED_COLUMN, result.ts)
        })
        .catch((err: Error) => {
          history.drop(step)
          data.patchRow(rowid, field, previous ?? '')
          record.patch(field, previous ?? '')
          toasts.error(err.message)
        })
    },
    [client, table, data, record, history, toasts],
  )

  /** A cell click focuses its row; the panel follows unless this row was just closed. */
  const focusRow = useCallback(
    (rowid: number) => {
      if (!table || dismissed.current === rowid) return
      setOpenRecord((prev) =>
        prev && prev.table === table && prev.rowid === rowid ? prev : { table, rowid },
      )
    },
    [table],
  )

  /** The expand control is unconditional — it is the user asking for the panel by name. */
  const expandRow = useCallback(
    (rowid: number) => {
      if (!table) return
      dismissed.current = null
      setOpenRecord({ table, rowid })
    },
    [table],
  )

  /**
   * The panel's width, held here rather than in the panel.
   *
   * DetailPanel unmounts constantly — closing it, switching rows, switching tables — so state
   * owned there resets on all of those. Session-scoped and never persisted, so a fresh webview
   * still opens at 360px.
   */
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH)
  /** Mirrors the grid's horizontal scroll so the summary bar stays under its columns. */
  const [gridScrollLeft, setGridScrollLeft] = useState(0)
  const [gridScrollbarWidth, setGridScrollbarWidth] = useState(0)

  /**
   * Persist a new tab order, and show it immediately rather than after the round trip. A tab
   * that springs back to where it was while the write is in flight looks like the drag failed.
   */
  const reorderTables = useCallback(
    (names: string[]) => {
      workspace.setTableOrder(names)
      void client.setTableOrder(names).catch((err: Error) => {
        toasts.error(err.message)
        void workspace.reloadTables()
      })
    },
    [client, workspace, toasts],
  )

  const closePanel = useCallback(() => {
    dismissed.current = panelRowid
    setOpenRecord(null)
  }, [panelRowid])

  /**
   * Cmd/Ctrl+F focuses the table search; pressing it again moves to the record search when the
   * detail panel is showing one, and a third press comes back.
   *
   * Two surfaces answer "find", and which one you mean depends on what you are looking at — so
   * the key cycles rather than picking for you. `preventDefault` is what stops the host's own
   * find bar opening over the top, which in a webview searches the rendered DOM: the visible
   * window of a virtualised grid, not the table.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return
      event.preventDefault()

      const tableSearch = document.querySelector<HTMLInputElement>('[data-testid="search-input"]')
      const recordSearch = document.querySelector<HTMLInputElement>(
        '[data-testid="record-search-input"]',
      )
      // Absent whenever the panel is closed, showing History, or showing no record.
      const next =
        document.activeElement === tableSearch && recordSearch ? recordSearch : tableSearch
      next?.focus()
      next?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * Escape closes the panel from anywhere, not only when focus is inside it.
   *
   * The panel's own handler only fires when the panel holds focus, which it usually does not —
   * you click a cell, the panel opens beside the grid, and focus stays on the grid. So Escape
   * did nothing, which is the one key everybody presses to dismiss a panel.
   *
   * Three things get first refusal, and each already handles Escape for itself:
   *   - an open editor, which stops propagation, so this listener never sees the event
   *   - a confirmation modal, guarded on explicitly below
   *   - anything focused that takes text, where Escape means "clear this field"
   */
  useEffect(() => {
    if (!openRecord) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || confirm) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, .afs-menu')) return
      closePanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openRecord, confirm, closePanel])

  /**
   * Follow a link to the record it names. A chip knows a key value, a reverse-lookup row
   * knows a rowid, and either can point at a different table — in which case the grid moves
   * there too, so the panel is always showing a record from the table on screen.
   */
  const navigate = useCallback(
    (targetTable: string, locator: RecordLocator) => {
      dismissed.current = null

      if ('rowid' in locator) {
        setOpenRecord({ table: targetTable, rowid: locator.rowid })
        return
      }
      if (locator.keyValue === null || locator.keyValue === '') return

      void client
        .record(targetTable, locator)
        .then((row) => {
          if (!row || row.rowid === null) {
            toasts.error(`That linked record is no longer in "${targetTable}".`)
            return
          }
          setOpenRecord({ table: targetTable, rowid: row.rowid })
        })
        .catch((err: Error) => toasts.error(err.message))
    },
    [client, workspace, toasts],
  )

  const navigateFromCell = useCallback(
    (column: string, value: SqlValue) => {
      const target = links.target(column)
      if (!target) return
      navigate(target.table, { keyColumn: target.keyColumn, keyValue: value })
    },
    [links, navigate],
  )

  const handleAddRow = useCallback(() => {
    if (!table) return
    void client
      .insert(table)
      .then((result) => {
        if (typeof result.rowid === 'number') {
          history.record({ kind: 'insert', table, rowids: [result.rowid] })
        }
        data.refresh()
      })
      .catch((err: Error) => toasts.error(err.message))
  }, [client, table, data, history, toasts])

  const handleDeleteSelected = useCallback(() => {
    if (!table || selected.size === 0) return
    const rowids = [...selected]

    // Captured before the delete, while the rows still exist. Selection only ever contains
    // rows the grid has fetched, so the cache has all of them.
    const removed = rowids
      .map((rowid) => findRow(data, rowid))
      .filter((row): row is Row => row !== undefined)

    setConfirm({
      title: `Delete ${rowids.length} ${rowids.length === 1 ? 'record' : 'records'}?`,
      detail: 'Undo with Cmd/Ctrl+Z.',
      confirmLabel: 'Delete',
      danger: true,
      run: () => {
        const step: Step | null =
          removed.length > 0 ? { kind: 'delete', table, rows: removed } : null
        if (step) history.record(step)

        void client
          .delete(table, rowids)
          .then((result) => {
            setSelected(new Set())
            data.refresh()
            toasts.info(`Deleted ${result.changes} ${result.changes === 1 ? 'record' : 'records'}.`)
          })
          .catch((err: Error) => {
            if (step) history.drop(step)
            toasts.error(err.message)
          })
      },
    })
  }, [client, table, selected, data, history, toasts])

  const handleBulkEdit = useCallback(
    (field: string, value: SqlValue) => {
      if (!table || selected.size === 0) return
      const rowids = [...selected]

      // One previous value per row: a bulk edit is one gesture, not one value, and undoing
      // it by writing a single "old value" back would flatten rows that never matched.
      const before: Array<[number, SqlValue]> = rowids.map((rowid) => [
        rowid,
        findValue(data, rowid, field) ?? '',
      ])

      setConfirm({
        title: `Set ${field} on ${rowids.length} ${rowids.length === 1 ? 'record' : 'records'}?`,
        detail: `Every selected record will have its ${field} replaced.`,
        confirmLabel: 'Apply',
        run: () => {
          const step: Step = { kind: 'bulk-edit', table, field, before, after: value }
          history.record(step)

          void client
            .bulkUpdate(table, rowids, field, value)
            .then((result) => {
              for (const rowid of rowids) {
                data.patchRow(rowid, field, value)
                if (result.ts) data.patchRow(rowid, MODIFIED_COLUMN, result.ts)
              }
              toasts.info(`Updated ${result.changes} ${result.changes === 1 ? 'record' : 'records'}.`)
            })
            // A bulk write is one transaction, so a failure means nothing changed — the
            // cached rows are still correct and need no rollback, but the step it would have
            // undone has to come back off the stack.
            .catch((err: Error) => {
              history.drop(step)
              toasts.error(err.message)
            })
        },
      })
    },
    [client, table, selected, data, history, toasts],
  )

  /**
   * Paste a TSV block starting at the cursor.
   *
   * Cells landing on existing rows overwrite them; cells past the last row create records.
   * Both are confirmed together and counted honestly, because a paste that quietly invents
   * twelve records in someone's database is not something to discover later.
   *
   * Written row by row rather than cell by cell for the new records: one INSERT carrying the
   * pasted values beats an INSERT plus N UPDATEs, and it gives undo a single step to reverse.
   */
  const handlePaste = useCallback(
    (cursor: CellCursor, cells: string[][]) => {
      if (!table || !editable || cells.length === 0) return

      const targets = layout.slice(cursor.column).map((c) => c.descriptor)
      const writable = targets.filter((descriptor) => !descriptor.virtual)
      if (writable.length === 0) return

      // Walk the display slots from the cursor down, collecting the rows the paste lands on.
      const overwrite: Array<{ rowid: number; values: Array<[string, string]> }> = []
      const created: Array<Record<string, SqlValue>> = []

      let display = cursor.display
      for (const line of cells) {
        const values: Array<[string, string]> = []
        line.forEach((text, offset) => {
          const descriptor = targets[offset]
          if (!descriptor || descriptor.virtual) return
          values.push([descriptor.name, text])
        })
        if (values.length === 0) continue

        // Skip group headers: they occupy display slots but are not records.
        while (display < view.length && view.at(display)?.kind !== 'row') display++

        const item = display < view.length ? view.at(display) : undefined
        const row = item?.kind === 'row' ? data.getRow(item.rowIndex) : undefined
        if (row && row.rowid !== null) {
          overwrite.push({ rowid: row.rowid, values })
        } else {
          created.push(Object.fromEntries(values))
        }
        display++
      }

      const cellCount = overwrite.reduce((n, target) => n + target.values.length, 0)
      if (cellCount === 0 && created.length === 0) return

      const parts: string[] = []
      if (cellCount > 0) parts.push(`overwrite ${cellCount} ${cellCount === 1 ? 'cell' : 'cells'}`)
      if (created.length > 0) {
        parts.push(`add ${created.length} ${created.length === 1 ? 'record' : 'records'}`)
      }

      const run = () => {
        void (async () => {
          try {
            for (const target of overwrite) {
              for (const [field, text] of target.values) {
                await client.update(table, target.rowid, field, text)
              }
            }
            const added: number[] = []
            for (const values of created) {
              const result = await client.insert(table, values)
              if (typeof result.rowid === 'number') added.push(result.rowid)
            }

            // One step for the whole paste on the created side; the overwrites are recorded
            // individually because that is what can be inverted per cell.
            for (const target of overwrite) {
              for (const [field, text] of target.values) {
                history.record({
                  kind: 'edit',
                  table,
                  rowid: target.rowid,
                  field,
                  before: findValue(data, target.rowid, field) ?? '',
                  after: text,
                })
              }
            }
            if (added.length > 0) history.record({ kind: 'insert', table, rowids: added })

            data.refresh()
            toasts.info(`Pasted — ${parts.join(', ')}.`)
          } catch (err) {
            data.refresh()
            toasts.error((err as Error).message)
          }
        })()
      }

      // A single cell is a single cell; anything wider gets confirmed, per the requirements.
      if (cellCount <= 1 && created.length === 0) return run()

      setConfirm({
        title: `Paste will ${parts.join(' and ')}?`,
        confirmLabel: 'Paste',
        ...(created.length > 0 ? { danger: true } : {}),
        run,
      })
    },
    [client, table, editable, layout, view, data, history, toasts],
  )

  /**
   * Run an action against a row.
   *
   * Scripts and webhooks come back asking rather than doing, carrying the exact command or
   * request they would make; that string goes straight into the confirmation, so what the
   * user authorises is what runs. Everything else happens on the first call.
   */
  const runAction = useCallback(
    (action: ActionDefinition, row: Row) => {
      setRunningAction(action.id)

      const finish = (message: string) => {
        setRunningAction(null)
        toasts.info(message)
      }
      const fail = (err: Error) => {
        setRunningAction(null)
        toasts.error(err.message)
      }

      void client
        .runAction(action.id, row, false)
        .then((result) => {
          if (result.status === 'done') return finish(result.message)

          setRunningAction(null)
          setConfirm({
            title: `Run “${action.label}”?`,
            detail:
              action.type === 'script'
                ? 'This will run a shell command on your machine, as configured in this database file.'
                : 'This will send data to another server, as configured in this database file.',
            preview: result.preview,
            confirmLabel: 'Run',
            danger: true,
            run: () => {
              setRunningAction(action.id)
              void client
                .runAction(action.id, row, true)
                .then((done) =>
                  finish(done.status === 'done' ? done.message : 'Nothing happened.'),
                )
                .catch(fail)
            },
          })
        })
        .catch(fail)
    },
    [client, toasts],
  )

  const handleSort = useCallback(
    (column: string, direction: 'asc' | 'desc' | null, additive: boolean) => {
      const current = views.config.sort ?? []
      const without = current.filter((s) => s.column !== column)
      const next: SortSpec[] = direction
        ? additive
          ? [...without, { column, direction }]
          : [{ column, direction }]
        : without
      views.update({ sort: next })
    },
    [views],
  )

  const handleHideColumn = useCallback(
    (column: string) => {
      views.update({
        columnVisibility: { ...(views.config.columnVisibility ?? {}), [column]: false },
      })
    },
    [views],
  )

  const handleShowColumn = useCallback(
    (column: string, visible: boolean) => {
      views.update({
        columnVisibility: { ...(views.config.columnVisibility ?? {}), [column]: visible },
      })
    },
    [views],
  )

  /**
   * Resize now, persist shortly after.
   *
   * Both halves used to live here — the working config for instant feedback, and a debounced
   * write to `_airsqlite_columns` so the width survived without a view. The second half is gone:
   * `useViews` writes the active view itself, coalesced, so updating the config *is* persisting.
   */
  const handleResizeColumn = useCallback(
    (column: string, width: number) => {
      views.update({ columnWidths: { ...(views.config.columnWidths ?? {}), [column]: width } })
    },
    [views],
  )

  const handleReorderColumns = useCallback(
    (order: string[]) => views.update({ columnOrder: order }),
    [views],
  )

  const handleGroupBy = useCallback(
    (column: string, grouped: boolean) => {
      const current = views.config.grouping ?? []
      // Order matters — it is the nesting order, so a newly checked column goes innermost.
      const next = grouped ? [...current.filter((c) => c !== column), column] : current.filter((c) => c !== column)
      views.update({ grouping: next })
    },
    [views],
  )

  /**
   * Export the active view. The first thing in this app that asks the host for something
   * rather than asking the database — see state/host.ts.
   *
   * The spec handed over is `querySpec`, the same one the grid is looking at, so the file
   * matches the screen rather than the table underneath it.
   */
  const handleExportCsv = useCallback(() => {
    if (!table) return
    void exportViewToCsv({
      client,
      host,
      table,
      viewName: views.active?.name ?? 'view',
      layout,
      spec: querySpec,
    })
      .then((count) => toasts.info(`Exported ${count.toLocaleString()} rows.`))
      .catch((err: Error) => toasts.error(err.message))
  }, [client, host, table, views.active, layout, querySpec, toasts])

  const handleSummary = useCallback(
    (column: string, fn: SummaryFunction | null) => {
      // Same shape as a resize: updating the active view is what persists it. The second write
      // to `_airsqlite_columns` that used to live here had no type to catch it — `setMeta` takes a
      // `Record<string, unknown>` — so it would have gone on being sent and silently ignored.
      views.update({ summary: { ...(views.config.summary ?? {}), [column]: fn } })
    },
    [views],
  )

  const handleFreezeCount = useCallback(
    (count: number) => views.update({ frozenCount: count }),
    [views],
  )

  const handleSetDisplayType = useCallback(
    (column: string, type: DisplayType, options: Record<string, unknown> | null) => {
      if (!table) return
      void client
        .setMeta(table, { columns: { [column]: { displayType: type, options } } })
        .then(() => schema.reload())
        .catch((err: Error) => toasts.error(err.message))
    },
    [client, table, data, toasts],
  )

  const handleSetDescription = useCallback(
    (column: string, description: string | null) => {
      if (!table) return
      void client
        .setMeta(table, { columns: { [column]: { description } } })
        // Reload the schema, unlike a resize: the info icon lives on the descriptor, so the
        // header cannot show a new description until the columns come back.
        .then(() => schema.reload())
        .catch((err: Error) => toasts.error(err.message))
    },
    [client, table, schema, toasts],
  )

  /**
   * The values a column already holds, as strings.
   *
   * Converting a text column full of "Won"/"Lost"/"Open" into a select field and finding an
   * empty option list is the moment the feature looks broken — the answer is right there in
   * the data. A failure returns nothing rather than surfacing an error: the conversion itself
   * still succeeds, and an empty list is the same state the user would have had anyway.
   */
  const handleHarvestValues = useCallback(
    (column: string): Promise<string[]> => {
      if (!table) return Promise.resolve([])
      return client
        .distinctValues(table, column)
        .then((values) => values.map((v) => String(v)).filter(Boolean))
        .catch(() => [])
    },
    [client, table],
  )

  const handleCreateTable = useCallback(
    (name: string) => {
      void client
        .createTable(name)
        .then((created) => {
          // Reload the tab list before selecting, or the new table is chosen before it exists
          // as far as the workspace is concerned and the grid opens on nothing.
          void workspace.reloadTables()
          workspace.selectTable(created.name)
        })
        .catch((err: Error) => toasts.error(err.message))
    },
    [client, workspace, toasts],
  )

  /**
   * Deleting a table names the SQL views that read from it, and puts the table's name in the
   * dialog rather than "this table" — the one thing that stops a mis-click being a mis-delete.
   */
  const handleDeleteTable = useCallback(
    (name: string) => {
      void client.dependents(name).then((views) => {
        const dependents = views.map((v) => v.name)
        setConfirm({
          title: `Delete the ${name} table?`,
          detail: [
            'Every record in it goes, along with its views, field types, and buttons.',
            dependents.length > 0
              ? `These SQL views read from it and will break: ${dependents.join(', ')}.`
              : '',
            'This cannot be undone from here.',
          ]
            .filter(Boolean)
            .join(' '),
          confirmLabel: `Delete ${name}`,
          danger: true,
          run: () => {
            void client
              .dropTable(name)
              .then(() => workspace.reloadTables())
              .catch((err: Error) => toasts.error(err.message))
          },
        })
      })
    },
    [client, workspace, toasts],
  )

  /** Reload columns and the primary field together — both come from `get-meta`. */
  const reloadMeta = useCallback(() => {
    if (!table) return
    void client
      .meta(table)
      .then((meta) => setPrimaryField(meta.primaryField))
      .catch(() => undefined)
    schema.reload()
  }, [client, table, schema])

  const handleRenameTable = useCallback(
    (name: string, next: string) => {
      void client
        .renameTable(name, next)
        .then((renamed) => {
          void workspace.reloadTables()
          workspace.selectTable(renamed.name)
        })
        .catch((err: Error) => toasts.error(err.message))
    },
    [client, workspace, toasts],
  )

  const handleDescribeTable = useCallback(
    (name: string, description: string | null) => {
      void client
        .describeTable(name, description)
        .then(() => void workspace.reloadTables())
        .catch((err: Error) => toasts.error(err.message))
    },
    [client, workspace, toasts],
  )

  /**
   * Add a field, optionally beside an existing one.
   *
   * "Beside" is a *view* position. `ALTER TABLE ADD COLUMN` always appends and SQLite cannot
   * insert one mid-table without rebuilding it — so the column lands last in the table and the
   * active view's `columnOrder` puts it where it was asked for. That is the position the user
   * can see, and the only one they were talking about.
   */
  const handleAddColumn = useCallback(
    (name: string, columnType: string, beside?: { column: string; side: 'left' | 'right' }, displayType?: DisplayType) => {
      if (!table) return
      void client
        .addColumn(table, name, columnType)
        .then(async (added) => {
          if (displayType && displayType !== 'text') {
            await client.setMeta(table, { columns: { [added.name]: { displayType, options: null } } })
          }
          if (beside) {
            const order = layout.map((c) => c.descriptor.name).filter((c) => c !== added.name)
            const at = order.indexOf(beside.column)
            if (at >= 0) {
              order.splice(beside.side === 'left' ? at : at + 1, 0, added.name)
              views.update({ columnOrder: order })
            }
          }
          reloadMeta()
        })
        .catch((err: Error) => toasts.error(err.message))
    },
    [client, table, layout, views, reloadMeta, toasts],
  )

  const handleSetPrimary = useCallback(
    (column: string) => {
      if (!table) return
      void client
        .setMeta(table, { primaryField: column })
        .then((meta) => {
          setPrimaryField(meta.primaryField)
          schema.reload()
        })
        .catch((err: Error) => toasts.error(err.message))
    },
    [client, table, schema, toasts],
  )

  /**
   * Duplicating a column asks one question with two answers that are not interchangeable: with
   * values it is a backup you are about to edit, without it is a new field shaped like an old
   * one. There is no sensible default, so both are offered as buttons rather than a checkbox
   * with a guess in it.
   */
  const handleDuplicateColumn = useCallback(
    (column: string) => {
      if (!table) return
      const name = `${column}_copy`
      const run = (copyValues: boolean) => () => {
        void client
          .duplicateColumn(table, column, name, copyValues)
          .then(() => {
            reloadMeta()
            toasts.info(`Added ${name}.`)
          })
          .catch((err: Error) => toasts.error(err.message))
      }

      setConfirm({
        title: `Duplicate ${column} as ${name}?`,
        detail: 'Copy this field\u2019s values into the new column, or leave it empty.',
        confirmLabel: 'Copy values',
        secondaryLabel: 'Leave empty',
        onSecondary: run(false),
        run: run(true),
      })
    },
    [client, table, reloadMeta, toasts],
  )

  /**
   * Deleting a column names the SQL views that read from it.
   *
   * SQLite drops the column and reports nothing; the view stays in the schema and fails at
   * next read, which may be days later and somewhere else entirely. The dependent list is
   * deliberately over-inclusive — see `Schema.dependents` — because a spurious name makes
   * somebody look twice and a missing one lets them break something silently.
   */
  const handleDeleteColumn = useCallback(
    (column: string) => {
      if (!table) return
      void client.dependents(table, column).then((views) => {
        const naming = views.filter((v) => v.namesColumn).map((v) => v.name)
        const others = views.filter((v) => !v.namesColumn).map((v) => v.name)
        const parts = [
          naming.length > 0 ? `These views name it: ${naming.join(', ')}.` : '',
          others.length > 0 ? `These read from ${table}: ${others.join(', ')}.` : '',
          views.length > 0 ? 'SQLite will not stop the drop — they break at next read.' : '',
        ].filter(Boolean)

        setConfirm({
          title: `Delete the ${column} column?`,
          detail:
            parts.length > 0
              ? parts.join(' ')
              : 'Its values go with it. This cannot be undone from here.',
          confirmLabel: 'Delete column',
          danger: true,
          run: () => {
            void client
              .dropColumn(table, column)
              .then(reloadMeta)
              .catch((err: Error) => toasts.error(err.message))
          },
        })
      })
    },
    [client, table, reloadMeta, toasts],
  )

  const toggleRow = useCallback((rowid: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(rowid)) next.delete(rowid)
      else next.add(rowid)
      return next
    })
  }, [])

  // Select-all covers the rows that have actually been fetched; selecting 100k rows the user
  // has never seen would make a bulk edit far broader than it looks.
  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (prev.size > 0) return new Set()
      const all = new Set<number>()
      for (let i = 0; i < data.rowCount; i++) {
        const rowid = data.getRow(i)?.rowid
        if (typeof rowid === 'number') all.add(rowid)
      }
      return all
    })
  }, [data])

  if (workspace.status === 'connecting') {
    return (
      <div class="afs-boot" data-testid="boot" data-state="connecting">
        <span>Connecting…</span>
      </div>
    )
  }

  if (workspace.status === 'error') {
    return (
      <div class="afs-boot" data-testid="boot" data-state="error">
        <strong>Could not open this database.</strong>
        <span data-testid="boot-error">{workspace.error}</span>
      </div>
    )
  }

  if (workspace.tables.length === 0) {
    return (
      <div class="afs-app" data-testid="boot" data-state="ready">
        <div class="afs-empty" data-testid="empty-database">
          <strong>This database has no tables.</strong>
          <span>Use your coding agent to create one.</span>
        </div>
      </div>
    )
  }

  return (
    <div class="afs-app" data-testid="boot" data-state="ready">
      <TableTabs
        tables={workspace.tables}
        active={workspace.activeTable}
        onSelect={workspace.selectTable}
        onReorder={canConfigure ? reorderTables : undefined}
        onCreate={canConfigure ? handleCreateTable : undefined}
        onRename={canConfigure ? handleRenameTable : undefined}
        onDescribe={canConfigure ? handleDescribeTable : undefined}
        onDelete={canConfigure ? handleDeleteTable : undefined}
      />

      <div class="afs-toolbar" data-testid="toolbar">
        <ViewSwitcher
          views={views.views}
          activeViewId={views.activeViewId}
          active={views.active}
          writable={views.writable}
          listOpen={showViews}
          onToggleList={() => setShowViews((prev) => !prev)}
          onSelect={views.selectView}
          onCreate={views.create}
          onDuplicate={views.duplicate}
          onRename={views.rename}
          onDescribe={views.describe}
          onSetDefault={views.setDefault}
          onDelete={views.remove}
          onExportCsv={handleExportCsv}
        />

        <FilterMenu
          open={showFilters}
          active={!!views.config.filter}
          onToggle={() => setShowFilters((prev) => !prev)}
          onClose={() => setShowFilters(false)}
        >
          <FilterBuilder
            columns={schema.columns}
            linkColumns={links.columns}
            filter={views.config.filter ?? null}
            onChange={(filter) => views.update({ filter })}
            onClose={() => setShowFilters(false)}
          />
        </FilterMenu>

        <SortMenu
          columns={schema.columns}
          sort={sort}
          groupedBy={groupColumns}
          onChange={(next) => views.update({ sort: next })}
        />

        <HiddenColumnsMenu
          columns={schema.columns}
          visibility={views.config.columnVisibility ?? {}}
          onToggle={handleShowColumn}
        />

        <GroupMenu
          columns={schema.columns}
          grouping={groupColumns}
          onToggle={handleGroupBy}
          onCollapseAll={grouping.collapseAll}
          onExpandAll={grouping.expandAll}
        />

        <SearchBar value={search} onChange={setSearch} />
      </div>

      {activeTable?.withoutRowid ? (
        <div class="afs-notice" data-testid="without-rowid-notice">
          <strong>{activeTable.name}</strong> is a WITHOUT ROWID table. Its rows have no stable
          identity to edit against, so it is shown read-only.
        </div>
      ) : null}

      <SelectionBar
        count={selected.size}
        columns={schema.columns}
        onClear={() => setSelected(new Set())}
        onDelete={handleDeleteSelected}
        onBulkEdit={handleBulkEdit}
      />

      <div class="afs-main">
        {showViews ? (
          <ViewsPanel
            views={views.views}
            activeViewId={views.activeViewId}
            writable={views.writable}
            onSelect={views.selectView}
            onCreate={views.create}
          />
        ) : null}

        <div class="afs-main__grid">
          {data.error ? (
            <div class="afs-empty" data-testid="table-error">
              <strong>Could not read this table.</strong>
              <span>{data.error}</span>
            </div>
          ) : (
            <>
              <Grid
                search={search}
                onHorizontalScroll={(left, sbw) => { setGridScrollLeft(left); setGridScrollbarWidth(sbw) }}
                data={data}
                layout={layout}
                editable={editable}
                sort={sort}
                selected={selected}
                canConfigure={canConfigure}
                frozenCount={views.config.frozenCount ?? 0}
                client={client}
                links={links}
                view={view}
                onToggleGroup={grouping.toggle}
                onUndo={() => runHistory('undo')}
                onRedo={() => runHistory('redo')}
                onPaste={handlePaste}
                rowActions={gridActions}
                runningAction={runningAction}
                onRunAction={runAction}
                activeRowid={panelIsSameTable ? panelRowid : null}
                onFocusRow={focusRow}
                onExpandRow={expandRow}
                onNavigateLink={navigateFromCell}
                onSort={handleSort}
                onToggleRow={toggleRow}
                onToggleAll={toggleAll}
                onEdit={handleEdit}
                onSetDisplayType={handleSetDisplayType}
                onSetDescription={handleSetDescription}
                onHarvestValues={handleHarvestValues}
                primaryField={primaryField}
                onSetPrimary={handleSetPrimary}
                onDuplicateColumn={handleDuplicateColumn}
                onDeleteColumn={handleDeleteColumn}
                onAddColumn={(beside) => setNewField(beside ? { beside } : {})}
                onHideColumn={handleHideColumn}
                onResizeColumn={handleResizeColumn}
                onReorderColumns={handleReorderColumns}
                onFreezeCount={handleFreezeCount}
                allDateColumns={layout.filter(c => c.descriptor.displayType === 'date').map(c => c.descriptor.name)}
                onSetAllTimezones={(tz) => {
                  if (!table) return
                  const dateCols = layout.filter(c => c.descriptor.displayType === 'date')
                  const updates: Record<string, { displayType: DisplayType; options: Record<string, unknown> }> = {}
                  for (const col of dateCols) {
                    updates[col.descriptor.name] = {
                      displayType: 'date',
                      options: { ...col.descriptor.options, timezone: tz || undefined },
                    }
                  }
                  void client
                    .setMeta(table, { columns: updates })
                    .then(() => schema.reload())
                    .catch((err: Error) => toasts.error(err.message))
                }}
                onSplitCommaValues={async (col) => {
                  if (!table) return 0
                  const result = await client.splitCommaValues(table, col)
                  await schema.reload()
                  return result
                }}
                onConfirmCommaSplit={(col, commaValues, applyMultiSelect) => {
                  setConfirm({
                    title: `${commaValues.length} value${commaValues.length > 1 ? 's' : ''} contain commas`,
                    detail: commaValues.join('\n'),
                    confirmLabel: 'Split into multiple selects',
                    run: () => {
                      if (!table) return
                      void client.splitCommaValues(table, col).then(async () => {
                        const fresh = await client.distinctValues(table, col)
                        const tags = fresh.flatMap((v) => {
                          const s = String(v)
                          try { const p = JSON.parse(s); return Array.isArray(p) ? p.map(String) : [s] } catch { return [s] }
                        })
                        const unique = [...new Set(tags)].filter(Boolean)
                        const colors = ['blue','cyan','teal','green','lime','yellow','orange','red','pink','purple','indigo','gray'] as const
                        const options = {
                          choices: unique.map((v, i) => ({ value: v, color: colors[i % colors.length] })),
                          colored: true,
                          defaultValue: null,
                        }
                        void client
                          .setMeta(table, { columns: { [col]: { displayType: 'multi_select' as const, options } } })
                          .then(() => { schema.reload(); data.refresh() })
                      })
                    },
                    secondaryLabel: 'Keep as single values',
                    onSecondary: () => applyMultiSelect(),
                  })
                }}
              />
              <SummaryBar
                scrollLeft={gridScrollLeft}
                columns={layout}
                leadingWidth={chromeWidth(editable)}
                frozenCount={Math.max(views.config.frozenCount ?? 0, layout.length > 0 ? 1 : 0)}
                summary={summaryConfig}
                values={summaryValues}
                onChange={handleSummary}
                addRow={editable ? handleAddRow : undefined}
                recordCount={data.rowCount}
                totalCount={data.totalCount}
                trailingWidth={trailingWidth(gridActions.length, canConfigure) + gridScrollbarWidth}
              />
              {data.rowCount === 0 && !data.loading ? (
                <div class="afs-empty" data-testid="empty-table">
                  <strong>No records yet</strong>
                  {editable ? (
                    <button
                      type="button"
                      class="afs-button afs-button--primary"
                      data-testid="empty-add-row"
                      onClick={handleAddRow}
                    >
                      Add row
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>

        {panelTable && panelRowid !== null ? (
          <DetailPanel
            width={panelWidth}
            onResize={setPanelWidth}
            client={client}
            table={panelTable}
            rowid={panelRowid}
            row={record.row}
            error={record.error}
            columns={panelIsSameTable ? schema.columns : panelColumns.columns}
            primaryField={panelIsSameTable ? primaryField : crossPrimaryField}
            links={links}
            editable={panelIsSameTable && editable}
            related={related}
            actions={panelIsSameTable ? actions : []}
            runningAction={runningAction}
            onRunAction={runAction}
            onEdit={handleEdit}
            onNavigate={navigate}
            onClose={closePanel}
          />
        ) : null}
      </div>


      {newField ? (
        <NewFieldDialog
          {...(newField.beside ? { beside: newField.beside } : {})}
          onCancel={() => setNewField(null)}
          onAdd={(name, columnType, displayType) => {
            const pending = newField
            setNewField(null)
            handleAddColumn(name, columnType, pending.beside, displayType)
          }}
        />
      ) : null}

      {confirm ? (
        <ConfirmModal
          title={confirm.title}
          {...(confirm.detail ? { detail: confirm.detail } : {})}
          {...(confirm.preview ? { preview: confirm.preview } : {})}
          confirmLabel={confirm.confirmLabel}
          {...(confirm.danger ? { danger: true } : {})}
          {...(confirm.secondaryLabel && confirm.onSecondary
            ? {
                secondaryLabel: confirm.secondaryLabel,
                onSecondary: () => {
                  const pending = confirm
                  setConfirm(null)
                  pending.onSecondary?.()
                },
              }
            : {})}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const pending = confirm
            setConfirm(null)
            pending.run()
          }}
        />
      ) : null}

      <ToastHost toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </div>
  )
}

/**
 * Choose the grouping columns. Checked order is nesting order, so grouping by status and then
 * customer nests customers inside statuses — the same reading as the column list itself.
 */
function GroupMenu({
  columns,
  grouping,
  onToggle,
  onCollapseAll,
  onExpandAll,
}: {
  columns: Array<{ name: string; virtual?: boolean }>
  grouping: string[]
  onToggle: (column: string, grouped: boolean) => void
  onCollapseAll: () => void
  onExpandAll: () => void
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const container = useDismissOnOutside(open, useCallback(() => setOpen(false), []))

  // Created and Modified come from the changelog; SQLite has no column to GROUP BY.
  const groupable = columns.filter((column) => !column.virtual)
  const shown = groupable.filter((column) => matches(column.name, filter))

  return (
    <span class="afs-columns-menu" ref={container}>
      <button
        type="button"
        class={`afs-button${grouping.length > 0 ? ' afs-button--primary' : ''}`}
        data-testid="group-toggle"
        onClick={() => {
          setFilter('')
          setOpen((prev) => !prev)
        }}
      >
        Group{grouping.length > 0 ? ` (${grouping.length})` : ''}
      </button>
      {open ? (
        <div class="afs-menu afs-menu--anchored" data-testid="group-menu">
          <MenuFilter
            testid="group-filter"
            count={groupable.length}
            value={filter}
            onInput={setFilter}
          />
          {shown.length === 0 ? (
            <p class="afs-menu__hint" data-testid="group-filter-empty">
              No column matches “{filter}”.
            </p>
          ) : null}
          {shown
            .map((column) => (
              <label key={column.name} class="afs-menu__check">
                <input
                  type="checkbox"
                  data-testid={`group-by-${column.name}`}
                  checked={grouping.includes(column.name)}
                  onChange={(event) =>
                    onToggle(column.name, (event.currentTarget as HTMLInputElement).checked)
                  }
                />
                {column.name}
                {grouping.includes(column.name) ? (
                  <span class="afs-menu__hint"> {grouping.indexOf(column.name) + 1}</span>
                ) : null}
              </label>
            ))}
          {grouping.length > 0 ? (
            <div class="afs-menu__section">
              <button
                type="button"
                class="afs-menu__item"
                data-testid="group-collapse-all"
                onClick={onCollapseAll}
              >
                Collapse all
              </button>
              <button
                type="button"
                class="afs-menu__item"
                data-testid="group-expand-all"
                onClick={onExpandAll}
              >
                Expand all
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </span>
  )
}

/**
 * Close a dropdown when the user clicks anywhere else, or presses Escape.
 *
 * Returns a ref to put on the element that counts as "inside" — which must include the toggle
 * button, not just the menu. If the trigger sits outside it, a click on it closes on mousedown
 * and then re-opens on click, and the button appears unable to close what it opened. That is
 * the exact bug the column header caret had.
 */
/**
 * The filter builder in a dropdown, matching the Columns, Group, and Sort menus.
 *
 * It used to be a panel that pushed the grid down when open, which meant opening it moved every
 * row you were looking at and closing it moved them back — and the only way to dismiss it was
 * the Done button, since clicking away did nothing. Same content, same builder inside; what
 * changed is that it now behaves like its four neighbours in the toolbar.
 */
function FilterMenu({
  open,
  active,
  onToggle,
  onClose,
  children,
}: {
  open: boolean
  active: boolean
  onToggle: () => void
  onClose: () => void
  children: preact.ComponentChildren
}) {
  const container = useDismissOnOutside(open, useCallback(() => onClose(), [onClose]))

  return (
    <span class="afs-columns-menu" ref={container}>
      <button
        type="button"
        class={`afs-button${active ? ' afs-button--primary' : ''}`}
        data-testid="filter-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        Filter{active ? ' •' : ''}
      </button>
      {open ? (
        <div class="afs-menu afs-menu--anchored afs-menu--filter" data-testid="filter-menu">
          {children}
        </div>
      ) : null}
    </span>
  )
}

/** Case-insensitive substring. Deliberately not fuzzy — a column list is not a command palette. */
function matches(name: string, filter: string): boolean {
  const needle = filter.trim().toLowerCase()
  return needle === '' || name.toLowerCase().includes(needle)
}

/**
 * A filter box for the column and group menus.
 *
 * Only rendered once the list is long enough to need one. A real table runs to forty-odd
 * columns — `prospects` has 41 — where finding one by eye means reading a scrolling list of
 * checkboxes; on an eight-column fixture the same box is just something extra to look at.
 */
const FILTER_THRESHOLD = 12

function MenuFilter({
  testid,
  count,
  value,
  onInput,
}: {
  testid: string
  count: number
  value: string
  onInput: (next: string) => void
}) {
  if (count < FILTER_THRESHOLD) return null
  return (
    <input
      class="afs-menu__input afs-menu__filter"
      data-testid={testid}
      type="search"
      autofocus
      placeholder={`Filter ${count} columns…`}
      value={value}
      onInput={(event) => onInput((event.currentTarget as HTMLInputElement).value)}
      // Escape clears the filter first and only closes the menu once it is already empty.
      // Pressing it after typing four characters should undo the typing, not throw away the
      // menu and make you reopen it.
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || value === '') return
        event.stopPropagation()
        onInput('')
      }}
    />
  )
}

/**
 * Hidden columns have to be reachable again, or hiding one is a one-way door — the header
 * that would carry its menu is exactly the thing that is gone.
 */
function HiddenColumnsMenu({
  columns,
  visibility,
  onToggle,
}: {
  columns: Array<{ name: string }>
  visibility: Record<string, boolean>
  onToggle: (column: string, visible: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const container = useDismissOnOutside(open, useCallback(() => setOpen(false), []))
  const hiddenCount = columns.filter((c) => visibility[c.name] === false).length
  const shown = columns.filter((column) => matches(column.name, filter))

  return (
    <span class="afs-columns-menu" ref={container}>
      <button
        type="button"
        class="afs-button"
        data-testid="columns-toggle"
        onClick={() => {
          setFilter('')
          setOpen((prev) => !prev)
        }}
      >
        Columns{hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ''}
      </button>
      {open ? (
        <div class="afs-menu afs-menu--anchored" data-testid="columns-menu">
          <MenuFilter
            testid="columns-filter"
            count={columns.length}
            value={filter}
            onInput={setFilter}
          />
          {shown.length === 0 ? (
            <p class="afs-menu__hint" data-testid="columns-filter-empty">
              No column matches “{filter}”.
            </p>
          ) : null}
          {shown.map((column) => (
            <label key={column.name} class="afs-menu__check">
              <input
                type="checkbox"
                data-testid={`column-visible-${column.name}`}
                checked={visibility[column.name] !== false}
                onChange={(event) =>
                  onToggle(column.name, (event.currentTarget as HTMLInputElement).checked)
                }
              />
              {column.name}
            </label>
          ))}
        </div>
      ) : null}
    </span>
  )
}

/** Look up the current cached value, so a failed write can be rolled back to it. */
function findValue(
  data: ReturnType<typeof useTableData>,
  rowid: number,
  field: string,
): SqlValue | undefined {
  return findRow(data, rowid)?.[field]
}

/**
 * The cached row for a rowid, if the grid happens to hold it. Undefined is a normal answer:
 * the record may be filtered out of the current view, or simply in a chunk nobody scrolled to.
 */
function findRow(data: ReturnType<typeof useTableData>, rowid: number): Row | undefined {
  for (let i = 0; i < data.rowCount; i++) {
    const row = data.getRow(i)
    if (row?.rowid === rowid) return row
  }
  return undefined
}

function Root() {
  const client = useMemo(() => new Client(createTransport()), [])
  // Both seams are chosen here, together and once. `createHostServices` has to run before any
  // render that might want it, and it shares the webview handle with the transport — VS Code
  // allows exactly one `acquireVsCodeApi` call per session.
  const host = useMemo(() => createHostServices(), [])
  return <App client={client} host={host} />
}

const root = document.getElementById('root')
if (root) render(<Root />, root)
