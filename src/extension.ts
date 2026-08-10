import * as vscode from 'vscode'
import type { ActionHost } from './backend/actions.js'
import { createSession, respond, type Session } from './backend/protocol.js'
import type { RequestEnvelope } from './shared/protocol.js'
import { HOST_MESSAGE, type HostMessage } from './shared/host.js'

// VS Code entry point.
//
// This is a *readonly* custom editor in VS Code's sense, which is the opposite of what it
// sounds like: it means VS Code holds no in-memory document and never asks us to save one.
// Edits go straight to SQLite through the backend, so there is nothing for VS Code's dirty
// state or backup machinery to manage. Treating a database as an editable text document
// would mean holding the whole file in memory and racing with every external writer.

const VIEW_TYPE = 'airtableForSqlite.editor'

/** Exposed only in test mode, so the extension-host smoke test can observe the webview. */
export interface TestApi {
  /** Resolves once a webview has completed its first request round trip. */
  webviewReady(timeoutMs?: number): Promise<string>
  /** Prove better-sqlite3 loads and queries inside the real extension host. */
  probe(dbPath: string): Promise<unknown>
}

class SqliteDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose(): void {}
}

class SqliteEditorProvider implements vscode.CustomReadonlyEditorProvider<SqliteDocument> {
  #context: vscode.ExtensionContext
  #onWebviewReady: (path: string) => void

  constructor(context: vscode.ExtensionContext, onWebviewReady: (path: string) => void) {
    this.#context = context
    this.#onWebviewReady = onWebviewReady
  }

  openCustomDocument(uri: vscode.Uri): SqliteDocument {
    return new SqliteDocument(uri)
  }

  async resolveCustomEditor(
    document: SqliteDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const distUri = vscode.Uri.joinPath(this.#context.extensionUri, 'dist')

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [distUri],
    }

    let session: Session | null = null
    try {
      session = createSession({ dbPath: document.uri.fsPath, host: this.#actionHost() })
    } catch (err) {
      panel.webview.html = this.#errorHtml((err as Error).message)
      return
    }

    panel.webview.html = this.#html(panel.webview, distUri)

    const subscription = panel.webview.onDidReceiveMessage(
      async (message: RequestEnvelope | HostMessage) => {
        if (!session || typeof message?.id !== 'string') return

        // Two kinds share this channel. Host messages ask VS Code for something it owns — a
        // save dialog — and never reach the backend, which has no business knowing what a
        // dialog is. Anything without the marker is a protocol request as before.
        if ((message as HostMessage).kind === HOST_MESSAGE) {
          await this.#handleHostMessage(panel, message as HostMessage)
          return
        }

        const request = message as RequestEnvelope
        const response = await respond(session.handle, request.id, request.request)
        void panel.webview.postMessage(response)
        this.#onWebviewReady(document.uri.fsPath)
      },
    )

    // Live reload: the watcher fires on this side too, in the same envelope shape the
    // WebSocket transport uses, so the UI cannot tell which host it is running in.
    const unsubscribe = session.onEvent((event) => {
      void panel.webview.postMessage({ event })
    })

    panel.onDidDispose(() => {
      subscription.dispose()
      unsubscribe()
      session?.close()
      session = null
    })
  }

  /**
   * The VS Code half of `HostServices`.
   *
   * A cancelled dialog resolves without an error: the user declining to save is an outcome, not
   * a failure, and reporting it as one would put a toast on screen for a decision they made.
   */
  async #handleHostMessage(panel: vscode.WebviewPanel, message: HostMessage): Promise<void> {
    const reply: { kind: typeof HOST_MESSAGE; id: string; error?: string } = {
      kind: HOST_MESSAGE,
      id: message.id,
    }

    try {
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(message.request.suggestedName),
      })
      if (target) {
        await vscode.workspace.fs.writeFile(target, Buffer.from(message.request.data, 'utf8'))
      }
    } catch (err) {
      reply.error = (err as Error).message
    }

    void panel.webview.postMessage(reply)
  }

  /**
   * What an action can ask the host to do.
   *
   * These two capabilities are the reason `createSession` takes a host at all: `src/backend/`
   * has never imported `vscode` and must not start, and browser mode has no VS Code to ask.
   * Absent, those action types report so rather than failing in some less legible way.
   */
  #actionHost(): ActionHost {
    return {
      openUrl: async (url: string) => {
        await vscode.env.openExternal(vscode.Uri.parse(url))
      },
      /**
       * Claude actions run the CLI in a terminal.
       *
       * Discovery, 2026-08-06: the installed `anthropic.claude-code` extension (2.1.222)
       * contributes 24 commands and not one of them accepts a prompt argument, so there is
       * nothing to invoke with row context. The CLI does take one, and works whether or not
       * the extension is installed — which is the plan's stated fallback and, as it turns
       * out, the more predictable path.
       */
      openTerminal: (command: string) => {
        const terminal = vscode.window.createTerminal('Claude')
        terminal.show()
        terminal.sendText(command)
      },
      copyToClipboard: async (text: string) => { await vscode.env.clipboard.writeText(text) },
    }
  }

  /**
   * Strict CSP: no remote anything, and scripts only run if they carry the nonce minted for
   * this exact page load. The webview renders whatever is in the database, so an injected
   * script tag from a cell value must be inert.
   */
  #html(webview: vscode.Webview, distUri: vscode.Uri): string {
    const nonce = makeNonce()
    const script = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'ui.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'ui.css'))

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style}">
<title>Airtable for SQLite</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" type="module" src="${script}"></script>
</body>
</html>`
  }

  /**
   * The one surface that never loads ui.css, so it cannot go through the --afs-* tokens and
   * has to name the host variables itself. That is safe here in a way it is not anywhere in
   * src/ui/: this page only ever renders inside a VS Code webview, where they are guaranteed
   * to exist. The fallbacks are there for the same reason every other fallback is — so that
   * a variable VS Code renames does not turn the error page into black text on black.
   */
  #errorHtml(message: string): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-editor-foreground, #1f2328);
    background: var(--vscode-editor-background, #ffffff);
    padding: 2rem;
  }
  h3 { color: var(--vscode-errorForeground, #d1242f); margin-top: 0; }
  p { color: var(--vscode-descriptionForeground, #656d76); }
</style>
</head>
<body>
<h3>Could not open this database</h3>
<p>${escapeHtml(message)}</p>
</body></html>`
  }
}

function makeNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let nonce = ''
  for (let i = 0; i < 32; i++) nonce += alphabet[Math.floor(Math.random() * alphabet.length)]
  return nonce
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const readyWaiters: Array<(path: string) => void> = []
  let readyPath: string | null = null

  const provider = new SqliteEditorProvider(context, (path) => {
    readyPath = path
    for (const waiter of readyWaiters.splice(0)) waiter(path)
  })

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      // The grid holds fetched chunks and scroll position; rebuilding it on every tab
      // switch would refetch from SQLite for no reason.
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
  )

  // The headless harness covers everything except the VS Code surface itself. This hook is
  // how the one smoke test that does cover it can see a webview finish a round trip.
  if (context.extensionMode !== vscode.ExtensionMode.Test) return undefined

  return {
    webviewReady(timeoutMs = 20_000) {
      if (readyPath) return Promise.resolve(readyPath)
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('No webview completed a round trip in time.')),
          timeoutMs,
        )
        readyWaiters.push((path) => {
          clearTimeout(timer)
          resolve(path)
        })
      })
    },
    async probe(dbPath: string) {
      const session = createSession({ dbPath, readonly: true })
      try {
        return await session.handle({ type: 'query', table: 'customers', limit: 1 })
      } finally {
        session.close()
      }
    },
  }
}

export function deactivate(): void {
  // Sessions are closed when their panels are disposed.
}
