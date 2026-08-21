// Field-type icons extracted from Lucide v1.31.0 (ISC license).
// https://lucide.dev
import { useEffect, useRef, useState } from 'preact/hooks'

interface IconProps {
  size?: number
  class?: string
}

const svg = (children: string, props: IconProps) => {
  const s = props.size ?? 14
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;vertical-align:middle" class="${props.class ?? ''}">${children}</svg>`
}

const icons: Record<string, string> = {
  // type
  text: '<path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/>',
  // align-left
  long_text: '<path d="M21 5H3"/><path d="M15 12H3"/><path d="M17 19H3"/>',
  // hash
  number: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  // dollar-sign
  currency: '<line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  // square-check
  checkbox: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
  // square (unchecked)
  square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  // toggle-left
  toggle: '<circle cx="9" cy="12" r="3"/><rect width="20" height="14" x="2" y="5" rx="7"/>',
  // circle-dot
  single_select: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>',
  // list
  multi_select: '<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>',
  // calendar
  date: '<path d="M8 2v3"/><path d="M16 2v3"/><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/>',
  // link
  url: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  // mail
  email: '<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/>',
  // phone
  phone: '<path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"/>',
  // percent
  percent: '<line x1="19" x2="5" y1="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  // timer
  duration: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
  // star
  rating: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  // square-arrow-out-up-right (linked record)
  linked_record: '<path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/><path d="m21 3-9 9"/><path d="M15 3h6v6"/>',
  // braces (computed field badge)
  braces: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
  // pencil (rename)
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  // --- general UI icons ---
  // menu (hamburger)
  menu: '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>',
  // x (close)
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  // plus
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  // info
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  // chevron-down
  chevron_down: '<path d="m6 9 6 6 6-6"/>',
  // chevron-right
  chevron_right: '<path d="m9 18 6-6-6-6"/>',
  // arrow-up
  arrow_up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  // arrow-down
  arrow_down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  // arrow-right
  arrow_right: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  // arrow-up-a-z
  sort_az: '<path d="m3 8 4-4 4 4"/><path d="M7 4v16"/><path d="M20 8h-5"/><path d="M15 10V6.5a2.5 2.5 0 0 1 5 0V10"/><path d="M15 14h5l-5 6h5"/>',
  // arrow-down-z-a
  sort_za: '<path d="m3 16 4 4 4-4"/><path d="M7 4v16"/><path d="M15 4h5l-5 6h5"/><path d="M15 20v-3.5a2.5 2.5 0 0 1 5 0V20"/><path d="M20 18h-5"/>',

  // --- menu action icons ---
  // arrow-up-narrow-wide
  sort_asc: '<path d="m3 8 4-4 4 4"/><path d="M7 4v16"/><path d="M11 12h4"/><path d="M11 16h7"/><path d="M11 20h10"/>',
  // arrow-down-wide-narrow
  sort_desc: '<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/>',
  // eye-off
  hide: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  // snowflake
  freeze: '<path d="m10 20-1.25-2.5L6 18"/><path d="M10 4 8.75 6.5 6 6"/><path d="m14 20 1.25-2.5L18 18"/><path d="m14 4 1.25 2.5L18 6"/><path d="m17 21-3-6h-4"/><path d="m17 3-3 6 1.5 3"/><path d="M2 12h6.5L10 9"/><path d="m20 10-1.5 2 1.5 2"/><path d="M22 12h-6.5L14 15"/><path d="m4 10 1.5 2L4 14"/><path d="m7 21 3-6-1.5-3"/><path d="m7 3 3 6h4"/>',
  // panel-left-close
  insert_left: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>',
  // panel-right-close
  insert_right: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m8 9 3 3-3 3"/>',
  // copy
  duplicate: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  // trash-2
  delete: '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  // key
  primary: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  // text-cursor-input
  description: '<path d="M12 20h-1a2 2 0 0 1-2-2 2 2 0 0 1-2 2H6"/><path d="M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7"/><path d="M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1"/><path d="M6 4h1a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1"/><path d="M9 6v12"/>',
  // grip-vertical
  grip_vertical: '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>',
  // clipboard-copy
  copy_clipboard: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/><path d="M16 4h2a2 2 0 0 1 2 2v4"/><path d="M21 14H11"/><path d="m15 10-4 4 4 4"/>',
  // expand (maximize-2)
  expand: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>',
  // triangle-alert
  alert_triangle: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  // minimize-2 (collapse all)
  minimize: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/>',
  // maximize-2 (expand all) — reuses the `expand` entry
  // eye
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
}

export function fieldTypeIcon(type: string | undefined, props: IconProps = {}): string | null {
  const inner = icons[type ?? 'text']
  if (!inner) return null
  return svg(inner, props)
}

export function menuIcon(key: string, props: IconProps = {}): string {
  return svg(icons[key] ?? '', props)
}

export interface TypePickerProps {
  types: Array<{ value: string; label: string }>
  value: string
  disabled?: boolean
  testId?: string
  onChange: (value: string) => void
}

export function TypePicker({ types, value, disabled, testId, onChange }: TypePickerProps) {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState<string | null>(null)
  const current = types.find((t) => t.value === value)
  const listRef = useRef<HTMLDivElement>(null)
  const bufferRef = useRef('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); return }
      if (event.key === 'Enter' && highlight) {
        onChange(highlight)
        setOpen(false)
        return
      }
      if (event.key.length !== 1 || event.metaKey || event.ctrlKey) return

      if (timerRef.current) clearTimeout(timerRef.current)
      bufferRef.current += event.key.toLowerCase()
      timerRef.current = setTimeout(() => { bufferRef.current = '' }, 500)

      const match = types.find((t) => t.label.toLowerCase().startsWith(bufferRef.current))
      if (match) {
        setHighlight(match.value)
        listRef.current?.querySelector(`[data-value="${match.value}"]`)?.scrollIntoView({ block: 'nearest' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [open, highlight, types, onChange])

  useEffect(() => {
    if (open) setHighlight(null)
  }, [open])

  return (
    <div class="afs-type-picker">
      <button
        type="button"
        class="afs-type-picker__toggle"
        data-testid={testId ? `${testId}-toggle` : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span
          class="afs-type-list__icon"
          dangerouslySetInnerHTML={{ __html: fieldTypeIcon(value, { size: 14 }) ?? '' }}
        />
        {current?.label ?? value}
        <span class="afs-type-picker__caret" dangerouslySetInnerHTML={{ __html: menuIcon(open ? 'arrow_up' : 'arrow_down', { size: 12 }) }} />
      </button>
      {open ? (
        <div class="afs-type-list" data-testid={testId} ref={listRef}>
          {types.map((type) => (
            <button
              key={type.value}
              type="button"
              data-value={type.value}
              class={
                'afs-type-list__item' +
                (type.value === value ? ' afs-type-list__item--active' : '') +
                (type.value === highlight ? ' afs-type-list__item--highlight' : '')
              }
              onClick={() => {
                onChange(type.value)
                setOpen(false)
              }}
            >
              <span
                class="afs-type-list__icon"
                dangerouslySetInnerHTML={{ __html: fieldTypeIcon(type.value, { size: 14 }) ?? '' }}
              />
              {type.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export interface ColumnPickerProps {
  columns: Array<{ name: string; displayType?: string }>
  value: string
  testId?: string
  class?: string
  onChange: (name: string) => void
}

export function ColumnPicker({ columns, value, testId, class: className, onChange }: ColumnPickerProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const current = columns.find((c) => c.name === value)
  const listRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const bufferRef = useRef('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); return }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
        bufferRef.current += event.key.toLowerCase()
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => { bufferRef.current = '' }, 500)
        const match = listRef.current?.querySelector<HTMLElement>(
          `[data-col-name^="${CSS.escape(bufferRef.current)}"]`,
        )
        match?.scrollIntoView({ block: 'nearest' })
        match?.focus()
      }
    }
    const onDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node) &&
          !listRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [open])

  const handleOpen = () => {
    if (open) { setOpen(false); return }
    bufferRef.current = ''
    const rect = toggleRef.current?.getBoundingClientRect()
    if (rect) setPos({ left: rect.left, top: rect.bottom + 2 })
    setOpen(true)
  }

  return (
    <div class={`afs-col-picker${className ? ` ${className}` : ''}`} ref={containerRef}>
      <button
        type="button"
        class="afs-col-picker__toggle"
        data-testid={testId}
        ref={toggleRef}
        onClick={handleOpen}
      >
        <span
          class="afs-type-list__icon"
          dangerouslySetInnerHTML={{ __html: fieldTypeIcon(current?.displayType, { size: 14 }) ?? '' }}
        />
        {value}
        <span class="afs-type-picker__caret" dangerouslySetInnerHTML={{ __html: menuIcon(open ? 'arrow_up' : 'arrow_down', { size: 10 }) }} />
      </button>
      {open && pos ? (
        <div class="afs-col-picker__list" ref={listRef} style={{ left: `${pos.left}px`, top: `${pos.top}px` }}>
          {columns.map((col) => (
            <button
              key={col.name}
              type="button"
              class={`afs-col-picker__item${col.name === value ? ' afs-col-picker__item--active' : ''}`}
              data-col-name={col.name.toLowerCase()}
              onClick={() => {
                onChange(col.name)
                setOpen(false)
              }}
            >
              <span
                class="afs-type-list__icon"
                dangerouslySetInnerHTML={{ __html: fieldTypeIcon(col.displayType, { size: 14 }) ?? '' }}
              />
              {col.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
