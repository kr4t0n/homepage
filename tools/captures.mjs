/**
 * Where the browser scripts put what they capture: a capture is evidence for
 * one run, so each run gets a fresh directory under the system temp dir rather
 * than a folder in the checkout that would need an ignore entry.
 *
 * The path is printed on exit whatever the outcome, since a failed run is when
 * captures matter most; a directory left empty is removed instead.
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
