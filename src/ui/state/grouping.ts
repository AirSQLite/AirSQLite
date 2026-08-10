import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'
import type { GroupInfo, SqlValue } from '../../shared/protocol.js'
import type { Client } from './client.js'
import type { QuerySpec, TableData } from './store.js'

// Grouping, without giving up virtual scroll.
//
// The grid's whole performance story is that scroll offset ÷ row height gives a row index in
// one division. Grouping threatens that twice: headers are display rows that are not records,
// and a collapsed group hides records. Both are survivable because of one property of the
// backend — grouping columns sort *ahead* of the user's sort, so each group's records are a
// contiguous run whose absolute offset is just the sum of the counts before it. Collapsing
// removes display slots; it never moves a row.
//
// So there are two index spaces. A *display index* addresses what is on screen, headers
// included. A *row index* addresses the server's ordering and is what the chunk cache is
// keyed by. The segment table below converts between them in a binary search over a list
// whose length is the number of groups, not the number of rows.

export interface GroupNode {
  /** Grouping-column values down to this node, outermost first. Doubles as its identity. */
  values: SqlValue[]
  depth: number
  /** Records beneath this node, nested ones included. */
  count: number
  /** Absolute row offset of this node's first record in the server ordering. */
  rowStart: number
  children: GroupNode[]
}

/** What occupies one display slot. */
export type DisplayItem =
  | { kind: 'header'; node: GroupNode; collapsed: boolean }
  | { kind: 'row'; rowIndex: number }

/**
 * What the grid renders from: a flat list of display slots it can look up by index without
 * materialising one entry per row.
 */
export interface GridView {
  /** Total display slots — records plus headers, minus anything collapsed. */
  length: number
  at: (index: number) => DisplayItem | undefined
  /** Fetch whatever rows back this display range. */
  ensure: (start: number, end: number) => void
  grouped: boolean
}

/** A run of display slots backed by one thing. There is one of these per group, not per row. */
interface Segment {
  displayStart: number
  displayCount: number
  kind: 'header' | 'rows'
  node: GroupNode
  /** Absolute row offset of the first record — meaningful for `rows` segments. */
  rowStart: number
}

export function groupKey(values: SqlValue[]): string {
  // JSON rather than join: it keeps null distinct from the string "null", and from a value
  // that happens to contain the separator.
  return JSON.stringify(values)
}

/**
 * Turn the backend's flat list of leaf groups into a tree.
 *
 * The leaves arrive ordered by every grouping column, so a parent is simply a run of
 * consecutive leaves sharing a prefix — no sorting, no grouping pass, one walk.
 */
export function buildGroupTree(groups: GroupInfo[], depth: number): GroupNode[] {
  if (depth === 0 || groups.length === 0) return []

  const roots: GroupNode[] = []
  let rowStart = 0

  for (const group of groups) {
    let siblings = roots
    let parent: GroupNode | null = null

    for (let level = 0; level < depth; level++) {
      const values = group.values.slice(0, level + 1)
      const id = groupKey(values)
      const last = siblings[siblings.length - 1]

      let node: GroupNode
      if (last && groupKey(last.values) === id) {
        node = last
      } else {
        node = { values, depth: level, count: 0, rowStart, children: [] }
        siblings.push(node)
      }

      node.count += group.count
      parent = node
      siblings = node.children
    }

    if (parent) rowStart = parent.rowStart + parent.count
  }

  return roots
}

/** Flatten a tree into display segments, honouring which nodes are collapsed. */
export function layoutGroups(nodes: GroupNode[], collapsed: Set<string>): {
  segments: Segment[]
  length: number
} {
  const segments: Segment[] = []
  let display = 0

  const walk = (list: GroupNode[]): void => {
    for (const node of list) {
      segments.push({
        displayStart: display,
        displayCount: 1,
        kind: 'header',
        node,
        rowStart: node.rowStart,
      })
      display += 1

      if (collapsed.has(groupKey(node.values))) continue

      if (node.children.length > 0) {
        walk(node.children)
      } else if (node.count > 0) {
        segments.push({
          displayStart: display,
          displayCount: node.count,
          kind: 'rows',
          node,
          rowStart: node.rowStart,
        })
        display += node.count
      }
    }
  }

  walk(nodes)
  return { segments, length: display }
}

/** Which segment holds a display index. Binary search — the list is per group, not per row. */
function findSegment(segments: Segment[], index: number): Segment | undefined {
  let low = 0
  let high = segments.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const segment = segments[mid]!
    if (index < segment.displayStart) high = mid - 1
    else if (index >= segment.displayStart + segment.displayCount) low = mid + 1
    else return segment
  }
  return undefined
}

/** The ungrouped case: display index and row index are the same number. */
export function flatView(data: TableData): GridView {
  return {
    length: data.rowCount,
    at: (index) => (index < data.rowCount ? { kind: 'row', rowIndex: index } : undefined),
    ensure: (start, end) => data.ensureRange(start, end),
    grouped: false,
  }
}

export function groupedView(
  data: TableData,
  segments: Segment[],
  length: number,
  collapsed: Set<string>,
): GridView {
  return {
    length,
    grouped: true,
    at(index) {
      const segment = findSegment(segments, index)
      if (!segment) return undefined
      if (segment.kind === 'header') {
        return { kind: 'header', node: segment.node, collapsed: collapsed.has(groupKey(segment.node.values)) }
      }
      return { kind: 'row', rowIndex: segment.rowStart + (index - segment.displayStart) }
    },
    ensure(start, end) {
      // A display range can straddle several groups, and the row ranges behind them are not
      // contiguous when anything between is collapsed. Ask per segment rather than for one
      // span, or a collapsed group in the middle would pull in every row it is hiding.
      for (const segment of segments) {
        if (segment.kind !== 'rows') continue
        if (segment.displayStart >= end) break
        if (segment.displayStart + segment.displayCount <= start) continue

        const from = Math.max(start, segment.displayStart)
        const to = Math.min(end, segment.displayStart + segment.displayCount)
        data.ensureRange(
          segment.rowStart + (from - segment.displayStart),
          segment.rowStart + (to - segment.displayStart) - 1,
        )
      }
    },
  }
}

/**
 * Fetch the group list for the current table and query, and hold which nodes are collapsed.
 *
 * Collapse state is session-scoped on purpose. It is not in `ViewConfig`: a saved view
 * describes how a table is *arranged*, and which twisties happen to be open is a scroll
 * position, not an arrangement.
 */
export function useGrouping(
  client: Client,
  table: string | null,
  columns: string[],
  spec: QuerySpec,
) {
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const specKey = JSON.stringify({ filter: spec.filter, search: spec.search, columns })

  useEffect(() => {
    setGroups([])
    setError(null)
    if (!table || columns.length === 0) return

    let cancelled = false
    void client
      .groups(table, columns, spec)
      .then((result) => {
        if (!cancelled) setGroups(result)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- specKey stands in for spec
  }, [client, table, specKey])

  // Collapsing survives a refetch but not a change of grouping: the node identities would
  // mean something different, so keeping them would collapse arbitrary groups.
  useEffect(() => setCollapsed(new Set()), [table, columns.join(' ')])

  const tree = useMemo(() => buildGroupTree(groups, columns.length), [groups, columns.length])

  const toggle = useCallback((values: SqlValue[]) => {
    const id = groupKey(values)
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const collapseAll = useCallback(() => {
    const ids: string[] = []
    const walk = (nodes: GroupNode[]): void => {
      for (const node of nodes) {
        ids.push(groupKey(node.values))
        walk(node.children)
      }
    }
    walk(tree)
    setCollapsed(new Set(ids))
  }, [tree])

  const expandAll = useCallback(() => setCollapsed(new Set()), [])

  return { groups, tree, collapsed, error, toggle, collapseAll, expandAll }
}
