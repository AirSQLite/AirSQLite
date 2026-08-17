import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type {
  ActionDefinition,
  ColumnDescriptor,
  FilterNode,
  RelatedGroup,
  Row,
  SortSpec,
  SqlValue,
  SummaryFunction,
  SummaryResult,
  TableInfo,
} from '../../shared/protocol.js'
import type { Client } from './client.js'

// Application state.
//
// The part worth reading carefully is useTableData. A 100k-row table cannot be held in the
// UI, so rows are fetched in fixed-size chunks and cached sparsely; the grid asks for the
// range it is about to paint and renders placeholders for anything not back yet. Chunk
// boundaries are fixed rather than following the scroll position, so scrolling up and down
// over the same region reuses cached chunks instead of refetching shifted windows.

export const CHUNK_SIZE = 200

// ---------------------------------------------------------------------------
// Workspace: which tables exist, which one is showing
// ---------------------------------------------------------------------------

export interface WorkspaceState {
  status: 'connecting' | 'ready' | 'error'
  error: string | null
  dbPath: string
  tables: TableInfo[]
  activeTable: string | null
}

export function useWorkspace(client: Client, preferredTable?: string | null) {
  const [state, setState] = useState<WorkspaceState>({
    status: 'connecting',
    error: null,
    dbPath: '',
    tables: [],
    activeTable: null,
  })

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const [{ dbPath }, tables] = await Promise.all([client.ping(), client.tables()])
        if (cancelled) return
        const saved = preferredTable && tables.some((t) => t.name === preferredTable)
          ? preferredTable
          : null
        setState({
          status: 'ready',
          error: null,
          dbPath,
          tables,
          activeTable: saved ?? tables[0]?.name ?? null,
        })
      } catch (err) {
        if (cancelled) return
        setState((prev) => ({ ...prev, status: 'error', error: (err as Error).message }))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [client])

  const selectTable = useCallback((name: string) => {
    setState((prev) => (prev.activeTable === name ? prev : { ...prev, activeTable: name }))
  }, [])

  /** Apply a new tab order locally, so a drag lands before the write round-trips. */
  const setTableOrder = useCallback((names: string[]) => {
    setState((prev) => {
      const byName = new Map(prev.tables.map((table) => [table.name, table]))
      const ordered = names.flatMap((name) => {
        const table = byName.get(name)
        if (table) byName.delete(name)
        return table ? [table] : []
      })
      // Anything the caller did not name keeps its place at the end rather than disappearing.
      return { ...prev, tables: [...ordered, ...byName.values()] }
    })
  }, [])

  /** Re-read the order from the database — the rollback path when a write is rejected. */
  const reloadTables = useCallback(async () => {
    try {
      const tables = await client.tables()
      setState((prev) => ({ ...prev, tables }))
    } catch {
      // The order on screen is already the best answer available.
    }
  }, [client])

  return { ...state, selectTable, setTableOrder, reloadTables }
}

// ---------------------------------------------------------------------------
// Table data: columns, counts, and a sparse windowed row cache
// ---------------------------------------------------------------------------

export interface TableData {
  rowCount: number
  totalCount: number
  loading: boolean
  error: string | null
  /** The row at an absolute index, or undefined if its chunk has not arrived. */
  getRow: (index: number) => Row | undefined
  /** Tell the store which absolute row range is about to be painted. */
  ensureRange: (start: number, end: number) => void
  /** Write a value into the cached row so the grid updates without a refetch. */
  patchRow: (rowid: number, field: string, value: SqlValue) => void
  /** Drop every cached chunk and refetch. Needed after an insert or delete moves rows. */
  refresh: () => void
  /** What an external write just changed, for highlighting. Empties itself after a beat. */
  changes: ExternalChanges
}

/** Cells and rows an external process changed, held only long enough to draw attention. */
export interface ExternalChanges {
  /** `rowid` + field, for cells whose value moved under us. */
  cells: Set<string>
  /** Rows that appeared. */
  added: Set<number>
}

const NO_CHANGES: ExternalChanges = { cells: new Set(), added: new Set() }

/** How long a changed cell stays highlighted. */
const HIGHLIGHT_MS = 2_000

export function changeKey(rowid: number, field: string): string {
  return `${rowid} ${field}`
}

/** What an external write did, in the terms the toast reports. */
export interface ChangeSummary {
  updated: number
  added: number
  deleted: number
}

/** Everything that changes which rows come back — a change to any of it invalidates the cache. */
export interface QuerySpec {
  sort?: SortSpec[]
  filter?: FilterNode | null
  search?: string
  /** Search only these columns; the grid passes its visible ones. */
  searchColumns?: string[]
  /** Grouping columns. They sort ahead of `sort`, which is what keeps groups contiguous. */
  groupBy?: string[]
  /** Sort direction per grouping column. Absent keys default to 'asc'. */
  groupSort?: Record<string, 'asc' | 'desc'>
}

/**
 * Column descriptors for a table.
 *
 * Deliberately separate from row fetching. Columns belong to the *table*; rows belong to the
 * *query*. Reloading columns whenever a filter changed would blank the headers mid-interaction,
 * and anything deriving the query from the visible columns — search does — would feed itself
 * an empty list and loop.
 */
export function useTableColumns(client: Client, table: string | null) {
  const [columns, setColumns] = useState<ColumnDescriptor[]>([])
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const prevTable = useRef(table)

  useEffect(() => {
    if (prevTable.current !== table) {
      setColumns([])
      prevTable.current = table
    }
    setError(null)
    if (!table) return

    let cancelled = false
    void client
      .columns(table)
      .then((cols) => {
        if (!cancelled) setColumns(cols)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })

    return () => {
      cancelled = true
    }
  }, [client, table, generation])

  useEffect(
    () =>
      client.onEvent((event) => {
        if (event.type === 'db-changed') setGeneration((n) => n + 1)
      }),
    [client],
  )

  /** Refetch — after a display type changes, for instance. */
  const reload = useCallback(() => setGeneration((n) => n + 1), [])

  return { columns, error, reload }
}

// ---------------------------------------------------------------------------
// One record: the detail panel's view of a row
// ---------------------------------------------------------------------------

export interface RecordState {
  row: Row | null
  error: string | null
  /** Apply an optimistic edit to the fetched copy. A no-op when the grid cache owns the row. */
  patch: (field: string, value: SqlValue) => void
}

/**
 * The record the detail panel is showing.
 *
 * It prefers the grid's cached row, which is what makes editing two-way for free: the panel
 * and the grid read the same object, so an edit in either shows in both. The fetch is the
 * fallback for a record the grid does not have — the current filter can exclude it, or a chip
 * can point 40,000 rows down into a table nobody has scrolled.
 */
export function useRecord(
  client: Client,
  table: string | null,
  rowid: number | null,
  cached: Row | undefined,
): RecordState {
  const [fetched, setFetched] = useState<Row | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inCache = cached !== undefined

  useEffect(() => {
    setError(null)
    if (!table || rowid === null || inCache) {
      setFetched(null)
      return
    }

    let cancelled = false
    void client
      .record(table, { rowid })
      .then((row) => {
        if (!cancelled) setFetched(row)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })

    return () => {
      cancelled = true
    }
  }, [client, table, rowid, inCache])

  const patch = useCallback((field: string, value: SqlValue) => {
    setFetched((prev) => (prev ? { ...prev, [field]: value } : prev))
  }, [])

  return { row: cached ?? fetched, error, patch }
}

// ---------------------------------------------------------------------------
// Related records: the reverse-lookup sections
// ---------------------------------------------------------------------------

export interface RelatedState {
  groups: RelatedGroup[]
  loading: boolean
  error: string | null
}

/** Child records pointing at one row, one group per inbound foreign key. */
export function useRelated(client: Client, table: string | null, rowid: number | null): RelatedState {
  const [groups, setGroups] = useState<RelatedGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setGroups([])
    setError(null)
    if (!table || rowid === null) return

    let cancelled = false
    setLoading(true)
    void client
      .related(table, rowid)
      .then((result) => {
        if (cancelled) return
        setGroups(result)
        setLoading(false)
      })
      .catch((err: Error) => {
        if (cancelled) return
        setError(err.message)
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [client, table, rowid])

  return { groups, loading, error }
}

// ---------------------------------------------------------------------------
// Action buttons
// ---------------------------------------------------------------------------

/**
 * The actions configured for a table.
 *
 * Refetched when an external write lands, because `_airsqlite_actions` is a table in the same
 * database — an agent adding a button is exactly the kind of thing this app should show
 * without being reopened.
 */
export function useActions(client: Client, table: string | null): ActionDefinition[] {
  const [actions, setActions] = useState<ActionDefinition[]>([])
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    setActions([])
    if (!table) return

    let cancelled = false
    void client
      .actions(table)
      .then((result) => {
        if (!cancelled) setActions(result)
      })
      // A database with no actions table is the normal case, not an error worth showing.
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [client, table, generation])

  useEffect(
    () =>
      client.onEvent((event) => {
        if (event.type === 'db-changed') setGeneration((n) => n + 1)
      }),
    [client],
  )

  return actions
}

// ---------------------------------------------------------------------------
// Summary aggregates
// ---------------------------------------------------------------------------

/**
 * Aggregates for the summary bar.
 *
 * Recomputed whenever the query changes *and* whenever an external write lands — a total
 * that silently describes the table as it was five minutes ago is worse than no total, and
 * this app exists to be watched while something else writes.
 */
export function useSummary(
  client: Client,
  table: string | null,
  config: Record<string, SummaryFunction>,
  spec: QuerySpec,
): SummaryResult {
  const [values, setValues] = useState<SummaryResult>({})
  const [generation, setGeneration] = useState(0)
  const key = JSON.stringify({ config, filter: spec.filter, search: spec.search })

  useEffect(() => {
    if (!table || Object.keys(config).length === 0) {
      setValues({})
      return
    }

    let cancelled = false
    void client
      .summary(table, config, spec)
      .then((result) => {
        if (!cancelled) setValues(result)
      })
      // A summary that cannot be computed shows as blank rather than taking down the grid.
      .catch(() => {
        if (!cancelled) setValues({})
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key stands in for config + spec
  }, [client, table, key, generation])

  useEffect(
    () =>
      client.onEvent((event) => {
        if (event.type === 'db-changed') setGeneration((n) => n + 1)
      }),
    [client],
  )

  return values
}

export function useTableData(
  client: Client,
  table: string | null,
  spec: QuerySpec = {},
  onExternalChange?: (summary: ChangeSummary) => void,
): TableData {
  const [rowCount, setRowCount] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const chunks = useRef(new Map<number, Row[]>())
  const inFlight = useRef(new Set<number>())
  // Rows live in a ref so a fetch does not rebuild the map; this counter is what tells
  // Preact something changed, and it is part of the memo key below so consumers that do
  // compare `data` by identity still see arriving chunks.
  const [version, bumpVersion] = useState(0)
  const [generation, setGeneration] = useState(0)
  const rerender = useCallback(() => bumpVersion((n) => n + 1), [])

  // Sorting, filtering, and search all happen in SQL, so a change to any of them invalidates
  // every cached chunk. Serialising the spec keeps the effect dependency stable across
  // renders that rebuild an equivalent object.
  const specKey = JSON.stringify(spec)
  const activeSpec = useRef(specKey)

  // Rows are invalidated by a table switch, any change to the query, or an explicit refresh.
  useEffect(() => {
    activeSpec.current = specKey
    chunks.current = new Map()
    inFlight.current = new Set()
    setRowCount(0)
    setTotalCount(0)

    if (!table) return
    let cancelled = false
    setLoading(true)

    void client
      .query({ table, offset: 0, limit: CHUNK_SIZE, ...spec })
      .then((first) => {
        if (cancelled) return
        chunks.current.set(0, first.rows)
        setRowCount(first.filteredCount)
        setTotalCount(first.totalCount)
        setLoading(false)
        rerender()
      })
      .catch((err: Error) => {
        if (cancelled) return
        setError(err.message)
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- specKey stands in for spec
  }, [client, table, specKey, generation, rerender])

  const fetchChunk = useCallback(
    (chunkIndex: number) => {
      if (!table) return
      if (chunks.current.has(chunkIndex) || inFlight.current.has(chunkIndex)) return

      inFlight.current.add(chunkIndex)
      const snapshot = specKey
      void client
        .query({ table, offset: chunkIndex * CHUNK_SIZE, limit: CHUNK_SIZE, ...spec })
        .then((result) => {
          if (activeSpec.current !== snapshot) return
          chunks.current.set(chunkIndex, result.rows)
          rerender()
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => inFlight.current.delete(chunkIndex))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- specKey stands in for spec
    [client, table, specKey, rerender],
  )

  const ensureRange = useCallback(
    (start: number, end: number) => {
      const firstChunk = Math.max(0, Math.floor(start / CHUNK_SIZE))
      const lastChunk = Math.floor(Math.max(0, end) / CHUNK_SIZE)
      for (let i = firstChunk; i <= lastChunk; i++) fetchChunk(i)
    },
    [fetchChunk],
  )

  const getRow = useCallback((index: number): Row | undefined => {
    const chunk = chunks.current.get(Math.floor(index / CHUNK_SIZE))
    return chunk?.[index % CHUNK_SIZE]
  }, [])

  /**
   * Update a cached row in place. Without this an edit would not appear until the table was
   * switched, because the grid renders from the chunk cache rather than from the server.
   */
  const patchRow = useCallback(
    (rowid: number, field: string, value: SqlValue) => {
      for (const rows of chunks.current.values()) {
        const index = rows.findIndex((row) => row.rowid === rowid)
        if (index === -1) continue
        const existing = rows[index]
        if (!existing) continue
        rows[index] = { ...existing, [field]: value }
        rerender()
        return
      }
    },
    [rerender],
  )

  // Inserts and deletes shift every row after them, so no cached chunk can be trusted.
  const refresh = useCallback(() => setGeneration((n) => n + 1), [])

  // -------------------------------------------------------------------------
  // Live reload
  // -------------------------------------------------------------------------

  const [changes, setChanges] = useState<ExternalChanges>(NO_CHANGES)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notify = useRef(onExternalChange)
  notify.current = onExternalChange

  /**
   * Re-read what is on screen and work out what moved.
   *
   * Only the *cached* chunks are refetched. Rows nobody is looking at do not need
   * classifying, and refetching a 100k-row table to find three changed cells would make the
   * live part of live reload the slowest thing in the app.
   */
  const reconcile = useCallback(async () => {
    if (!table) return
    const indices = [...chunks.current.keys()]
    if (indices.length === 0) {
      setGeneration((n) => n + 1)
      return
    }

    const before = new Map<number, Row>()
    for (const rows of chunks.current.values()) {
      for (const row of rows) if (row.rowid !== null) before.set(row.rowid, row)
    }
    const beforeCount = rowCount

    let results: Awaited<ReturnType<Client['query']>>[]
    try {
      results = await Promise.all(
        indices.map((index) =>
          client.query({ table, offset: index * CHUNK_SIZE, limit: CHUNK_SIZE, ...spec }),
        ),
      )
    } catch {
      // A failed reconcile leaves the last good data on screen rather than blanking it.
      return
    }

    const cells = new Set<string>()
    const added = new Set<number>()
    const seen = new Set<number>()
    let updatedRows = 0

    indices.forEach((chunkIndex, i) => {
      const result = results[i]
      if (!result) return
      chunks.current.set(chunkIndex, result.rows)

      for (const row of result.rows) {
        if (row.rowid === null) continue
        seen.add(row.rowid)
        const previous = before.get(row.rowid)
        if (!previous) {
          added.add(row.rowid)
          continue
        }
        let touched = false
        for (const field of Object.keys(row)) {
          if (field === 'rowid') continue
          if (previous[field] === row[field]) continue
          cells.add(changeKey(row.rowid, field))
          touched = true
        }
        if (touched) updatedRows++
      }
    })

    const nextCount = results[0]?.filteredCount ?? beforeCount
    setRowCount(nextCount)
    setTotalCount(results[0]?.totalCount ?? totalCount)
    rerender()

    // Counts come from the row count, not from the window. A row leaving the visible window
    // is not the same as a row leaving the table — an insert at the top shifts every offset,
    // and reporting that as 200 deletions would be nonsense.
    const summary: ChangeSummary = {
      updated: updatedRows,
      added: Math.max(0, nextCount - beforeCount),
      deleted: Math.max(0, beforeCount - nextCount),
    }

    if (cells.size > 0 || added.size > 0) {
      setChanges({ cells, added })
      if (highlightTimer.current) clearTimeout(highlightTimer.current)
      highlightTimer.current = setTimeout(() => setChanges(NO_CHANGES), HIGHLIGHT_MS)
    }
    if (summary.updated > 0 || summary.added > 0 || summary.deleted > 0) {
      notify.current?.(summary)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- specKey stands in for spec
  }, [client, table, specKey, rowCount, totalCount, rerender])

  const reconcileRef = useRef(reconcile)
  reconcileRef.current = reconcile

  useEffect(() => {
    // One subscription for the life of the client, calling through a ref, so a change to the
    // sort or filter does not tear down and rebuild the event listener.
    return client.onEvent((event) => {
      if (event.type === 'db-changed') void reconcileRef.current()
    })
  }, [client])

  useEffect(
    () => () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current)
    },
    [],
  )

  return useMemo(
    () => ({
      rowCount,
      totalCount,
      loading,
      error,
      getRow,
      ensureRange,
      patchRow,
      refresh,
      changes,
    }),
    // `chunks` is a ref, so `version` is what makes this recompute when a chunk lands.
    [
      rowCount,
      totalCount,
      loading,
      error,
      getRow,
      ensureRange,
      patchRow,
      refresh,
      changes,
      version,
    ],
  )
}
