import { useCallback, useState } from 'preact/hooks'

// Drag-to-reorder, once, for everything that has it.
//
// There were two implementations before this — tabs and column headers — and a third was about
// to arrive for select options. They disagreed about the thing that actually matters, which is
// what the user is told *during* the drag:
//
//   - Column headers showed nothing at all. You dragged, you released, and you found out.
//   - Tabs highlighted the tab that would be displaced, which is not where the item lands. Drag
//     right and it lands after that tab; drag left and it lands before. Same highlight, two
//     different outcomes.
//
// So the primitive is built around an *insertion point*, not a target: which gap the item drops
// into, decided by whether the pointer is past the midpoint of whatever it is over. That is the
// only reading that stays true in both directions, and it is what the line gets drawn on.

export type DropEdge = 'before' | 'after'

export interface ReorderOptions {
  /** The current order, as stable keys. */
  items: string[]
  onReorder: (next: string[]) => void
  /** False disables dragging outright — a read-only file, or a list too short to reorder. */
  enabled?: boolean
  /** Which axis the items run along. Decides whether the midpoint test uses x or y. */
  orientation?: 'horizontal' | 'vertical'
}

export interface ItemDragProps {
  draggable: boolean
  onDragStart: (event: DragEvent) => void
  onDragOver: (event: DragEvent) => void
  onDragLeave: () => void
  onDrop: (event: DragEvent) => void
  onDragEnd: () => void
}

export interface Reorder {
  /** The key being dragged, for the "lifted" styling. */
  dragging: string | null
  /** Which edge of this item the insertion line belongs on, if any. */
  edge(key: string): DropEdge | null
  /** Spread onto each reorderable item. */
  itemProps(key: string): ItemDragProps
}

/**
 * Move `moved` into the gap on `edge` of `key`.
 *
 * The dragged item is removed *first* and the target index resolved afterwards, which is what
 * makes dragging left and dragging right symmetric. Resolving against the original array is the
 * classic off-by-one here: every index past the dragged item shifts by one once it is lifted.
 */
export function reorderInto(
  items: string[],
  moved: string,
  key: string,
  edge: DropEdge,
): string[] | null {
  if (moved === key) return null
  const rest = items.filter((item) => item !== moved)
  const index = rest.indexOf(key)
  if (index < 0) return null

  const at = edge === 'after' ? index + 1 : index
  rest.splice(at, 0, moved)

  // A drag that changes nothing still fires a drop. Reporting it would write a view config and,
  // in a list of two, look like the drag failed.
  if (rest.every((item, i) => item === items[i])) return null
  return rest
}

export function useReorder(options: ReorderOptions): Reorder {
  const { items, onReorder, enabled = true, orientation = 'horizontal' } = options
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<{ key: string; edge: DropEdge } | null>(null)

  const clear = useCallback(() => {
    setDragging(null)
    setOver(null)
  }, [])

  const edge = useCallback(
    (key: string): DropEdge | null => {
      if (!dragging || !over || over.key !== key) return null
      // No line on the item being dragged: it is the thing moving, not a place to put it.
      if (key === dragging) return null
      return over.edge
    },
    [dragging, over],
  )

  const itemProps = useCallback(
    (key: string): ItemDragProps => ({
      draggable: enabled,
      onDragStart: () => setDragging(key),
      onDragOver: (event: DragEvent) => {
        if (!dragging) return
        // Without preventDefault the browser refuses the drop and shows a "no entry" cursor,
        // which reads as reordering not being supported at all.
        event.preventDefault()
        const target = event.currentTarget as HTMLElement | null
        if (!target) return
        const rect = target.getBoundingClientRect()
        const past =
          orientation === 'horizontal'
            ? event.clientX > rect.left + rect.width / 2
            : event.clientY > rect.top + rect.height / 2
        setOver({ key, edge: past ? 'after' : 'before' })
      },
      onDragLeave: () => setOver((prev) => (prev?.key === key ? null : prev)),
      onDrop: (event: DragEvent) => {
        event.preventDefault()
        if (dragging && over) {
          const next = reorderInto(items, dragging, over.key, over.edge)
          if (next) onReorder(next)
        }
        clear()
      },
      onDragEnd: clear,
    }),
    [enabled, dragging, over, items, onReorder, orientation, clear],
  )

  return { dragging, edge, itemProps }
}
