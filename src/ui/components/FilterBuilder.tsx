import type {
  ColumnDescriptor,
  DisplayType,
  FilterCondition,
  FilterGroup,
  FilterNode,
  FilterOperator,
  SqlValue,
} from '../../shared/protocol.js'
import { ColumnPicker, menuIcon } from './FieldTypeIcons.js'
import { parseOptions } from '../state/choices.js'

// A filter builder with no SQL in it anywhere.
//
// The operator list is derived from the column's display type, which is the whole payoff of
// the metadata layer: offering "greater than" on an email column or "starts with" on a
// checkbox is how a filter UI teaches people it does not understand their data.

interface OperatorChoice {
  value: FilterOperator
  label: string
  /** How many value inputs this operator needs. */
  arity: 0 | 1 | 2
}

const TEXT_OPERATORS: OperatorChoice[] = [
  { value: 'contains', label: 'contains', arity: 1 },
  { value: 'not_contains', label: 'does not contain', arity: 1 },
  { value: 'is', label: 'is', arity: 1 },
  { value: 'is_not', label: 'is not', arity: 1 },
  { value: 'starts_with', label: 'starts with', arity: 1 },
  { value: 'ends_with', label: 'ends with', arity: 1 },
  { value: 'is_empty', label: 'is empty', arity: 0 },
  { value: 'is_not_empty', label: 'is not empty', arity: 0 },
]

const NUMBER_OPERATORS: OperatorChoice[] = [
  { value: 'eq', label: '=', arity: 1 },
  { value: 'neq', label: '≠', arity: 1 },
  { value: 'gt', label: '>', arity: 1 },
  { value: 'gte', label: '≥', arity: 1 },
  { value: 'lt', label: '<', arity: 1 },
  { value: 'lte', label: '≤', arity: 1 },
  { value: 'between', label: 'between', arity: 2 },
  { value: 'is_empty', label: 'is empty', arity: 0 },
  { value: 'is_not_empty', label: 'is not empty', arity: 0 },
]

const DATE_OPERATORS: OperatorChoice[] = [
  { value: 'is', label: 'is', arity: 1 },
  { value: 'is_not', label: 'is not', arity: 1 },
  { value: 'gt', label: 'is after', arity: 1 },
  { value: 'lt', label: 'is before', arity: 1 },
  { value: 'is_empty', label: 'is empty', arity: 0 },
  { value: 'is_not_empty', label: 'is not empty', arity: 0 },
]

const BOOLEAN_OPERATORS: OperatorChoice[] = [
  { value: 'eq', label: 'is', arity: 1 },
  { value: 'is_empty', label: 'is empty', arity: 0 },
  { value: 'is_not_empty', label: 'is not empty', arity: 0 },
]

const SELECT_OPERATORS: OperatorChoice[] = [
  { value: 'is', label: 'is', arity: 1 },
  { value: 'is_not', label: 'is not', arity: 1 },
  { value: 'contains', label: 'contains', arity: 1 },
  { value: 'is_empty', label: 'is empty', arity: 0 },
  { value: 'is_not_empty', label: 'is not empty', arity: 0 },
]

/** Linked records match on the target's primary field, which the backend resolves. */
const LINK_OPERATORS: OperatorChoice[] = [
  { value: 'is', label: 'is', arity: 1 },
  { value: 'is_not', label: 'is not', arity: 1 },
  { value: 'contains', label: 'contains', arity: 1 },
  { value: 'is_empty', label: 'is empty', arity: 0 },
  { value: 'is_not_empty', label: 'is not empty', arity: 0 },
]

export function operatorsFor(type: DisplayType | undefined, isLink: boolean): OperatorChoice[] {
  if (isLink) return LINK_OPERATORS
  switch (type) {
    case 'number':
    case 'currency':
      return NUMBER_OPERATORS
    case 'date':
      return DATE_OPERATORS
    case 'checkbox':
    case 'toggle':
      return BOOLEAN_OPERATORS
    case 'single_select':
    case 'multi_select':
      return SELECT_OPERATORS
    default:
      return TEXT_OPERATORS
  }
}

export interface FilterBuilderProps {
  columns: ColumnDescriptor[]
  linkColumns: Set<string>
  filter: FilterNode | null
  onChange: (filter: FilterNode | null) => void
  onClose: () => void
}

const emptyGroup = (): FilterGroup => ({ kind: 'group', conjunction: 'and', children: [] })

/**
 * A new condition has to start on an operator its column actually supports. Defaulting to
 * `contains` put number columns into a state the operator dropdown could not represent — it
 * displayed the first valid operator while the condition still carried the invalid one.
 */
function newCondition(columns: ColumnDescriptor[], linkColumns: Set<string>): FilterCondition {
  const column = columns[0]
  const operators = operatorsFor(column?.displayType, linkColumns.has(column?.name ?? ''))
  const first = operators[0]
  return {
    kind: 'condition',
    column: column?.name ?? '',
    operator: first?.value ?? 'contains',
    ...(first?.arity === 0 ? {} : { value: first?.arity === 2 ? ['', ''] : '' }),
  }
}

export function FilterBuilder({
  columns,
  linkColumns,
  filter,
  onChange,
  onClose,
}: FilterBuilderProps) {
  const root: FilterGroup =
    filter && filter.kind === 'group'
      ? filter
      : filter
        ? { kind: 'group', conjunction: 'and', children: [filter] }
        : emptyGroup()

  const commit = (next: FilterGroup) => {
    // An empty group means no filter at all, not "match nothing".
    onChange(next.children.length === 0 ? null : next)
  }

  return (
    <div class="afs-filter" data-testid="filter-builder">
      <div class="afs-filter__head">
        <strong>Filters</strong>
        <button type="button" class="afs-button" data-testid="filter-clear" onClick={() => onChange(null)}>
          <span class="afs-menu__item-icon" dangerouslySetInnerHTML={{ __html: menuIcon('x', { size: 14 }) }} />
          Clear all
        </button>
      </div>

      <GroupEditor
        group={root}
        columns={columns}
        linkColumns={linkColumns}
        depth={0}
        onChange={commit}
      />
    </div>
  )
}

interface GroupEditorProps {
  group: FilterGroup
  columns: ColumnDescriptor[]
  linkColumns: Set<string>
  depth: number
  onChange: (group: FilterGroup) => void
}

function GroupEditor({ group, columns, linkColumns, depth, onChange }: GroupEditorProps) {
  const replaceChild = (index: number, child: FilterNode) => {
    const children = [...group.children]
    children[index] = child
    onChange({ ...group, children })
  }

  const removeChild = (index: number) => {
    onChange({ ...group, children: group.children.filter((_, i) => i !== index) })
  }

  return (
    <div class="afs-filter__group" data-testid={`filter-group-${depth}`} data-depth={depth}>
      {group.children.map((child, index) => (
        <div class="afs-filter__row" key={index}>
          <div class="afs-filter__joiner">
            {index === 0 ? (
              <span>Where</span>
            ) : index === 1 ? (
              <select
                class="afs-filter__conjunction"
                data-testid={`filter-conjunction-${depth}`}
                value={group.conjunction}
                onChange={(event) =>
                  onChange({
                    ...group,
                    conjunction: (event.currentTarget as HTMLSelectElement).value as 'and' | 'or',
                  })
                }
              >
                <option value="and">and</option>
                <option value="or">or</option>
              </select>
            ) : (
              // Only the first joiner is editable; every row in a group shares one
              // conjunction, which is what keeps the tree unambiguous without parentheses.
              <span class="afs-filter__conjunction-echo">{group.conjunction}</span>
            )}
          </div>

          {child.kind === 'condition' ? (
            <ConditionEditor
              condition={child}
              columns={columns}
              linkColumns={linkColumns}
              onChange={(next) => replaceChild(index, next)}
            />
          ) : (
            <GroupEditor
              group={child}
              columns={columns}
              linkColumns={linkColumns}
              depth={depth + 1}
              onChange={(next) => replaceChild(index, next)}
            />
          )}

          <button
            type="button"
            class="afs-filter__remove"
            data-testid={`filter-remove-${depth}-${index}`}
            title="Remove"
            onClick={() => removeChild(index)}
          >
            <span dangerouslySetInnerHTML={{ __html: menuIcon('x', { size: 14 }) }} />
          </button>
        </div>
      ))}

      <div class="afs-filter__actions">
        <button
          type="button"
          class="afs-button"
          data-testid={`filter-add-condition-${depth}`}
          onClick={() =>
            onChange({ ...group, children: [...group.children, newCondition(columns, linkColumns)] })
          }
        >
          <span class="afs-menu__item-icon" dangerouslySetInnerHTML={{ __html: menuIcon('plus', { size: 14 }) }} />
          Condition
        </button>
        <button
          type="button"
          class="afs-button"
          data-testid={`filter-add-group-${depth}`}
          onClick={() =>
            onChange({
              ...group,
              children: [
                ...group.children,
                { kind: 'group', conjunction: 'or', children: [newCondition(columns, linkColumns)] },
              ],
            })
          }
        >
          <span class="afs-menu__item-icon" dangerouslySetInnerHTML={{ __html: menuIcon('plus', { size: 14 }) }} />
          Condition group
        </button>
      </div>
    </div>
  )
}

interface ConditionEditorProps {
  condition: FilterCondition
  columns: ColumnDescriptor[]
  linkColumns: Set<string>
  onChange: (condition: FilterCondition) => void
}

function ConditionEditor({ condition, columns, linkColumns, onChange }: ConditionEditorProps) {
  const descriptor = columns.find((c) => c.name === condition.column)
  const isLink = linkColumns.has(condition.column)
  const operators = operatorsFor(descriptor?.displayType, isLink)
  const active = operators.find((o) => o.value === condition.operator) ?? operators[0]

  const setColumn = (name: string) => {
    const nextDescriptor = columns.find((c) => c.name === name)
    const nextOperators = operatorsFor(nextDescriptor?.displayType, linkColumns.has(name))
    // Changing column can strand an operator the new type does not offer, which would send
    // the backend something it rejects. Fall back to the first valid one.
    const keep = nextOperators.some((o) => o.value === condition.operator)
    onChange({
      ...condition,
      column: name,
      operator: keep ? condition.operator : (nextOperators[0]?.value ?? 'contains'),
    })
  }

  const setValue = (value: SqlValue | [SqlValue, SqlValue]) => {
    onChange({ ...condition, value })
  }

  const pair: [SqlValue, SqlValue] = Array.isArray(condition.value)
    ? condition.value
    : ['', '']

  return (
    <div class="afs-filter__condition" data-testid="filter-condition">
      <ColumnPicker
        columns={columns}
        value={condition.column}
        testId="filter-column"
        class="afs-filter__column"
        onChange={setColumn}
      />

      <select
        class="afs-filter__operator"
        data-testid="filter-operator"
        value={condition.operator}
        onChange={(event) => {
          const next = (event.currentTarget as HTMLSelectElement).value as FilterOperator
          const arity = operators.find((o) => o.value === next)?.arity ?? 1
          // Build the whole condition in one go. Emitting a change and then a second one to
          // strip `value` sent the stale operator back from the closure.
          const { value: previous, ...rest } = condition
          onChange(
            arity === 0
              ? { ...rest, operator: next }
              : {
                  ...rest,
                  operator: next,
                  value: arity === 2 ? ['', ''] : Array.isArray(previous) ? '' : (previous ?? ''),
                },
          )
        }}
      >
        {operators.map((operator) => (
          <option key={operator.value} value={operator.value}>
            {operator.label}
          </option>
        ))}
      </select>

      {active?.arity === 1 ? (
        <ValueInput
          descriptor={descriptor}
          isLink={isLink}
          value={Array.isArray(condition.value) ? '' : (condition.value ?? '')}
          onChange={setValue}
        />
      ) : null}

      {active?.arity === 2 ? (
        <span class="afs-filter__pair">
          <ValueInput
            descriptor={descriptor}
            isLink={isLink}
            value={pair[0]}
            testId="filter-value-low"
            onChange={(next) => setValue([next, pair[1]])}
          />
          <ValueInput
            descriptor={descriptor}
            isLink={isLink}
            value={pair[1]}
            testId="filter-value-high"
            onChange={(next) => setValue([pair[0], next])}
          />
        </span>
      ) : null}
    </div>
  )
}

function ValueInput({
  descriptor,
  isLink,
  value,
  onChange,
  testId = 'filter-value',
}: {
  descriptor: ColumnDescriptor | undefined
  isLink: boolean
  value: SqlValue
  onChange: (value: SqlValue) => void
  testId?: string
}) {
  // A foreign key column holds integers, so it infers as a number — but what the user types
  // into a linked-record filter is the *other* table's display value, which is text.
  const type = isLink ? 'text' : (descriptor?.displayType ?? 'text')
  const text = value === null || value === undefined ? '' : String(value)

  if (type === 'checkbox' || type === 'toggle') {
    return (
      <select
        class="afs-filter__value"
        data-testid={testId}
        value={text === '1' ? '1' : '0'}
        onChange={(event) => onChange(Number((event.currentTarget as HTMLSelectElement).value))}
      >
        <option value="1">checked</option>
        <option value="0">unchecked</option>
      </select>
    )
  }

  const choices = parseOptions(descriptor?.options).choices.map((c) => c.value)

  if (choices.length > 0) {
    return (
      <select
        class="afs-filter__value"
        data-testid={testId}
        value={text}
        onChange={(event) => onChange((event.currentTarget as HTMLSelectElement).value)}
      >
        <option value="">—</option>
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    )
  }

  return (
    <input
      class="afs-filter__value"
      data-testid={testId}
      type={type === 'number' || type === 'currency' ? 'number' : type === 'date' ? 'date' : 'text'}
      value={text}
      onInput={(event) => {
        const raw = (event.currentTarget as HTMLInputElement).value
        onChange((type === 'number' || type === 'currency') && raw !== '' ? Number(raw) : raw)
      }}
    />
  )
}
