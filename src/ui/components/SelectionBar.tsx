import { useMemo, useState } from 'preact/hooks'
import type { ColumnDescriptor, SqlValue } from '../../shared/protocol.js'
import { parseOptions } from '../state/choices.js'

// Appears only when rows are selected. Both actions it offers are destructive in the sense
// that matters — they change many rows at once — so both route through a confirmation that
// states the count.

export interface SelectionBarProps {
  count: number
  columns: ColumnDescriptor[]
  onClear: () => void
  onDelete: () => void
  onBulkEdit: (field: string, value: SqlValue) => void
}

export function SelectionBar({ count, columns, onClear, onDelete, onBulkEdit }: SelectionBarProps) {
  const [field, setField] = useState(columns[0]?.name ?? '')
  const [value, setValue] = useState('')

  // Single-select only. A multi-select cell holds a JSON array, so setting one across a
  // selection needs the tag picker rather than a single choice — left for when it is asked for.
  const choices = useMemo(() => {
    const column = columns.find((c) => c.name === field)
    if (column?.displayType !== 'single_select') return []
    return parseOptions(column.options).choices
  }, [columns, field])

  if (count === 0) return null

  return (
    <div class="afs-selection" data-testid="selection-bar">
      <strong data-testid="selection-count">
        {count} {count === 1 ? 'record' : 'records'} selected
      </strong>

      <div class="afs-selection__edit">
        <select
          class="afs-selection__field"
          data-testid="bulk-field"
          value={field}
          onChange={(event) => setField((event.currentTarget as HTMLSelectElement).value)}
        >
          {columns.map((column) => (
            <option key={column.name} value={column.name}>
              {column.name}
            </option>
          ))}
        </select>
        {/* A select field gets its own options rather than a free-text box (entry #381).
            Typing "Wonn" into forty records and finding out later is the failure this removes;
            the options are known, so offering anything else is offering a way to be wrong.
            The date and checkbox halves of #381 are still open. */}
        {choices.length > 0 ? (
          <select
            class="afs-selection__value"
            data-testid="bulk-value"
            value={value}
            onChange={(event) => setValue((event.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">—</option>
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.value}
              </option>
            ))}
          </select>
        ) : (
          <input
            class="afs-selection__value"
            data-testid="bulk-value"
            placeholder="New value"
            value={value}
            onInput={(event) => setValue((event.currentTarget as HTMLInputElement).value)}
          />
        )}
        <button
          type="button"
          class="afs-button"
          data-testid="bulk-apply"
          disabled={!field}
          onClick={() => onBulkEdit(field, value)}
        >
          Apply to all
        </button>
      </div>

      <button
        type="button"
        class="afs-button afs-button--danger"
        data-testid="bulk-delete"
        onClick={onDelete}
      >
        Delete
      </button>
      <button type="button" class="afs-button" data-testid="selection-clear" onClick={onClear}>
        Clear
      </button>
    </div>
  )
}
