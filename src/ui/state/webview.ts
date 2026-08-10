// The one place `acquireVsCodeApi` is called.
//
// VS Code allows exactly one call per webview session and throws on the second, so the handle
// cannot simply be acquired wherever it is wanted. Both things that need it — the transport and
// host services — go through here instead.
//
// Nothing in this file imports `vscode`: `acquireVsCodeApi` is a global the webview host injects
// into the page, not a module. That is what keeps the UI bundle portable, and what
// scripts/check-portability.js exists to defend.

export interface WebviewApi {
  postMessage(message: unknown): void
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => WebviewApi
  }
}

let cached: WebviewApi | null | undefined

/** The webview handle, or null when this page is not running inside VS Code. */
export function webviewApi(): WebviewApi | null {
  if (cached === undefined) {
    cached = typeof window.acquireVsCodeApi === 'function' ? window.acquireVsCodeApi() : null
  }
  return cached
}
