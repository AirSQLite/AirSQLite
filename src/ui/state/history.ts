import { useCallback, useRef, useState } from 'preact/hooks'
import type { Row, SqlValue } from '../../shared/protocol.js'

// Undo/redo.
//
// The stack holds *inverses*, captured at the moment each mutation is issued, when the old
// values are still in hand. It is deliberately not derived from the changelog: that file also
// records what external writers did, and undoing an agent's write because it happened to be
// the last line would be a serious misfire in an app whose whole point is watching agents
// work.
//
// Session-scoped, per the requirements. Nothing here is persisted.

const LIMIT = 100

export interface EditStep {
  kind: 'edit'
  table: string
  rowid: number
  field: string
  before: SqlValue
  after: SqlValue
}

export interface BulkEditStep {
  kind: 'bulk-edit'
  table: string
  field: string
  /** Previous value per row — a bulk edit is only one *gesture*, not one value. */
  before: Array<[number, SqlValue]>
  after: SqlValue
}

/** Rows removed, whole, so undo can put back the same records rather than equivalent ones. */
export interface DeleteStep {
  kind: 'delete'
  table: string
  rows: Row[]
}

export interface InsertStep {
  kind: 'insert'
  table: string
  rowids: number[]
}

export type Step = EditStep | BulkEditStep | DeleteStep | InsertStep

/** What a step needs from the outside world to be applied in either direction. */
export interface HistoryOps {
  update: (table: string, rowid: number, field: string, value: SqlValue) => Promise<unknown>
  bulkUpdate: (table: string, rowids: number[], field: string, value: SqlValue) => Promise<unknown>
  insert: (table: string, values: Record<string, SqlValue>, rowid?: number) => Promise<unknown>
  remove: (table: string, rowids: number[]) => Promise<unknown>
}

/** Strip the virtual system columns — they are derived, and no table has them to insert into. */
function storable(row: Row): Record<string, SqlValue> {
  const values: Record<string, SqlValue> = {}
  for (const [key, value] of Object.entries(row)) {
    if (key === 'rowid' || key.startsWith('__')) continue
    values[key] = value
  }
  return values
}

async function apply(step: Step, direction: 'undo' | 'redo', ops: HistoryOps): Promise<void> {
  const undoing = direction === 'undo'

  switch (step.kind) {
    case 'edit':
      await ops.update(step.table, step.rowid, step.field, undoing ? step.before : step.after)
      return

    case 'bulk-edit':
      if (undoing) {
        // Row by row, because each one had its own previous value. Grouping them by value
        // would be an optimisation for the common case that silently mangles the rest.
        for (const [rowid, value] of step.before) {
          await ops.update(step.table, rowid, step.field, value)
        }
        return
      }
      await ops.bulkUpdate(
        step.table,
        step.before.map(([rowid]) => rowid),
        step.field,
        step.after,
      )
      return

    case 'delete':
      if (undoing) {
        for (const row of step.rows) {
          if (row.rowid === null) continue
          await ops.insert(step.table, storable(row), row.rowid)
        }
        return
      }
      await ops.remove(
        step.table,
        step.rows.map((row) => row.rowid).filter((id): id is number => id !== null),
      )
      return

    case 'insert':
      if (undoing) {
        await ops.remove(step.table, step.rowids)
        return
      }
      // Redoing an add cannot recover the row's contents — it was blank when created, and
      // anything typed into it afterwards is its own step on the stack.
      for (const rowid of step.rowids) await ops.insert(step.table, {}, rowid)
      return
  }
}

export function useHistory(ops: HistoryOps) {
  const undoStack = useRef<Step[]>([])
  const redoStack = useRef<Step[]>([])
  // Depth is state rather than a ref so the toolbar can disable its buttons.
  const [depth, setDepth] = useState({ undo: 0, redo: 0 })

  const sync = useCallback(() => {
    setDepth({ undo: undoStack.current.length, redo: redoStack.current.length })
  }, [])

  const record = useCallback(
    (step: Step) => {
      undoStack.current.push(step)
      if (undoStack.current.length > LIMIT) undoStack.current.shift()
      // A new action makes the redo branch unreachable, which is what every editor does.
      redoStack.current = []
      sync()
    },
    [sync],
  )

  /**
   * Take a step back off the stack because the write it describes was rejected.
   *
   * Steps are recorded when a mutation is *issued*, not when it succeeds — otherwise Cmd+Z
   * pressed in the moment before the response lands finds an empty stack and does nothing,
   * which is a real thing a fast typist does. The cost of that is this: a write that fails
   * has to take its step back out.
   */
  const drop = useCallback(
    (step: Step) => {
      const index = undoStack.current.lastIndexOf(step)
      if (index !== -1) undoStack.current.splice(index, 1)
      sync()
    },
    [sync],
  )

  const run = useCallback(
    async (direction: 'undo' | 'redo'): Promise<Step | null> => {
      const from = direction === 'undo' ? undoStack.current : redoStack.current
      const to = direction === 'undo' ? redoStack.current : undoStack.current
      const step = from.pop()
      if (!step) {
        sync()
        return null
      }

      try {
        await apply(step, direction, ops)
        to.push(step)
        return step
      } catch (err) {
        // The step could not be applied — the row is gone, or a value it would restore now
        // collides with something written since. Dropping it keeps the stack honest about
        // what it can still do, rather than leaving an entry that will fail again.
        throw err
      } finally {
        sync()
      }
    },
    [ops, sync],
  )

  const clear = useCallback(() => {
    undoStack.current = []
    redoStack.current = []
    sync()
  }, [sync])

  return {
    record,
    drop,
    undo: () => run('undo'),
    redo: () => run('redo'),
    clear,
    canUndo: depth.undo > 0,
    canRedo: depth.redo > 0,
  }
}
