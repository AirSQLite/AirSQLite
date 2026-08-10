import { spawn } from 'node:child_process'
import type { ActionDefinition, ActionResult, ActionType, Row, SqlValue } from '../shared/protocol.js'
import type { Db } from './db.js'
import { ProtocolError } from './errors.js'

// Action buttons: the one part of this tool that reaches outside the database file.
//
// Everything before this phase had a blast radius that ended at the .db. An action can issue
// an HTTP request, open a URL, or run a shell command — and its definition lives *inside* the
// database, where anything that can write to the file can put one. So the two types that can
// do real damage ask first, and the confirmation shows the fully interpolated command or URL.
//
// The preview and the execution come from the same code path on purpose. A confirmation
// generated separately from the thing it authorises is a confirmation that can be wrong.

const TYPES = new Set<ActionType>(['webhook', 'url', 'script', 'claude', 'clipboard'])
const STYLES = new Set(['default', 'primary', 'danger'])
/** Long enough for a real command, short enough that a hung one does not wedge the session. */
const SCRIPT_TIMEOUT_MS = 30_000
const OUTPUT_LIMIT = 4_000

/**
 * The capabilities an action needs from whatever is hosting the session.
 *
 * `openUrl` and `openTerminal` only exist inside VS Code; in browser mode they are absent and
 * those action types report so rather than failing in some less legible way. `runScript` and
 * `request` have Node defaults and are injectable so tests can assert on side effects without
 * actually running anything.
 */
export interface ActionHost {
  openUrl?: (url: string) => Promise<void> | void
  openTerminal?: (command: string) => Promise<void> | void
  copyToClipboard?: (text: string) => Promise<void> | void
  runScript?: (command: string) => Promise<{ code: number; output: string }>
  request?: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ status: number }>
}

interface ActionRow {
  id: number
  table_name: string
  label: string
  icon: string | null
  style: string | null
  action_type: string
  config: string
  show_in_grid: number
  show_in_detail: number
}

/**
 * Replace `{{field}}` with the row's value.
 *
 * A reference to a field that does not exist is an error naming it, not a blank. These are
 * written by a coding agent against a schema that can change underneath them, and silently
 * posting an empty string where a customer id was meant to go is the kind of failure nobody
 * notices until the data is already somewhere else.
 */
export function interpolate(template: string, row: Row): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, field: string) => {
    if (!(field in row)) {
      throw new ProtocolError(
        `This action refers to a field called "${field}", which this record does not have.`,
      )
    }
    const value = row[field]
    if (value === null || value === undefined) return ''
    if (value instanceof Uint8Array) return `${value.byteLength} bytes`
    return String(value)
  })
}

/** Interpolate every string in a nested config value, leaving other types alone. */
function interpolateDeep(value: unknown, row: Row): unknown {
  if (typeof value === 'string') return interpolate(value, row)
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, row))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateDeep(v, row)]),
    )
  }
  return value
}

function parseConfig(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * What is wrong with a stored action, or null. Actions are written by an agent with no GUI to
 * validate them, so a bad row has to arrive as a disabled button explaining itself rather
 * than as a missing feature or a thrown error.
 */
function validate(type: string, config: Record<string, unknown> | null): string | null {
  if (!TYPES.has(type as ActionType)) return `"${type}" is not an action type this tool knows about.`
  if (!config) return 'This action’s configuration is not valid JSON.'

  const needs = (key: string): string | null =>
    typeof config[key] === 'string' && (config[key] as string).trim() !== ''
      ? null
      : `This action needs a "${key}" in its configuration.`

  switch (type as ActionType) {
    case 'webhook':
    case 'url':
      return needs('url')
    case 'script':
      return needs('command')
    case 'claude':
    case 'clipboard':
      return needs('prompt')
  }
  return null
}

export class Actions {
  #db: Db
  #host: ActionHost

  constructor(db: Db, host: ActionHost = {}) {
    this.#db = db
    this.#host = host
  }

  #available(): boolean {
    const row = this.#db.connection
      .prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='_airsqlite_actions'`)
      .get() as { n: number }
    return row.n === 1
  }

  list(table: string): ActionDefinition[] {
    if (!this.#available()) return []
    const rows = this.#db.connection
      .prepare('SELECT * FROM _airsqlite_actions WHERE table_name = ? ORDER BY id')
      .all(table) as ActionRow[]

    return rows.map((row) => {
      const config = parseConfig(row.config)
      return {
        id: row.id,
        tableName: row.table_name,
        label: row.label,
        icon: row.icon,
        style: STYLES.has(row.style ?? '') ? (row.style as ActionDefinition['style']) : 'default',
        type: row.action_type as ActionType,
        config: config ?? {},
        showInGrid: row.show_in_grid === 1,
        showInDetail: row.show_in_detail !== 0,
        problem: validate(row.action_type, config),
      }
    })
  }

  #get(actionId: number): ActionDefinition {
    if (!this.#available()) throw new ProtocolError('This database has no actions configured.')
    const row = this.#db.connection
      .prepare('SELECT * FROM _airsqlite_actions WHERE id = ?')
      .get(actionId) as ActionRow | undefined
    if (!row) throw new ProtocolError('That action no longer exists in this database.')

    const found = this.list(row.table_name).find((action) => action.id === actionId)
    if (!found) throw new ProtocolError('That action no longer exists in this database.')
    return found
  }

  save(table: string, action: Partial<ActionDefinition>): ActionDefinition {
    if (this.#db.readonly || !this.#available()) {
      throw new ProtocolError('This database file is read-only, so actions can’t be saved.')
    }
    const label = String(action.label ?? '').trim()
    if (label === '') throw new ProtocolError('An action needs a label.')
    if (!TYPES.has(action.type as ActionType)) {
      throw new ProtocolError(`"${String(action.type)}" is not an action type this tool knows about.`)
    }

    const values = [
      table,
      label,
      action.icon ?? null,
      STYLES.has(action.style ?? '') ? action.style! : 'default',
      action.type as string,
      JSON.stringify(action.config ?? {}),
      action.showInGrid ? 1 : 0,
      action.showInDetail === false ? 0 : 1,
    ]

    const id =
      typeof action.id === 'number'
        ? (this.#db.connection
            .prepare(
              `UPDATE _airsqlite_actions SET table_name=?, label=?, icon=?, style=?, action_type=?,
                 config=?, show_in_grid=?, show_in_detail=? WHERE id=?`,
            )
            .run(...values, action.id),
          action.id)
        : Number(
            this.#db.connection
              .prepare(
                `INSERT INTO _airsqlite_actions
                   (table_name, label, icon, style, action_type, config, show_in_grid, show_in_detail)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(...values).lastInsertRowid,
          )

    return this.#get(id)
  }

  remove(actionId: number): void {
    if (this.#db.readonly || !this.#available()) {
      throw new ProtocolError('This database file is read-only, so actions can’t be changed.')
    }
    this.#db.connection.prepare('DELETE FROM _airsqlite_actions WHERE id = ?').run(actionId)
  }

  // -------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------

  /** True for the types that can reach outside this machine or run code on it. */
  static needsConfirmation(type: ActionType): boolean {
    return type === 'script' || type === 'webhook'
  }

  /**
   * Run an action against one row.
   *
   * Nothing happens on the first call for a script or a webhook: it returns the exact
   * command or request that *would* run, and waits to be called again with `confirmed`.
   * Interpolation happens once, here, so the preview and the execution cannot disagree.
   */
  async run(actionId: number, row: Row, confirmed: boolean): Promise<ActionResult> {
    const action = this.#get(actionId)
    if (action.problem) throw new ProtocolError(action.problem)

    const config = interpolateDeep(action.config, row) as Record<string, unknown>

    switch (action.type) {
      case 'url': {
        const url = String(config['url'])
        if (!this.#host.openUrl) {
          throw new ProtocolError('Opening a link is only available inside VS Code.')
        }
        await this.#host.openUrl(url)
        return { status: 'done', message: `Opened ${url}` }
      }

      case 'claude': {
        const prompt = String(config['prompt'])
        if (!this.#host.openTerminal) {
          throw new ProtocolError('Running Claude is only available inside VS Code.')
        }
        await this.#host.openTerminal(`claude ${JSON.stringify(prompt)}`)
        return { status: 'done', message: 'Sent to Claude Code.' }
      }

      case 'clipboard': {
        const prompt = String(config['prompt'])
        if (!this.#host.copyToClipboard) {
          throw new ProtocolError('Copying to clipboard is only available inside VS Code.')
        }
        await this.#host.copyToClipboard(prompt)
        return { status: 'done', message: 'Copied to clipboard.' }
      }

      case 'webhook': {
        const url = String(config['url'])
        const method = String(config['method'] ?? 'POST').toUpperCase()
        const headers = {
          'content-type': 'application/json',
          ...((config['headers'] as Record<string, string> | undefined) ?? {}),
        }
        // The row itself is the default payload — "POST row data", per the requirements.
        const body = JSON.stringify(config['body'] ?? stripDerived(row))

        if (!confirmed) {
          return {
            status: 'needs-confirmation',
            preview: `${method} ${url}\n\n${body}`,
          }
        }

        const send = this.#host.request ?? defaultRequest
        const response = await send(url, { method, headers, body })
        return { status: 'done', message: `${method} ${url} — ${response.status}` }
      }

      case 'script': {
        const command = String(config['command'])
        if (!confirmed) return { status: 'needs-confirmation', preview: command }

        const exec = this.#host.runScript ?? defaultRunScript
        const result = await exec(command)
        if (result.code !== 0) {
          throw new ProtocolError(
            `The command exited with code ${result.code}.${result.output ? `\n${result.output}` : ''}`,
          )
        }
        return { status: 'done', message: result.output.trim() || 'Command finished.' }
      }
    }
  }
}

/** The virtual system columns are ours, not the user's data, so they stay out of payloads. */
function stripDerived(row: Row): Record<string, SqlValue> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('__')))
}

async function defaultRequest(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ status: number }> {
  try {
    const response = await fetch(url, init)
    return { status: response.status }
  } catch (err) {
    throw new ProtocolError(`Could not reach ${url} — ${(err as Error).message}`)
  }
}

function defaultRunScript(command: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    // `shell: true` because the configured value is a command line, not an argv. That is the
    // whole reason this type asks for confirmation first.
    const child = spawn(command, { shell: true, timeout: SCRIPT_TIMEOUT_MS })
    let output = ''
    const collect = (chunk: Buffer) => {
      if (output.length < OUTPUT_LIMIT) output += chunk.toString()
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (err) => reject(new ProtocolError(`Could not run the command — ${err.message}`)))
    child.on('close', (code) => resolve({ code: code ?? 0, output: output.slice(0, OUTPUT_LIMIT) }))
  })
}
