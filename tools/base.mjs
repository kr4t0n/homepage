/**
 * Where the dev-server scripts point, and how they establish that whatever is
 * there is actually this project.
 *
 * Two separate problems, one module.
 *
 * The first is that the target used to be written out in each script, so
 * pointing the suite anywhere else meant passing an argument to every one of
 * them, and two scripts had it hardcoded with no argument to pass at all.
 *
 * The second is worse and is why `requireOurServer` exists. A script aimed at a
 * port something else owns does not fail in a way that says so: it describes
 * what it found in terms of this project, because that is the only vocabulary it
 * has. `verify-api` reported an unrelated app on port 5173 as "dev server not
 * reachable" while one of its security assertions quietly passed against that
 * app's response. Every browser-driven script here has the same exposure, and
 * for those the symptom is a Playwright timeout hunting for a canvas that was
 * never going to be there.
 *
 * So: identify the server before driving it, and say plainly which of the three
 * situations you are in.
 */

/**
 * Precedence is argument, then environment, then the dev server's default.
 *
 * The argument comes first because it is the more specific of the two and is
 * what a person types while debugging one script; the variable is what CI sets
 * once for all of them. Trailing slashes are stripped so callers can append
 * `/#/about` without producing a double slash.
 */
export const BASE = (process.argv[2] ?? process.env.VERIFY_BASE ?? 'http://localhost:5173').replace(
  /\/+$/,
  '',
)

/**
 * Whether a check that could not run counts as a failure.
 *
 * Off by default, because running a script without a dev server up and having it
 * tell you what it skipped is genuinely useful. On in CI, because there a
 * section that does not execute is indistinguishable from one that passed, and
 * the whole point of a gate is that it cannot pass by not running.
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
 * `/api/health` is the probe because it is ours, it is cheap, and it
 * deliberately does not touch Argus -- so it distinguishes "our server is not
 * there" from "our server is there and the upstream is down", which are
 * different problems with different fixes.
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
