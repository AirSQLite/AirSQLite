import { HOST_MESSAGE, type HostReply, type SaveFileRequest } from '../../shared/host.js'
import { webviewApi } from './webview.js'

export type { SaveFileRequest } from '../../shared/host.js'

// The second portability seam, and the first thing in this project that could not be a protocol
// request.
//
// Everything else the UI wants is a question about the database, so `Transport` carries it and
// the backend answers. Saving a file is not that. It is a question about the *host*: VS Code has
// a save dialog and a workspace filesystem, a browser tab has a download, and the answers are
// not the same shape. Routing it through the backend would give the wrong result in browser
// mode too — the Node process is on localhost, so "write a file" would land on the server's disk
// rather than in the user's downloads.
//
// So it lives here, beside `Transport`, with the same rule: nothing in this file knows which
// host it is running in, and nothing above it can tell. CSV export in Phase 2 is the first
// caller; the standalone package's file picker will be the second.

export interface HostServices {
  /**
   * Put a file somewhere the user can find it. Resolves once the host has taken responsibility
   * for it — which is *not* the same as the file existing, since a save dialog can be cancelled.
   * A cancelled save resolves rather than rejecting: the user declining is not an error.
   */
  saveFile(request: SaveFileRequest): Promise<void>
}

/**
 * VS Code: hand the request to the extension host, which owns the save dialog.
 *
 * This deliberately does not go over `Transport`. The backend runs in the extension host too,
 * but it is the part that knows about SQLite, not the part that knows about VS Code — and
 * keeping the protocol free of host concerns is what lets the same backend serve a browser.
 */
class WebviewHostServices implements HostServices {
  #post: (message: unknown) => void
  #pending = new Map<string, { resolve: () => void; reject: (err: Error) => void }>()
  #nextId = 0

  constructor(post: (message: unknown) => void) {
    this.#post = post
    window.addEventListener('message', (event: MessageEvent) => {
      const reply = event.data as HostReply | undefined
      if (!reply || reply.kind !== HOST_MESSAGE) return
      const waiting = this.#pending.get(reply.id)
      if (!waiting) return
      this.#pending.delete(reply.id)
      if (reply.error) waiting.reject(new Error(reply.error))
      else waiting.resolve()
    })
  }

  saveFile(request: SaveFileRequest): Promise<void> {
    const id = `h${this.#nextId++}`
    return new Promise<void>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#post({ kind: HOST_MESSAGE, id, request: { type: 'save-file', ...request } })
    })
  }
}

/**
 * Everywhere else: a Blob and a click.
 *
 * The object URL is revoked on the next task rather than immediately — Safari has historically
 * cancelled the download if the URL dies in the same tick as the click.
 */
class BrowserHostServices implements HostServices {
  saveFile(request: SaveFileRequest): Promise<void> {
    const blob = new Blob([request.data], { type: request.mimeType })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = request.suggestedName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    return Promise.resolve()
  }
}

/** Pick an implementation from what the host page provides, mirroring `createTransport`. */
export function createHostServices(): HostServices {
  const api = webviewApi()
  if (api) return new WebviewHostServices((message) => api.postMessage(message))
  return new BrowserHostServices()
}
