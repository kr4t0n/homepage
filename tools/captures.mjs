/**
 * Where the browser scripts put what they capture.
 *
 * A screenshot is evidence for one run, so each run gets a fresh directory under
 * the system temp dir rather than a folder in the checkout. A folder there needs
 * an ignore entry, and then sits in every clone and worktree until someone
 * remembers to clear it.
 *
 * The path is printed as the process exits, whatever the outcome, because a
 * failed run is when the captures matter most. A run that stopped before its
 * first capture removes the empty directory instead of printing it.
 */
import { mkdtempSync, readdirSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

/** A fresh `homepage-<script>-XXXXXX` directory, named after the running script. */
export function captureDir() {
  const script = basename(process.argv[1] ?? 'tools', '.mjs')
  const dir = mkdtempSync(join(tmpdir(), `homepage-${script}-`))
  process.on('exit', () => {
    if (readdirSync(dir).length) console.log(`\ncaptures: ${dir}`)
    else rmdirSync(dir)
  })
  return dir
}
