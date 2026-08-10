import fs from 'node:fs'
import path from 'node:path'

// Detecting that somebody else wrote to the database.
//
// The naive version watches the .db file's mtime and fires on every change — including our
// own writes, which would make the grid diff against itself after every edit. The fix is not
// a timestamp window or a suppression flag: SQLite already answers this question exactly.
// `PRAGMA data_version` is bumped by commits from *other* connections and left alone for
// commits on this one, so the file event is only a hint to go and check it.
//
// In WAL mode the .db file itself barely changes; the writes land in the -wal sidecar. Both
// are watched, and the sidecar is watched through its directory because it comes and goes.

const DEBOUNCE_MS = 60

export interface WatcherOptions {
  /** Called once per settled burst of filesystem activity, after externality is confirmed. */
  onChange: () => void
  /** Returns true when another connection has committed since the last call. */
  hasExternalChange: () => boolean
  debounceMs?: number
}

export class Watcher {
  #watchers: fs.FSWatcher[] = []
  #timer: ReturnType<typeof setTimeout> | null = null
  #options: WatcherOptions
  #closed = false

  private constructor(options: WatcherOptions) {
    this.#options = options
  }

  static start(dbPath: string, options: WatcherOptions): Watcher {
    const watcher = new Watcher(options)
    const dir = path.dirname(dbPath)
    const base = path.basename(dbPath)

    // One directory watch covers the .db, its -wal and -shm sidecars, and the fact that the
    // sidecars are created and deleted rather than merely modified. Watching the .db file
    // directly would miss every WAL-mode write.
    try {
      const handle = fs.watch(dir, (_event, filename) => {
        if (filename && !String(filename).startsWith(base)) return
        watcher.#schedule()
      })
      handle.on('error', () => undefined)
      watcher.#watchers.push(handle)
    } catch {
      // A filesystem that cannot be watched costs live reload, not the editor.
    }

    return watcher
  }

  #schedule(): void {
    if (this.#closed) return
    if (this.#timer) clearTimeout(this.#timer)
    // A single commit produces several filesystem events across .db, -wal and -shm. Firing
    // per event would re-query the table three times for one write.
    this.#timer = setTimeout(() => {
      this.#timer = null
      if (this.#closed) return
      if (!this.#options.hasExternalChange()) return
      this.#options.onChange()
    }, this.#options.debounceMs ?? DEBOUNCE_MS)
  }

  close(): void {
    this.#closed = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    for (const handle of this.#watchers) handle.close()
    this.#watchers = []
  }
}
