import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { DisplayType, SqlValue, SummaryFunction, SummaryResult } from '../../shared/protocol.js'
import type { LaidOutColumn } from '../state/views.js'
import { formatCurrency, formatValue } from './CellValue.js'

// The summary bar: one aggregate per column, along the bottom, over the rows the current
// filter and search actually left. It lines up with the columns above it — a total that does
// not sit under the column it totals is a number you have to go and match up by hand.

const FUNCTIONS: Array<{ value: SummaryFunction; label: string }> = [
  { value: 'sum', label: 'Sum' },
  { value: 'average', label: 'Average' },
  { value: 'count', label: 'Count' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'count_empty', label: 'Empty' },
  { value: 'count_not_empty', label: 'Filled' },
  { value: 'percent_empty', label: '% empty' },
]

const LABELS = new Map(FUNCTIONS.map((f) => [f.value, f.label]))

/** Functions whose result is still in the column's own units. Counts and percentages are not. */
const MONETARY = new Set<SummaryFunction>(['sum', 'average', 'min', 'max'])

export interface SummaryBarProps {
  columns: LaidOutColumn[]
  /** How much chrome sits left of the data columns, so the cells line up with the grid. */
  leadingWidth: number
  /** How many data columns are frozen in the grid above. */
  frozenCount: number
  summary: Record<string, SummaryFunction>
  values: SummaryResult
  /** The grid's horizontal scroll offset, so the totals stay under their columns. */
  scrollLeft: number
  onChange: (column: string, fn: SummaryFunction | null) => void
  addRow?: () => void
  recordCount?: number
  totalCount?: number
  trailingWidth?: number
}

export function SummaryBar({
  columns,
  leadingWidth,
  frozenCount,
  summary,
  values,
  scrollLeft,
  onChange,
  addRow,
  recordCount,
  totalCount,
  trailingWidth,
}: SummaryBarProps) {
  const [open, setOpen] = useState<string | null>(null)
  /**
   * Where to draw the open menu, in viewport coordinates.
   *
   * The menu is `position: fixed`, which is the only way out of here: this bar has to clip
   * horizontally to scroll with the grid, and an element that clips on one axis clips on both —
   * `overflow-x: auto` forces `overflow-y` to compute to `auto`, not `visible`. So a menu
   * positioned inside the bar is painted nowhere, which is exactly how this looked: clicking a
   * summary cell appeared to do nothing at all.
   */
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const bar = useRef<HTMLDivElement>(null)

  // Track the grid's horizontal scroll. Assigning scrollLeft rather than translating keeps the
  // bar's own layout identical to the grid's, so the columns cannot drift apart.
  useLayoutEffect(() => {
    if (bar.current && bar.current.scrollLeft !== scrollLeft) bar.current.scrollLeft = scrollLeft
  }, [scrollLeft, columns])

  // A fixed-position menu does not move with the bar, so anything that would move it closes it
  // instead — otherwise it hangs in mid-air over the wrong column.
  useEffect(() => {
    if (!open) return
    const close = () => {
      setOpen(null)
      setAnchor(null)
    }
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (!target.closest('.afs-summary__cell') && !target.closest('.afs-menu')) close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    bar.current?.addEventListener('scroll', close)
    const scroller = bar.current
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      scroller?.removeEventListener('scroll', close)
    }
  }, [open])

  const frozenOffsets: number[] = []
  let offset = leadingWidth
  for (let i = 0; i < frozenCount && i < columns.length; i++) {
    frozenOffsets.push(offset)
    offset += columns[i]!.width
  }

  return (
    <div class="afs-summary" data-testid="summary-bar" ref={bar}>
      <div
        class={`afs-summary__lead${leadingWidth > 0 ? ' afs-summary__lead--frozen' : ''}`}
        data-testid="status-bar"
        style={leadingWidth > 0 ? { width: `${leadingWidth}px` } : undefined}
      >
        {addRow ? (
          <button type="button" class="afs-summary__add" data-testid="add-row" onClick={addRow}>
            +
          </button>
        ) : null}
        <span class="afs-summary__count" data-testid="row-count">
          {totalCount !== undefined && recordCount !== undefined
            ? recordCount === totalCount
              ? `${totalCount.toLocaleString()} records`
              : `Showing ${recordCount.toLocaleString()} of ${totalCount.toLocaleString()} records`
            : null}
        </span>
      </div>

      {columns.map(({ descriptor, width }, index) => {
        const fn = summary[descriptor.name]
        const isOpen = open === descriptor.name
        const frozen = index < frozenCount

        return (
          <div
            key={descriptor.name}
            class={`afs-summary__cell${frozen ? ' afs-summary__cell--frozen' : ''}`}
            style={{
              width: `${width}px`,
              minWidth: `${width}px`,
              ...(frozen ? { left: `${frozenOffsets[index]}px` } : undefined),
            }}
            data-column={descriptor.name}
          >
            <button
              type="button"
              class="afs-summary__button"
              data-testid={`summary-open-${descriptor.name}`}
              // Virtual columns have no column behind them for SQL to aggregate.
              disabled={descriptor.virtual}
              onClick={(event) => {
                if (isOpen) {
                  setOpen(null)
                  setAnchor(null)
                  return
                }
                const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
                setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top })
                setOpen(descriptor.name)
              }}
            >
              {fn ? (
                <>
                  <span class="afs-summary__label">{LABELS.get(fn)}</span>
                  <span class="afs-summary__value" data-testid={`summary-${descriptor.name}`}>
                    {display(values[descriptor.name], descriptor.displayType, fn, descriptor.options)}
                  </span>
                </>
              ) : (
                <span class="afs-summary__empty">—</span>
              )}
            </button>

            {isOpen && anchor ? (
              <div
                class="afs-menu afs-menu--fixed"
                data-testid="summary-menu"
                style={{ left: `${anchor.left}px`, bottom: `${anchor.bottom}px` }}
              >
                <button
                  type="button"
                  class="afs-menu__item"
                  data-testid="summary-none"
                  onClick={() => {
                    onChange(descriptor.name, null)
                    setOpen(null)
                    setAnchor(null)
                  }}
                >
                  None
                </button>
                {FUNCTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    class="afs-menu__item"
                    aria-pressed={fn === option.value}
                    data-testid={`summary-pick-${option.value}`}
                    onClick={() => {
                      onChange(descriptor.name, option.value)
                      setOpen(null)
                      setAnchor(null)
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
      {trailingWidth ? <div style={{ width: `${trailingWidth}px`, flex: '0 0 auto' }} /> : null}
    </div>
  )
}

/**
 * A summary of nothing is not zero. SUM over an empty set and AVG over all-NULL both come
 * back NULL, and printing 0 there would assert something the data does not say.
 */
function display(value: SqlValue | undefined, type?: DisplayType, fn?: SummaryFunction, options?: Record<string, unknown> | null): string {
  if (value === null || value === undefined) return '—'

  if (type === 'currency' && fn && MONETARY.has(fn)) {
    const showCents = (options?.showCents as boolean) ?? true
    const money = formatCurrency(value, showCents)
    if (money !== null) return money
  }

  if (type === 'percent' && fn && MONETARY.has(fn)) {
    const n = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(n)) return `${(n * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
  }

  if (typeof value === 'number' && !Number.isInteger(value)) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  }
  if (typeof value === 'number') return value.toLocaleString()
  return formatValue(value)
}
