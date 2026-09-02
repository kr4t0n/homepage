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
  /**
   * In the nav but not clickable in the room, because the object it names has
   * its own richer interaction. The monitors are the case: clicking one focuses
   * that screen rather than opening a panel, but Work still needs a nav entry,
   * since it is the only keyboard route to the Argus and nodex links.
   */
  navOnly?: boolean
}

/** Hotspots offered in the nav and the 2D fallback. */
export const ROOM_HOTSPOTS = () => HOTSPOTS.filter((h) => !h.unverified)

/** Hotspots a click in the 3D room can resolve to. */
export const PICKABLE_HOTSPOTS = () =>
  HOTSPOTS.filter((h) => !h.unverified && !h.navOnly)

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
 * what is physically there: the synth carries the playable keys, the shelves
 * become writing, the framed art becomes the bio.
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
    // The monitors have their own interaction, so a click in the room focuses a
    // screen instead of opening this. Kept in the nav because it is the only
    // keyboard-reachable route to the project links.
    navOnly: true,
  },
  {
    id: 'music',
    // The synth, not the DJ controller. Both region names in the exporter used
    // to be wrong, which put this hotspot on the wrong instrument; they now
    // describe what they actually enclose. The DJ controller still exports as
    // `hot_djcontroller` and is currently not wired to anything.
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
    id: 'signals',
    // TODO(export): no verified node yet. `hot_hexpanels` turned out to enclose
    // a small wall fixture rather than the light panels. `hot_djcontroller` is
    // now free and a mixing desk would suit a levels board, which is the
    // obvious candidate. Verify with `node tools/verify-hotspots.mjs`, which
    // hovers each hotspot and captures what actually lights up.
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


/**
 * The three monitor panels, as independently interactive surfaces.
 *
 * They are merged into `hot_screens` in the GLB, so none of them can be
 * addressed as a node. Each is instead an independent plane placed over its
 * panel using geometry measured by tools/find_screens.py.
 *
 * Interaction is two-stage: the first click flies the camera dead-on to the
 * screen, and a second click opens `href` if there is one. Nothing here opens a
 * panel. The staging exists because a single click that navigated off-site
 * would be far too easy to trigger by accident while exploring a room.
 *
 * `normal` is negated from what find_screens.py reports; see AGENTS.md.
 */
export interface Screen {
  /** Stable id, used in the URL and as a hover key. */
  id: string
  /** Source object in the .blend, for traceability back to find_screens.py. */
  source: string
  label: string
  /** Shown under the label on hover. */
  hint: string
  image?: string
  href?: string
  centre: [number, number, number]
  normal: [number, number, number]
  width: number
  height: number
}

export const SCREENS: Screen[] = [
  {
    // Leftmost from the default camera, confirmed by projecting each centre
    // onto the camera's right vector.
    id: 'nodex',
    source: 'Plane.033',
    label: 'nodex',
    hint: 'Click to look closer, again to open',
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
    label: 'Centre display',
    hint: 'Nothing on this one yet',
    centre: [1.1017, 1.302, -1.5808],
    normal: [0, 0, 1],
    width: 1.3661,
    height: 0.5689,
  },
  {
    id: 'right',
    source: 'Plane.031',
    label: 'Right display',
    hint: 'Nothing on this one yet',
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

export const hotspotById = (id: string | null) =>
  id ? (HOTSPOTS.find((h) => h.id === id) ?? null) : null
