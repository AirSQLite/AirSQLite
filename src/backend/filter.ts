import type { FilterCondition, FilterNode, SqlValue } from '../shared/protocol.js'
import { ProtocolError } from './errors.js'

// Compiles the UI's filter tree into a parameterized WHERE clause.
//
// Two invariants hold everywhere in this file, and both are security properties rather
// than style choices:
//
//   1. Every user-supplied *value* becomes a bound parameter. None is ever concatenated
//      into SQL, no matter how harmless it looks.
//   2. Every user-supplied *identifier* is checked against the table's real column list
//      before being quoted. Identifiers cannot be parameterized in SQLite, so validation
//      is the only defence — and an unknown column is a bug worth surfacing anyway.

export interface CompiledFilter {
  /** A complete boolean expression, safe to drop after WHERE. `'1=1'` when there is no filter. */
  sql: string
  params: SqlValue[]
}

/** A foreign key column, and how to reach the display value on the other side of it. */
export interface LinkTarget {
  table: string
  /** The column in the target table that this foreign key points at. */
  keyColumn: string
  /** The target table's primary field — what the user sees in a linked-record chip. */
  primaryField: string
}

export interface FilterContext {
  columns: Set<string>
  /** Foreign key columns, keyed by the column name in *this* table. */
  links?: Map<string, LinkTarget>
}

/** Double-quote an identifier, escaping any embedded quote. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Escape LIKE wildcards in a user's search text so that a literal `%` matches a `%`
 * rather than everything. Paired with `ESCAPE '\'` in the emitted SQL.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function asScalar(condition: FilterCondition): SqlValue {
  const { value } = condition
  if (value === undefined || Array.isArray(value)) {
    throw new ProtocolError(`The "${condition.operator}" filter needs a value.`)
  }
  return value
}

function asText(condition: FilterCondition): string {
  const value = asScalar(condition)
  return value === null ? '' : String(value)
}

function compileCondition(condition: FilterCondition, ctx: FilterContext): CompiledFilter {
  if (!ctx.columns.has(condition.column)) {
    throw new ProtocolError(`There is no column named "${condition.column}" in this table.`)
  }

  const col = quoteIdent(condition.column)
  const link = ctx.links?.get(condition.column)
  const like = (pattern: string): CompiledFilter => ({
    sql: `${col} LIKE ? ESCAPE '\\'`,
    params: [pattern],
  })

  switch (condition.operator) {
    case 'contains':
      // On a linked-record column the user is matching what they can see — the target's
      // primary field — not the foreign key integer underneath it.
      if (link) {
        return {
          sql: `${col} IN (SELECT ${quoteIdent(link.keyColumn)} FROM ${quoteIdent(
            link.table,
          )} WHERE ${quoteIdent(link.primaryField)} LIKE ? ESCAPE '\\')`,
          params: [`%${escapeLike(asText(condition))}%`],
        }
      }
      return like(`%${escapeLike(asText(condition))}%`)

    // "does not contain" has to match empty cells too — a NULL cell does not contain the
    // text, and a user filtering for absence expects to see it.
    case 'not_contains':
      return {
        sql: `(${col} IS NULL OR ${col} NOT LIKE ? ESCAPE '\\')`,
        params: [`%${escapeLike(asText(condition))}%`],
      }

    case 'starts_with':
      return like(`${escapeLike(asText(condition))}%`)

    case 'ends_with':
      return like(`%${escapeLike(asText(condition))}`)

    case 'is':
    case 'eq':
      // On a linked column every operator works against the display value. Matching `is`
      // against the raw key while `contains` matched the primary field would mean the same
      // dropdown behaved differently depending on which operator was chosen.
      if (link) {
        return {
          sql: `${col} IN (SELECT ${quoteIdent(link.keyColumn)} FROM ${quoteIdent(
            link.table,
          )} WHERE ${quoteIdent(link.primaryField)} = ?)`,
          params: [asScalar(condition)],
        }
      }
      return { sql: `${col} = ?`, params: [asScalar(condition)] }

    case 'is_not':
    case 'neq':
      if (link) {
        return {
          sql: `(${col} IS NULL OR ${col} NOT IN (SELECT ${quoteIdent(
            link.keyColumn,
          )} FROM ${quoteIdent(link.table)} WHERE ${quoteIdent(link.primaryField)} = ?))`,
          params: [asScalar(condition)],
        }
      }
      return { sql: `(${col} IS NULL OR ${col} <> ?)`, params: [asScalar(condition)] }

    case 'gt':
      return { sql: `${col} > ?`, params: [asScalar(condition)] }
    case 'gte':
      return { sql: `${col} >= ?`, params: [asScalar(condition)] }
    case 'lt':
      return { sql: `${col} < ?`, params: [asScalar(condition)] }
    case 'lte':
      return { sql: `${col} <= ?`, params: [asScalar(condition)] }

    case 'between': {
      const { value } = condition
      if (!Array.isArray(value) || value.length !== 2) {
        throw new ProtocolError('The "between" filter needs a low and a high value.')
      }
      return { sql: `${col} BETWEEN ? AND ?`, params: [value[0], value[1]] }
    }

    // Empty means "nothing there to a person": NULL or the empty string. The distinction
    // between the two is invisible in the grid, so it must be invisible in filters too.
    case 'is_empty':
      return { sql: `(${col} IS NULL OR ${col} = '')`, params: [] }

    case 'is_not_empty':
      return { sql: `(${col} IS NOT NULL AND ${col} <> '')`, params: [] }

    default: {
      const unreachable: never = condition.operator
      throw new ProtocolError(`Unknown filter operator "${String(unreachable)}".`)
    }
  }
}

export function compileFilter(
  node: FilterNode | null | undefined,
  context: FilterContext | Set<string>,
): CompiledFilter {
  const ctx: FilterContext = context instanceof Set ? { columns: context } : context

  if (!node) return { sql: '1=1', params: [] }

  if (node.kind === 'condition') return compileCondition(node, ctx)

  const parts = node.children.map((child) => compileFilter(child, ctx))
  // An empty group must not silently filter everything out.
  if (parts.length === 0) return { sql: '1=1', params: [] }

  const joiner = node.conjunction === 'or' ? ' OR ' : ' AND '
  return {
    sql: `(${parts.map((p) => p.sql).join(joiner)})`,
    params: parts.flatMap((p) => p.params),
  }
}

/**
 * Free-text search across the given columns. Separate from the filter tree because it is a
 * different gesture: one box, every visible column, no operator to choose.
 */
export function compileSearch(query: string, searchColumns: string[]): CompiledFilter {
  const text = query.trim()
  if (text === '' || searchColumns.length === 0) return { sql: '1=1', params: [] }

  const pattern = `%${escapeLike(text)}%`
  return {
    sql: `(${searchColumns
      .map((c) => `${quoteIdent(c)} LIKE ? ESCAPE '\\'`)
      .join(' OR ')})`,
    params: searchColumns.map(() => pattern),
  }
}
