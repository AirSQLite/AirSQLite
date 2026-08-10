import { useEffect, useRef, useState } from 'preact/hooks'

// Scoped to the active table, by design — not a global search. Searching every table would
// return rows the grid cannot show without switching context out from under the user.
//
// Search is transient and is not part of a saved view: it answers a question you have right
// now, whereas a view is a way of looking that you return to.
//
// The input is deliberately **uncontrolled**. A controlled `value={draft}` re-asserts the DOM
// value on every render, and this app re-renders a lot while a table loads — meta, views,
// foreign keys, and row chunks all arrive separately. A render landing between a keystroke
// reaching the DOM and the input event being handled silently wipes what was typed. Owning
// the element by ref and writing to it only when the *external* value changes removes that
// race rather than narrowing the window.

const DEBOUNCE_MS = 200

export interface SearchBarProps {
  value: string
  onChange: (value: string) => void
}

export function SearchBar({ value, onChange }: SearchBarProps) {
  const input = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(value)

  // Every keystroke is a query against SQLite, so wait for a pause before asking.
  useEffect(() => {
    if (draft === value) return
    const timer = setTimeout(() => onChange(draft), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft, value, onChange])

  // Push an external reset (a table switch, say) into the DOM — and only then.
  useEffect(() => {
    const element = input.current
    if (element && element.value !== value) {
      element.value = value
      setDraft(value)
    }
  }, [value])

  const clear = () => {
    if (input.current) input.current.value = ''
    setDraft('')
    onChange('')
  }

  return (
    <span class="afs-search">
      <input
        ref={input}
        class="afs-search__input"
        data-testid="search-input"
        type="search"
        placeholder="Search this table"
        onInput={(event) => setDraft((event.currentTarget as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onChange(draft)
          if (event.key === 'Escape') clear()
        }}
      />
    </span>
  )
}
