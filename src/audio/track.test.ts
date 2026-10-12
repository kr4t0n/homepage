import { describe, expect, it } from 'vitest'
import { parseTrack } from './track'

const manifest = { src: 'song.mp3', title: 'A Song', artist: 'Someone' }

describe('parseTrack', () => {
  it('builds a track out of files beside the manifest', () => {
    expect(parseTrack(manifest)).toEqual({
      src: '/media/song.mp3',
      title: 'A Song',
      artist: 'Someone',
    })
  })

  it('adds a cover when the manifest names a valid one', () => {
    expect(parseTrack({ ...manifest, cover: 'cover.jpg' })?.cover).toBe('/media/cover.jpg')
  })

  it('keeps only the fields it names', () => {
    const track = parseTrack({ ...manifest, href: 'https://example.com', autoplay: true })
    expect(Object.keys(track ?? {}).sort()).toEqual(['artist', 'src', 'title'])
  })

  it('trims text and encodes file names', () => {
    expect(parseTrack({ src: ' my song?.mp3 ', title: '  A Song ', artist: 'Someone  ' })).toEqual({
      src: '/media/my%20song%3F.mp3',
      title: 'A Song',
      artist: 'Someone',
    })
  })

  // A manifest can only point at files beside it. Each value here breaks the
  // rule one way, and none of them may become a URL.
  it.each([
    ['a path into a subdirectory', 'audio/song.mp3'],
    ['a parent path', '../secret.mp3'],
    ['an absolute path', '/etc/passwd'],
    ['a Windows path', 'audio\\song.mp3'],
    ['a scheme', 'javascript:alert(1)'],
    ['another origin', 'https://example.com/song.mp3'],
    ['a protocol-relative URL', '//example.com/song.mp3'],
    ['a dotfile', '.env'],
    ['a name that is only dots', '..'],
    ['an empty name', ''],
    ['a blank name', '   '],
    ['a name over 200 characters', `${'a'.repeat(197)}.mp3`],
    ['a number', 42],
    ['an array', ['song.mp3']],
    ['nothing', undefined],
  ])('refuses %s as src', (_, src) => {
    expect(parseTrack({ ...manifest, src })).toBeNull()
  })

  it('accepts a name of exactly 200 characters', () => {
    expect(parseTrack({ ...manifest, src: `${'a'.repeat(196)}.mp3` })).not.toBeNull()
  })

  it.each([
    ['title', ''],
    ['title', undefined],
    ['artist', '  '],
    ['artist', 7],
    ['title', 'x'.repeat(201)],
  ])('refuses a track whose %s is %j', (field, value) => {
    expect(parseTrack({ ...manifest, [field]: value })).toBeNull()
  })

  it.each([null, undefined, 'song.mp3', 42, []])('refuses %j, which is not a manifest', (json) => {
    expect(parseTrack(json)).toBeNull()
  })

  // The player has a no-art state and none for half a track, so a bad cover
  // costs the cover and nothing else.
  it.each(['../cover.jpg', 'https://example.com/cover.jpg', '.cover.jpg', 3])(
    'drops a cover of %j and keeps the track',
    (cover) => {
      const track = parseTrack({ ...manifest, cover })
      expect(track).toEqual({ src: '/media/song.mp3', title: 'A Song', artist: 'Someone' })
      expect(track && 'cover' in track).toBe(false)
    },
  )
})
