import type { SqlValue } from '../../shared/protocol.js'
import { formatValue } from './CellValue.js'

// A foreign key rendered as the thing it points at rather than as the integer it stores.
//
// When the label has not arrived — or the key matches no record at all — the raw value shows
// instead, dimmed. Both cases are honest: one resolves in a moment, and the other is a
// dangling key that genuinely is just a number.

export interface LinkedRecordChipProps {
  value: SqlValue | undefined
  label: string | undefined
  onNavigate: () => void
}

export function LinkedRecordChip({ value, label, onNavigate }: LinkedRecordChipProps) {
  const raw = formatValue(value)
  if (raw === '') return <span />

  const resolved = label !== undefined && label !== ''

  return (
    <button
      type="button"
      class={`afs-chip${resolved ? '' : ' afs-chip--unresolved'}`}
      data-testid="link-chip"
      data-link-value={raw}
      title={resolved ? `${label} — open record` : raw}
      onClick={(event) => {
        // The cell behind this opens an editor on click; a chip is a navigation control.
        event.stopPropagation()
        onNavigate()
      }}
    >
      {resolved ? label : raw}
    </button>
  )
}
