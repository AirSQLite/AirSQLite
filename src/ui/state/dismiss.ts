import { useEffect, useRef } from 'preact/hooks'

// "Click anywhere outside and it closes, Escape closes it too."
//
// One rule, five menus: columns, groups, sort, filter, and the view list. It lived inside
// index.tsx while three of them were there; the filter panel adopting it is what made it
// shared, because the alternative was a fourth copy that would drift from the other three.
//
// The container is a ref rather than a document-wide selector so nested menus work: a click
// inside a submenu is inside its parent too, and each level only closes when the click landed
// outside its own subtree.

export function useDismissOnOutside<T extends HTMLElement = HTMLSpanElement>(
  open: boolean,
  close: () => void,
) {
  const container = useRef<T>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  return container
}
