/**
 * Single source of truth for everything the page says.
 *
 * Both the 3D room and the no-WebGL fallback render from this file, so content
 * never drifts between the two. Adding a hotspot means adding an entry here and
 * pointing it at a node that exists in `scene-manifest.json`.
 */

export type PanelKind = 'projects' | 'music' | 'stats' | 'writing' | 'about' | 'cv' | 'contact'

export interface Project {
  name: string
  tagline: string
  body: string
  href: string
  repo?: string
  stack: string[]
  status: 'live' | 'building'
}

export interface Hotspot {
  /** URL fragment, e.g. #/work */
  id: string
  /** Mesh node inside room.glb. Must match a key in scene-manifest.json. */
  node: string
  /** Shown in the hover label. Keep it short. */
  label: string
  /** One line, shown under the label on hover. */
  hint: string
  kind: PanelKind
  /**
   * Camera pose for the focused state, in glTF space (Y up).
   * `offset` is added to the node's bounding-box centre to place the camera.
   * `look` is added to the centre to place the orbit target.
   */
  offset: [number, number, number]
  look: [number, number, number]
  /** Placeholder panels are visibly marked as such rather than faked. */
  placeholder?: boolean
  /**
   * Set when the glTF node has not been visually confirmed to be the object the
   * label claims. Excluded from the room so a click never frames the wrong
   * prop; the panel is still reachable from the nav and the 2D fallback.
   */
  unverified?: boolean
}

/** Hotspots whose node is confirmed to be the right physical object. */
export const ROOM_HOTSPOTS = () => HOTSPOTS.filter((h) => !h.unverified)

export const PROFILE = {
  handle: 'kr4t0n',
  role: 'AI engineer',
  /** Max 20 words, has to fit the hero without scrolling. */
  intro: 'I build tools for people who work with coding agents. Occasionally I play something loud.',
  github: 'https://github.com/kr4t0n',
} as const

export const PROJECTS: Project[] = [
  {
    name: 'Argus',
    tagline: 'The open-source dashboard for CLI coding agents.',
    body: 'One pane of glass over Claude Code, Codex, Cursor and anything else you drive from a terminal, across every machine you run them on. A self-registering Go sidecar per host, a NestJS and Redis Streams control plane, a React frontend. Real PTY, so vim and htop stay usable.',
    href: 'https://kr4t0n.github.io/argus',
    repo: 'https://github.com/kr4t0n/argus',
    stack: ['Go', 'NestJS', 'Redis Streams', 'React', 'Socket.IO'],
    status: 'live',
  },
  {
    name: 'nodex',
    tagline: 'A component registry organised by design language.',
    body: 'Components that belong to a design language, rather than to a framework or a category. One language, drawn all the way through. Currently in design.',
    href: 'https://nodex.kubitnodes.com',
    stack: ['TypeScript', 'CLI'],
    status: 'building',
  },
]

/**
 * Object -> content map. The room is a music studio, so the mapping leans on
 * what is physically there: the DJ controller becomes the metrics console, the
 * shelves become writing, the framed art becomes the bio.
 *
 * Offsets are tuned to keep the object filling roughly the upper half of the
 * frame, since the content panel occupies the lower half.
 */
export const HOTSPOTS: Hotspot[] = [
  {
    id: 'work',
    node: 'hot_screens',
    label: 'Work',
    hint: 'Argus and nodex',
    kind: 'projects',
    offset: [1.1, 1.5, 4.2],
    look: [0, 0.15, 0],
  },
  {
    id: 'music',
    // Verified by hover capture: this node is the DJ controller on its stand.
    // The upright piano ended up inside the merged static mesh; splitting it
    // out is a region-tuning pass in tools/export_glb.py, not a code change.
    node: 'hot_midikeys',
    label: 'Music',
    hint: 'Playable. Bring headphones.',
    kind: 'music',
    offset: [1.9, 2.4, 3.4],
    look: [0, 0.1, 0],
  },
  {
    id: 'signals',
    // TODO(export): no verified node yet. The `hot_hexpanels` region turned out
    // to enclose a small wall fixture rather than the light panels, and
    // `hot_djdeck` encloses a mic stand. Re-point this once the regions in
    // tools/export_glb.py isolate the hex panels. Verify with
    // `node tools/verify-hotspots.mjs`, which hovers each hotspot and captures
    // what actually lights up.
    node: 'hot_hexpanels',
    label: 'Signals',
    hint: 'Agent activity and GitHub',
    kind: 'stats',
    offset: [2.6, 0.7, 2.9],
    look: [0, -0.05, 0],
    placeholder: true,
    unverified: true,
  },
  {
    id: 'writing',
    node: 'hot_shelves',
    label: 'Writing',
    hint: 'Notes and longer pieces',
    kind: 'writing',
    offset: [4.3, 1.1, 2.6],
    look: [0, -0.2, 0],
    placeholder: true,
  },
  {
    id: 'about',
    node: 'hot_wallart',
    label: 'About',
    hint: 'Who is typing',
    kind: 'about',
    offset: [3.6, 0.9, 2.2],
    look: [0, 0, 0],
  },
  {
    id: 'cv',
    node: 'hot_desk',
    label: 'CV',
    hint: 'The formal version',
    kind: 'cv',
    offset: [1.4, 2.6, 4.0],
    look: [0, -0.1, 0],
    placeholder: true,
  },
  {
    id: 'contact',
    node: 'hot_sofa',
    label: 'Contact',
    hint: 'Pull up a seat',
    kind: 'contact',
    offset: [4.0, 2.0, 3.2],
    look: [0, 0, 0],
  },
]

/**
 * Things in the room that open an external URL instead of a panel.
 *
 * Kept separate from HOTSPOTS because these are not glTF nodes and must never
 * reach the raycast map or the nav. Every one of these has to be reachable some
 * other way as well: a click target that exists only in the 3D scene cannot be
 * tabbed to or read by a screen reader, so it can decorate a route, never be
 * the route.
 */
export interface RoomLink {
  id: string
  label: string
  hint: string
  href: string
}

export const ROOM_LINKS: RoomLink[] = [
  {
    // The neon wordmark on the back wall. Also in the header and the 2D
    // fallback, both of which are keyboard reachable.
    id: 'neon',
    label: 'GitHub',
    hint: 'github.com/kr4t0n',
    href: PROFILE.github,
  },
]

export const roomLinkById = (id: string | null) =>
  id ? (ROOM_LINKS.find((l) => l.id === id) ?? null) : null

/** Label and hint for the hover readout, for hotspots and links alike. */
export const readoutFor = (id: string | null): { label: string; hint: string } | null => {
  const h = hotspotById(id)
  if (h) return { label: h.label, hint: h.hint }
  const l = roomLinkById(id)
  if (l) return { label: l.label, hint: l.hint }
  return null
}

/** Default camera, framing the whole diorama. glTF space, Y up. */
export const HOME_CAMERA = {
  position: [10.5, 7.4, 10.6] as [number, number, number],
  target: [0.9, 0.55, 0.6] as [number, number, number],
}

export const hotspotById = (id: string | null) =>
  id ? (HOTSPOTS.find((h) => h.id === id) ?? null) : null
