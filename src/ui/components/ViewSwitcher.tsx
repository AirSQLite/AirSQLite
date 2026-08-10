import { useEffect, useRef, useState } from 'preact/hooks'
import type { SavedView } from '../../shared/protocol.js'
import { menuIcon } from './FieldTypeIcons.js'

// Views are per table and live in the database file, so they travel with it.
//
// **This file used to argue the opposite of what it now does.** The original note read:
// "The unsaved state is shown rather than auto-saved. Sorting or hiding a column to answer one
// question is the common case; silently rewriting the saved view every time would make views
// useless as a thing you return to."
//
// That objection is real and was not wrong. Airtable answers it with two things: duplicate a
// view before you explore, and personal views nobody else sees. We adopt the first and not the
// second, which is why "Duplicate view" sits directly under the view's own name rather than
// buried — it is the entire escape hatch, and a user who never finds it has no way back to a
// layout they liked. The cost of auto-save is real; it is being paid deliberately.

export interface ViewSwitcherProps {
  views: SavedView[]
  activeViewId: number | null
  active: SavedView | null
  writable: boolean
  /** The left panel's state, owned by the app — the panel is a sibling of the grid, not of this. */
  listOpen: boolean
  onToggleList: () => void
  onSelect: (id: number) => void
  onCreate: (name: string) => void
  onDuplicate: (name: string) => void
  onRename: (id: number, name: string) => void
  onDescribe: (id: number, description: string | null) => void
  onSetDefault: (id: number) => void
  onDelete: (id: number) => void
  onExportCsv: () => void
}

/** Which single-line prompt is open, if any. All three reuse one input. */
type Prompt =
  | { kind: 'create' }
  | { kind: 'duplicate' }
  | { kind: 'rename'; id: number }
  | { kind: 'describe'; id: number }

const PROMPTS: Record<Prompt['kind'], { placeholder: string; confirm: string; testid: string }> = {
  create: { placeholder: 'View name', confirm: 'Create', testid: 'view-create' },
  duplicate: { placeholder: 'Name for the copy', confirm: 'Duplicate', testid: 'view-duplicate' },
  rename: { placeholder: 'Rename view', confirm: 'Rename', testid: 'view-rename-save' },
  describe: { placeholder: 'View description', confirm: 'Save', testid: 'view-describe-save' },
}

export function ViewSwitcher({
  views,
  activeViewId,
  active,
  writable,
  listOpen,
  onToggleList,
  onSelect,
  onCreate,
  onDuplicate,
  onRename,
  onDescribe,
  onSetDefault,
  onDelete,
  onExportCsv,
}: ViewSwitcherProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [value, setValue] = useState('')
  const root = useRef<HTMLDivElement>(null)

  // Only the caret menu dismisses itself. The views list is a panel beside the grid, not a
  // menu over it: it is somewhere you work from while you work, so it stays until the hamburger
  // is clicked again. Closing it on the first click into the grid would make it useless for the
  // thing it is for — switching views while comparing them.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (event: MouseEvent) => {
      if (root.current?.contains(event.target as Node)) return
      setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const open = (next: Prompt, initial = '') => {
    setPrompt(next)
    setValue(initial)
    setMenuOpen(false)
  }

  const close = () => {
    setPrompt(null)
    setValue('')
  }

  const commit = () => {
    if (!prompt) return
    const trimmed = value.trim()
    // Every prompt but `describe` names something, and a nameless view is not a thing.
    if (!trimmed && prompt.kind !== 'describe') return

    if (prompt.kind === 'create') onCreate(trimmed)
    else if (prompt.kind === 'duplicate') onDuplicate(trimmed)
    else if (prompt.kind === 'rename') onRename(prompt.id, trimmed)
    else onDescribe(prompt.id, trimmed || null)
    close()
  }

  const spec = prompt ? PROMPTS[prompt.kind] : null

  return (
    <div class="afs-views" data-testid="view-switcher" ref={root}>
      <button
        type="button"
        class={`afs-views__hamburger${listOpen ? ' afs-views__hamburger--on' : ''}`}
        data-testid="view-list-toggle"
        aria-expanded={listOpen}
        title={listOpen ? 'Hide views' : 'Show views'}
        aria-label="Views"
        onClick={() => {
          onToggleList()
          setMenuOpen(false)
        }}
      >
        <span dangerouslySetInnerHTML={{ __html: menuIcon('menu', { size: 16 }) }} />
      </button>

      <span class="afs-views__name" data-testid="view-active-name">
        {active?.name ?? '—'}
      </span>

      {active?.description ? (
        <span class="afs-views__hint" data-testid="view-description" title={active.description} dangerouslySetInnerHTML={{ __html: menuIcon('info', { size: 14 }) }} />
      ) : null}

      {/* Styled like the column header caret rather than as a button: it is an affordance on
          the name beside it, not a control of its own, and a button outline around a single
          glyph reads as a second thing to press. */}
      <button
        type="button"
        class="afs-head__menu afs-views__caret"
        data-testid="view-menu-toggle"
        aria-expanded={menuOpen}
        title="View options"
        aria-label="View options"
        disabled={!active}
        onClick={() => setMenuOpen((prev) => !prev)}
      >
        <span dangerouslySetInnerHTML={{ __html: menuIcon('chevron_down', { size: 14 }) }} />
      </button>

      {menuOpen && active ? (
        <div class="afs-menu afs-views__menu" data-testid="view-menu" role="menu">
          {writable ? (
            <>
              <button
                type="button"
                class="afs-menu__item"
                role="menuitem"
                data-testid="view-rename"
                onClick={() => open({ kind: 'rename', id: active.id }, active.name)}
              >
                Rename view
              </button>
              <button
                type="button"
                class="afs-menu__item"
                role="menuitem"
                data-testid="view-describe"
                onClick={() => open({ kind: 'describe', id: active.id }, active.description ?? '')}
              >
                Edit view description
              </button>
              <button
                type="button"
                class="afs-menu__item"
                role="menuitem"
                data-testid="view-duplicate-open"
                onClick={() => open({ kind: 'duplicate' }, `${active.name} copy`)}
              >
                Duplicate view
              </button>
            </>
          ) : null}

          {/* Export needs no write permission — it reads the view and hands bytes to the host. */}
          <button
            type="button"
            class="afs-menu__item"
            role="menuitem"
            data-testid="view-export-csv"
            onClick={() => {
              onExportCsv()
              setMenuOpen(false)
            }}
          >
            Export view to CSV
          </button>

          {writable ? (
            <>
              <div class="afs-menu__divider" />
              {/* Only offered when it would do something. A button that is already true reads
                  as broken when clicking it changes nothing. */}
              {!active.isDefault ? (
                <button
                  type="button"
                  class="afs-menu__item"
                  role="menuitem"
                  data-testid="view-set-default"
                  onClick={() => {
                    onSetDefault(active.id)
                    setMenuOpen(false)
                  }}
                >
                  Set as default
                </button>
              ) : null}
              <button
                type="button"
                class="afs-menu__item afs-menu__item--danger"
                role="menuitem"
                data-testid="view-delete"
                onClick={() => {
                  onDelete(active.id)
                  setMenuOpen(false)
                }}
              >
                Delete view
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {prompt && spec ? (
        <span class="afs-views__naming">
          <input
            class="afs-views__input"
            data-testid="view-name"
            autofocus
            placeholder={spec.placeholder}
            value={value}
            onInput={(event) => setValue((event.currentTarget as HTMLInputElement).value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit()
              else if (event.key === 'Escape') close()
            }}
          />
          <button
            type="button"
            class="afs-button afs-button--primary"
            data-testid={spec.testid}
            disabled={!value.trim() && prompt.kind !== 'describe'}
            onClick={commit}
          >
            {spec.confirm}
          </button>
          {/* Escape cancels too, but a keyboard-only way out is not a way out for somebody
              reaching for the mouse — and the input otherwise has no visible exit. */}
          <button
            type="button"
            class="afs-button afs-views__cancel"
            data-testid="view-name-cancel"
            title="Cancel"
            aria-label="Cancel"
            onClick={close}
          >
            <span dangerouslySetInnerHTML={{ __html: menuIcon('x', { size: 14 }) }} />
          </button>
        </span>
      ) : null}
    </div>
  )
}

export interface ViewsPanelProps {
  views: SavedView[]
  activeViewId: number | null
  writable: boolean
  onSelect: (id: number) => void
  onCreate: (name: string) => void
}

/**
 * The views list, as a panel beside the grid rather than a menu over it.
 *
 * It was a dropdown first, and that was wrong for what it is used for: switching between views
 * to compare them means going back to the list repeatedly, and a menu that dismisses on the
 * first click into the grid makes each trip a two-click round. So this stays open until the
 * hamburger is clicked again, and it takes width from the grid rather than covering it —
 * nothing is hidden behind it.
 */
export function ViewsPanel({
  views,
  activeViewId,
  writable,
  onSelect,
  onCreate,
}: ViewsPanelProps) {
  // The panel names a new view itself rather than borrowing the toolbar's prompt. Creating one
  // is the thing you do *from the list*, and bouncing focus up to the toolbar to type the name
  // would put the input somewhere the eye is not.
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [filter, setFilter] = useState('')

  const commit = () => {
    const trimmed = name.trim()
    if (trimmed) onCreate(trimmed)
    setName('')
    setNaming(false)
  }

  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? views.filter((view) => view.name.toLowerCase().includes(needle))
    : views

  return (
    <aside class="afs-views-panel" data-testid="view-list" aria-label="Views">
      <div class="afs-views-panel__head">Views</div>

      {/* Always shown. It was hidden below five views on the theory that a short list is its
          own search — but a control that appears once a table crosses a threshold is a control
          nobody knows exists, and the panel is the one place someone would look for it. */}
      <input
        class="afs-views-panel__search"
        data-testid="view-search"
        placeholder="Find a view"
        value={filter}
        onInput={(event) => setFilter((event.currentTarget as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setFilter('')
        }}
      />

      <div class="afs-views-panel__list" role="menu">
        {shown.length === 0 ? (
          <p class="afs-menu__hint" data-testid="view-search-empty">
            No view matches “{filter}”.
          </p>
        ) : null}
        {shown.map((view) => (
          <button
            key={view.id}
            type="button"
            class={`afs-views-panel__item${
              view.id === activeViewId ? ' afs-views-panel__item--on' : ''
            }`}
            role="menuitem"
            data-view-id={view.id}
            title={view.description ?? view.name}
            onClick={() => onSelect(view.id)}
          >
            <span class="afs-views-panel__name">{view.name}</span>
            {view.isDefault ? <span class="afs-views-panel__tag">default</span> : null}
          </button>
        ))}
      </div>

      {writable ? (
        naming ? (
          <div class="afs-views-panel__naming">
            <input
              class="afs-views__input"
              data-testid="view-name"
              autofocus
              placeholder="View name"
              value={name}
              onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commit()
                else if (event.key === 'Escape') {
                  setName('')
                  setNaming(false)
                }
              }}
            />
            <button
              type="button"
              class="afs-button afs-button--primary"
              data-testid="view-create"
              disabled={!name.trim()}
              onClick={commit}
            >
              Create
            </button>
            <button
              type="button"
              class="afs-button afs-views__cancel"
              data-testid="view-name-cancel"
              title="Cancel"
              aria-label="Cancel"
              onClick={() => {
                setName('')
                setNaming(false)
              }}
            >
              <span dangerouslySetInnerHTML={{ __html: menuIcon('x', { size: 14 }) }} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            class="afs-views-panel__new"
            data-testid="view-new"
            onClick={() => setNaming(true)}
          >
            <span dangerouslySetInnerHTML={{ __html: menuIcon('plus', { size: 14 }) }} /> Create new view
          </button>
        )
      ) : null}
    </aside>
  )
}
