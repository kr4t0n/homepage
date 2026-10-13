/**
 * Where the dev-server scripts point, and how they establish that whatever is
 * there is actually this project.
 *
 * A script aimed at a port something else owns describes what it finds in
 * terms of this project, so identify the server before driving it and say
 * plainly which of the three situations you are in.
 */

/**
 * Argument, then VERIFY_BASE, then the dev server's default: the argument is
 * what a person types for one script, the variable is set once for all of them.
 * Trailing slashes are stripped so callers can append `/#/about`.
 */
export const BASE = (process.argv[2] ?? process.env.VERIFY_BASE ?? 'http://localhost:5173').replace(
  /\/+$/,
  '',
)

/**
 * Whether a check that could not run counts as a failure. Off by default, where
 * a report of what was skipped is useful; on for a gate such as CI, where a
 * section that did not run is indistinguishable from one that passed.
 */
export const STRICT = process.env.VERIFY_STRICT === '1'

/** Node's fetch says only "fetch failed" and keeps the reason on `cause`. */
export const describe = (err) => {
  const parts = []
  let e = err
  while (e instanceof Error && parts.length < 3) {
    parts.push(e.message)
    e = e.cause
  }
  return parts.join(': ') || String(err)
}

/**
 * Work out what is answering at `base`.
 *
 * `/api/health` is the probe because it does not touch Argus, so "our server is
 * not there" stays distinct from "our server is there and the upstream is down".
 *
 * Returns one of:
 *   { state: 'absent'  }  nothing accepted the connection
 *   { state: 'foreign' }  something answered, but it is not us
 *   { state: 'ours'    }  our server, upstream unknown
 */
export async function identify(base = BASE) {
  let res
  try {
    res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    return { state: 'absent', why: `nothing answering at ${base} (${describe(err).slice(0, 60)})` }
  }

  let ours = false
  try {
    ours = res.ok && (await res.json())?.ok === true
  } catch {
    // Not JSON, so not our health route. Falls through to foreign.
  }
  if (!ours) {
    return {
      state: 'foreign',
      why: `something is answering at ${base}, but /api/health did not return {ok:true}, so it is not this project`,
    }
  }
  return { state: 'ours' }
}

/**
 * For the browser-driven scripts: refuse to start unless the target is ours.
 *
 * Exits rather than returning a result, because there is nothing useful for a
 * caller to do with the answer -- driving Chromium at the wrong site produces a
 * timeout several minutes later that describes the wrong problem.
 */
export async function requireOurServer(base = BASE) {
  const found = await identify(base)
  if (found.state === 'ours') return
  console.error(`FAIL  ${found.why}`)
  console.error(`      Start the dev server, or pass the right URL: node <script> <url>`)
  console.error(`      (or set VERIFY_BASE)`)
  process.exit(1)
}
