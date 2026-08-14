import { useEffect, useRef, useState } from 'preact/hooks'
import type { DisplayType } from '../../shared/protocol.js'
import { TypePicker } from './FieldTypeIcons.js'

// Naming a new field.
//
// A modal rather than a popover anchored to the header it was opened from: the grid is
// virtualised and horizontally scrolled, so the anchor can be scrolled out from under a popover
// while it is open. It is two inputs and a button, which is not enough content to be worth the
// positioning problem.

const TYPES: Array<{ value: string; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'long_text', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'percent', label: 'Percent' },
  { value: 'currency', label: 'Currency (USD)' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'toggle', label: 'Toggle' },
  { value: 'single_select', label: 'Single select' },
  { value: 'multi_select', label: 'Multi-select' },
  { value: 'date', label: 'Date' },
  { value: 'url', label: 'URL' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'duration', label: 'Duration' },
  { value: 'rating', label: 'Rating' },
]

const SQLITE_TYPE: Record<string, string> = {
  text: 'TEXT', long_text: 'TEXT', url: 'TEXT', email: 'TEXT', phone: 'TEXT',
  single_select: 'TEXT', multi_select: 'TEXT',
  number: 'REAL', currency: 'REAL', percent: 'REAL', duration: 'REAL', rating: 'REAL',
  checkbox: 'INTEGER', toggle: 'INTEGER', date: 'INTEGER',
}

export interface NewFieldDialogProps {
  /** Which column it will sit beside in the view, if it was opened from one. */
  beside?: { column: string; side: 'left' | 'right' }
  onAdd: (name: string, columnType: string, displayType: DisplayType) => void
  onCancel: () => void
}

export function NewFieldDialog({ beside, onAdd, onCancel }: NewFieldDialogProps) {
  const [name, setName] = useState('')
  const [type, setType] = useState('text')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const commit = () => {
    const trimmed = name.trim()
    if (trimmed) onAdd(trimmed, SQLITE_TYPE[type] ?? 'TEXT', type as DisplayType)
  }

  return (
    <div class="afs-modal-backdrop" data-testid="new-field-dialog" onClick={onCancel}>
      <div
        class="afs-modal"
        role="dialog"
        aria-modal="true"
        aria-label="New field"
        onClick={(event) => event.stopPropagation()}
      >
        <strong>New field</strong>
        {beside ? (
          <p class="afs-modal__detail">
            It will sit to the {beside.side} of {beside.column} in this view. SQLite adds every
            new column at the end of the table, so that position is the view's, not the file's.
          </p>
        ) : null}

        <input
          ref={input}
          class="afs-menu__input"
          data-testid="column-name"
          placeholder="Field name"
          value={name}
          onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
          }}
        />

        <TypePicker
          types={TYPES}
          value={type}
          testId="column-type"
          onChange={setType}
        />

        <div class="afs-modal__actions">
          <button type="button" class="afs-button" data-testid="column-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            class="afs-button afs-button--primary"
            data-testid="column-add"
            disabled={!name.trim()}
            onClick={commit}
          >
            Add field
          </button>
        </div>
      </div>
    </div>
  )
}
