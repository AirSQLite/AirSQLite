// Select-field options: the list, the colors, and the two ways people get values into it.
//
// Everything here is pure. The editor UI, the cell renderer, and the bulk editor all read the
// same normalised shape, so there is exactly one answer to "what color is this value" rather
// than three that can drift.

/** A color name, not a hex value — the actual color resolves through an `--afs-choice-*` token. */
export type ChoiceColor =
  | 'blue'
  | 'cyan'
  | 'teal'
  | 'green'
  | 'lime'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'pink'
  | 'purple'
  | 'indigo'
  | 'gray'

/**
 * Twelve colors in a fixed order, assigned to options as they are added.
 *
 * Fixed rather than random so a list built twice looks the same twice, and ordered so adjacent
 * options are adjacent hues — which makes a long list read as a spectrum instead of a jumble.
 * Grey is last because it is the one that reads as "no category" and should not be handed out
 * while a real color is free.
 */
export const CHOICE_COLORS: ChoiceColor[] = [
  'blue',
  'cyan',
  'teal',
  'green',
  'lime',
  'yellow',
  'orange',
  'red',
  'pink',
  'purple',
  'indigo',
  'gray',
]

export interface Choice {
  value: string
  color: ChoiceColor
}

export interface ChoiceOptions {
  choices: Choice[]
  /** Whether cells render their value as a colored chip or as plain text. */
  colored: boolean
  /** Pre-filled into new records. Null means none. */
  defaultValue: string | null
}

export const EMPTY_OPTIONS: ChoiceOptions = { choices: [], colored: true, defaultValue: null }

/** The color the nth option gets, cycling once twelve are used. */
export function colorFor(index: number): ChoiceColor {
  return CHOICE_COLORS[index % CHOICE_COLORS.length] as ChoiceColor
}

function isChoiceColor(value: unknown): value is ChoiceColor {
  return typeof value === 'string' && (CHOICE_COLORS as string[]).includes(value)
}

/**
 * Read whatever is in `_airsqlite_columns.options` into the canonical shape.
 *
 * Two formats exist in the wild. The original was `{choices: ["a", "b"]}` — a plain string
 * array, which is what an agent writing a column by hand still produces and what every database
 * configured before this phase contains. The current one carries a color per choice. Both are
 * accepted, and a string array is colored by position, so an old file gains colors by being
 * opened rather than needing a migration.
 */
export function parseOptions(raw: Record<string, unknown> | null | undefined): ChoiceOptions {
  if (!raw) return EMPTY_OPTIONS

  const list = Array.isArray(raw['choices']) ? raw['choices'] : []
  const seen = new Set<string>()
  const choices: Choice[] = []

  for (const entry of list) {
    if (typeof entry === 'string') {
      if (!entry || seen.has(entry)) continue
      seen.add(entry)
      choices.push({ value: entry, color: colorFor(choices.length) })
      continue
    }
    if (entry && typeof entry === 'object') {
      const value = String((entry as Record<string, unknown>)['value'] ?? '')
      if (!value || seen.has(value)) continue
      seen.add(value)
      const color = (entry as Record<string, unknown>)['color']
      choices.push({ value, color: isChoiceColor(color) ? color : colorFor(choices.length) })
    }
  }

  const defaultValue = raw['defaultValue']
  return {
    choices,
    // Default true: a select field with no colors is a text field with extra steps, and the
    // stored `false` is the deliberate case.
    colored: raw['colored'] !== false,
    defaultValue:
      typeof defaultValue === 'string' && seen.has(defaultValue) ? defaultValue : null,
  }
}

/** Back to the stored shape. Written whole, never patched, so the order in the array is the order. */
export function serializeOptions(options: ChoiceOptions): Record<string, unknown> {
  return {
    choices: options.choices.map((c) => ({ value: c.value, color: c.color })),
    colored: options.colored,
    defaultValue: options.defaultValue,
  }
}

/**
 * Split pasted text into values, accepting both formats people actually have.
 *
 * A JSON array is taken as one — that is what a list copied out of another tool or exported
 * from this one looks like. Anything else splits on commas and newlines. The JSON attempt comes
 * first because `["a","b"]` split on commas produces `["a"` and `"b"]`, which is worse than
 * useless: it looks like it worked.
 */
export function parsePastedValues(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return dedupe(parsed.map((v) => String(v).trim()).filter(Boolean))
      }
    } catch {
      // Not JSON after all — fall through and treat it as a delimited list.
    }
  }

  return dedupe(
    trimmed
      .split(/[,\n\r]+/)
      .map((v) => v.trim())
      .filter(Boolean),
  )
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  return values.filter((v) => (seen.has(v) ? false : (seen.add(v), true)))
}

/** Add values that are not already present, coloring each by its position in the final list. */
export function addValues(options: ChoiceOptions, values: string[]): ChoiceOptions {
  const existing = new Set(options.choices.map((c) => c.value))
  const choices = [...options.choices]
  for (const value of values) {
    if (existing.has(value)) continue
    existing.add(value)
    choices.push({ value, color: colorFor(choices.length) })
  }
  return { ...options, choices }
}

/**
 * Rename an option, carrying the default with it.
 *
 * Renaming does *not* rewrite the rows holding the old value — that would be a bulk data edit
 * hiding inside a config change. The old value stays in the cells and shows as an unconfigured
 * value, which is visible and fixable, rather than silently rewriting records.
 */
export function renameChoice(options: ChoiceOptions, from: string, to: string): ChoiceOptions {
  const value = to.trim()
  if (!value || value === from) return options
  if (options.choices.some((c) => c.value === value)) return options
  return {
    ...options,
    choices: options.choices.map((c) => (c.value === from ? { ...c, value } : c)),
    defaultValue: options.defaultValue === from ? value : options.defaultValue,
  }
}

export function removeChoice(options: ChoiceOptions, value: string): ChoiceOptions {
  return {
    ...options,
    choices: options.choices.filter((c) => c.value !== value),
    defaultValue: options.defaultValue === value ? null : options.defaultValue,
  }
}

/** Sort by value. Colors travel with their option rather than being reassigned by position. */
export function sortChoices(options: ChoiceOptions, direction: 'asc' | 'desc'): ChoiceOptions {
  const sorted = [...options.choices].sort((a, b) =>
    direction === 'asc' ? a.value.localeCompare(b.value) : b.value.localeCompare(a.value),
  )
  return { ...options, choices: sorted }
}

/** The clipboard form of the whole list: comma separated, which is what people paste elsewhere. */
export function choicesToText(options: ChoiceOptions): string {
  return options.choices.map((c) => c.value).join(', ')
}
