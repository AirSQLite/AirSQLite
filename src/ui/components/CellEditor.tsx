import { useEffect, useRef, useState } from 'preact/hooks'
import type { ColumnDescriptor, SqlValue } from '../../shared/protocol.js'
import { menuIcon } from './FieldTypeIcons.js'
import { formatValue, parseTags } from './CellValue.js'
import { parseOptions } from '../state/choices.js'

// The editor for one cell, chosen by display type.
//
// The NULL rule from the requirements lives here and is easy to get wrong: typing into a
// blank cell writes an **empty string**, not NULL, and no editor offers a way back to NULL.
// A three-state text field where blank sometimes means "nothing" and sometimes means "not
// set" is a distinction the user did not ask for and cannot see.

export interface CellEditorProps {
  column: ColumnDescriptor
  value: SqlValue | undefined
  onCommit: (next: SqlValue) => void
  onCancel: () => void
}

function choicesOf(column: ColumnDescriptor): string[] {
  return parseOptions(column.options).choices.map((c) => c.value)
}

/** Chip background for a configured option, or nothing for a value the column does not describe. */
function chipStyle(column: ColumnDescriptor, value: string): { background?: string } {
  const options = parseOptions(column.options)
  if (!options.colored) return {}
  const choice = options.choices.find((c) => c.value === value)
  return choice ? { background: `var(--afs-choice-${choice.color})` } : {}
}

export function CellEditor({ column, value, onCommit, onCancel }: CellEditorProps) {
  const type = column.displayType ?? 'text'
  const [draft, setDraft] = useState(formatValue(value))
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null)
  /**
   * Set as soon as this editor is finished, either way.
   *
   * Escape and Enter both unmount the editor, and the browser still fires blur on the way
   * out — where blur commits. Without this, cancelling saves the edit, and *committing*
   * commits it twice. The second commit used to be a harmless no-op write; once committing
   * also moved the cursor, it started skipping a row.
   */
  const settled = useRef(false)

  useEffect(() => {
    const element = inputRef.current
    element?.focus()
    if (element && 'select' in element) element.select()
  }, [])

  const commitText = () => {
    if (settled.current) return
    settled.current = true
    // Empty string, never null — see the note at the top of this file.
    if (type === 'number' || type === 'currency') {
      const trimmed = draft.trim()
      if (trimmed === '') return onCommit('')
      const parsed = Number(trimmed)
      return onCommit(Number.isFinite(parsed) ? parsed : trimmed)
    }
    onCommit(draft)
  }

  const cancel = () => {
    if (settled.current) return
    settled.current = true
    onCancel()
  }

  const commitOnBlur = () => {
    if (settled.current) return
    commitText()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      cancel()
      return
    }
    // Long text needs Enter for newlines, so it commits with a modifier instead.
    const commits =
      event.key === 'Enter' && (type !== 'long_text' || event.metaKey || event.ctrlKey)
    if (commits) {
      event.preventDefault()
      event.stopPropagation()
      commitText()
    }
  }

  if (type === 'single_select') {
    const choices = choicesOf(column)
    return (
      <select
        ref={inputRef as never}
        class="afs-editor"
        data-testid="editor-select"
        value={draft}
        onChange={(event) => {
          if (settled.current) return
          settled.current = true
          onCommit((event.currentTarget as HTMLSelectElement).value)
        }}
        onBlur={cancel}
        onKeyDown={onKeyDown}
      >
        <option value="">—</option>
        {/* A stored value outside the configured choices must stay selectable, or opening
            the editor would silently destroy it. */}
        {(choices.includes(draft) || draft === '' ? choices : [...choices, draft]).map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    )
  }

  if (type === 'multi_select') {
    return <TagEditor column={column} value={value} onCommit={onCommit} onCancel={onCancel} />
  }

  if (type === 'long_text') {
    return (
      <textarea
        ref={inputRef as never}
        class="afs-editor afs-editor--long"
        data-testid="editor-long-text"
        value={draft}
        onInput={(event) => setDraft((event.currentTarget as HTMLTextAreaElement).value)}
        onBlur={commitOnBlur}
        onKeyDown={onKeyDown}
      />
    )
  }

  return (
    <input
      ref={inputRef as never}
      class="afs-editor"
      data-testid="editor-input"
      type={type === 'number' || type === 'currency' ? 'number' : type === 'date' ? 'date' : 'text'}
      value={type === 'date' ? draft.slice(0, 10) : draft}
      onInput={(event) => setDraft((event.currentTarget as HTMLInputElement).value)}
      onBlur={commitOnBlur}
      onKeyDown={onKeyDown}
    />
  )
}

/**
 * Multi-select stores a JSON array in a TEXT column — one canonical format, matching what
 * inference looks for and what `json_each()` can query.
 */
function TagEditor({ column, value, onCommit, onCancel }: CellEditorProps) {
  const [tags, setTags] = useState<string[]>(parseTags(value))
  const [entry, setEntry] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const settled = useRef(false)
  const choices = choicesOf(column).filter((c) => !tags.includes(c))

  useEffect(() => inputRef.current?.focus(), [])

  const commit = (next: string[]) => {
    if (settled.current) return
    settled.current = true
    onCommit(JSON.stringify(next))
  }

  const add = (tag: string) => {
    const clean = tag.trim()
    if (!clean || tags.includes(clean)) return
    setTags([...tags, clean])
    setEntry('')
  }

  return (
    <div class="afs-editor afs-editor--tags" data-testid="editor-tags">
      {tags.map((tag) => (
        <span key={tag} class="afs-tag" style={chipStyle(column, tag)}>
          {tag}
          <button
            type="button"
            class="afs-tag__remove"
            data-testid={`tag-remove-${tag}`}
            onClick={() => setTags(tags.filter((t) => t !== tag))}
          >
            <span dangerouslySetInnerHTML={{ __html: menuIcon('x', { size: 10 }) }} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        class="afs-editor__tag-input"
        data-testid="editor-tag-input"
        list={`choices-${column.name}`}
        value={entry}
        onInput={(event) => setEntry((event.currentTarget as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            if (entry.trim()) add(entry)
            else commit(tags)
          } else if (event.key === 'Escape') {
            event.stopPropagation()
            if (settled.current) return
            settled.current = true
            onCancel()
          } else if (event.key === 'Backspace' && entry === '' && tags.length > 0) {
            setTags(tags.slice(0, -1))
          }
        }}
        onBlur={() => commit(tags)}
      />
      {choices.length > 0 ? (
        <datalist id={`choices-${column.name}`}>
          {choices.map((choice) => (
            <option key={choice} value={choice} />
          ))}
        </datalist>
      ) : null}
    </div>
  )
}
