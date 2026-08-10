import { useEffect, useRef } from 'preact/hooks'

// Every destructive action passes through here, and the message says what will happen in
// counted, concrete terms — "Delete 3 records?", not "Are you sure?". Undo (Phase 10) is the
// safety net behind this, not a replacement for it.

export interface ConfirmModalProps {
  title: string
  detail?: string
  /**
   * Shown verbatim in a monospaced block: the exact command or request an action would make.
   * Separate from `detail` because this is evidence, not prose — it must not be reflowed,
   * and what is displayed has to be character-for-character what will run.
   */
  preview?: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
  /**
   * A second affirmative answer, for a question with two valid ones — duplicate this column
   * *with* its values or *without* them. Distinct from Cancel, which is always present and
   * always does nothing: offering "Leave empty" as the cancel button would make backing out
   * of the dialog perform a schema change.
   */
  secondaryLabel?: string
  onSecondary?: () => void
}

export function ConfirmModal({
  title,
  detail,
  preview,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
  secondaryLabel,
  onSecondary,
}: ConfirmModalProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirmRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div class="afs-modal-backdrop" data-testid="confirm-modal" onClick={onCancel}>
      <div
        class="afs-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <strong>{title}</strong>
        {detail ? <p class="afs-modal__detail">{detail}</p> : null}
        {preview ? (
          <pre class="afs-modal__preview" data-testid="confirm-preview">
            {preview}
          </pre>
        ) : null}
        <div class="afs-modal__actions">
          <button type="button" class="afs-button" onClick={onCancel} data-testid="confirm-cancel">
            Cancel
          </button>
          {secondaryLabel && onSecondary ? (
            <button
              type="button"
              class="afs-button"
              onClick={onSecondary}
              data-testid="confirm-secondary"
            >
              {secondaryLabel}
            </button>
          ) : null}
          <button
            type="button"
            ref={confirmRef}
            class={`afs-button ${danger ? 'afs-button--danger' : 'afs-button--primary'}`}
            onClick={onConfirm}
            data-testid="confirm-accept"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
