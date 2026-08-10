import type {
  EventEnvelope,
  OutboundMessage,
  ProtocolEvent,
  ProtocolRequest,
  RequestEnvelope,
  ResponseEnvelope,
} from '../../shared/protocol.js'
import { type WebviewApi, webviewApi } from './webview.js'

// The portability seam. Everything above this file is plain DOM and Preact; everything
// below it is platform-specific. Two implementations exist — `postMessage` inside a VS Code
// webview, WebSocket everywhere else — and the UI cannot tell which one it is talking to.
//
// Note what is absent: no `vscode` import, no `acquireVsCodeApi` type dependency, nothing
// from Node. scripts/check-portability.js fails the build if that ever changes.

export interface Transport {
  request<T = unknown>(request: ProtocolRequest): Promise<T>
  onEvent(listener: (event: ProtocolEvent) => void): () => void
  dispose(): void
}

export class TransportError extends Error {}

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

/**
 * Shared plumbing: hands out request ids, matches responses back to their promise, and
 * fans events out to listeners. Subclasses only have to move bytes.
 */
abstract class BaseTransport implements Transport {
  #nextId = 0
  #pending = new Map<string, Pending>()
  #listeners = new Set<(event: ProtocolEvent) => void>()

  protected abstract send(envelope: RequestEnvelope): void

  request<T = unknown>(request: ProtocolRequest): Promise<T> {
    const id = `r${this.#nextId++}`
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      try {
        this.send({ id, request })
      } catch (err) {
        this.#pending.delete(id)
        reject(err instanceof Error ? err : new TransportError(String(err)))
      }
    })
  }

  onEvent(listener: (event: ProtocolEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Call from the subclass whenever a message arrives from the backend. */
  protected receive(message: OutboundMessage): void {
    if ('event' in message) {
      for (const listener of this.#listeners) listener((message as EventEnvelope).event)
      return
    }

    const response = message as ResponseEnvelope
    const pending = this.#pending.get(response.id)
    if (!pending) return // Response to a request we already gave up on.
    this.#pending.delete(response.id)

    if (response.ok) pending.resolve(response.data)
    else pending.reject(new TransportError(response.error))
  }

  /** Reject everything still in flight — the connection is gone. */
  protected failAll(reason: string): void {
    for (const pending of this.#pending.values()) pending.reject(new TransportError(reason))
    this.#pending.clear()
  }

  dispose(): void {
    this.failAll('The connection was closed.')
    this.#listeners.clear()
  }
}

// ---------------------------------------------------------------------------
// VS Code webview
// ---------------------------------------------------------------------------

class PostMessageTransport extends BaseTransport {
  #api: WebviewApi
  #onMessage: (event: MessageEvent) => void

  constructor(api: WebviewApi) {
    super()
    this.#api = api
    this.#onMessage = (event: MessageEvent) => this.receive(event.data as OutboundMessage)
    window.addEventListener('message', this.#onMessage)
  }

  protected send(envelope: RequestEnvelope): void {
    this.#api.postMessage(envelope)
  }

  override dispose(): void {
    window.removeEventListener('message', this.#onMessage)
    super.dispose()
  }
}

// ---------------------------------------------------------------------------
// WebSocket (dev server, headless tests, future browser mode)
// ---------------------------------------------------------------------------

class WebSocketTransport extends BaseTransport {
  #socket: WebSocket
  #queue: RequestEnvelope[] = []
  #open = false

  constructor(url: string) {
    super()
    this.#socket = new WebSocket(url)
    this.#socket.addEventListener('open', () => {
      this.#open = true
      for (const envelope of this.#queue) this.#socket.send(JSON.stringify(envelope))
      this.#queue = []
    })
    this.#socket.addEventListener('message', (event) => {
      this.receive(JSON.parse(event.data as string) as OutboundMessage)
    })
    this.#socket.addEventListener('close', () => {
      this.#open = false
      this.failAll('Lost connection to the database server.')
    })
  }

  protected send(envelope: RequestEnvelope): void {
    // Requests fired during page boot would otherwise be lost to the connecting socket.
    if (this.#open) this.#socket.send(JSON.stringify(envelope))
    else this.#queue.push(envelope)
  }

  override dispose(): void {
    super.dispose()
    this.#socket.close()
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Pick a transport from what the host page provides. A VS Code webview injects
 * `acquireVsCodeApi`; anything else is served by the dev server and gets a WebSocket.
 */
export function createTransport(): Transport {
  const api = webviewApi()
  if (api) return new PostMessageTransport(api)

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocketTransport(`${protocol}//${window.location.host}/ws${window.location.search}`)
}
