/**
 * The backing track's manifest, read at runtime rather than compiled in.
 *
 * `/media/` is `public/media/` in dev and a volume over `dist/media/` in the
 * cluster. A missing or malformed manifest is the fresh-clone state, not an
 * error: the player reports that no track is served.
 */

export const MEDIA = '/media/'
export const MANIFEST = `${MEDIA}track.json`

export interface Track {
  /** URL of the audio, under MEDIA. */
  src: string
  title: string
  artist: string
  /** URL of the cover art under MEDIA, if the manifest names one. */
  cover?: string
}

const MAX_TEXT = 200

const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() && v.length <= MAX_TEXT ? v.trim() : null

/**
 * A bare file name inside MEDIA. Anything with a separator, a leading dot or a
 * scheme is refused, so a manifest can only point at files beside it and never
 * turn the audio element into a fetch of some other origin or path.
 */
const file = (v: unknown): string | null => {
  const name = text(v)
  if (!name || name.startsWith('.') || /[/\\:]/.test(name)) return null
  return `${MEDIA}${encodeURIComponent(name)}`
}

/**
 * Build a Track from untrusted JSON out of named fields, or return null.
 *
 * Built rather than cast, as with `publish` in the proxy, so an unexamined key
 * never reaches the page. A bad cover is dropped rather than failing the track:
 * the player has a no-art state and none for a half-track.
 */
export function parseTrack(json: unknown): Track | null {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  const src = file(o.src)
  const title = text(o.title)
  const artist = text(o.artist)
  if (!src || !title || !artist) return null
  const cover = file(o.cover)
  return cover ? { src, title, artist, cover } : { src, title, artist }
}
