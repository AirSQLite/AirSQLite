import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { createSession, respond } from './backend/protocol.js'
import type { RequestEnvelope } from './shared/protocol.js'

// The dev and test server. It serves the UI bundle over HTTP and speaks the protocol over
// a WebSocket — which is to say it is browser mode, arriving early because Playwright needs
// somewhere to point at.
//
// That is deliberate. Driving the UI in headless Chromium requires exactly the transport
// that browser mode requires, so portability gets proven by every e2e run instead of being
// asserted once at the end. What is missing before this could ship as a product is polish,
// not architecture: a file picker, its own theme, and a way to choose a database that isn't
// a query string.

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)))
const ROOT = path.join(DIST, '..')

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Airtable for SQLite</title>
<link rel="stylesheet" href="/ui.css">
</head>
<body>
<div id="root"></div>
<script type="module" src="/ui.js"></script>
</body>
</html>`
}

/**
 * Resolve which database this connection is for. `?db=` wins, then the CLI argument, then
 * the basic fixture — so `npm run serve` is useful with no arguments during development.
 */
function resolveDbPath(search: string): string {
  const requested = new URLSearchParams(search).get('db')
  const fallback = process.argv[2] ?? path.join(ROOT, 'fixtures', 'basic.db')
  return path.resolve(requested ?? fallback)
}

const SCRATCH = path.join(ROOT, 'fixtures', '.scratch')
let scratchCounter = 0

/**
 * Hand out a private copy of a fixture.
 *
 * Once the e2e suite started writing, a shared fixture made every test order-dependent: one
 * test renaming a row broke the next test's assertion about that row's name. Tests that need
 * to mutate ask for their own copy instead. Dev/test server only — this file is not shipped.
 */
function freshCopy(fixture: string): string {
  const safe = path.basename(fixture)
  const source = path.join(ROOT, 'fixtures', safe)
  if (!fs.existsSync(source)) throw new Error(`No such fixture: ${safe}`)

  fs.mkdirSync(SCRATCH, { recursive: true })
  const target = path.join(SCRATCH, `${scratchCounter++}-${safe}`)
  fs.copyFileSync(source, target)
  return target
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname === '/__fresh') {
    try {
      const db = freshCopy(url.searchParams.get('fixture') ?? 'basic.db')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ db }))
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // A webhook target for the e2e suite: records what it was sent, and hands it back.
  // Dev/test only — this file is not shipped in the .vsix.
  if (url.pathname === '/__hook') {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      hookCalls.push({ method: req.method ?? '', url: req.url ?? '', body })
      res.writeHead(204)
      res.end()
    })
    return
  }

  if (url.pathname === '/__hook-calls') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(hookCalls))
    return
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page())
    return
  }

  const asset = path.join(DIST, path.basename(url.pathname))
  if (fs.existsSync(asset) && fs.statSync(asset).isFile()) {
    res.writeHead(200, { 'content-type': MIME[path.extname(asset)] ?? 'application/octet-stream' })
    fs.createReadStream(asset).pipe(res)
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Not found')
})

/** What the test webhook target has received this run. */
const hookCalls: Array<{ method: string; url: string; body: string }> = []

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (socket, req) => {
  const search = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
  const dbPath = resolveDbPath(search)

  let session: ReturnType<typeof createSession>
  try {
    session = createSession({ dbPath })
  } catch (err) {
    // Nothing to serve — tell the UI why in the same envelope shape it expects, then close.
    socket.send(
      JSON.stringify({ id: 'connect', ok: false, error: (err as Error).message }),
    )
    socket.close()
    return
  }

  // The backend's only unsolicited channel. Until Phase 8 nothing ever came this way, which
  // is why the event half of the transport sat unused since Phase 1.
  const unsubscribe = session.onEvent((event) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ event }))
  })

  socket.on('message', async (raw) => {
    let envelope: RequestEnvelope
    try {
      envelope = JSON.parse(raw.toString()) as RequestEnvelope
    } catch {
      return // A malformed frame has no id to reply against.
    }
    socket.send(JSON.stringify(await respond(session.handle, envelope.id, envelope.request)))
  })

  socket.on('close', () => {
    unsubscribe()
    session.close()
  })
})

// Start clean: leftover scratch copies from a previous run are dead weight.
fs.rmSync(SCRATCH, { recursive: true, force: true })

const port = Number(process.env.PORT ?? 5178)
server.listen(port, () => {
  console.log(`[server] http://localhost:${port}`)
  console.log(`[server] default database: ${resolveDbPath('')}`)
})
