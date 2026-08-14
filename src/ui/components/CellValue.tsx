import type { ColumnDescriptor, DisplayType, SqlValue } from '../../shared/protocol.js'
import { menuIcon } from './FieldTypeIcons.js'
import { parseOptions, type ChoiceOptions } from '../state/choices.js'

// Read-only rendering for each of the eleven display types.
//
// Two rules run through all of them. A NULL and an empty string look identical, because they
// are identical to a person looking at a spreadsheet. And nothing here truncates by cutting
// the string — CSS ellipsis does that, so the full value stays in the DOM for copy, for the
// title tooltip, and for the detail panel in Phase 7.

/**
 * USD, with cents and thousands separators. Deliberately narrow: no currency selection, no
 * minor-unit storage, no locale switching. The value in SQLite stays a plain number, which is
 * what keeps SUM and AVG in the summary bar meaningful — a formatted string would not add up.
 *
 * A value that is not a number is passed through untouched rather than shown as $NaN: the
 * display type is a user's assertion about a column, and it can be wrong about a given row.
 */
const USD_CENTS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const USD_NO_CENTS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

export function formatCurrency(value: SqlValue | undefined, showCents = true): string | null {
  if (value === null || value === undefined || value === '') return ''
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? (showCents ? USD_CENTS : USD_NO_CENTS).format(n) : null
}

export function formatValue(value: SqlValue | undefined): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (value instanceof Uint8Array) return `${value.byteLength} bytes`
  return String(value)
}

/** SQLite has no boolean type, so truthiness has to be read from whatever is stored. */
export function isTruthy(value: SqlValue | undefined): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const text = String(value).trim().toLowerCase()
  return text !== '' && text !== '0' && text !== 'false' && text !== 'no'
}

export function parseTags(value: SqlValue | undefined): string[] {
  const text = formatValue(value).trim()
  if (!text) return []
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [text]
  } catch {
    return [text]
  }
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = Math.round(totalSeconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function linkHref(type: DisplayType, text: string): string | null {
  if (!text) return null
  if (type === 'url') return /^https?:\/\//i.test(text) ? text : `https://${text}`
  if (type === 'email') return `mailto:${text}`
  if (type === 'phone') return `tel:${text.replace(/[^\d+]/g, '')}`
  return null
}

/**
 * The chip background for a value, or nothing when the column is not coloring its values or
 * the value is not one of the configured options.
 */
function chipStyle(options: ChoiceOptions, value: string): { background?: string } {
  if (!options.colored) return {}
  const choice = options.choices.find((c) => c.value === value)
  return choice ? { background: `var(--afs-choice-${choice.color})` } : {}
}

export interface CellValueProps {
  column: ColumnDescriptor
  value: SqlValue | undefined
  /** Toggle types commit immediately rather than opening an editor. */
  onToggle?: (next: number) => void
  readOnly?: boolean
}

export function CellValue({ column, value, onToggle, readOnly }: CellValueProps) {
  const type = column.displayType ?? 'text'
  const text = formatValue(value)

  if (type === 'checkbox' || type === 'toggle') {
    const checked = isTruthy(value)
    return (
      <input
        type="checkbox"
        class={type === 'toggle' ? 'afs-toggle' : 'afs-checkbox'}
        checked={checked}
        disabled={readOnly}
        data-testid="cell-boolean"
        // A checkbox that needs a double click to change is a checkbox that is lying about
        // being a checkbox, so these commit on the spot rather than entering edit mode.
        onClick={(event) => {
          event.stopPropagation()
          if (!readOnly) onToggle?.(checked ? 0 : 1)
        }}
      />
    )
  }

  // A value with no configured option still renders as a chip, just an uncolored one. It is
  // real data the column happens not to describe — usually because somebody renamed the option
  // rather than rewriting the rows — and hiding it would be worse than showing it plain.
  if (type === 'multi_select') {
    const tags = parseTags(value)
    if (tags.length === 0) return <span />
    const options = parseOptions(column.options)
    return (
      <span class="afs-tags" data-testid="cell-tags">
        {tags.map((tag) => (
          <span key={tag} class="afs-tag" style={chipStyle(options, tag)}>
            {tag}
          </span>
        ))}
      </span>
    )
  }

  if (type === 'single_select') {
    if (!text) return <span />
    return (
      <span class="afs-tag" data-testid="cell-select" style={chipStyle(parseOptions(column.options), text)}>
        {text}
      </span>
    )
  }

  if (type === 'currency') {
    const showCents = (column.options?.showCents as boolean) ?? true
    const money = formatCurrency(value, showCents)
    return <span data-testid="cell-currency">{money === null ? text : money}</span>
  }

  if (type === 'percent') {
    if (value === null || value === undefined || value === '') return <span />
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n)) return <span>{text}</span>
    const decimals = (column.options?.decimals as number) ?? 2
    return <span data-testid="cell-percent">{(n * 100).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}%</span>
  }

  if (type === 'duration') {
    if (value === null || value === undefined || value === '') return <span />
    const secs = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(secs) || secs < 0) return <span>{text}</span>
    return <span data-testid="cell-duration">{formatDuration(secs)}</span>
  }

  if (type === 'rating') {
    const max = ((column.options?.max as number) ?? 5)
    const n = typeof value === 'number' ? value : Number(value)
    const filled = Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n))) : 0
    return (
      <span class="afs-rating" data-testid="cell-rating">
        {Array.from({ length: max }, (_, i) => (
          <span key={i} class={i < filled ? 'afs-star afs-star--on' : 'afs-star'}
            onClick={(event) => {
              event.stopPropagation()
              if (!readOnly) onToggle?.(i + 1 === filled ? 0 : i + 1)
            }}
            dangerouslySetInnerHTML={{ __html: menuIcon('rating', { size: 14 }) }}
          />
        ))}
      </span>
    )
  }

  if (type === 'date' && text) {
    const ts = typeof value === 'number' ? value : Date.parse(text)
    if (Number.isFinite(ts)) {
      const d = new Date(ts)
      const showTime = (column.options?.showTime as boolean) ?? false
      const tz = (column.options?.timezone as string) || undefined
      const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }
      if (tz) opts.timeZone = tz
      if (showTime) {
        opts.hour = 'numeric'
        opts.minute = '2-digit'
      }
      return <span data-testid="cell-date">{d.toLocaleDateString(undefined, opts)}</span>
    }
    return <span>{text}</span>
  }

  if (type === 'number') {
    const decimals = column.options?.decimals as number | undefined
    if (decimals !== undefined && value !== null && value !== undefined && value !== '') {
      const n = typeof value === 'number' ? value : Number(value)
      if (Number.isFinite(n)) {
        return <span>{n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</span>
      }
    }
  }

  const href = linkHref(type, text)
  if (href) {
    return (
      <span class="afs-link-cell">
        {/* A plain click has to reach the cell, or an email column becomes uneditable — the
            link would cover the whole cell and swallow every attempt to open an editor.
            Ctrl/Cmd-click (and middle click) still follow the link, matching how a link
            inside any other editable surface behaves. */}
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          data-testid="cell-link"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || readOnly) return
            event.preventDefault()
          }}
        >
          {text}
        </a>
        <button
          type="button"
          class="afs-copy"
          title="Copy"
          data-testid="cell-copy"
          onClick={(event) => {
            event.stopPropagation()
            void navigator.clipboard?.writeText(text)
          }}
        >
          <span dangerouslySetInnerHTML={{ __html: menuIcon('copy_clipboard', { size: 12 }) }} />
        </button>
      </span>
    )
  }

  return <span>{text}</span>
}
