# kubitnodes homepage

Personal homepage, served at `www.kubitnodes.com`. An explorable 3D diorama of a studio room: click an object,
the camera flies to it, a panel opens with the content that object stands for.

Built from a purchased Blender scene that is converted to a web-ready GLB by a
headless Blender pipeline, then rendered with React Three Fiber. Falls back to a
plain, fully readable 2D page when WebGL is unavailable or the viewport is small.

## Prerequisites

- Node.js 20+ (developed on 24)
- Python 3.11 exactly, only if you need to re-run the asset pipeline. The `bpy`
  wheel is built against a specific CPython minor version.
- [uv](https://docs.astral.sh/uv/) for the Python side

## Setup

```bash
npm install
npm run dev            # http://localhost:5173
```

`public/room.glb` is committed, so the site runs without touching Blender.

## Environment

Copy `.env.example` to `.env`. Both variables are read only by
`src/server/api.ts`, and neither is prefixed `VITE_` — that prefix is what would
inline the credential into the client bundle.

| Variable | Purpose |
|---|---|
| `ARGUS` | Base URL of the upstream that feeds the pixel board |
| `ARGUS_KEY` | Sent as `X-API-Key`. Server-side only |

Without them the site runs fine and the board stays unlit; only `/api/pixels`
fails. In the cluster they come from a Secret.

**What the proxy publishes is a deliberate subset.** It calls two upstream
endpoints and forwards a fraction of what they return:

| From | Forwarded | Withheld |
|---|---|---|
| `/me/pixels` | the grid, and opaque project hashes | — |
| `/me/usage/by-project` | `name`, and `tokens` as `in`/`out`/`cached` | `workingDir`, `machineId`, `projectId`, `costUsd`, raw usage keys |

`workingDir` carries an absolute path with a username in it, and `costUsd` runs
to five figures. Neither belongs on a public page, so the reduction happens in
the proxy rather than the browser — passing the endpoint through, or doing the
name lookup client-side, would publish all of it. `node tools/verify-api.mjs`
asserts against the live response that it stays that way.

Note that project *names* are public by design here: the board says `fluvio`,
`harbor`, `homepage` rather than hashes. If a name should not be, the place to
fix it is an alias map in `fetchNames`.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck then production build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm run lint` | ESLint (flat config) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify:api` | Secret containment, proxy disclosure, payload validation |
| `npm run room` | Re-export `room.glb` from the `.blend` |

## The asset pipeline

The source file is `room-v2.blend`: the purchased isometric studio scene plus a
pixel board and, added beside it, a project ranking board. It supersedes
`room.blend` (which superseded the original purchase, `ZEFUHEZF.blend`) —
verified as a strict superset each time, all original objects present and none
moved. It is saved by Blender 5.0.2, which matters twice — the file is
zstd-compressed, and it uses the 17-byte header format, so
`tools/inspect_blend.py` cannot read it — that parser only understands the legacy
12-byte header of the 2.82 original. It now says so, with the decompression
command, rather than dying on a misread header. Use `bpy` to inspect this file.

**It is not in this repo, by design.** This repository is public, and committing
the `.blend` would redistribute a purchased asset rather than use it, which
essentially every marketplace licence forbids. The derived `public/room.glb` is
committed, so the site builds and runs without it. If you need to re-run the
pipeline, drop your copy of the `.blend` at the repo root; `*.blend` is
gitignored.

The purchased half arrives in poor shape: 193 objects all named `Plane.041`-style,
157 materials named `Material.088`-style, and every texture path pointing at the
seller's Windows RAR extraction temp folder, so no texture resolves. It is also
2.8 GB of triangles once the cable curves are tessellated. The two boards added
on top bring the scene to 1482 objects — 1008 of those are individual pixels and
160 are individual LED segments.

**Both boards arrive with their objects selection-locked in the outliner, and
that silently deletes geometry.** `select_set(True)` on a locked object is a
no-op that raises nothing, so the group join in step 4 finds only its active
object, returns `{'CANCELLED'}` rather than an error, and the hotspot exports as
whatever single mesh happened to be first. The ranking board came out as a
92-triangle enclosure this way, with its other 15,828 triangles shipped as loose
top-level nodes — rendered, in the right place, and not part of the hotspot. The
pixel board had been quietly losing its 74 hour and weekday labels to the same
thing. Step 1a clears the lock, and the join now compares triangle counts before
and after and refuses to export if any went missing.

`tools/export_glb.py` fixes all of that headlessly:

1. Strips image-texture nodes whose files are missing, falling back to each
   material's flat viewport colour. This is why the room is flat-shaded, and
   why it looks deliberate rather than broken.
2. Drops curve resolution before converting cables to mesh. At authoring
   resolution they alone produce 3.5M triangles.
3. Bakes modifiers, then decimates to a per-group triangle budget. Baking has
   to happen before the join, because joining drops the modifiers of every
   non-active object and several props here are defined by theirs. Subsurf is
   dropped rather than baked; it only smooths and the decimate undoes it.
4. Tags every object into a semantic group by world-space AABB region and joins
   each group into one mesh named `hot_<group>` or `static_<group>`. An object
   lands in the **first** region whose box contains its centre, so order matters:
   `pixelboard` is listed ahead of `wallart` and `shelves` because those two
   would otherwise split the board three ways and a hotspot cannot be three
   meshes.
5. Converts text to mesh. glTF has no text primitive, so a `FONT` object is
   dropped on export with no warning. The board's hour, weekday and week labels
   are all text — without this step it exports as an unlabelled grid.
6. Exports GLB with Draco compression and writes `src/scene-manifest.json`,
   which carries each group's bounding box in glTF space for camera framing.

Result: **1.6 GB to 3.78 MB, 368,102 triangles.**

Most of that is the pixel board: `hot_pixelboard` alone is **189,692 triangles**,
more than the entire rest of the room put together, because it is 1008
individually modelled pixels at ~188 triangles each. The per-mesh triangle budget
never fires on it — decimation runs before the join, and each single pixel is far
under the 4000 ceiling. Adding `pixelboard` to `TRI_BUDGET` with a per-pixel
ceiling around 40 would cut it by roughly 4x and is invisible at the size a pixel
occupies on screen, but it has not been done: it changes newly authored art, and
that is the owner's call.

### Re-running it

```bash
cd tools
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python bpy
cd .. && npm run room
```

No Blender install needed; `bpy` is Blender as a Python module.

## The two wall boards

Both sit on the -x wall and both are driven from the same `/api/pixels` poll.
They answer different questions, and the difference is not a bug to reconcile:

| Board | Node | Shows | Ordered by |
|---|---|---|---|
| Pixel board | `hot_pixelboard` | 1008 hours, coloured by owner, lit by how busy | hours *won* |
| Ranking board | `hot_ranking` | Top 5 projects, 32-segment bar each | tokens `in + out` |

An hour on the heatmap goes to whichever project was busiest in it, so a project
can burn tokens all week and win almost no cells. `researchers` ranks third by
tokens while holding a single hour on the board beside it.

**Both are lit by writing emissive on named materials, never by adding
geometry.** The pixel board finds 1008 `Pixel Light R# C#`; the ranking board
finds 160 `Ranking - LED Pnn Snn`. Anything that paints a lasting colour must
also call `setBaseline`, or the hover wash will blank it — see
`src/three/materials.ts`.

The ranking board's segment materials existed in the `.blend` but were never
assigned; all 160 objects pointed at `Ranking - LED P01 S01`, and all 160 shared
one mesh datablock. The export wires each object to its own material, copying
the mesh first so the assignment does not write through every LED at once.

**Text on the ranking board is not in the GLB.** glTF has no text primitive, and
the source scene baked `PROJECT 01`..`PROJECT 05`, five frozen score readouts, a
`SAMPLE PROJECTS` footer and a `SCORE / 100` column head. Every one of those is
false once real data arrives, so `export_glb.py` deletes them and records their
world-space boxes to `src/ranking-anchors.json`. `RankingBoard.tsx` draws live
text into a canvas and maps it onto one transparent plane at those anchors.

The anchors are exported rather than transcribed on purpose: hardcoded
millimetres would be right once and then rot the first time a row moved, leaving
the board rendering correctly with its names a few millimetres off the rows they
label. Everything that stays true regardless of the data — the rank digits,
`CURRENT RANKING`, `ACTIVE` — stays baked in the mesh.

A canvas rather than drei's `<Text>`: troika needs a `.ttf`/`.otf`/`.woff` and
only converts WOFF1, while this project ships Geist Mono as WOFF2 only. Using
`<Text>` would mean committing a duplicate font binary or letting troika fetch
Roboto from a CDN at runtime. The canvas draws with the webfont the page has
already loaded, so the board is set in the same face as the rest of the site.

## Verifying hotspots

Region tagging is approximate: a box in world space catches whatever is inside
it, which is not always the object you meant. Never trust a region name without
looking.

```bash
npm run build
node tools/verify-hotspots.mjs   # hovers each hotspot, writes tools/shots/hover/
node tools/shoot.mjs             # full walkthrough, writes tools/shots/
```

Both serve `dist/` from an in-process static server and drive headless Chromium
with a software WebGL context, so they need no display and no detached server.

## Camera behaviour tests

These drive a running dev server instead, because they assert on the dev-only
`window.__orbit` hook rather than on pixels alone:

```bash
npm run dev                          # in one shell
node tools/verify-orbit.mjs          # orbit, zoom, drag-vs-click
node tools/verify-view-restore.mjs   # tuned view survives a hotspot visit
node tools/sweep-highlight.mjs       # renders a hover-accent tuning sweep
node tools/sweep-neon.mjs            # renders a neon brightness sweep
node tools/verify-neon-link.mjs      # the neon wordmark behaves as a link
node tools/verify-keyboard.mjs       # the room is usable without a pointer
node tools/verify-screens.mjs        # the two-stage monitor interaction
```

`verify-view-restore`, `verify-neon-link`, `verify-keyboard` and
`verify-screens` exit non-zero on failure, so all four are usable as gates.

One more runs against a production build rather than the dev server, because it
asserts on media loading and needs real MIME types and range requests:

```bash
npm run build
node tools/verify-player.mjs          # autoplay policy, transport, persistence
node tools/verify-glass.mjs           # panel text clears WCAG AA on glass
```

Both exit non-zero on failure. `verify-hotspots.mjs` likewise serves `dist/`.

## The glass panels

Panels use `.glass` in `src/index.css`. Being accurate about what that is: Apple
documents Liquid Glass for Apple platforms and there is no official web
implementation, so this is an approximation — an unfiltered pane, a hairline
specular edge and a depth shadow. It will not match Apple's material pixel for
pixel.

There is **one** material, `.glass`, used by every panel with no modifier and no
per-panel variant. It is optically clear: no blur, no tint, no fill. The room
passes through sharp and unmodified, and the edge does the work — a sub-pixel
hairline border, two faint inset catches and a drop shadow.

**Six panels knowingly ship under WCAG AA, and that was a deliberate choice.**
Content panels sit in front of the lit monitors and the hexagon light wall, and
clear glass there leaves 14px muted text between 1.03:1 and 2.89:1 against a
4.5:1 requirement. An earlier version dimmed each panel's own backdrop with
`brightness(0.16)`, which cleared AA everywhere at a tightest 5.17:1, but read as
smoked rather than clear. The owner compared both in a real browser and chose the
clear render. The decks bar is the one panel that passes outright, at 5.55:1,
because it is anchored over the dark floor rather than in front of anything lit.

The measured cost is recorded in `ACCEPTED` in `tools/verify-glass.mjs` rather
than being left implicit. **The route back to a clean pass is the camera, not the
CSS:** reframe those hotspots over darker parts of the room, the way the bar
already is, and clear glass becomes affordable at no legibility cost.

Removing the frost *improved* contrast, which is worth knowing before anyone adds
it back. Behind the bar the worst backdrop went from rgb(63,72,93) frosted to
rgb(52,63,88) clear, and body text from 5.01:1 to 5.76:1: a blur pulls bright
pixels in from neighbouring areas and a white fill adds luminance outright. A
faint white fill over clear measured 4.42:1, so there is no fill at all.

There is no full-screen scrim. `brightness()` inside `backdrop-filter` only ever
dimmed what was behind a pane, never the room around it.

No SVG `feDisplacementMap` edge refraction, though that is the mechanism visible
in the reference and `backdrop-filter: url(#…)` does work in Chromium: Safari does
not support SVG filters in `backdrop-filter`, and Safari is the browser this site
gets checked in, so it would be an effect its owner never sees.

`node tools/verify-glass.mjs` is the gate. Per panel it reads the computed colour
and size of every piece of visible text, hides the contents so only the composited
surface remains, finds the brightest tile — the worst backdrop any glyph could
land on — and judges each colour at 3:1 for large text or 4.5:1 otherwise. It
tests the colours actually present rather than a fixed list, and resolves text on
an opaque button against that button. Run it after touching any opacity, any panel colour, or the room's
lighting. The failure mode is invisible otherwise: the bright surfaces that cause
it are off screen when the panel is closed.

Two traps if you retune it. The gate insets past the panel padding on purpose —
the border, inset rim and specular sheen are all bright and within ~3px of the
edge, and sampling them reports failures on a backdrop no glyph ever touches.
And it waits for the camera flight to land, because measuring early samples the
brighter home framing through the glass.

Gloss belongs on the edge, where it is also free: white across the face raises
the luminance text sits on and the gate charges for it, while a brighter border,
rim and sweep cost nothing measured.

Reduced transparency is honoured completely — no blur, no translucency, no sheen
— via `prefers-reduced-transparency`. There is also a nearly-opaque fallback for
browsers without `backdrop-filter`, because shipping a transparent panel with
unreadable text over a moving scene is worse than shipping no glass.

**Not verified:** the GPU cost of blurring a continuously rendering canvas. This
box has no hardware GL, and software rasterisation gives ~6fps with no glass at
all, so the numbers are meaningless. Watch for dropped frames while orbiting with
a panel open, which is when the compositor must re-blur every frame.

All of the above need a one-time `npx playwright install chromium`.

## The backing track

The room plays a track on loop. **The audio file is not in this repository** —
`*.mp3` is gitignored for the same reason the `.blend` is: the current track is
a commercial release, and this repo is public, so committing it would
redistribute the recording rather than play it.

A fresh clone therefore runs silent, on purpose. `usePlayer.available` goes
false when the file 404s and the decks panel says so instead of pretending. To
put audio back:

1. Drop a file in as `public/track.mp3`.
2. Update `TRACK` in `src/content.ts` — `title`, `artist` and `seconds`.
3. Optionally add cover art as `public/cover.webp`, 192px square. It fills the
   transport button, so it needs to hold up at 3x DPR on a 56px control. Leave
   `TRACK.cover` undefined, or omit the file, and the button falls back to a
   solid accent fill — that is the fresh-clone default and a supported state,
   not a broken one.

`artist` is the attribution and the panel always renders it, so a track that is
not yours stays credited. There is no longer a longer disclaimer below the card.

Cover art is usually already inside the file, as an ID3v2 `APIC` frame, at a size
made for a media library rather than a 56px control — the track supplied here
carried a 1400x1400 PNG. Extract it, resize it, and the 1.59 MB becomes 4.9 KB:

```python
from PIL import Image
Image.open('cover.png').convert('RGB').resize((192, 192), Image.LANCZOS) \
     .save('public/cover.webp', 'WEBP', quality=88, method=6)
```

The glyph sits on top of the artwork, so contrast is not guaranteed by anything.
A light scrim plus a hard drop shadow carries it; a scrim heavy enough to
guarantee contrast alone turns the cover into a dark disc and defeats the point.
Check a bright cover by eye rather than trusting it.

`public/cover.webp` is gitignored for the same reason as the track: art pulled
out of a commercial release is exactly as rights-encumbered as the recording. If
you own the artwork, drop that line from `.gitignore` and commit it.

Two behaviours worth knowing before changing any of this:

- **It cannot autoplay with sound on a cold visit, and does not try to cheat.**
  Chrome and Safari require a user gesture, and the preloader dismisses itself
  rather than asking for a click. So playback is attempted at load (which
  succeeds for a returning visitor with media engagement) and otherwise armed
  to start on the first `pointerdown`, `keydown`, `wheel` or `touchstart`.
  Exploring the room is the gesture, which is why there is no "enable sound"
  prompt.
- **There is one piece of user state, `on`, not a mute flag plus a paused
  flag.** Two flags let the HUD speaker and the panel transport disagree about
  the same track. The choice persists to `localStorage` under `kr4t0n:music`.
- **The track starts at full level with no fade-in, deliberately.** WebKit pauses
  media that becomes audible without a user gesture, so a volume ramp after
  `play()` means Safari starts the track and immediately stops it while Chromium
  plays it fine. Volume is set before `play()`, synchronously. Fading *out* is
  unrestricted. See AGENTS.md before adding any fade-in.
- **The suite is Chromium-only.** Verify autoplay, volume and codec changes
  manually in Safari; Playwright's WebKit is not Safari and does not stand in
  for it.

Strip embedded cover art before serving a file. The track supplied for this
build carried 1.6 MB of ID3v2 album art — 22% of the download — that the page
never renders.

## Putting an image on a monitor

The three panels are entries in `SCREENS` in `src/content.ts`. Give one an
`image` and it renders; give it an `href` and a second click on the framed
screen opens that URL. Geometry for all three is already measured; to re-derive
it run `tools/.venv/bin/python tools/find_screens.py` and negate the normal it
prints, for the reason in AGENTS.md.

Images are cover-fitted, never stretched: the panels are 2.4:1 and screenshots
rarely are, so something gets cropped. Set `anchor: 'top'` for a page
screenshot, where the nav and hero carry the identity and a centred crop would
cut the nav off.

The left panel shows nodex and the centre shows Argus. The right one is wired
and empty.

## Putting something on a wall

`tools/find_walls.py` reports the wall planes and `tools/wall_occupancy.py`
lists what is already mounted plus the clear bands between. Mount against the
wall's inner face, not the outer one; see AGENTS.md for why that trips people
up. `src/three/NeonSign.tsx` is a worked example.

## Adding or changing content

Everything the page says lives in `src/content.ts`. Add a hotspot by adding an
entry pointing at a node that exists in `src/scene-manifest.json`, then run the
verification script to confirm it highlights the object you expect. A hotspot
marked `unverified: true` is excluded from the 3D room but still renders in the
2D fallback.

There is no Work panel. The two projects it listed are on the monitors — click
the left one for nodex, the centre one for Argus — which is the presentation that
was wanted, so a panel repeating it was redundant. `PROJECTS` still drives the 2D
fallback, and About links both by name, because the monitors are raycast targets
with no `tabIndex` and would otherwise be unreachable without a pointer.

## Deployment

Deployed into a Kubernetes cluster and exposed through an ingress at
`www.kubitnodes.com`, alongside `argus-api.kubitnodes.com`. A single container
serves the built `dist/` and the `/api/pixels` endpoint from one origin, so there
is no CORS and no credential in the browser.

There is no GitHub Pages workflow. An earlier revision of this repo had one; it
was never the intended target and has been removed. `base: '/'` in
`vite.config.ts` stays, because the site serves from a domain root.

The manifests and container build are not written yet — see the pixel board work.

## Project structure

```
src/
  content.ts            all copy, projects, hotspot -> node map
  scene-manifest.json   generated: bounding boxes per group
  ranking-anchors.json  generated: where the ranking board's live text goes
  store.ts              focus/hover state, hash routing
  server/
    api.ts              the /api/pixels proxy; the only holder of ARGUS_KEY
  shared/
    pixels.ts           payload type, validator and grid maths, both sides
  pixels/
    usePixels.ts        poll, cache, live-slot tracking
    palette.ts          project colours, cell appearance, cell indexing
    ranking.ts          top-5 by tokens, scores and segment counts
  three/
    Scene.tsx           canvas, lighting, tone mapping
    Room.tsx            GLB load, raycasting, hover highlight
    CameraDirector.tsx  GSAP camera choreography, orbit, idle drift
    orbit.ts            drag/zoom/pinch input, limits, home-view stash
    highlight.ts        hover accent colour and strength
    materials.ts        emissive baselines shared by hover and the boards
    PixelBoard.tsx      lights 1008 cells from live activity
    RankingBoard.tsx    lights 160 LEDs, draws live text to a canvas
    Screens.tsx         the three monitors, framed on click, link on second
    NeonSign.tsx        canvas-drawn neon wordmark on the back wall
  ui/
    Hud.tsx             hero, hotspot nav, framed-screen exit, sound toggle
    Panel.tsx           focused content panels
    PixelTooltip.tsx    per-cell readout when the board is focused
    Preloader.tsx       real GLB load progress
    Fallback2D.tsx      no-WebGL / small-screen page
  audio/
    synth.ts            Web Audio synth for the music hotspot
    player.ts           backing-track playback, autoplay policy, ducking
tools/
  export_glb.py         the asset pipeline
  inspect_blend.py      dependency-free .blend parser
  inspect_scene.py      bpy scene report + preview renders
  diff_blend.py         what changed between two .blend versions
  find_screens.py       measures the monitor panels for SCREENS
  find_walls.py         measures the wall planes
  compare_view.py       source vs export from any camera
  diagnose_keys.py      source vs export vs flat-material render
  diagnose_lighting.py  material colours, neutral vs site light rig
  wall_occupancy.py     lists wall decor and finds clear bands
  verify-api.mjs        secret containment, proxy disclosure, ranking maths
  verify-glass.mjs      glass contrast gate
  verify-hotspots.mjs   hover verification captures
  verify-orbit.mjs      orbit, zoom, drag-vs-click checks
  verify-view-restore.mjs  camera restore regression test
  verify-player.mjs     backing-track transport
  sweep-highlight.mjs   hover-accent tuning sweep
  sweep-neon.mjs        neon brightness tuning sweep
  verify-neon-link.mjs  neon wordmark link behaviour
  verify-keyboard.mjs   keyboard-only reachability
  verify-screens.mjs    two-stage monitor interaction
  shoot.mjs             full walkthrough captures
```

## Known gaps

- The DJ controller carries the player. It was deliberately unassigned until
  there was content that suited a mixing desk; the backing track is that
  content, so `hot_djcontroller` is now the `player` hotspot.
- The Signals panel measures ~1.02:1 against the lit board behind it, which is
  the worst contrast in the project. It was recorded at 2.06:1 until the glass
  gate learned to serve a pixel payload — before that the board behind it was
  always unlit in the test, so the number described a state that never ships.
  Nothing regressed; the measurement got honest. Per the project's own rule the
  fix is the camera, not the CSS: frame this hotspot so the panel lands over a
  darker part of the room. Until then it sits in `ACCEPTED` alongside `about`
  and `contact`.
- The ranking board has no hotspot of its own. `hot_ranking` is in the GLB and
  is marked interactive in the manifest, but there is no `content.ts` entry
  pointing at it, so it is not in the nav, not pickable, and has no panel. It
  reads as part of the Signals view because it sits beside the pixel board.
  Giving it its own framing would make its text far more legible than it is at
  the Signals standoff.
- One bar full and four stubs is what the data looks like. The leader is ~3.5x
  the runner-up and ~12x fifth place, so a linear bar normalised to the leader
  leaves the lower rows at 3-9 segments of 32. That is honest and it is also
  hard to read. A log scale would flatter the lower rows and misrepresent the
  gap; the alternative worth considering is ranking by output tokens alone,
  which is a less skewed distribution and arguably a better proxy for work.
- The right-hand monitor is wired and empty. Adding an `image` and `href` to the
  `right` entry in `SCREENS` is all it needs.
- Writing, CV and the stats board are marked placeholders in the UI rather than
  filled with invented content.
- The About copy is inferred from the GitHub bio and the two projects, not
  written by its subject.
- The source `.blend` shipped with a `minion.jpg` texture reference among
  others. All missing textures are stripped at export, so nothing
  rights-encumbered ships, but the asset's provenance is not clean.
- The track currently wired up is a commercial release used as scaffolding. It
  is kept out of the repo and the artist is credited in the panel, but it should
  be replaced with an original mixdown rather than shipped as-is.
