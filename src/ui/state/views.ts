import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { ColumnDescriptor, SavedView, ViewConfig } from '../../shared/protocol.js'
import type { Client } from './client.js'

// Saved views: sort, filter, and column layout, stored per table inside the database file.
//
// A note on why TanStack Table is not doing this. It has been a dependency since Phase 1,
// held for exactly this moment, and it does not fit:
//
//   - Its row model wants the whole dataset. Ours is a sparse server-fetched window, so row
//     indices would be wrong and every model it builds would describe 200 rows out of 100k.
//   - Filtering is a nested AND/OR tree compiled to SQL. TanStack models flat per-column
//     filters evaluated in memory.
//   - Sorting and pagination happen in SQLite, not in the client.
//
// What is left is column visibility, order, and width — three plain objects and the derive
// function below. Wiring an adapter, a fake empty data array, and a state bridge to reach
// that would be more code than the code it replaces, and harder to follow. The dependency was
// removed in Phase 12; re-adding it costs `npm i` plus an adapter and moves nothing that
// exists today.

export const DEFAULT_CONFIG: ViewConfig = { version: 1 }

/**
 * The coalescing window for view-config writes.
 *
 * Leading *and* trailing, not trailing only. A pure trailing debounce looked right and lost
 * data: sorting a column and closing the tab inside the window meant the sort was never
 * written, and nothing anywhere said so — the failure mode of a save with no save button is
 * that its absence is invisible. Now the first change in a quiet period writes immediately and
 * only the rapid-fire tail is coalesced, so a resize drag costs two transactions instead of
 * two hundred while a single deliberate click costs one and is durable at once.
 */
const WRITE_WINDOW_MS = 250


export interface ViewsApi {
  views: SavedView[]
  /** Null only while the first load is in flight, or on a read-only file with no views. */
  activeViewId: number | null
  active: SavedView | null
  config: ViewConfig
  writable: boolean
  error: string | null
  update: (patch: Partial<ViewConfig>) => void
  selectView: (id: number) => void
  /** A view from scratch: everything visible, nothing filtered, nothing sorted. */
  create: (name: string) => void
  /** A copy of the active view, config and all. The way to explore without disturbing it. */
  duplicate: (name: string) => void
  /** Rename in place. Sends only the name — see the note below. */
  rename: (id: number, name: string) => void
  describe: (id: number, description: string | null) => void
  /** Make this the view that opens with the table. Clears the flag on the others. */
  setDefault: (id: number) => void
  reorder: (ids: number[]) => void
  remove: (id: number) => void
}

export function useViews(client: Client, table: string | null, writable: boolean): ViewsApi {
  const [views, setViews] = useState<SavedView[]>([])
  const [activeViewId, setActiveViewId] = useState<number | null>(null)
  const [config, setConfig] = useState<ViewConfig>(DEFAULT_CONFIG)
  const [baseline, setBaseline] = useState<ViewConfig>(DEFAULT_CONFIG)
  const [error, setError] = useState<string | null>(null)

  /**
   * Whether anything has deliberately chosen a view for the current table yet.
   *
   * The initial load picks the default, but it is asynchronous, and creating a view is now one
   * click away from a fresh open. Without this the sequence is: create resolves and adopts the
   * new view, *then* the still-in-flight load resolves and hands the default back — so the view
   * you just made appears for a frame and is silently replaced by the one you did not choose.
   *
   * A ref rather than state because the load's `.then` needs the value as of when it resolves,
   * not as of when the effect closed over it.
   */
  const chosen = useRef(false)

  // A table switch resets everything: a view belongs to one table, and carrying a column
  // order across tables would apply names that do not exist there.
  useEffect(() => {
    setViews([])
    setActiveViewId(null)
    setConfig(DEFAULT_CONFIG)
    setBaseline(DEFAULT_CONFIG)
    setError(null)
    chosen.current = false

    if (!table) return
    let cancelled = false

    void client
      .views(table)
      .then((loaded) => {
        if (cancelled) return
        setViews(loaded)
        if (chosen.current) return
        // Where you left it beats where the table starts. `isDefault` is the answer for a table
        // nobody has opened yet, or one whose remembered view has since been deleted — the
        // backend resolves a stale id to nothing rather than to a wrong view.
        //
        // `loaded[0]` as the last fallback: the backend orders defaults first and mints one when
        // a table has none, so an empty list means a read-only file — the one case with no view.
        const preferred =
          loaded.find((v) => v.isLast) ?? loaded.find((v) => v.isDefault) ?? loaded[0] ?? null
        if (!preferred) return
        chosen.current = true
        setActiveViewId(preferred.id)
        setConfig(preferred.config)
        setBaseline(preferred.config)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })

    return () => {
      cancelled = true
    }
  }, [client, table])

  const update = useCallback((patch: Partial<ViewConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }))
  }, [])

  /**
   * Auto-save. There is no save button any more.
   *
   * An active view always exists, so every change to the layout *is* a change to that view.
   * Three properties this has to hold, all of them about staying invisible:
   *
   *   - **Coalesced, leading and trailing.** A resize drag calls `update` on every pointer move,
   *     and 200 transactions for one decision is a stutter rather than a save. But coalescing
   *     the *leading* edge away loses data: a sort followed by closing the tab inside the window
   *     never reaches the file. So the first change in a quiet period goes immediately and only
   *     the tail is collapsed.
   *   - **No reload afterwards.** Re-reading the views would blank and refetch the grid mid-drag.
   *     The working config already shows the truth; the stored one only matters next open.
   *   - **No rollback.** Data writes roll back visibly when they fail because the user needs to
   *     know their edit did not land. A config write failing means a column is the wrong width
   *     next time — surfacing that as a snap-back mid-drag would be worse than the problem.
   *
   * The file watcher cannot see these either: it gates on `PRAGMA data_version`, which moves
   * only for commits from *other* connections, so the tool cannot reload in response to itself.
   *
   * `config === baseline` is reference equality on purpose — both are set to the same object on
   * load and on view switch, so a table change cannot look like an edit.
   */
  const lastWriteAt = useRef(0)

  useEffect(() => {
    if (!table || activeViewId === null || !writable) return
    if (config === baseline) return

    // Zero when nothing has been written recently — the leading edge. Otherwise wait out the
    // remainder of the window, and let the next change cancel and re-arm this, which is what
    // collapses a drag into one write at the end.
    const since = Date.now() - lastWriteAt.current
    const delay = since >= WRITE_WINDOW_MS ? 0 : WRITE_WINDOW_MS - since

    const timer = setTimeout(() => {
      lastWriteAt.current = Date.now()
      void client
        .saveView(table, { id: activeViewId, config })
        .then(() => {
          setBaseline(config)
          // Patch the saved list in place rather than refetching it.
          //
          // Without this the list keeps whatever config it was loaded with, and switching away
          // and back restores that stale copy — the width you just dragged reverts, which looks
          // exactly like the resize not having been saved. Refetching would fix it too and cost
          // a round trip plus a re-render mid-drag, which is what this phase is avoiding.
          setViews((prev) =>
            prev.map((view) => (view.id === activeViewId ? { ...view, config } : view)),
          )
        })
        .catch((err: Error) => setError(err.message))
    }, delay)

    return () => clearTimeout(timer)
  }, [client, table, activeViewId, writable, config, baseline])

  /**
   * Write whatever is pending, now, for the view it belongs to.
   *
   * The coalescing effect keys on `activeViewId`, so anything that changes it — switching
   * views, switching tables, closing the page — tears the effect down and takes the armed
   * timer with it. The change is then simply gone. This is the escape hatch for every one of
   * those, and it captures the *current* ids rather than reading them later, so a flush during
   * a switch cannot write the outgoing view's layout into the incoming one.
   */
  const flushPending = useCallback(() => {
    if (!table || activeViewId === null || !writable) return
    if (config === baseline) return
    const id = activeViewId
    const pending = config
    lastWriteAt.current = Date.now()
    void client.saveView(table, { id, config: pending }).catch(() => undefined)
    setBaseline(pending)
    setViews((prev) => prev.map((v) => (v.id === id ? { ...v, config: pending } : v)))
  }, [client, table, activeViewId, writable, config, baseline])

  /**
   * Flush a pending write when the page is going away.
   *
   * The coalescing window is small, but "small" is not "zero": closing a VS Code tab or a
   * browser tab inside it would drop the change, and with no save button there is nothing on
   * screen that was ever going to warn about that. `pagehide` is the last point at which a
   * message can still be posted; `visibilitychange` covers the mobile-style case where
   * `pagehide` never fires at all.
   *
   * Best-effort by nature — the transport may not get the bytes out. It converts a guaranteed
   * loss into an unlikely one, which is the most this shape of write can promise.
   */
  useEffect(() => {
    if (!table || activeViewId === null || !writable) return

    const onHidden = () => {
      if (document.visibilityState === 'hidden') flushPending()
    }

    window.addEventListener('pagehide', flushPending)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', flushPending)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [table, activeViewId, writable, flushPending])

  /**
   * Switch views.
   *
   * Both config and baseline are set to the *same object*, which is what stops the auto-save
   * effect reading a view switch as an edit and immediately writing the view you just left's
   * layout into the one you just opened.
   */
  const selectView = useCallback(
    (id: number) => {
      if (id === activeViewId) return
      // Before leaving, commit whatever this view has pending. Otherwise the switch cancels the
      // armed timer and the layout you just changed is lost — silently, since there was never a
      // save indicator to go stale.
      flushPending()
      const next = views.find((v) => v.id === id)?.config ?? DEFAULT_CONFIG
      chosen.current = true
      setActiveViewId(id)
      setConfig(next)
      setBaseline(next)

      // Fire-and-forget, like every other config write: which view you are looking at is not
      // something to report succeeding, and a failure means the next open starts on the default
      // rather than here — a smaller loss than a toast about it would be an interruption.
      if (table && writable) void client.setLastView(table, id).catch(() => undefined)
    },
    [views, activeViewId, flushPending, client, table, writable],
  )

  /**
   * Re-read the view list after something changed its *metadata* — a name, a description, the
   * default flag.
   *
   * It deliberately does not touch `baseline`. It used to, back when baseline meant "what the
   * server has and the user has not saved over". Under auto-save baseline means "what we last
   * wrote", and reassigning it from a server read re-runs the write effect, which cancels the
   * pending timer and starts a fresh 250ms — so renaming a view a moment after changing it
   * could postpone that change's write indefinitely, and navigating away lost it.
   */
  const reload = useCallback(() => {
    if (!table) return
    void client.views(table).then(setViews)
  }, [client, table])

  /** Adopt a newly created view as the active one, config and baseline together. */
  const adopt = useCallback(
    (saved: SavedView) => {
      chosen.current = true
      setActiveViewId(saved.id)
      setConfig(saved.config)
      setBaseline(saved.config)
      // Creating a view leaves you looking at it, so it is now where you left off.
      if (table && writable) void client.setLastView(table, saved.id).catch(() => undefined)
      reload()
    },
    [reload, client, table, writable],
  )

  const create = useCallback(
    (name: string) => {
      const trimmed = name.trim()
      if (!table || !trimmed) return
      // From scratch, deliberately: DEFAULT_CONFIG, not the current one. "Create new view" and
      // "Duplicate view" are the two halves of the same choice, and collapsing them into one
      // that always copies would leave no way to get back to an unfiltered table.
      void client
        .saveView(table, { name: trimmed, config: DEFAULT_CONFIG })
        .then(adopt)
        .catch((err: Error) => setError(err.message))
    },
    [client, table, adopt],
  )

  const duplicate = useCallback(
    (name: string) => {
      const trimmed = name.trim()
      if (!table || !trimmed) return
      // The *working* config, which under auto-save is also the saved one. This is the escape
      // hatch for the objection auto-save creates: explore in a copy, leave the original alone.
      void client
        .saveView(table, { name: trimmed, config })
        .then(adopt)
        .catch((err: Error) => setError(err.message))
    },
    [client, table, config, adopt],
  )

  /**
   * Rename without touching anything else.
   *
   * This is why `save-view` is a partial patch. It used to matter because the working config
   * was ahead of the saved one and a rename carrying it would commit edits nobody chose to
   * save. Under auto-save they are never far apart — but the reason to send the narrowest
   * patch survives and is now the stronger one: re-sending `config` from local state would let
   * a rename reassert whatever this client last read, over a change made in another window.
   */
  const rename = useCallback(
    (id: number, name: string) => {
      const trimmed = name.trim()
      if (!table || !trimmed) return
      void client
        .saveView(table, { id, name: trimmed })
        .then(() => reload())
        .catch((err: Error) => setError(err.message))
    },
    [client, table, reload],
  )

  const describe = useCallback(
    (id: number, description: string | null) => {
      if (!table) return
      void client
        .saveView(table, { id, description: description?.trim() ? description.trim() : null })
        .then(() => reload())
        .catch((err: Error) => setError(err.message))
    },
    [client, table, reload],
  )

  const setDefault = useCallback(
    (id: number) => {
      if (!table) return
      void client
        .saveView(table, { id, isDefault: true })
        // Reload rather than patching locally: the backend clears the flag on every other view
        // of this table, and the switcher has to stop labelling the old one as default.
        .then(() => reload())
        .catch((err: Error) => setError(err.message))
    },
    [client, table, reload],
  )

  /**
   * Delete a view and land somewhere valid.
   *
   * Deleting the last view does not leave the table without one — the backend mints a fresh
   * default on the next read. So this re-reads rather than assuming an empty list, and adopts
   * whatever came back. Selecting "no view" is not an option any more; there is no such state.
   */
  const remove = useCallback(
    (id: number) => {
      if (!table) return
      void client
        .deleteView(id)
        .then(() => client.views(table))
        .then((loaded) => {
          setViews(loaded)
          if (activeViewId !== id) return
          const next = loaded.find((v) => v.isDefault) ?? loaded[0]
          if (!next) return
          chosen.current = true
          setActiveViewId(next.id)
          setConfig(next.config)
          setBaseline(next.config)
          // The remembered id now points at a deleted view. The backend already resolves that
          // to nothing, but recording where we landed saves the next open a fallback.
          if (writable) void client.setLastView(table, next.id).catch(() => undefined)
        })
        .catch((err: Error) => setError(err.message))
    },
    [client, table, activeViewId],
  )

  const reorder = useCallback(
    (ids: number[]) => {
      if (!table) return
      setViews((prev) => {
        const byId = new Map(prev.map((v) => [v.id, v]))
        return ids.map((id) => byId.get(id)!).filter(Boolean)
      })
      void client
        .reorderViews(table, ids)
        .then((loaded) => setViews(loaded))
        .catch((err: Error) => setError(err.message))
    },
    [client, table],
  )

  const active = views.find((v) => v.id === activeViewId) ?? null

  return {
    views,
    activeViewId,
    active,
    config,
    writable,
    error,
    update,
    selectView,
    create,
    duplicate,
    rename,
    describe,
    setDefault,
    reorder,
    remove,
  }
}

// ---------------------------------------------------------------------------
// Deriving the rendered column list
// ---------------------------------------------------------------------------

export interface LaidOutColumn {
  descriptor: ColumnDescriptor
  width: number
}

export const DEFAULT_COLUMN_WIDTH = 160

/**
 * Apply a view's ordering, visibility, and widths to the table's real columns.
 *
 * Ordering is by *name*, and names in the config that no longer exist are dropped while
 * columns missing from the config are appended. A schema changing underneath a saved view is
 * the normal case here — an agent is editing it — so the view has to degrade rather than
 * either crash or silently hide the new column.
 */
export function layOutColumns(
  columns: ColumnDescriptor[],
  config: ViewConfig,
): LaidOutColumn[] {
  const byName = new Map(columns.map((c) => [c.name, c]))
  const ordered: ColumnDescriptor[] = []

  for (const name of config.columnOrder ?? []) {
    const column = byName.get(name)
    if (column) {
      ordered.push(column)
      byName.delete(name)
    }
  }
  // Anything the view has never seen goes to the end, visible.
  for (const column of columns) if (byName.has(column.name)) ordered.push(column)

  const visibility = config.columnVisibility ?? {}
  const widths = config.columnWidths ?? {}

  return ordered
    .filter((column) => visibility[column.name] !== false)
    .map((column) => ({
      descriptor: column,
      // Session drag wins, then the width stored per table in `_airsqlite_columns`, then the default.
      // Widths are deliberately not view state: they persist the moment they change, and they
      // do not jump around when you switch views.
      width: widths[column.name] ?? DEFAULT_COLUMN_WIDTH,
    }))
}
