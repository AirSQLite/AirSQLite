// The host-services contract, shared by the UI and whatever is hosting it.
//
// Separate from `protocol.ts` because it is not the protocol. The protocol is questions about
// the database, answered by `src/backend/`. This is questions about the *host* — currently only
// "put this file somewhere the user can find it" — which VS Code and a browser tab answer in
// completely different ways, and which the backend should never learn to answer at all.
//
// It lives in `shared/` so the extension can speak it without importing anything from `src/ui/`.

export interface SaveFileRequest {
  /** What to call it. The host may let the user change it. */
  suggestedName: string
  mimeType: string
  /** Text content. Binary would need a different envelope; nothing needs one yet. */
  data: string
}

/** Envelope marker, so this and the protocol can share one postMessage channel unambiguously. */
export const HOST_MESSAGE = 'airsqlite:host'

export interface HostMessage {
  kind: typeof HOST_MESSAGE
  id: string
  request: SaveFileRequest & { type: 'save-file' }
}

export interface HostReply {
  kind: typeof HOST_MESSAGE
  id: string
  error?: string
}
