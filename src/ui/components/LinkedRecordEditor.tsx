import { useEffect, useRef, useState } from 'preact/hooks'
import type { Row, SqlValue } from '../../shared/protocol.js'
import type { Client } from '../state/client.js'
import type { LinkTargetInfo } from '../state/links.js'
import { formatValue } from './CellValue.js'

// Picking a linked record means searching the *other* table by what it displays, not typing
// its primary key. The search runs server-side against the target's primary field, so this
// works the same on a table with eight rows and one with eighty thousand.

const RESULT_LIMIT = 20
const DEBOUNCE_MS = 120

/**
 * Picking an option must not move focus. Letting the input blur closes this editor, and the
 * click then lands on the grid cell underneath — which reopens it, so the pick is undone by
 * the same gesture that made it. Same family of bug as the Escape-commits-on-blur trap in
 * CellEditor: the browser fires focus events between mousedown and click, and a control that
 * unmounts on blur never survives its own activation.
 */
function keepFocus(event: MouseEvent): void {
  event.preventDefault()
}

export interface LinkedRecordEditorProps {
  client: Client
  target: LinkTargetInfo
  value: SqlValue | undefined
  /** The current label, so the field does not appear blank while results load. */
  label: string | undefined
  onCommit: (next: SqlValue) => void
  onCancel: () => void
}

export function LinkedRecordEditor({
  client,
  target,
  value,
  label,
  onCommit,
  onCancel,
}: LinkedRecordEditorProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  // Escape unmounts this, but blur still fires on the way out — same trap as CellEditor.
  const cancelling = useRef(false)

  useEffect(() => {
    input.current?.focus()
  }, [])

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      void client
        .query({
          table: target.table,
          search: query,
          searchColumns: [target.primaryField],
          limit: RESULT_LIMIT,
        })
        .then((result) => {
          if (!cancelled) setResults(result.rows)
        })
        .catch((err: Error) => {
          if (!cancelled) setError(err.message)
        })
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [client, target.table, target.primaryField, query])

  const cancel = () => {
    cancelling.current = true
    onCancel()
  }

  const current = formatValue(value)

  return (
    <div
      class="afs-link-editor"
      data-testid="link-editor"
      onBlur={(event) => {
        // Blur fires while moving between the input and a result button, which is not
        // leaving the editor. Only a focus landing outside it counts.
        const next = event.relatedTarget as Node | null
        if (next && event.currentTarget.contains(next)) return
        if (!cancelling.current) cancel()
      }}
    >
      <input
        ref={input}
        class="afs-editor"
        data-testid="link-search"
        placeholder={label ?? current ?? 'Search…'}
        value={query}
        onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            cancel()
          }
        }}
      />

      <div class="afs-link-editor__results">
        {/*
          Clearing a link writes NULL, which is the one deliberate exception to the rule that
          a blank cell holds an empty string. A foreign key is a relationship; "no
          relationship" is NULL. An empty string in an INTEGER key column would fail the
          foreign key check outright and mean nothing if it did not.
        */}
        <button
          type="button"
          class="afs-link-editor__option afs-link-editor__option--clear"
          data-testid="link-clear"
          onMouseDown={keepFocus}
          onClick={(event) => {
            event.stopPropagation()
            onCommit(null)
          }}
        >
          — none —
        </button>

        {error ? <div class="afs-link-editor__empty">{error}</div> : null}

        {!error && results.length === 0 ? (
          <div class="afs-link-editor__empty">No matching records in {target.table}.</div>
        ) : null}

        {results.map((row) => {
          const key = row[target.keyColumn] ?? null
          const display = formatValue(row[target.primaryField])
          return (
            <button
              key={String(key)}
              type="button"
              class={`afs-link-editor__option${
                String(key) === current ? ' afs-link-editor__option--current' : ''
              }`}
              data-testid="link-option"
              onMouseDown={keepFocus}
              onClick={(event) => {
                event.stopPropagation()
                onCommit(key)
              }}
            >
              {display === '' ? <span class="afs-dim">(blank)</span> : display}
            </button>
          )
        })}
      </div>
    </div>
  )
}
