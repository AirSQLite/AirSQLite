import { useState } from 'preact/hooks'
import { menuIcon } from './FieldTypeIcons.js'
import {
  CHOICE_COLORS,
  addValues,
  choicesToText,
  colorFor,
  parsePastedValues,
  removeChoice,
  renameChoice,
  sortChoices,
  type ChoiceColor,
  type ChoiceOptions,
} from '../state/choices.js'
import { useReorder } from '../state/reorder.js'

// Configuring a select field's options.
//
// This replaced a single comma-separated text box. That box was fine for three values and
// actively hostile at thirty: no way to see the list, no way to reorder it, no way to tell
// which value a color belonged to, and renaming one meant retyping the whole line and hoping
// you had not dropped a comma. The list below is the same data with each operation given its
// own affordance.
//
// Every edit reports the *whole* options object. Options are stored as one JSON blob, so a
// partial update has nothing to merge into — and the order of the array is the order the user
// dragged the rows into, which a patch-shaped API would lose.

export interface ChoiceEditorProps {
  options: ChoiceOptions
  disabled: boolean
  onChange: (options: ChoiceOptions) => void
}

export function ChoiceEditor({ options, disabled, onChange }: ChoiceEditorProps) {
  const [adding, setAdding] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)

  const reorder = useReorder({
    items: options.choices.map((c) => c.value),
    enabled: !disabled,
    orientation: 'vertical',
    onReorder: (order) => {
      const byValue = new Map(options.choices.map((c) => [c.value, c]))
      // Colors stay with their option rather than being reassigned by position. Dragging
      // "Won" down the list must not turn it from green into orange.
      onChange({
        ...options,
        choices: order.map((value) => byValue.get(value)).filter((c) => !!c),
      })
    },
  })

  /** Accepts one value or a whole pasted list — see `parsePastedValues`. */
  const commitAdd = (text: string) => {
    const values = parsePastedValues(text)
    if (values.length > 0) onChange(addValues(options, values))
    setAdding('')
  }

  /**
   * Renaming an option does not rewrite the rows holding the old value — that would be a bulk
   * data edit hiding inside a config change. The old value stays in the cells and renders as an
   * unconfigured chip, which is visible and fixable.
   */
  const commitRename = (from: string) => {
    onChange(renameChoice(options, from, draft))
    setEditing(null)
    setDraft('')
  }

  const copyAll = () => {
    void navigator.clipboard?.writeText(choicesToText(options)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div class="afs-choices" data-testid="choice-editor">
      <div class="afs-choices__bar">
        <span class="afs-menu__label">Options</span>
        <button
          type="button"
          class="afs-button afs-choices__mini"
          data-testid="choices-sort-asc"
          title="Sort A–Z"
          disabled={disabled || options.choices.length < 2}
          onClick={() => onChange(sortChoices(options, 'asc'))}
        >
          <span dangerouslySetInnerHTML={{ __html: menuIcon('sort_az', { size: 14 }) }} />
        </button>
        <button
          type="button"
          class="afs-button afs-choices__mini"
          data-testid="choices-sort-desc"
          title="Sort Z–A"
          disabled={disabled || options.choices.length < 2}
          onClick={() => onChange(sortChoices(options, 'desc'))}
        >
          <span dangerouslySetInnerHTML={{ __html: menuIcon('sort_za', { size: 14 }) }} />
        </button>
        <button
          type="button"
          class="afs-button afs-choices__mini"
          data-testid="choices-copy"
          title="Copy every option as a comma-separated list"
          disabled={options.choices.length === 0}
          onClick={copyAll}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* Scrollable rather than growing without bound: a forty-option field would otherwise
          push the field-type dropdown off the bottom of the menu. */}
      <ul class="afs-choices__list" data-testid="choices-list">
        {options.choices.map((choice) => {
          const edge = reorder.edge(choice.value)
          return (
            <li
              key={choice.value}
              class={`afs-choices__row${edge ? ` afs-choices__row--drop-${edge}` : ''}${
                reorder.dragging === choice.value ? ' afs-choices__row--dragging' : ''
              }`}
              data-choice={choice.value}
              {...reorder.itemProps(choice.value)}
            >
              <span class="afs-choices__grip" aria-hidden="true">
                ⠿
              </span>

              <select
                class="afs-choices__color"
                data-testid={`choice-color-${choice.value}`}
                aria-label={`Color for ${choice.value}`}
                style={{ background: `var(--afs-choice-${choice.color})` }}
                value={choice.color}
                disabled={disabled}
                onChange={(event) => {
                  const color = (event.currentTarget as HTMLSelectElement).value as ChoiceColor
                  onChange({
                    ...options,
                    choices: options.choices.map((c) =>
                      c.value === choice.value ? { ...c, color } : c,
                    ),
                  })
                }}
              >
                {CHOICE_COLORS.map((color) => (
                  <option key={color} value={color}>
                    {color}
                  </option>
                ))}
              </select>

              {editing === choice.value ? (
                <input
                  class="afs-choices__input"
                  data-testid="choice-rename"
                  autofocus
                  value={draft}
                  onInput={(event) => setDraft((event.currentTarget as HTMLInputElement).value)}
                  onBlur={() => commitRename(choice.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitRename(choice.value)
                    else if (event.key === 'Escape') {
                      setEditing(null)
                      setDraft('')
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  class="afs-choices__value"
                  data-testid={`choice-value-${choice.value}`}
                  disabled={disabled}
                  title="Click to rename"
                  onClick={() => {
                    setEditing(choice.value)
                    setDraft(choice.value)
                  }}
                >
                  {choice.value}
                </button>
              )}

              <button
                type="button"
                class="afs-choices__remove"
                data-testid={`choice-remove-${choice.value}`}
                title={`Remove ${choice.value}`}
                aria-label={`Remove ${choice.value}`}
                disabled={disabled}
                onClick={() => onChange(removeChoice(options, choice.value))}
              >
                <span dangerouslySetInnerHTML={{ __html: menuIcon('x', { size: 12 }) }} />
              </button>
            </li>
          )
        })}
      </ul>

      {/* One input for both jobs. Typing a name adds one option; pasting a list adds all of
          them, because the parser decides by what arrived rather than by which box it went in
          — there is no second box to discover. */}
      <input
        class="afs-menu__input"
        data-testid="choice-add"
        placeholder="Add an option, or paste a list"
        value={adding}
        disabled={disabled}
        onInput={(event) => setAdding((event.currentTarget as HTMLInputElement).value)}
        onPaste={(event) => {
          const text = event.clipboardData?.getData('text') ?? ''
          const values = parsePastedValues(text)
          // Only intercept a paste that is actually a list. Pasting a single value should
          // land in the box so it can be edited before being committed.
          if (values.length < 2) return
          event.preventDefault()
          onChange(addValues(options, values))
          setAdding('')
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          commitAdd(adding)
        }}
        onBlur={() => commitAdd(adding)}
      />

      {/* One setting, not a star on every row.
          A star per option is a radio group drawn as twelve toggles: the rule that only one can
          be on is invisible until you click a second and watch the first go out, and with the
          list scrolled you cannot see which one is set without scrolling to find it. A single
          dropdown states the rule by being a dropdown, and shows the answer without hunting. */}
      <label class="afs-choices__setting">
        Default
        <select
          class="afs-choices__default-select"
          data-testid="choices-default"
          value={options.defaultValue ?? ''}
          disabled={disabled || options.choices.length === 0}
          onChange={(event) => {
            const next = (event.currentTarget as HTMLSelectElement).value
            onChange({ ...options, defaultValue: next || null })
          }}
        >
          <option value="">None</option>
          {options.choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.value}
            </option>
          ))}
        </select>
      </label>

      <label class="afs-choices__toggle">
        <input
          type="checkbox"
          data-testid="choices-colored"
          checked={options.colored}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...options, colored: (event.currentTarget as HTMLInputElement).checked })
          }
        />
        Color values in the grid
      </label>
    </div>
  )
}

/** Where a brand-new option's color comes from, exported so the cell editor agrees. */
export { colorFor }
