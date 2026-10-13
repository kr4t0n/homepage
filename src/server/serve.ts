/**
 * Production entry: the built site and `api` from one origin, so there is no
 * CORS and ARGUS_KEY stays in this process. Adds only what Vite provides in dev
 * (static files, cache policy, shutdown); routes belong in api.ts.
 */

import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { api } from './api'
import { MANIFEST } from '../audio/track'

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

// Fail at startup: a crash loop says the image has no build, where a process
// serving nothing but 404s looks like a routing problem.
if (!existsSync(INDEX)) {
  console.error(`[serve] no build found at ${DIST}. Run \`pnpm run build\` first.`)
  process.exit(1)
}

/** Read once: it answers every non-file route, and the image it ships in is immutable. */
const INDEX_HTML = readFileSync(INDEX, 'utf8')

/**
 * `/assets` is content-hashed by Vite, so immutable. `public/` files keep their
 * names, so an hour rather than revalidation, which serve-static never answers
 * with a 304. index.html (names hashed assets a redeploy deletes) and the track
 * manifest (swapped on the media volume without a deploy) are never held.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable'
const SHORT = 'public, max-age=3600'
const NEVER = 'no-cache'

const app = new Hono()

// First: a matched API route sets its own `no-store` and ends the chain, so it
// never reaches the cache middleware, the static tree or the SPA fallback.
app.route('/', api)

app.use('*', async (c, next) => {
  const path = c.req.path
  c.header(
    'cache-control',
    path.startsWith('/assets/')
      ? IMMUTABLE
      : path === '/' || path.endsWith('.html') || path === MANIFEST
        ? NEVER
        : SHORT,
  )
  await next()
})

// Handles Range requests, which the backing track needs: Chromium fetches media
// by range and stalls forever against a server that answers 200 to everything.
app.use('*', serveStatic({ root: DIST }))

/**
 * A page request gets the app, so a stray URL is not a dead end (routing is
 * hash-based). Anything else gets a real 404: GLTFLoader and the Draco .wasm
 * handed HTML fail with a parse error far from the cause.
 */
app.notFound((c) => {
  const wantsHtml = c.req.method === 'GET' && (c.req.header('accept') ?? '').includes('text/html')
  if (!wantsHtml) return c.text('not found', 404)
  return c.html(INDEX_HTML, 200, { 'cache-control': NEVER })
})

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`[serve] listening on ${HOST}:${info.port}, serving ${DIST}`)
  // Not fatal, since unlit boards are a supported state, but one line here beats
  // diagnosing it from 502s later.
  if (!process.env.ARGUS || !process.env.ARGUS_KEY) {
    console.warn(
      '[serve] ARGUS and ARGUS_KEY are not both set; /api/pixels will 502 and the wall boards stay unlit',
    )
  }
})

/**
 * Drain on SIGTERM so a rolling deploy drops no in-flight request. The timer is a
 * backstop for a connection that never closes, unref'd so it cannot itself hold
 * the process open.
 */
const shutdown = (signal: string) => {
  console.log(`[serve] ${signal} received, draining`)
  server.close(() => process.exit(0))
  // `close()` alone waits for each keep-alive socket to idle out, which under
  // traffic runs into the backstop; drop the idle ones now and leave those
  // mid-request. Guarded rather than cast: the HTTP/2 members of `serve()`'s
  // return type lack the method, though this server is never HTTP/2.
  if ('closeIdleConnections' in server) server.closeIdleConnections()
  setTimeout(() => {
    console.error('[serve] drain timed out, exiting anyway')
    process.exit(1)
  }, 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
