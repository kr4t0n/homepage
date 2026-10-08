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
   * Further nodes this hotspot covers, if it is one thing made of several
   * meshes. Picking, hover and camera framing all treat `node` and these as a
   * single object: the camera frames the union of their bounding boxes, so the
   * framing follows the asset if the parts move relative to each other.
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
   * Focus this hotspot without opening a panel: the object itself is the
   * content, and the only chrome is the way back out.
   *
   * The framed monitors already worked this way. It suits anything the camera
   * can put in front of you legibly, where a panel would sit on top of the very
   * thing you asked to look at and say it again in words.
   */
  bare?: boolean
}

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
    // The synth, not the DJ controller. Both region names in the exporter used
    // to be wrong, which put this hotspot on the wrong instrument; they now
    // describe what they actually enclose. The DJ controller is the `player`
    // hotspot below.
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
    // The decks carry the transport for whatever the room is playing. Chosen
    // over the synth because the synth is the instrument you play and this is
    // the deck you cue a record on, which is the distinction the panel makes.
    id: 'player',
    node: 'hot_djcontroller',
    label: 'Now playing',
    hint: 'What the room is listening to',
    kind: 'player',
    // The deck is 2.53 units wide, the widest hotspot in the room, against a
    // 34-degree lens: visible half-width is 0.49x distance, so it needs ~3.5
    // units of standoff to sit at three quarters of the frame. The x offset
    // stays near zero because pushing the camera sideways while still aiming at
    // the centre swings the far end of a wide object straight out of frame.
    //
    // `look` is measurably left of the node's centre. Aiming dead at the centre
    // renders the deck ~320px left of frame centre at 1440x900, close enough to
    // the left edge to clip at other aspect ratios; aiming left of it pushes the
    // object right. Pointer parallax is not the cause — it is eased to zero when
    // a hotspot is focused, and the framing is identical with the pointer parked
    // anywhere. `look` barely lifts the object, unlike the other hotspots, whose
    // offsets clear a full-height content panel: the decks render as a compact
    // bar, so the same lift left a third of the frame as empty floor.
    offset: [0.15, 1.35, 3.3],
    look: [-0.55, -0.08, 0],
  },
  {
    id: 'signals',
    // Resolved at last. This hotspot carried a TODO and `unverified: true` from
    // the beginning, because no node in the purchased scene was a plausible
    // stats board -- `hot_hexpanels` turned out to be a small wall fixture, and
    // the DJ controller went to the player. The board now exists for real: a
    // 24x42 pixel grid added to the source scene, with hour and weekday labels,
    // which is an activity heatmap and exactly what this hotspot was reserved
    // for.
    node: 'hot_pixelboard',
    // Signals is both wall boards, not just the heatmap. They are one display
    // in two pieces -- the same six weeks, ranked two ways -- so framing only
    // the left one cut the ranking board half out of shot and left it as a dead
    // zone the pointer could cross without the hotspot lighting up.
    nodes: ['hot_ranking'],
    label: 'Signals',
    hint: 'Six weeks of agent activity',
    kind: 'stats',
    // No panel. The boards carry the whole readout -- the heatmap, the legend
    // colours, the ranking with its token totals -- and the panel restated it
    // in words while covering the bottom of both boards to do so. Per-cell
    // detail is on hover, via PixelTooltip, which needs the board visible.
    bare: true,
    // Together the boards are 2.39 wide by 0.96 tall on the -x wall, facing +x
    // -- the pixel board's 1.74 plus the ranking board and the gap between
    // them. At a 34-degree lens visible half-width is 0.49x distance, so 3.1 of
    // standoff puts the pair at ~79% of frame width. Framing is taken from the
    // union of both bounding boxes, so this holds if the boards move again;
    // they already have once.
    //
    // Dead centre, and close, because there is no panel to share the frame
    // with. While there was one this sat at 4.4 with `look` pushing the boards
    // up into the top half so the glass did not cover their bottom edges; that
    // cost most of the legibility the boards were being framed for. Filling the
    // frame is the whole point now -- the hour and week labels, the rank rows
    // and the token totals all have to be readable, because they are the
    // content rather than an illustration beside it.
    //
    // The camera sits level with the boards' centre and looks straight at it.
    // These are flat wall panels; any vertical offset keystones the grid, which
    // is very visible on something made of rows and columns.
    offset: [3.1, 0, 0],
    look: [0, 0, 0],
  },
  {
    id: 'writing',
    node: 'hot_shelves',
    label: 'Writing',
    hint: 'Notes and longer pieces',
    kind: 'writing',
    // Raised and aimed further down than the original [4.3, 1.1, 2.6] /
    // [0, -0.2, 0]. room-v3 slid both wall boards along this wall and added a
    // fourth lamp to the shelf rail, which grew `hot_shelves`'s bounding box --
    // and since the camera is placed relative to that box, the framing shifted
    // enough to bring the lit pixel board in behind the panel. Contrast fell
    // from 1.64:1 to 1.11:1 with nothing in the CSS having changed. This puts
    // the panel back over the sofa and restores 1.64:1 exactly.
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
  // No hotspot on the sofa. It used to open a Contact panel whose whole job was
  // a GitHub link, which the neon wordmark on the back wall now is. `hot_sofa`
  // is still exported as its own group, so it can come back without a re-export.
]

/**
 * Things in the room that open an external URL instead of a panel.
 *
 * Kept separate from HOTSPOTS because these are not glTF nodes and must never
 * reach the raycast map. Every one of these has to be reachable some other way
 * as well: a click target that exists only in the 3D scene cannot be tabbed to
 * or read by a screen reader, so it can decorate a route, never be the route.
 * The keyboard index in Hud.tsx renders each of them as a real anchor, so adding
 * one here adds its keyboard route with it.
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
  image?: string
  href?: string
  /**
   * Which part of the image to keep when its aspect does not match the panel.
   * Images are cover-fitted, never stretched, so something has to be cropped.
   * 'top' for a page screenshot, where the nav and hero carry the identity and
   * a centred crop would cut the nav off. Defaults to 'centre'.
   */
  anchor?: 'top' | 'centre'
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
    // The screenshot is 1.68:1 against a 2.4:1 panel, so 30% of its height is
    // cropped. Anchored to the top: that keeps the nav, the hero line and the
    // install CTA, and loses the bottom of the dashboard mockup. A centred crop
    // would have cut the nav off.
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
