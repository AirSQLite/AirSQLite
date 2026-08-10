import type { ActionDefinition, Row } from '../../shared/protocol.js'

// Buttons configured in `_airsqlite_actions` by a coding agent, not by any GUI in this app.
//
// That is why a malformed definition renders as a *disabled* button explaining itself rather
// than as nothing at all: whoever wrote the row has no form validation to have caught it, and
// a button that silently fails to appear is impossible to debug from the other side.

export interface ActionButtonsProps {
  actions: ActionDefinition[]
  row: Row
  /** Which action is mid-flight, so a slow webhook cannot be fired twice by an impatient click. */
  running: number | null
  inline?: boolean
  onRun: (action: ActionDefinition, row: Row) => void
}

export function ActionButtons({ actions, row, running, inline, onRun }: ActionButtonsProps) {
  if (actions.length === 0) return null

  return (
    <div
      class={`afs-actions${inline ? ' afs-actions--inline' : ''}`}
      data-testid={inline ? 'row-actions' : 'record-actions'}
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          class={`afs-action afs-action--${action.style}${
            running === action.id ? ' afs-action--running' : ''
          }`}
          data-testid={`action-${action.id}`}
          data-action-label={action.label}
          disabled={action.problem !== null || running === action.id}
          title={action.problem ?? action.label}
          onClick={(event) => {
            // Inline in a row, this sits on top of a cell that would otherwise open an
            // editor and move the detail panel.
            event.stopPropagation()
            onRun(action, row)
          }}
        >
          {action.icon ? <span aria-hidden="true">{action.icon}</span> : null}
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  )
}
