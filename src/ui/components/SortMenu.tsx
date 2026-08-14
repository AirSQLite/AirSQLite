import { useCallback, useState } from 'preact/hooks'
import type { ColumnDescriptor, SortSpec } from '../../shared/protocol.js'
import { ColumnPicker, menuIcon } from './FieldTypeIcons.js'
import { useDismissOnOutside } from '../state/dismiss.js'

// Stacked sort rules, in one place.
//
// Sorting was reachable only from a column's own header menu, which makes a single sort easy
// and a multi-column sort nearly invisible: you had to know that shift-clicking the second
// column added to the first rather than replacing it, and once you had three rules there was
// nowhere to see them, no way to reorder them, and no way to drop the middle one.
//
// There is no "automatically sort records" toggle. Airtable has one, and it means "stop
// re-sorting rows as I edit them" — which needs a frozen snapshot of row order that survives
// edits. Rows here come from SQLite a window at a time, in whatever order the query says, so a
// snapshot would have to be materialised and kept in sync with every external write. Rules are
// either configured or cleared with the X; there is no third state.

export interface SortMenuProps {
  columns: ColumnDescriptor[]
  sort: SortSpec[]
  /** True when grouping is on — the grouped columns sort ahead of these, and it is worth saying. */
  groupedBy: string[]
  onChange: (sort: SortSpec[]) => void
}

export function SortMenu({ columns, sort, groupedBy, onChange }: SortMenuProps) {
  const [open, setOpen] = useState(false)
  const container = useDismissOnOutside(
    open,
    useCallback(() => setOpen(false), []),
  )

  // Created and Modified come from the changelog and exist in no SQLite table, so there is
  // nothing for ORDER BY to name.
  const sortable = columns.filter((column) => !column.virtual)
  const used = new Set(sort.map((rule) => rule.column))
  const unused = sortable.filter((column) => !used.has(column.name))

  const replace = (index: number, patch: Partial<SortSpec>) =>
    onChange(sort.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))

  return (
    <span class="afs-columns-menu" ref={container}>
      <button
        type="button"
        class={`afs-button${sort.length > 0 ? ' afs-button--primary' : ''}`}
        data-testid="sort-toggle"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        Sort{sort.length > 0 ? ` (${sort.length})` : ''}
      </button>

      {open ? (
        <div class="afs-menu afs-menu--anchored" data-testid="sort-menu" role="menu">
          {groupedBy.length > 0 ? (
            <p class="afs-menu__hint" data-testid="sort-group-note">
              Grouped by {groupedBy.join(', ')} — these rules sort within each group.
            </p>
          ) : null}

          {sort.length === 0 ? (
            <p class="afs-menu__hint" data-testid="sort-empty">
              No sort rules. Records appear in the order SQLite returns them.
            </p>
          ) : null}

          <ul class="afs-sort__list" data-testid="sort-list">
            {sort.map((rule, index) => (
              <li key={rule.column} class="afs-sort__row" data-sort-column={rule.column}>
                <span class="afs-sort__ordinal">{index === 0 ? 'Sort by' : 'then by'}</span>

                <ColumnPicker
                  columns={sortable.filter((column) => column.name === rule.column || !used.has(column.name))}
                  value={rule.column}
                  testId={`sort-column-${index}`}
                  class="afs-sort__column"
                  onChange={(name) => replace(index, { column: name })}
                />

                <select
                  class="afs-sort__direction"
                  data-testid={`sort-direction-${index}`}
                  value={rule.direction}
                  onChange={(event) =>
                    replace(index, {
                      direction: (event.currentTarget as HTMLSelectElement).value as
                        | 'asc'
                        | 'desc',
                    })
                  }
                >
                  <option value="asc">A → Z</option>
                  <option value="desc">Z → A</option>
                </select>

                <button
                  type="button"
                  class="afs-sort__remove"
                  data-testid={`sort-remove-${index}`}
                  title={`Stop sorting by ${rule.column}`}
                  aria-label={`Stop sorting by ${rule.column}`}
                  onClick={() => onChange(sort.filter((_, i) => i !== index))}
                >
                  <span dangerouslySetInnerHTML={{ __html: menuIcon('x', { size: 14 }) }} />
                </button>
              </li>
            ))}
          </ul>

          <div class="afs-sort__actions">
            {/* Adding appends, so the click order is the precedence order — which is the only
                reading of "then by" that does not need explaining. */}
            <button
              type="button"
              class="afs-button"
              data-testid="sort-add"
              disabled={unused.length === 0}
              onClick={() => {
                const next = unused[0]
                if (next) onChange([...sort, { column: next.name, direction: 'asc' }])
              }}
            >
              <span dangerouslySetInnerHTML={{ __html: menuIcon('plus', { size: 14 }) }} /> Sort rule
            </button>

            <button
              type="button"
              class="afs-button"
              data-testid="sort-clear"
              disabled={sort.length === 0}
              title="Clear every sort rule"
              onClick={() => onChange([])}
            >
              <span dangerouslySetInnerHTML={{ __html: menuIcon('x', { size: 14 }) }} /> Clear
            </button>
          </div>
        </div>
      ) : null}
    </span>
  )
}
