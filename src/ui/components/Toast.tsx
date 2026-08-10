import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

// Toasts carry the backend's own words. The error mapper in src/backend/errors.ts already
// turns "UNIQUE constraint failed: customers.email" into a sentence naming the column and
// echoing what was typed, so nothing here rewrites or truncates a message — doing so would
// throw away the only explanation the user gets.

export type ToastKind = 'error' | 'info'

export interface ToastMessage {
  id: number
  kind: ToastKind
  text: string
}

const DISMISS_MS: Record<ToastKind, number> = {
  // Errors get longer: they usually describe something the user has to act on.
  error: 5_000,
  info: 4_000,
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) clearTimeout(timer)
    timers.current.delete(id)
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (kind: ToastKind, text: string) => {
      const id = nextId.current++
      setToasts((prev) => [...prev, { id, kind, text }])
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DISMISS_MS[kind]),
      )
      return id
    },
    [dismiss],
  )

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer)
      timers.current.clear()
    },
    [],
  )

  return {
    toasts,
    dismiss,
    error: useCallback((text: string) => push('error', text), [push]),
    info: useCallback((text: string) => push('info', text), [push]),
  }
}

export interface ToastHostProps {
  toasts: ToastMessage[]
  onDismiss: (id: number) => void
}

export function ToastHost({ toasts, onDismiss }: ToastHostProps) {
  if (toasts.length === 0) return null

  return (
    <div class="afs-toasts" data-testid="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          class={`afs-toast afs-toast--${toast.kind}`}
          data-testid={`toast-${toast.kind}`}
          onClick={() => onDismiss(toast.id)}
          title="Dismiss"
        >
          {toast.text}
        </button>
      ))}
    </div>
  )
}
