import { useEffect, useMemo, useState } from 'preact/hooks'
import type {
  ActionDefinition,
  ChangeEntry,
  ColumnDescriptor,
  RecordLocator,
  Row,
  SqlValue,
} from '../../shared/protocol.js'
import { menuIcon } from './FieldTypeIcons.js'
import type { Client } from '../state/client.js'
import type { Links } from '../state/links.js'
import type { RelatedState } from '../state/store.js'
import { ActionButtons } from './ActionButtons.js'
import { CellEditor } from './CellEditor.js'
import { CellValue, formatValue } from './CellValue.js'
import { LinkedRecordChip } from './LinkedRecordChip.js'
import { LinkedRecordEditor } from './LinkedRecordEditor.js'

// One record, opened alongside the grid rather than on top of it — the grid stays visible
// and editable on the left.
//
// The panel shows *every* column, including ones the current view hides. Column visibility
// is a property of how you are looking at the table, not of the record; a field you hid to
// make the grid readable is exactly the kind of thing you open a record to check.

/** Where the panel opens, every time. Resizing is session-only — see startResize below. */
export const DEFAULT_PANEL_WIDTH = 360
const MIN_PANEL_WIDTH = 280
/** Cap as a fraction of the window, so the panel can never squeeze the grid out entirely. */
const MAX_PANEL_FRACTION = 0.8

export interface DetailPanelProps {
  client: Client
  table: string
  rowid: number
  row: Row | null
  error: string | null
  columns: ColumnDescriptor[]
  primaryField: string
  links: Links
  editable: boolean
  related: RelatedState
  actions: ActionDefinition[]
  runningAction: number | null
  onRunAction: (action: ActionDefinition, row: Row) => void
  onEdit: (rowid: number, field: string, value: SqlValue) => void
  onNavigate: (table: string, locator: RecordLocator) => void
  onClose: () => void
  /** Session-scoped, owned by the app so it outlives this component's many remounts. */
  width: number
  onResize: (width: number) => void
}

export function DetailPanel({
  client,
  table,
  rowid,
  row,
  error,
  columns,
  primaryField,
  links,
  editable,
  related,
  actions,
  runningAction,
  onRunAction,
  onEdit,
  onNavigate,
  onClose,
  width,
  onResize,
}: DetailPanelProps) {
  const [editingField, setEditingField] = useState<string | null>(null)
  const [tab, setTab] = useState<'fields' | 'history'>('fields')
  const [query, setQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const title = row ? formatValue(row[primaryField]) : ''

  /**
   * Every occurrence of the search, in document order — not every *field* that matches.
   *
   * A field counts once for its name and once per hit inside its value, so stepping walks the
   * five mentions buried in one long description instead of skipping the whole field after the
   * first. On a record with forty fields, "which field" and "where in it" are the same question.
   */
  const hits = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '' || !row) return []

    const found: Array<{ column: string; kind: 'name' | 'value' }> = []
    for (const column of columns) {
      // Every occurrence, not every field — a name containing the needle twice is two stops,
      // because markOccurrences will draw two marks and each has to be reachable.
      const label = column.name.toLowerCase()
      for (let at = label.indexOf(needle); at !== -1; at = label.indexOf(needle, at + needle.length)) {
        found.push({ column: column.name, kind: 'name' })
      }
      const text = formatValue(row[column.name]).toLowerCase()
      for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
        found.push({ column: column.name, kind: 'value' })
      }
    }
    return found
  }, [query, columns, row])

  /** Where each column's value hits begin in `hits`, so a field can label its own marks. */
  const valueHitBase = useMemo(() => {
    const base = new Map<string, number>()
    hits.forEach((hit, index) => {
      if (hit.kind === 'value' && !base.has(hit.column)) base.set(hit.column, index)
    })
    return base
  }, [hits])

  // Snap to the current hit — the marked substring itself where there is one, otherwise the
  // field. `block: 'center'` rather than 'nearest' so a hit at the bottom of a long record does
  // not sit half under the edge of the panel. Instant, like the column-header scroll.
  useEffect(() => {
    const hit = hits[matchIndex]
    if (!hit) return
    const mark = document.querySelector(`[data-hit="${matchIndex}"]`)
    const target =
      mark ?? document.querySelector(`[data-testid="panel-field-${CSS.escape(hit.column)}"]`)
    target?.scrollIntoView({ block: 'center' })
  }, [hits, matchIndex])

  // A different record, or a tab switch, invalidates the search — the matches were about the
  // record you were looking at, not this one.
  useEffect(() => {
    setQuery('')
    setMatchIndex(0)
  }, [rowid, table, tab])

  /**
   * Drag the left edge to resize.
   *
   * The width lives in the *app*, not in this component, so it survives closing and reopening
   * the panel, switching rows, and switching tables — all of which unmount this. It is still
   * never written to the view config, so a fresh webview starts at 360px again: session-scoped,
   * the same treatment grouping gives collapse state. A saved view describes how a table is
   * arranged; how wide something was dragged is closer to a scroll position.
   *
   * Pointer capture rather than window listeners, for the same reason the column resize uses
   * it: the pointer leaves a 5px handle instantly on any real drag.
   */
  const startResize = (event: PointerEvent) => {
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    const startX = event.clientX
    const startWidth = handle.parentElement?.getBoundingClientRect().width ?? width
    handle.setPointerCapture(event.pointerId)

    const move = (moveEvent: PointerEvent) => {
      // Dragging left widens the panel, so the delta is inverted against a column resize.
      const next = startWidth + (startX - moveEvent.clientX)
      onResize(Math.max(MIN_PANEL_WIDTH, Math.min(next, window.innerWidth * MAX_PANEL_FRACTION)))
    }
    const up = () => {
      handle.releasePointerCapture(event.pointerId)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }

  return (
    <aside
      class="afs-panel"
      data-testid="detail-panel"
      data-table={table}
      data-rowid={rowid}
      style={{ width: `${width}px` }}
      onKeyDown={(event) => {
        // Escape closes the panel, but only when no editor is holding it — an editor's own
        // Escape means "cancel this edit", and it stops propagation to say so.
        if (event.key === 'Escape') onClose()
      }}
    >
      <div
        class="afs-panel__resize"
        data-testid="panel-resize"
        title="Drag to resize"
        onPointerDown={startResize}
        onDblClick={() => onResize(DEFAULT_PANEL_WIDTH)}
      />
      <header class="afs-panel__head">
        <div class="afs-panel__title">
          <span class="afs-panel__table">{table}</span>
          <strong data-testid="panel-title">{title === '' ? '(blank)' : title}</strong>
        </div>
        <button
          type="button"
          class="afs-panel__close"
          data-testid="panel-close"
          title="Close"
          onClick={onClose}
        >
          <span dangerouslySetInnerHTML={{ __html: menuIcon('x', { size: 16 }) }} />
        </button>
      </header>

      {error ? (
        <div class="afs-panel__empty" data-testid="panel-error">
          {error}
        </div>
      ) : !row ? (
        <div class="afs-panel__empty" data-testid="panel-missing">
          This record is no longer in the database.
        </div>
      ) : (
        <>
          <div class="afs-panel__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              class={`afs-panel__tab${tab === 'fields' ? ' afs-panel__tab--active' : ''}`}
              aria-selected={tab === 'fields'}
              data-testid="panel-tab-fields"
              onClick={() => setTab('fields')}
            >
              Fields
            </button>
            <button
              type="button"
              role="tab"
              class={`afs-panel__tab${tab === 'history' ? ' afs-panel__tab--active' : ''}`}
              aria-selected={tab === 'history'}
              data-testid="panel-tab-history"
              onClick={() => setTab('history')}
            >
              History
            </button>

            {tab === 'fields' ? (
              <RecordSearch
                query={query}
                matches={hits.length}
                index={matchIndex}
                onQuery={(next) => {
                  setQuery(next)
                  setMatchIndex(0)
                }}
                onStep={(delta) => {
                  if (hits.length === 0) return
                  setMatchIndex((prev) => (prev + delta + hits.length) % hits.length)
                }}
              />
            ) : null}
          </div>

          <div class="afs-panel__body">
            {tab === 'history' ? (
              <HistoryTimeline client={client} table={table} rowid={rowid} />
            ) : (
              <>
                <div class="afs-panel__fields">
                  {columns.map((column) => (
                    <PanelField
                      key={column.name}
                      client={client}
                      column={column}
                      value={row[column.name]}
                      links={links}
                      editable={editable}
                      editing={editingField === column.name}
                      onStartEdit={() => setEditingField(column.name)}
                      onStopEdit={() => setEditingField(null)}
                      onCommit={(next) => {
                        setEditingField(null)
                        onEdit(rowid, column.name, next)
                      }}
                      onNavigate={onNavigate}
                      query={query}
                      currentHit={matchIndex}
                      valueHitBase={valueHitBase.get(column.name) ?? null}
                      nameHitIndex={hits.findIndex(
                        (hit) => hit.kind === 'name' && hit.column === column.name,
                      )}
                      match={
                        hits[matchIndex]?.column === column.name
                          ? 'current'
                          : hits.some((hit) => hit.column === column.name)
                            ? 'hit'
                            : null
                      }
                    />
                  ))}
                </div>

                <ActionButtons
                  actions={actions.filter((action) => action.showInDetail)}
                  row={row}
                  running={runningAction}
                  onRun={onRunAction}
                />

                <RelatedSections related={related} onNavigate={onNavigate} />
              </>
            )}
          </div>
        </>
      )}
    </aside>
  )
}

/**
 * Find-within-record: a filter box plus previous/next, sitting beside the Fields tab.
 *
 * It does not hide non-matching fields, deliberately. Hiding them would answer "which fields
 * match" but destroy the thing you opened the record for — seeing the record. Highlighting and
 * scrolling keeps the record intact and still takes you straight there.
 */
function RecordSearch({
  query,
  matches,
  index,
  onQuery,
  onStep,
}: {
  query: string
  matches: number
  index: number
  onQuery: (next: string) => void
  onStep: (delta: number) => void
}) {
  return (
    <div class="afs-record-search" data-testid="record-search">
      <input
        type="search"
        class="afs-record-search__input"
        data-testid="record-search-input"
        placeholder="Search this record"
        value={query}
        onInput={(event) => onQuery((event.currentTarget as HTMLInputElement).value)}
        onKeyDown={(event) => {
          // Escape clears before it closes anything else, and Enter walks the hits the way
          // every other find bar does — shift to go back.
          if (event.key === 'Escape' && query !== '') {
            event.stopPropagation()
            onQuery('')
          } else if (event.key === 'Enter') {
            event.preventDefault()
            onStep(event.shiftKey ? -1 : 1)
          }
        }}
      />
      {query.trim() !== '' ? (
        <span class="afs-record-search__count" data-testid="record-search-count">
          {matches === 0 ? 'No matches' : `${index + 1} of ${matches}`}
        </span>
      ) : null}
      <button
        type="button"
        class="afs-record-search__step"
        data-testid="record-search-prev"
        title="Previous match"
        aria-label="Previous match"
        disabled={matches === 0}
        onClick={() => onStep(-1)}
      >
        <span dangerouslySetInnerHTML={{ __html: menuIcon('arrow_up', { size: 14 }) }} />
      </button>
      <button
        type="button"
        class="afs-record-search__step"
        data-testid="record-search-next"
        title="Next match"
        aria-label="Next match"
        disabled={matches === 0}
        onClick={() => onStep(1)}
      >
        <span dangerouslySetInnerHTML={{ __html: menuIcon('arrow_down', { size: 14 }) }} />
      </button>
    </div>
  )
}

interface PanelFieldProps {
  client: Client
  column: ColumnDescriptor
  value: SqlValue | undefined
  links: Links
  editable: boolean
  editing: boolean
  onStartEdit: () => void
  onStopEdit: () => void
  onCommit: (next: SqlValue) => void
  onNavigate: (table: string, locator: RecordLocator) => void
  /** Set while a record search is running: every hit, and which one is current. */
  match?: 'hit' | 'current' | null
  /** The active record search, for marking occurrences inside this field's value. */
  query?: string
  /** Index of the hit being stepped to, across the whole record. */
  currentHit?: number
  /** Where this field's value hits start in that global numbering. Null when it has none. */
  valueHitBase?: number | null
  /** Global index of this field's name hit, or -1. */
  nameHitIndex?: number
}

/**
 * Split a value into text and marked occurrences.
 *
 * Each mark carries its global hit index, which is what lets the panel scroll straight to the
 * third mention inside one description rather than to the top of the field containing it.
 */
function markOccurrences(text: string, query: string, base: number, current: number) {
  const needle = query.trim()
  if (needle === '') return text
  const haystack = text.toLowerCase()
  const lower = needle.toLowerCase()

  const parts: Array<string | preact.JSX.Element> = []
  let cursor = 0
  let nth = 0
  for (let at = haystack.indexOf(lower); at !== -1; at = haystack.indexOf(lower, at + lower.length)) {
    if (at > cursor) parts.push(text.slice(cursor, at))
    const index = base + nth
    parts.push(
      <mark
        key={index}
        class={`afs-hit${index === current ? ' afs-hit--current' : ''}`}
        data-hit={index}
      >
        {text.slice(at, at + needle.length)}
      </mark>,
    )
    cursor = at + needle.length
    nth += 1
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

function PanelField({
  client,
  column,
  value,
  links,
  editable,
  editing,
  onStartEdit,
  onStopEdit,
  onCommit,
  onNavigate,
  match,
  query,
  currentHit,
  valueHitBase,
  nameHitIndex,
}: PanelFieldProps) {
  const target = links.target(column.name)
  const type = column.displayType ?? 'text'
  // Created and Modified are derived from the changelog — there is no column behind them.
  const canEdit = editable && !column.primaryKeyIndex && !column.virtual && !column.computed
  /** Types whose value is prose worth marking. The rest render as controls, not text. */
  const searchable = !['checkbox', 'toggle', 'single_select', 'multi_select'].includes(type)

  return (
    <div
      class={
        `afs-field${editing ? ' afs-field--editing' : ''}` +
        (match === 'hit' ? ' afs-field--match' : '') +
        (match === 'current' ? ' afs-field--match afs-field--match-current' : '')
      }
      data-testid={`panel-field-${column.name}`}
      data-column={column.name}
      data-match={match ?? undefined}
    >
      <label
        class="afs-field__label"
        data-hit={nameHitIndex !== undefined && nameHitIndex >= 0 ? nameHitIndex : undefined}
      >
        {query?.trim() && nameHitIndex !== undefined && nameHitIndex >= 0
          ? markOccurrences(column.name, query, nameHitIndex, currentHit ?? -1)
          : column.name}
      </label>
      <div
        class={`afs-field__value${type === 'long_text' ? ' afs-field__value--long' : ''}`}
        data-testid={`panel-value-${column.name}`}
        onClick={() => {
          if (canEdit && !editing) onStartEdit()
        }}
      >
        {editing && target ? (
          <LinkedRecordEditor
            client={client}
            target={target}
            value={value}
            label={links.label(column.name, value ?? null)}
            onCommit={onCommit}
            onCancel={onStopEdit}
          />
        ) : editing ? (
          <CellEditor column={column} value={value} onCommit={onCommit} onCancel={onStopEdit} />
        ) : target ? (
          <LinkedRecordChip
            value={value}
            label={links.label(column.name, value ?? null)}
            onNavigate={() =>
              onNavigate(target.table, { keyColumn: target.keyColumn, keyValue: value ?? null })
            }
          />
        ) : searchable && query?.trim() && valueHitBase !== null && valueHitBase !== undefined ? (
          /* During a search a text-bearing field renders as marked plain text, so each
             occurrence is an element the panel can scroll to. Chips, tags, and checkboxes keep
             their own rendering — there is nothing to mark inside a checkbox, and replacing a
             chip with text would break the thing you click. */
          <span data-testid={`panel-marked-${column.name}`}>
            {markOccurrences(formatValue(value), query, valueHitBase, currentHit ?? -1)}
          </span>
        ) : (
          <CellValue
            column={column}
            value={value}
            readOnly={!canEdit}
            onToggle={(next) => {
              if (canEdit) onCommit(next)
            }}
          />
        )}
      </div>
    </div>
  )
}

/**
 * Reverse lookups — the "Orders" section on a customer. Discovered from foreign keys pointing
 * at this table, never configured, so a schema an agent just changed shows its new
 * relationships without anyone setting them up.
 */
function RelatedSections({
  related,
  onNavigate,
}: {
  related: RelatedState
  onNavigate: (table: string, locator: RecordLocator) => void
}) {
  if (related.error) {
    return (
      <div class="afs-panel__empty" data-testid="related-error">
        {related.error}
      </div>
    )
  }
  if (related.groups.length === 0) return null

  return (
    <div class="afs-panel__related">
      {related.groups.map((group) => (
        <section
          key={`${group.fromTable} ${group.fromColumns.join()}`}
          class="afs-related"
          data-testid={`related-${group.fromTable}`}
        >
          <h3 class="afs-related__head">
            {group.fromTable}
            <span class="afs-related__count" data-testid={`related-count-${group.fromTable}`}>
              {group.count}
            </span>
          </h3>

          <div class="afs-related__rows">
            {group.rows.map((row) => {
              const label = formatValue(row[group.primaryField])
              return (
                <button
                  key={String(row.rowid)}
                  type="button"
                  class="afs-related__row"
                  data-testid="related-row"
                  disabled={row.rowid === null}
                  onClick={() => {
                    if (row.rowid !== null) onNavigate(group.fromTable, { rowid: row.rowid })
                  }}
                >
                  {label === '' ? <span class="afs-dim">(blank)</span> : label}
                </button>
              )
            })}
            {/* The list is capped so a parent with 10,000 children does not build 10,000
                buttons. Saying so beats silently showing the first fifty as if that were all. */}
            {group.count > group.rows.length ? (
              <span class="afs-related__more">
                showing {group.rows.length} of {group.count}
              </span>
            ) : null}
          </div>
        </section>
      ))}
    </div>
  )
}

/**
 * The audit trail for one record, newest first.
 *
 * Read fresh every time the tab opens rather than cached: the point of this panel is watching
 * something else write to the database, so a stale history is the one thing it must not be.
 */
function HistoryTimeline({
  client,
  table,
  rowid,
}: {
  client: Client
  table: string
  rowid: number
}) {
  const [entries, setEntries] = useState<ChangeEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setEntries(null)
    setError(null)
    void client
      .history(table, rowid)
      .then((result) => {
        if (!cancelled) setEntries(result)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [client, table, rowid])

  if (error) {
    return (
      <div class="afs-panel__empty" data-testid="history-error">
        {error}
      </div>
    )
  }
  if (entries === null) {
    return <div class="afs-panel__empty">Loading…</div>
  }
  if (entries.length === 0) {
    return (
      <div class="afs-panel__empty" data-testid="history-empty">
        Nothing has changed this record since the change log started.
      </div>
    )
  }

  return (
    <ol class="afs-history" data-testid="history">
      {[...entries].reverse().map((entry, index) => (
        <li key={`${entry.ts} ${index}`} class="afs-history__entry" data-testid="history-entry">
          <div class="afs-history__head">
            <span class={`afs-history__op afs-history__op--${entry.op}`}>{entry.op}</span>
            <time class="afs-history__ts">{entry.ts.replace('T', ' ')}</time>
          </div>
          <div class="afs-history__fields">
            {Object.keys({ ...entry.before, ...entry.after }).map((field) => (
              <div key={field} class="afs-history__field">
                <span class="afs-history__name">{field}</span>
                {/* Only the fields that changed are stored, so this is the whole diff. */}
                <span class="afs-history__before">{formatValue(entry.before[field]) || '—'}</span>
                <span class="afs-history__arrow" dangerouslySetInnerHTML={{ __html: menuIcon('arrow_right', { size: 12 }) }} />
                <span class="afs-history__after">{formatValue(entry.after[field]) || '—'}</span>
              </div>
            ))}
          </div>
        </li>
      ))}
    </ol>
  )
}
