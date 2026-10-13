/**
 * Single source of truth for everything the page says.
 *
 * Both the 3D room and the no-WebGL fallback render from this file, so content
 * never drifts between the two. Adding a hotspot means adding an entry here and
 * pointing it at a node that exists in `scene-manifest.json`.
 */

export type PanelKind = 'music' | 'player' | 'stats' | 'writing' | 'about' | 'cv'

export interface Project {
  name: string
  tagline: string
  body: string
  href: string
  status: 'live' | 'building'
}

export interface Hotspot {
  /** URL fragment, e.g. #/about */
  id: string
  /** Mesh node inside room.glb. Must match a key in scene-manifest.json. */
  node: string
  /**
   * Further meshes of the same object. Picking, hover and framing treat these and
   * `node` as one; the camera frames the union of their bounding boxes.
   */
  nodes?: string[]
  /** Shown on the nav pill and as the panel heading. Keep it short. */
  label: string
  /** One line, shown under the heading in the panel. */
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
   * Focus without opening a panel: the object is the content, legible on its own,
   * and a panel would only cover it. The only chrome is the way back out.
   */
  bare?: boolean
}

export const PROFILE = {
  handle: 'kr4t0n',
  role: 'AI engineer',
  /** Max 20 words, has to fit the 2D fallback's hero without scrolling. */
  intro:
    'I build tools for people who work with coding agents. Occasionally I play something loud.',
  github: 'https://github.com/kr4t0n',
} as const

export const PROJECTS: Project[] = [
  {
    name: 'Argus',
    tagline: 'The open-source dashboard for CLI coding agents.',
    body: 'One pane of glass over Claude Code, Codex, Cursor and anything else you drive from a terminal, across every machine you run them on. A self-registering Go sidecar per host, a NestJS and Redis Streams control plane, a React frontend. Real PTY, so vim and htop stay usable.',
    href: 'https://kr4t0n.github.io/argus',
    status: 'live',
  },
  {
    name: 'nodex',
    tagline: 'A component registry organised by design language.',
    body: 'Components that belong to a design language, rather than to a framework or a category. One language, drawn all the way through. Currently in design.',
    href: 'https://nodex.kubitnodes.com',
    status: 'building',
  },
]

/**
 * Object -> content map. The room is a music studio, so the mapping leans on
 * what is physically there: the synth carries the playable keys, the shelves
 * become writing, the framed art becomes the bio.
 *
 * Offsets are tuned to keep the object filling roughly the upper half of the
 * frame, since the content panel occupies the lower half.
 */
export const HOTSPOTS: Hotspot[] = [
  {
    id: 'music',
    node: 'hot_synth',
    label: 'Music',
    hint: 'Playable. Bring headphones.',
    kind: 'music',
    // Target sits below the synth's centre so the keybed rides above the
    // panel rather than behind it.
    offset: [-1.6, 1.05, 2.25],
    look: [0, -0.26, 0],
  },
  {
    // The decks carry the transport: a record is cued here, while the synth is
    // the instrument you play.
    id: 'player',
    node: 'hot_djcontroller',
    label: 'Now playing',
    hint: 'What the room is listening to',
    kind: 'player',
    // 2.53 wide, the widest hotspot: at the 34-degree lens (half-width 0.49x
    // distance) ~3.5 of standoff fills three quarters of the frame, and x stays
    // near zero so the far end does not swing out. `look.x` is left of centre
    // because the bbox centre renders the deck far left of frame centre. Little
    // lift, since the decks panel is a compact bar rather than full height.
    offset: [0.15, 1.35, 3.3],
    look: [-0.55, -0.08, 0],
  },
  {
    id: 'signals',
    node: 'hot_pixelboard',
    // Both wall boards: one display in two pieces, the same six weeks ranked two
    // ways.
    nodes: ['hot_ranking'],
    label: 'Signals',
    hint: 'Six weeks of agent activity',
    kind: 'stats',
    // The boards carry the whole readout, and PixelTooltip's per-cell detail
    // needs them uncovered.
    bare: true,
    // The pair is 2.39 x 0.96 on the -x wall, facing +x. At the 34-degree lens,
    // 3.1 of standoff fills ~79% of frame width, close enough for the labels and
    // token totals to read. Level and dead centre: there is no panel to clear,
    // and any vertical offset keystones the grid.
    offset: [3.1, 0, 0],
    look: [0, 0, 0],
  },
  {
    id: 'writing',
    node: 'hot_shelves',
    label: 'Writing',
    hint: 'Notes and longer pieces',
    kind: 'writing',
    // High and aimed low so the panel sits over the dark sofa, not the lit pixel
    // board. Placed relative to `hot_shelves`'s box, so re-run verify-glass.mjs
    // whenever that group changes.
    offset: [4.3, 1.6, 2.6],
    look: [0, -0.6, 0],
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
  // `hot_sofa` is exported as its own group but has no hotspot: the neon
  // wordmark is the GitHub link.
]

/**
 * Things in the room that open an external URL instead of a panel. Not glTF
 * nodes, so kept out of HOTSPOTS and the raycast map. The keyboard index in
 * Hud.tsx renders each as a real anchor, its route for keyboard and screen reader.
 */
export interface RoomLink {
  id: string
  href: string
  /** Text of the link's entry in the keyboard index. */
  label: string
}

export const ROOM_LINKS: RoomLink[] = [
  {
    // The neon wordmark on the back wall. Also real markup in the keyboard
    // index and in the 2D fallback.
    id: 'neon',
    href: PROFILE.github,
    label: 'GitHub',
  },
]

/**
 * The three monitor panels, merged into `hot_screens` in the GLB, so each is a
 * separate plane measured by tools/find_screens.py; `normal` is negated from
 * what that reports, so it faces the room. Two-stage: the first click frames the
 * screen and a second opens `href`, so looking around never leaves the site.
 */
export interface Screen {
  /** Stable id, used in the URL and as a hover key. */
  id: string
  /** Source object in the .blend, for traceability back to find_screens.py. */
  source: string
  image?: string
  href?: string
  /**
   * Which part of a cover-fitted image survives the crop. 'top' suits a page
   * screenshot, keeping its nav. Defaults to 'centre'.
   */
  anchor?: 'top' | 'centre'
  centre: [number, number, number]
  normal: [number, number, number]
  width: number
  height: number
}

export const SCREENS: Screen[] = [
  {
    // Leftmost from the default camera.
    id: 'nodex',
    source: 'Plane.033',
    image: '/nodex-screenshot.png',
    href: 'https://nodex.kubitnodes.com',
    centre: [-0.1345, 1.302, -1.1292],
    normal: [0.7371, 0, 0.6758],
    width: 1.3661,
    height: 0.5689,
  },
  {
    id: 'centre',
    source: 'Plane.024',
    image: '/argus-screenshot.jpg',
    href: 'https://kr4t0n.github.io/argus',
    // 1.68:1 against a 2.4:1 panel, so 30% of the height is cropped; the top
    // keeps the nav, hero line and install CTA.
    anchor: 'top',
    centre: [1.1017, 1.302, -1.5808],
    normal: [0, 0, 1],
    width: 1.3661,
    height: 0.5689,
  },
  {
    id: 'right',
    source: 'Plane.031',
    centre: [2.3769, 1.302, -1.0929],
    normal: [-0.7018, 0, 0.7123],
    width: 1.3661,
    height: 0.5689,
  },
]

export const screenById = (id: string | null) =>
  id ? (SCREENS.find((s) => s.id === id) ?? null) : null

/** Default camera, framing the whole diorama. glTF space, Y up. */
export const HOME_CAMERA = {
  position: [10.5, 7.4, 10.6] as [number, number, number],
  target: [0.9, 0.55, 0.6] as [number, number, number],
}

/**
 * Every glTF node a hotspot owns, primary first. Use this rather than reading
 * `node` directly, or multi-node hotspots become pickable only by their first
 * mesh -- which looks like a dead zone over the other half of the object.
 */
export const hotspotNodes = (h: Hotspot): string[] => [h.node, ...(h.nodes ?? [])]

export const hotspotById = (id: string | null) =>
  id ? (HOTSPOTS.find((h) => h.id === id) ?? null) : null
