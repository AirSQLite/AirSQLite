import { useCallback, useState } from 'preact/hooks'
import { useDismissOnOutside } from '../state/dismiss.js'
import type { TableInfo } from '../../shared/protocol.js'
import { menuIcon } from './FieldTypeIcons.js'
import { useReorder } from '../state/reorder.js'

// Tables as tabs, Airtable-style. `_airsqlite_*` never reaches here — the backend excludes it
// from `tables()`, so configuration cannot be browsed as if it were data.
//
// Tabs can be dragged to reorder, and the order is stored in `_airsqlite_tables.sort_order`, so it
// travels inside the database file like every other piece of configuration. A table with no
// stored rank keeps its alphabetical position at the end, which is what makes a table created
// later show up rather than disappear.

export interface TableTabsProps {
  tables: TableInfo[]
  active: string | null
  /** Absent when the order cannot be persisted — a read-only file. Dragging is then disabled. */
  onReorder?: (names: string[]) => void
  onSelect: (name: string) => void
  /** Absent on a read-only file, where creating a table is not on offer. */
  onCreate?: (name: string) => void
  onRename?: (table: string, name: string) => void
  onDescribe?: (table: string, description: string | null) => void
  onDelete?: (table: string) => void
}

export function TableTabs({
  tables,
  active,
  onSelect,
  onReorder,
  onCreate,
  onRename,
  onDescribe,
  onDelete,
}: TableTabsProps) {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  /**
   * Where to paint the tab menu, measured from the caret.
   *
   * `.afs-tabs` scrolls horizontally, and a scroll container clips on *both* axes — so an
   * absolutely-positioned menu inside it is rendered, has a correct bounding box, and is
   * painted nowhere. Exactly the failure 07a70c3 found three times in the column header. The
   * fix there and in the summary bar is the same: position it fixed, from a measurement.
   */
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null)
  /** Which tab is being renamed or described, and which of the two. */
  const [editing, setEditing] = useState<{ table: string; kind: 'rename' | 'describe' } | null>(null)
  const [draft, setDraft] = useState('')

  const container = useDismissOnOutside<HTMLDivElement>(
    menuFor !== null,
    useCallback(() => setMenuFor(null), []),
  )

  const commitEdit = () => {
    if (!editing) return
    const value = draft.trim()
    if (editing.kind === 'rename') {
      if (value) onRename?.(editing.table, value)
    } else {
      onDescribe?.(editing.table, value || null)
    }
    setEditing(null)
    setDraft('')
  }

  const commit = () => {
    const trimmed = name.trim()
    if (trimmed) onCreate?.(trimmed)
    setName('')
    setNaming(false)
  }

  const names = tables.map((t) => t.name)
  const reorder = useReorder({
    items: names,
    onReorder: (next) => onReorder?.(next),
    enabled: !!onReorder && tables.length > 1,
  })

  const configurable = !!onRename && !!onDescribe && !!onDelete

  return (
    <div class="afs-tabs" role="tablist" data-testid="table-tabs" ref={container}>
      {tables.map((table) => {
        const edge = reorder.edge(table.name)
        const isActive = table.name === active
        return (
          <span
            key={table.name}
            class={`afs-tab-wrap${edge ? ` afs-tab--drop-${edge}` : ''}${
              reorder.dragging === table.name ? ' afs-tab--dragging' : ''
            }`}
            {...reorder.itemProps(table.name)}
          >
            <button
              type="button"
              role="tab"
              class="afs-tab"
              aria-selected={isActive}
              data-table={table.name}
              onClick={() => onSelect(table.name)}
            >
              {table.name}
            </button>

            {table.description ? (
              <span
                class="afs-tab__info"
                data-testid={`table-description-${table.name}`}
                title={table.description}
                dangerouslySetInnerHTML={{ __html: menuIcon('info', { size: 14 }) }}
              />
            ) : null}

            {/* Only on the tab you are looking at. A caret on every tab is a row of controls
                for tables you are not working in, and the menu acts on the active one anyway. */}
            {configurable && isActive ? (
              <button
                type="button"
                class="afs-head__menu afs-tab__caret"
                data-testid={`table-menu-${table.name}`}
                aria-expanded={menuFor === table.name}
                title={`Options for ${table.name}`}
                aria-label={`Options for ${table.name}`}
                // Opens on mousedown and stops there. The wrapper is `draggable`, and a
                // draggable ancestor swallows the pointer events its children need — the same
                // guard the column header caret, the resize handle, and the freeze handle use.
                onMouseDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  if (menuFor === table.name) {
                    setMenuFor(null)
                    return
                  }
                  const rect = (
                    event.currentTarget as HTMLElement
                  ).getBoundingClientRect()
                  setAnchor({ left: rect.left, top: rect.bottom + 4 })
                  setMenuFor(table.name)
                }}
                onClick={(event) => event.stopPropagation()}
              >
                <span dangerouslySetInnerHTML={{ __html: menuIcon('chevron_down', { size: 14 }) }} />
              </button>
            ) : null}

            {menuFor === table.name && anchor ? (
              <div
                class="afs-menu afs-menu--fixed"
                data-testid="table-menu"
                role="menu"
                style={{ left: `${anchor.left}px`, top: `${anchor.top}px` }}
              >
                <button
                  type="button"
                  class="afs-menu__item"
                  role="menuitem"
                  data-testid="table-rename"
                  onClick={() => {
                    setEditing({ table: table.name, kind: 'rename' })
                    setDraft(table.name)
                    setMenuFor(null)
                  }}
                >
                  Rename table
                </button>
                <button
                  type="button"
                  class="afs-menu__item"
                  role="menuitem"
                  data-testid="table-describe"
                  onClick={() => {
                    setEditing({ table: table.name, kind: 'describe' })
                    setDraft(table.description ?? '')
                    setMenuFor(null)
                  }}
                >
                  Edit table description
                </button>
                <div class="afs-menu__divider" />
                <button
                  type="button"
                  class="afs-menu__item afs-menu__item--danger"
                  role="menuitem"
                  data-testid="table-delete"
                  onClick={() => {
                    setMenuFor(null)
                    onDelete?.(table.name)
                  }}
                >
                  Delete table
                </button>
              </div>
            ) : null}
          </span>
        )
      })}

      {editing ? (
        <span class="afs-tabs__naming">
          <input
            class="afs-views__input"
            data-testid="table-edit-input"
            autofocus
            placeholder={editing.kind === 'rename' ? 'Table name' : 'Table description'}
            value={draft}
            onInput={(event) => setDraft((event.currentTarget as HTMLInputElement).value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitEdit()
              else if (event.key === 'Escape') {
                setEditing(null)
                setDraft('')
              }
            }}
          />
          <button
            type="button"
            class="afs-button afs-button--primary"
            data-testid="table-edit-save"
            disabled={editing.kind === 'rename' && !draft.trim()}
            onClick={commitEdit}
          >
            Save
          </button>
          <button
            type="button"
            class="afs-button afs-views__cancel"
            data-testid="table-edit-cancel"
            title="Cancel"
            aria-label="Cancel"
            onClick={() => {
              setEditing(null)
              setDraft('')
            }}
          >
            <span dangerouslySetInnerHTML={{ __html: menuIcon('x', { size: 14 }) }} />
          </button>
        </span>
      ) : null}

      {onCreate ? (
        naming ? (
          <span class="afs-tabs__naming">
            <input
              class="afs-views__input"
              data-testid="table-name"
              autofocus
              placeholder="Table name"
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
              data-testid="table-create"
              disabled={!name.trim()}
              onClick={commit}
            >
              Create
            </button>
            <button
              type="button"
              class="afs-button afs-views__cancel"
              data-testid="table-name-cancel"
              title="Cancel"
              aria-label="Cancel"
              onClick={() => {
                setName('')
                setNaming(false)
              }}
            >
              <span dangerouslySetInnerHTML={{ __html: menuIcon('x', { size: 14 }) }} />
            </button>
          </span>
        ) : (
          <button
            type="button"
            class="afs-tab afs-tab--add"
            data-testid="table-new"
            title="Create a table"
            onClick={() => setNaming(true)}
          >
            +
          </button>
        )
      ) : null}
    </div>
  )
}
