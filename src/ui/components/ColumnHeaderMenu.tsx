import { useEffect, useRef, useState } from 'preact/hooks'
import type { ColumnDescriptor, DisplayType } from '../../shared/protocol.js'
import { ChoiceEditor } from './ChoiceEditor.js'
import { TypePicker, menuIcon } from './FieldTypeIcons.js'
import { addValues, parseOptions, serializeOptions, type ChoiceOptions } from '../state/choices.js'

// The column header menu: sort, hide, freeze, and field type.
//
// Reordering and resizing are not here because they are direct manipulation — drag the header
// to move a column, drag its right edge to resize. A menu entry for something you can do by
// dragging the thing itself is a worse version of the same feature.

const TYPES: Array<{ value: DisplayType; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'long_text', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency (USD)' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'toggle', label: 'Toggle' },
  { value: 'single_select', label: 'Single select' },
  { value: 'multi_select', label: 'Multi-select' },
  { value: 'date', label: 'Date' },
  { value: 'url', label: 'URL' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'percent', label: 'Percent' },
  { value: 'duration', label: 'Duration' },
  { value: 'rating', label: 'Rating' },
]

const HAS_CHOICES = new Set<DisplayType>(['single_select', 'multi_select'])

export interface ColumnHeaderMenuProps {
  column: ColumnDescriptor
  sortDirection: 'asc' | 'desc' | null
  canConfigure: boolean
  frozen: boolean
  onSort: (direction: 'asc' | 'desc' | null, additive: boolean) => void
  onHide: () => void
  onFreezeThrough: () => void
  onSetDisplayType: (type: DisplayType, options: Record<string, unknown> | null) => void
  onSetDescription: (description: string | null) => void
  /** The values this column already holds, for seeding a freshly converted select field. */
  onHarvestValues: () => Promise<string[]>
  /** True when this is already the table's primary field, so the item is not offered. */
  isPrimary: boolean
  onSetPrimary: () => void
  onDuplicate: () => void
  onDelete: () => void
  onInsert: (side: 'left' | 'right') => void
  onClose: () => void
  allDateColumns: string[]
  onSetAllTimezones: (tz: string) => void
  onSplitCommaValues: (column: string) => Promise<number>
  onConfirmCommaSplit: (column: string, values: string[], applyType: () => void) => void
}

export function ColumnHeaderMenu({
  column,
  sortDirection,
  canConfigure,
  frozen,
  onSort,
  onHide,
  onFreezeThrough,
  onSetDisplayType,
  onSetDescription,
  onHarvestValues,
  isPrimary,
  onSetPrimary,
  onDuplicate,
  onDelete,
  onInsert,
  onClose,
  allDateColumns,
  onSetAllTimezones,
  onSplitCommaValues,
  onConfirmCommaSplit,
}: ColumnHeaderMenuProps) {
  const container = useRef<HTMLDivElement>(null)
  const current = column.displayType ?? 'text'
  const [choices, setChoices] = useState<ChoiceOptions>(() => parseOptions(column.options))
  const [description, setDescription] = useState(column.description ?? '')

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  /**
   * Switching to a select type harvests the column's existing values into the option list.
   *
   * Converting a column that already holds "Won", "Lost", "Open" and finding an empty option
   * list is the moment the feature looks broken — the data is right there. `sampleValues` comes
   * from the descriptor, so this is the distinct values the backend already sampled rather than
   * a new query.
   */
  const applyType = (type: DisplayType) => {
    if (!HAS_CHOICES.has(type)) {
      onSetDisplayType(type, null)
      return
    }

    const finish = (opts: ChoiceOptions) => {
      onSetDisplayType(type, serializeOptions(opts))
    }

    const checkCommas = (opts: ChoiceOptions) => {
      if (type !== 'multi_select' || current === 'multi_select') {
        finish(opts)
        return
      }
      void onHarvestValues().then((values) => {
        const withCommas = values.filter((v) => v.includes(','))
        if (withCommas.length > 0) {
          onConfirmCommaSplit(column.name, withCommas, () => finish(opts))
        } else {
          finish(opts)
        }
      })
    }

    if (choices.choices.length > 0) {
      checkCommas(choices)
      return
    }
    void onHarvestValues().then((values) => {
      const harvested = addValues(choices, values)
      setChoices(harvested)
      checkCommas(harvested)
    })
  }

  return (
    <div class="afs-menu" ref={container} data-testid="column-menu" role="menu">
      {column.virtual ? (
        <div class="afs-menu__note" data-testid="menu-virtual-note">
          Derived from the change history — not stored in the table.
        </div>
      ) : null}

      {column.virtual && current === 'date' && canConfigure ? (
        <div class="afs-menu__section">
          <DateOptions
            options={column.options ?? null}
            onChange={(next) => onSetDisplayType('date', next)}
            allDateColumns={allDateColumns}
            onSetAllTimezones={onSetAllTimezones}
          />
        </div>
      ) : null}

      {/* --- Group 1: Field type, description, primary --- */}
      {column.virtual ? null : (
      <div class="afs-menu__section">
        <label class="afs-menu__label">Field type</label>
        <TypePicker
          types={TYPES}
          value={current}
          disabled={!canConfigure}
          testId="menu-type"
          onChange={(v) => applyType(v as DisplayType)}
        />

        {HAS_CHOICES.has(current) ? (
          <ChoiceEditor
            options={choices}
            disabled={!canConfigure}
            onChange={(next) => {
              setChoices(next)
              onSetDisplayType(current, serializeOptions(next))
            }}
          />
        ) : null}

        {current === 'date' && canConfigure ? (
          <DateOptions
            options={column.options ?? null}
            onChange={(next) => onSetDisplayType('date', next)}
            allDateColumns={allDateColumns}
            onSetAllTimezones={onSetAllTimezones}
          />
        ) : null}

        {current === 'rating' && canConfigure ? (
          <label class="afs-menu__label" for={`rating-max-${column.name}`}>
            Max stars
            <select
              id={`rating-max-${column.name}`}
              class="afs-menu__select"
              data-testid="menu-rating-max"
              value={String((column.options?.max as number) ?? 5)}
              onChange={(event) => {
                const max = Number((event.currentTarget as HTMLSelectElement).value)
                onSetDisplayType('rating', { ...column.options, max })
              }}
            >
              {Array.from({ length: 10 }, (_, i) => (
                <option key={i + 1} value={String(i + 1)}>{i + 1}</option>
              ))}
            </select>
          </label>
        ) : null}

        {!canConfigure ? (
          <p class="afs-menu__hint">This database is read-only, so field types can't be saved.</p>
        ) : null}

        {canConfigure ? (
          <>
            <label class="afs-menu__label" for={`description-${column.name}`}>
              Field description
            </label>
            <input
              id={`description-${column.name}`}
              class="afs-menu__input"
              data-testid="menu-description"
              placeholder="What this field is for"
              value={description}
              onInput={(event) => setDescription((event.currentTarget as HTMLInputElement).value)}
              onBlur={() => onSetDescription(description.trim() ? description.trim() : null)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  onSetDescription(description.trim() ? description.trim() : null)
                  onClose()
                }
              }}
            />
          </>
        ) : null}

        {canConfigure ? (
          isPrimary ? (
            <p class="afs-menu__hint" data-testid="menu-is-primary">
              This is the primary field — it labels linked records and stays leftmost.
            </p>
          ) : (
            <button
              type="button"
              class="afs-menu__item"
              data-testid="menu-set-primary"
              onClick={() => {
                onSetPrimary()
                onClose()
              }}
            >
              <span class="afs-menu__item-icon" dangerouslySetInnerHTML={{ __html: menuIcon('primary', { size: 14 }) }} />
              Set as primary field
            </button>
          )
        ) : null}
      </div>
      )}

      {/* --- Group 2: Sort, hide, freeze --- */}
      <div class="afs-menu__section">
        {column.virtual ? null : (
          <>
            <button
              type="button"
              class="afs-menu__item"
              data-testid="menu-sort-asc"
              aria-pressed={sortDirection === 'asc'}
              title="Shift-click to add to the existing sort"
              onClick={(event) => onSort(sortDirection === 'asc' ? null : 'asc', event.shiftKey)}
            >
              <span class="afs-menu__item-icon" dangerouslySetInnerHTML={{ __html: menuIcon('sort_asc', { size: 14 }) }} />
              Sort ascending
            </button>
            <button
              type="button"
              class="afs-menu__item"
              data-testid="menu-sort-desc"
              aria-pressed={sortDirection === 'desc'}
              title="Shift-click to add to the existing sort"
              onClick={(event) => onSort(sortDirection === 'desc' ? null : 'desc', event.shiftKey)}
            >
              <span class="afs-menu__item-icon" dangerouslySetInnerHTML={{ __html: menuIcon('sort_desc', { size: 14 }) }} />
              Sort descending
            </button>
          </>
        )}
        <button type="button" class="afs-menu__item" data-testid="menu-hide" onClick={onHide}>
          <span class="afs-menu__item-icon" dangerouslySetInnerHTML={{ __html: menuIcon('hide', { size: 14 }) }} />
          Hide column
        </button>
        <button
          type="button"
          class="afs-menu__item"
          data-testid="menu-freeze"
          onClick={onFreezeThrough}
        >
          <span class="afs-menu__item-icon" dangerouslySetInnerHTML={{ __html: menuIcon('freeze', { size: 14 }) }} />
          {frozen ? 'Unfreeze columns' : 'Freeze up to this column'}
        </button>
      </div>

      {/* --- Group 3: Insert, duplicate, delete column --- */}
      {column.virtual || !canConfigure ? null : (
        <div class="afs-menu__section">
          <button
            type="button"
            class="afs-menu__item"
            data-testid="menu-insert-left"
            onClick={() => {
              onInsert('left')
              onClose()
            }}
          >
            <span class="afs-menu__item-icon" dangerouslySetInnerHTML={{ __html: menuIcon('insert_left', { size: 14 }) }} />
            Insert column left
          </button>
          <button
            type="button"
            class="afs-menu__item"
            data-testid="menu-insert-right"
            onClick={() => {
              onInsert('right')
              onClose()
            }}
          >
            <span class="afs-menu__item-icon" dangerouslySetInnerHTML={{ __html: menuIcon('insert_right', { size: 14 }) }} />
            Insert column right
          </button>
          <button
            type="button"
            class="afs-menu__item"
            data-testid="menu-duplicate-column"
            onClick={() => {
              onDuplicate()
              onClose()
            }}
          >
            <span class="afs-menu__item-icon" dangerouslySetInnerHTML={{ __html: menuIcon('duplicate', { size: 14 }) }} />
            Duplicate column
          </button>
          <button
            type="button"
            class="afs-menu__item afs-menu__item--danger"
            data-testid="menu-delete-column"
            onClick={() => {
              onDelete()
              onClose()
            }}
          >
            <span class="afs-menu__item-icon" dangerouslySetInnerHTML={{ __html: menuIcon('delete', { size: 14 }) }} />
            Delete column
          </button>
        </div>
      )}

    </div>
  )
}

const TIMEZONES = [
  { value: '', label: 'Local (browser)' },
  { value: 'UTC', label: 'UTC' },
  { value: 'America/New_York', label: 'Eastern (ET)' },
  { value: 'America/Chicago', label: 'Central (CT)' },
  { value: 'America/Denver', label: 'Mountain (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Paris', label: 'Central Europe (CET)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  { value: 'Asia/Shanghai', label: 'China (CST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
]

function DateOptions({
  options,
  onChange,
  allDateColumns,
  onSetAllTimezones,
}: {
  options: Record<string, unknown> | null
  onChange: (next: Record<string, unknown>) => void
  allDateColumns: string[]
  onSetAllTimezones: (tz: string) => void
}) {
  const showTime = (options?.showTime as boolean) ?? false
  const timezone = (options?.timezone as string) ?? ''
  const [pendingTz, setPendingTz] = useState<string | null>(null)

  return (
    <>
      <label class="afs-menu__toggle-row">
        <input
          type="checkbox"
          data-testid="menu-date-show-time"
          checked={showTime}
          onChange={() => onChange({ ...options, showTime: !showTime })}
        />
        Show time
      </label>
      <label class="afs-menu__label" for="date-timezone">
        Display time zone
      </label>
      <select
        id="date-timezone"
        class="afs-menu__select"
        data-testid="menu-date-timezone"
        value={timezone}
        onChange={(event) => {
          const tz = (event.currentTarget as HTMLSelectElement).value
          if (allDateColumns.length > 1) {
            setPendingTz(tz)
          } else {
            onChange({ ...options, timezone: tz || undefined })
          }
        }}
      >
        {TIMEZONES.map((tz) => (
          <option key={tz.value} value={tz.value}>{tz.label}</option>
        ))}
      </select>
      {pendingTz !== null ? (
        <div class="afs-menu__confirm">
          <p class="afs-menu__hint">
            Apply to all {allDateColumns.length} date fields?
          </p>
          <button
            type="button"
            class="afs-button afs-button--primary"
            data-testid="menu-tz-apply-all"
            onClick={() => {
              onSetAllTimezones(pendingTz)
              setPendingTz(null)
            }}
          >
            All date fields
          </button>
          <button
            type="button"
            class="afs-button"
            data-testid="menu-tz-apply-one"
            onClick={() => {
              onChange({ ...options, timezone: pendingTz || undefined })
              setPendingTz(null)
            }}
          >
            This field only
          </button>
        </div>
      ) : null}
    </>
  )
}
