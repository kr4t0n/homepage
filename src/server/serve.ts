/**
 * Production entry point: the built site and the API from one origin.
 *
 * That single origin is the whole point. The page fetches a same-origin
 * `/api/pixels`, so there is no CORS to configure and no credential in the
 * browser: ARGUS_KEY is read by this process and never travels further.
 *
 * `api` here is the very same Hono app that `@hono/vite-dev-server` runs during
 * `npm run dev`, mounted by `@hono/node-server` instead. One handler, two
 * adaptors, so dev cannot drift from prod. Everything this file adds is the
 * static half that Vite provides in dev and nothing provides in a container.
 */

import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { api } from './api'

const PORT = Number(process.env.PORT ?? 8080)
/** Containers must bind every interface; localhost would be unreachable from the pod network. */
const HOST = process.env.HOST ?? '0.0.0.0'

/**
 * Absolute on purpose. serve-static `join`s its root onto the request path, so
 * a relative root silently resolves against whatever directory the process was
 * started in and serves nothing from anywhere else.
 */
const DIST = resolve(process.env.DIST_DIR ?? 'dist')
const INDEX = join(DIST, 'index.html')

// Fail at startup rather than answering 404 forever. A container without a
// build in it is broken, and the crash loop says so immediately; a process that
// starts happily and serves nothing looks like a routing problem for an hour.
if (!existsSync(INDEX)) {
  console.error(`[serve] no build found at ${DIST}. Run \`npm run build\` first.`)
  process.exit(1)
}

/**
 * Read once. It is 1.7 KB, it is the answer to every route that is not a file,
 * and the image it ships in is immutable, so re-reading it per request could
 * never return anything different.
 */
const INDEX_HTML = readFileSync(INDEX, 'utf8')

/**
 * Vite content-hashes everything under `/assets`, so those URLs can never serve
 * different bytes and are safe to keep forever.
 *
 * Files copied from `public/` keep their names across builds — `room.glb`, the
 * Draco decoder, the screenshots — so they get an hour and no more. An hour
 * rather than a revalidation because serve-static sends `Last-Modified` but does
 * not answer `If-Modified-Since`: a revalidating client is handed all 4 MB of
 * room.glb again rather than a 304, which makes "always check" the expensive
 * option here rather than the cheap one.
 *
 * `index.html` is the one file that must never be held. It carries the hashed
 * asset URLs, so a stale copy points at files the redeploy has already deleted.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable'
const SHORT = 'public, max-age=3600'
const NEVER = 'no-cache'

const app = new Hono()

// First, so `/api/*` is answered by the shared handler and never falls through
// to the static tree or the SPA fallback. Registration order is also what keeps
// the cache middleware below off those responses: the API routes set their own
// `no-store`, they match first, and a matched handler ends the chain.
app.route('/', api)

app.use('*', async (c, next) => {
  const path = c.req.path
  c.header(
    'cache-control',
    path.startsWith('/assets/') ? IMMUTABLE : path === '/' || path.endsWith('.html') ? NEVER : SHORT,
  )
  await next()
})

// Handles Range requests, which the backing track needs: Chromium fetches media
// by range and stalls forever against a server that answers 200 to everything.
app.use('*', serveStatic({ root: DIST }))

/**
 * Anything the static tree did not answer.
 *
 * A browser asking for a page gets the app, so a mistyped or bookmarked path
 * lands in the room rather than on an error. Routing is hash-based, so there are
 * no real server-side routes to preserve; this is purely so a stray URL is not a
 * dead end.
 *
 * Everything else gets a genuine 404, and that distinction earns its keep. The
 * room is loaded by GLTFLoader and the Draco decoder is instantiated from a
 * .wasm; answering a missing one of those with HTML turns a plain missing-file
 * problem into a parse error several layers away from its cause.
 */
app.notFound((c) => {
  const wantsHtml = c.req.method === 'GET' && (c.req.header('accept') ?? '').includes('text/html')
  if (!wantsHtml) return c.text('not found', 404)
  return c.html(INDEX_HTML, 200, { 'cache-control': NEVER })
})

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`[serve] listening on ${HOST}:${info.port}, serving ${DIST}`)
  // Not fatal. The site runs fine without Argus and the boards simply stay
  // unlit, which is a supported state -- but it is worth one line at startup,
  // because the alternative is diagnosing it from 502s later.
  if (!process.env.ARGUS || !process.env.ARGUS_KEY) {
    console.warn('[serve] ARGUS and ARGUS_KEY are not both set; /api/pixels will 502 and the wall boards stay unlit')
  }
})

/**
 * Kubernetes sends SIGTERM and then waits before SIGKILL, so closing the
 * listener and letting in-flight requests finish is the difference between a
 * rolling deploy nobody notices and one that drops a request per pod.
 *
 * The timer is the backstop for a connection that never closes. It is unref'd so
 * that it cannot itself be the thing holding the process open.
 */
const shutdown = (signal: string) => {
  console.log(`[serve] ${signal} received, draining`)
  server.close(() => process.exit(0))
  // `close()` on its own stops accepting new connections and then waits for
  // every existing socket to go idle by itself, which for a keep-alive
  // connection means waiting out `keepAliveTimeout`. Measured here, that alone
  // turned a shutdown that should be instant into a five second one, and under
  // real traffic it walks straight into the backstop below and exits non-zero,
  // so a routine rolling deploy would be recorded as a crash. This drops the
  // sockets that are merely being held open and leaves the ones mid-request,
  // which is what draining was supposed to mean.
  //
  // Guarded rather than cast because `serve()` is typed as the union of every
  // server it can build, and the HTTP/2 members of that union do not carry this
  // method. We never ask it for HTTP/2, so this branch is always taken; the
  // check is what makes that assumption explicit instead of asserted.
  if ('closeIdleConnections' in server) server.closeIdleConnections()
  setTimeout(() => {
    console.error('[serve] drain timed out, exiting anyway')
    process.exit(1)
  }, 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
