# AGENTS.md

Context for coding agents: how this repository fits together, why it is built
the way it is, and what breaks if you change it. [README.md](README.md) covers
setup, scripts, environment variables, the asset pipeline's steps, deployment
and the file layout; this file links there rather than repeating it.

## What this is

A personal homepage whose landing page is an interactive 3D room. Clicking a
physical object focuses the camera on it and usually opens a content panel. The
room is a purchased Blender asset converted by a local pipeline.

## Architecture

```
room.blend --[tools/export_glb.py, headless bpy]--> public/room.glb
                                                +-> src/scene-manifest.json
                                                         |  node names, bounding boxes
                                                   src/content.ts
                                                         |
                                 +-----------------------+-----------------------+
                                 |                                               |
                         three/ (R3F scene)                              ui/ (DOM overlay)
```

`src/content.ts` is the contract: it maps each hotspot id to glTF node names, a
panel kind and a camera pose. The 3D room and the 2D fallback both read it, so
content cannot drift between them.

The two wall boards are the only live surfaces, and they have a server:

```
Argus /me/pixels           --+
      /me/usage/by-project --+--> src/server/api.ts --> /api/pixels --> usePixels
      (X-API-Key stays on the server)                                      |
                    +--------------------------+---------------------------+
                    |                          |                           |
        three/PixelBoard.tsx        three/RankingBoard.tsx       ui/PixelTooltip.tsx
        1008 cells, hours won       5x32 LEDs, tokens            per-cell hover readout
```

The proxy exists because `ARGUS_KEY` must never reach the browser. Only server
code reads it, from `process.env` (`api.ts` for the upstream call, `serve.ts`
for a startup warning; in dev `vite.config.ts` loads it there from `.env`), and
the missing `VITE_` prefix is what keeps Vite from inlining its value: renamed
`VITE_ARGUS_KEY`, it ships to every visitor. `verify-api.mjs` checks `dist/` for
the value, the name and the server module. The proxy's 9s cache, single-flight,
strict validation, field reduction and server-side failure log keep that hop
cheap and honest. One Hono handler is mounted twice: `@hono/vite-dev-server` in
`pnpm run dev`, `@hono/node-server` in `src/server/serve.ts` in the container,
so dev cannot drift from prod. `serve.ts` adds only what Vite supplies in dev
(the static tree, a cache policy, a shutdown path): put routes in `api.ts`, or
they exist only in production. `src/shared/pixels.ts` (payload type, validator,
grid maths) is imported by both sides; `src/pixels/ranking.ts` is pure so it is
unit-tested without a GPU.

## Asset pipeline

**The pipeline compensates for the asset, not the runtime.** The purchased scene
has no usable textures, no object naming and pathological geometry. Everything
fixable once at export is fixed in `tools/export_glb.py`, so React code carries
no asset workarounds. If the room looks wrong, check the exporter before
`src/three/`.

**Flat shading is a decision.** Every texture path points at the seller's
machine, so the export drops texture nodes and keeps each material's flat
colour. With ACES tone mapping at low exposure and a dim rig it reads as a
stylised night scene. Raising the key light blows the flat colours out to pale
grey; add fill instead (see Rendering).

**Regions are hand-authored world-space AABBs, and an object joins the first
region containing its centre.** So order is load-bearing (`pixelboard` precedes
`wallart` and `shelves`, whose boxes overlap it; otherwise the board splits
three ways and a hotspot cannot be three meshes), a nudge in Blender silently
moves objects into a neighbouring, still-valid group, and a region's name is not
evidence of its contents. The export asserts that every `Pixel*` and `Ranking*`
object lands in its own region; extend that check for any new systematically
named group. After any region or `.blend` change, diff the versions with
`tools/diff_blend.py`, run `node tools/verify-hotspots.mjs`, and rename a region
the moment its name stops matching what it holds.

**Geometry is joined per semantic group** (`hot_*` or `static_*`), so the room
loads as 16 groups rather than the purchase's 193 objects and raycasting stays
cheap.

**glTF has no text primitive, and the exporter drops `FONT` objects without a
warning.** The pass that converts curves to mesh converts fonts too, and `FONT`
is in `props` so labels get a region before conversion. A missing label means
check this first.

**The outliner's selection lock silently breaks a join.** `select_set(True)` on
a `hide_select` object is a no-op that raises nothing (`select_get()` just keeps
returning False), so `bpy.ops.object.join()` finds only its active object,
returns `{'CANCELLED'}` rather than raising, and the group exports as one mesh
while the rest ship as loose nodes that still render. Step 1a clears the lock,
and the join compares triangle counts and refuses to export on a mismatch. Never
trust a join operator's return value.

**`join()` discards every non-active object's modifiers**, and several props are
defined by theirs (the synth keybed is one key with an ARRAY of 22; MIRROR and
SOLIDIFY elsewhere). Modifiers are baked before joining; subsurf is dropped
instead, since decimation follows and, applied, it took three props from 858 to
167,552 triangles.

**`export_apply=True` applies modifiers after any counting you do.** Bake and
count in the same pass, and check the shipped total from the GLB's accessors,
not the log.

**`bpy.ops.object.convert(target='MESH')` acts on the whole selection.** Set
curve resolution on every curve before converting any.

**Linked duplicates share mesh data**: all 160 ranking LEDs use one datablock,
so assigning a material in a loop writes through to every copy. Do `o.data =
o.data.copy()` first. Step 1b then gives each `RankingLED_*` object the
`.blend`'s own `Ranking - LED Pnn Snn` material, a full 5x32 set carrying the
board's per-row colour ramp that the author never assigned. `RankingBoard.tsx`
finds them by name and reads each row's lit colour from their authored emissive,
so the ramp is load-bearing.

**Runtime text anchors are measured at export.** The exporter deletes the
ranking board's baked placeholder labels and writes their world-space boxes to
`src/ranking-anchors.json`, which `RankingBoard.tsx` reads. Hardcoded positions
would rot silently the first time a row moved. The placeholders are deleted at
export, not in the `.blend`, so the source stays a self-contained mockup; text
true of any five-row board (rank digits, `CURRENT RANKING`, `ACTIVE`, the entry
count) stays baked. Measure any new live readout on a modelled surface the same
way.

**The `.blend`'s lights never reach the site** (`export_lights=False`).
`src/three/lighting.ts` is a hand-tuned rig that deliberately does not mirror
Cycles. Lamp housings are geometry and do sync, so a new lamp can appear that
casts nothing.

**Coordinates:** Blender is Z-up, glTF Y-up; the manifest converts `(x, y, z) ->
(x, z, -y)`. Camera values in `content.ts` are glTF space.

**The monitor faces' normals point into the wall.** Placing an overlay with them
buries it in the monitor and backface-culls it, blank with no error. `SCREENS`
stores the negation of what `tools/find_screens.py` prints; a screen faces the
room (+z).

**Wall-mounted objects go on the wall's inner face.** The back wall's faces are
at z -2.10 and -1.99 with inverted normals; the room side is -1.99. Mounting at
-2.10 hides the object inside the wall. `tools/find_walls.py` measures planes
and `tools/wall_occupancy.py` lists mounted decor and clear bands, but only near
the wall plane: search obstructions by x and y span with depth open
(`Plane.006`, the framed picture, stands 1.2 m proud). `Circle.022` covers x
-0.66 to 3.41 full height and `Plane.006` x 3.48 to 4.73 up to y 1.98, so the
free space on that wall is the strip above the frame.

## Rendering

**three.js has no global illumination, so the room needs explicit fill.** The
offline renders look right partly because Cycles bounces light off the pale
floor; with one key and a flat ambient, everything not facing the key crushes to
black. `lighting.ts` adds a hemisphere term for sky and floor plus a weak
opposite-side bounce. Before changing the model, compare against an offline
render of the same GLB: `tools/diagnose_keys.py` (source, export, flat-material
export) and `tools/diagnose_lighting.py` (a bright neutral light, then a dim
ambient and one sun with no fill; that sun is not the site's key, since it takes
the site's Y-up `(7, 10, 7)` as Blender's Z-up and lands about 76° away, behind
the back wall).

**Never overwrite an authored `emissiveIntensity`.** Every glowing material
carries `KHR_materials_emissive_strength` between 1 and 10; forcing one value
crushes bright LEDs and boosts dim indicators. Scale the authored value.

**A glTF node with several primitives loads as a Group** with suffixed children
(`hot_desk_0`, ...), so `mesh.name === node` never matches. Use
`getObjectByName(node)` and traverse; raycasting walks up the parent chain, so
picking works either way.

**`Object3D.clone()` shares materials, including with drei's cached GLTF**, and
the asset reuses one material across unrelated props. Mutating in place changes
the other side of the room and the cache, which is why `verify-hotspots.mjs`
tints through copies.

**The scene-clone `useMemo` in `Room.tsx` must be pure**, because `<StrictMode>`
runs it twice in development and keeps the first result. An impure one shows as
a dev room darker than production, darker again on each hot reload of
`Room.tsx`, which matters because `lighting.ts` is tuned in dev. Every material
in the clone is a copy, so neither run writes into the cache. Two properties of
the copy keep production pixel-identical:
- **Sharing survives.** The roughness lift runs once per mesh, so a material
  shared by k meshes is lifted k times. Hotspot meshes get a copy per mesh (the
  wall boards write live emissive into theirs); every other material gets one
  copy shared by exactly the meshes that shared the original.
- **Material ids keep their relative order.** `WebGLRenderLists` sorts opaque
  draws by `material.id`, and on coplanar surfaces the later draw wins. Shared
  copies are made first, in the originals' id order, then hotspot copies. `id`
  is absent from `@types/three`, hence the accessor.

Nor may that memo clear shared state: the second run would wipe what the first
set up and refill it from a clone that is then thrown away.

**`Room.tsx` sets the Draco decoder path with `useGLTF.setDecoderPath` at module
level, before the preload at the bottom of the file.** drei keeps one loader, so
this covers every `useGLTF`, where a positional argument could be dropped at a
new call site; without it the decoder comes from gstatic, an undeclared third
party (README, "The Draco decoder").

**Board text is a canvas texture, not drei `<Text>`.** troika converts only
WOFF1 and Geist Mono ships as WOFF2, so `<Text>` would need a duplicate font
binary or a CDN fetch of Roboto. Draw only after `document.fonts.ready`; drawing
early silently falls back to the default monospace.

**The neon wordmark is a canvas texture, not geometry.** An extruded tube would
be the most detailed object in a flat-shaded low-poly room and look pasted in;
the canvas in `NeonSign.tsx` stays at the room's level of detail and draws in
the site's typeface.

## Camera

**One owner.** `CameraDirector` holds a single authored pose that GSAP tweens on
focus change. Idle drift, pointer parallax and the visitor's orbit and zoom are
bounded per-frame offsets on top of it. Nothing else writes `camera.position`;
accumulating offsets into it makes the camera drift away.

**Spherical, not Cartesian.** Drag and zoom change the same
`theta`/`phi`/`radius` GSAP tweens for flights, so manual and scripted moves
compose. `OrbitControls` would be a second writer of `camera.position`.

**The visitor's home view is stashed, not discarded.** Focusing a hotspot eases
the orbit to zero for the authored framing; `homeView` records the offsets
first, and the return flight restores them.

**A hotspot's pose is relative to its bounding box.** `offset` and `look` in
`content.ts` are deltas from the manifest centre, so anything that grows a group
re-frames its panel with no camera value edited, and can slide a lit surface
behind the glass. Re-run `node tools/verify-glass.mjs <panel>` after an export,
and fix a regression by retuning the camera, not the waiver.

**`look` is a world-space offset, not an angle**, so it does not survive a
change of standoff. Rescale `look` whenever `offset` changes.

**The lens is narrow.** `Scene.tsx` uses 34°, so visible half-width is ~0.49x
the standoff. Keep the x offset near zero for wide props: moving sideways while
aiming at the centre swings the far end out of frame.

**Aiming at a node's bounding-box centre does not centre it on screen**,
probably because joined groups include stands and legs. The DJ controller needs
`look.x = -0.55`; aimed at its centre it sits near enough the left edge to clip
at other aspect ratios. Pointer parallax is not the cause: it eases to zero
while a hotspot is focused. Framing offsets are empirical: change one,
screenshot, look.

**Screen framing distance is computed.** The panels are 2.4:1, so height limits
a wide window and width a narrow one; `poseForScreen` derives the distance from
the live camera's fov and aspect.

## Hotspots, links and the keyboard

**The room is unlabelled on purpose.** No hero copy, no visible hotspot list, no
"drag to look around" hint, no hover highlight: objects are found by exploring,
and the pointer cursor (`bindCursor`) is the only cue. The neon sign brightens
under the pointer as part of the sign. There is no header either: the neon sign
is the wordmark and the GitHub link, so a header would spend the room's whole
upper edge on a duplicate. The per-cell `PixelTooltip` is not a hover hint: it
appears only on the focused board and carries numbers shown nowhere else. Two
controls stay on purpose. Reset view appears only once the visitor has moved the
home view. The HUD speaker shows whenever a track is available: the room plays
on its own, so stopping it must not depend on finding the decks. It sits
top-right so it stays reachable while a panel owns the lower half, and hides
while a framed screen fills the frame or when no track is served, which is the
normal state for a clone. If a highlight ever returns, blend the accent into the
material's own emissive, or props flatten into silhouettes and glowing ones lose
their glow.

**The hotspot index in `Hud.tsx` is for the keyboard, and it is the only
keyboard route into the room.** Every hotspot, and the Argus, nodex and GitHub
links, depend on it. It is `sr-only` until a pill takes focus
(`focus-within:not-sr-only`), so a keyboard visitor sees what they tab through
(WCAG 2.4.7) and a pointer never does. It stays mounted and fades while a panel
is open, so the pressed pill keeps focus and the next Tab enters the panel. Do
not hide it with `opacity-0`: invisible pills that take pointer events are a
dead zone over the room, and invisible while focused fails focus visibility.
Tests cannot hover or click a pill; they `focus()` it or press Enter on it.
`verify-keyboard.mjs` asserts hidden at rest and visible on focus.

**A 3D object is never the only route to anything.** Raycast targets have no
`tabIndex` and no key handling. So About carries the Argus and nodex links that
the monitors open (`verify-screens.mjs` asserts them), and every `ROOM_LINKS`
entry is rendered by the index as a real anchor labelled by its `label`, whose
focus sets `hover` so the object lights as under the pointer. The neon wordmark
is the only keyboard route to GitHub outside the 2D fallback;
`verify-keyboard.mjs` walks the index to it, so run it before removing any
anchor.

**Objects that open URLs live in `ROOM_LINKS`, not `HOTSPOTS`.** They are not
glTF nodes, so as hotspots they would break the raycast map and get pills that
try to open a panel.

**A hotspot can own several meshes.** `nodes` lists glTF nodes beyond `node`;
picking and framing both read `hotspotNodes(h)`, and framing takes the union of
the boxes. Reading `h.node` gives a hotspot that picks or frames only half of
itself, which looks like design rather than a bug. Signals is both wall boards.

**A hotspot can be `bare`**: focusing opens no panel, and the only chrome it
adds is "Back to the room", as for a framed monitor. Signals is bare because the
boards are the whole readout and a panel covered their bottom edge restating it.
A bare hotspot is framed to fill the frame, not the top half, has no glass to
gate, and has no DOM representation at all: see README "Known gaps" before
adding another one that carries content.

**The monitors are overlays, not the GLB mesh.** All three faces are merged into
`hot_screens` with their UVs lost, so `Screens.tsx` places a transparent hit
plane in front of each and a drawn plane behind it (`raycast={() => null}`). No
hotspot points at `hot_screens`, so a click on a monitor resolves to a screen,
never to the room behind.

**Screens are two-stage**: the first click frames one dead-on, a second click on
the framed screen opens its link, because a one-click off-site navigation is too
easy to trigger while looking around, and the framed state gives the second
click an unambiguous target. The framed view is deliberately bare, so the second
click is discoverable only through the pointer cursor; if it needs to be more
obvious, add a hint rather than collapsing to one click.

**Screen images are cover-fitted from the decoded image.** `Screens.tsx` reads
`texture.image` for real dimensions and crops through the UV window, so any
aspect works. `anchor: 'top'` keeps a page screenshot's nav.

**A small click target gets a padded, separate hit mesh**, as the neon sign
does, with the drawn plane set to `raycast={() => null}`. The hit mesh must
`stopPropagation` on `onPointerMove`, or the room's handler behind it resolves
the wall and clears the hover every frame.

**Every click handler honours `orbit.suppressClick`**, so ending a drag on a
link does not navigate away (`verify-neon-link.mjs`).

**The panel is a `div` with `role="dialog"`, not a `<dialog>`.** Chromium
focuses an open `<dialog>` when anything inside is clicked, so the next key
draws the focus ring around the whole panel and arrow keys and PageDown stop
scrolling its inner scroller. A screen reader hears the same either way.
`Panel.tsx` turns off jsx-a11y's `prefer-tag-over-role` on both lines with that
reason. The preloader is an `<output>`, so the scripts wait for `output` to go.
The two checks that no panel opened, in `verify-boards` and `verify-screens`,
ask `getByRole('dialog')`, which counts a dialog however it is marked up.

## UI and CSS

**Never hand-write a `-webkit-` prefix.** Lightning CSS (inside Tailwind v4)
autoprefixes and treats `-webkit-backdrop-filter` as an alias of the standard
property, so writing both keeps whichever came last, and Chromium ignores the
prefixed one: the computed `backdrop-filter` reads `none` with no warning. Write
the standard property alone.

**Component base styles go in `@layer components`.** `.glass` sets `position:
relative`; in `@layer utilities` it beat Tailwind's own `fixed` by source order
and detached the panel. In `components`, utilities on the element win, as they
should over a base style.

**A gradient scrim is anchored to the viewport.** Its fully opaque bottom edge
is a hard line wherever it lands, and `bottom-0` inside a positioned container
means that container's bottom. Check `getBoundingClientRect().bottom` equals
`innerHeight`; a full-width step in a screenshot is the symptom.

**Put `data-fade` on the interactive element itself.** The `Hud` fade tween
writes `pointer-events: auto` inline to whatever carries it, overriding the
root's `pointer-events-none`; on a layout wrapper that claims the whole box from
the canvas. Check with `document.elementFromPoint` that the room answers where
you expect.

**`gsap.from()` under reduced motion hides UI.** It writes its start state at
once, so a skipped tween leaves the element parked there, and the CSS
reduced-motion block does not reach GSAP's inline styles. Create every `from()`
inside `gsap.matchMedia()` on `(prefers-reduced-motion: no-preference)`, as
`Panel.tsx`'s entrance does. For a `to()` that expresses a state change, keep
the tween with `duration: 0` so the state still lands.

**A looping tween is built once and paused, never rebuilt per state change.**
The spinning cover is one `paused: true` tween toggled by `play()`/`pause()`
from a separate `useEffect`. Rebuilding `gsap.to(el, {rotation: 360})` on each
change tweens from the current angle, so resuming at 350° crawls ten degrees
over a full turn's duration. `verify-player.mjs` checks the resumed angle
advances from where it stopped.

**A square exactly inscribing a circular mask is tangent, not covered**: at
every angle it touches the circle at four points, one anti-aliased pixel from
showing background. The cover carries a 1px bleed, sized with box properties
(`-inset-px` plus a `calc` size) because GSAP owns its transform and would
overwrite a `scale-*` class.

## Glass panels and contrast

**There is one `.glass`, optically clear: no blur, no tint, no fill.** The edge
does the work: a hairline border, faint inset catches, a drop shadow. Blur is
what made a panel read as frosted, however thin, and it also cost contrast by
pulling in bright pixels from around the glyphs; do not add it back to soften a
panel. A white fill adds luminance outright, and even a faint one put body text
under AA, so there is none. The supplied references are unfiltered and survive
by placing text over dark areas, which a moving camera cannot guarantee.
Background on the material: README, "The glass panels".

**Translucent panels over this room fail WCAG AA by default**, and invisibly:
the lit monitors and the hexagon light wall are off screen while a panel is
closed. A full-screen scrim passed AA but flattened the room; dimming each
panel's own backdrop (`brightness()` in `backdrop-filter`) passed too but read
as smoked. The owner chose clear glass. `--color-mute` is lifted for this
backdrop (the old `#7b88a8` was chosen against opaque near-black).

**Four panels ship under AA on purpose, as a waiver, not a red gate.**
`ACCEPTED` in `tools/verify-glass.mjs` holds each one's measured ratio, so the
gate still fails on a regression, on a panel outside the list, and on a stale
waiver whose panel now passes. Never widen a number to go green: the lever is
the camera. Reframe the hotspot over a darker part of the room, as the decks bar
is (it passes outright over the dark floor). No filter rescues a thin panel in
front of the light wall, which is why there is no dim variant of `.glass`.

**The gate measures the shipped state, not an empty one.** `verify-glass.mjs`
serves `dist/` plus a fixed `/api/pixels` fixture (`PIXEL_FIXTURE`), so the
boards are lit behind the panels as they are in production. It is a fixture on
purpose: a verdict must not depend on live data. Apply the same suspicion to any
check of content that arrives over the network.

**`PixelTooltip` is the one glass surface with a fill** (`bg-void/92`). It
floats over the activity board, the brightest and most saturated thing in the
room, where clear glass leaves body text near 1:1 over a lit cell; muted text
needs a fill of about 0.80 to reach 4.5:1 over the acid colour, so 0.92 leaves
margin for any cell. It keeps `.glass`'s edge, with a radius of its own, so it
reads as one of the panels.

**When measuring contrast on a surface, never sample its own chrome.** The gate
insets past the panel padding: the border, rim and specular sheen are bright,
within ~3px of the edge, and no glyph lands there. It also waits for the camera
flight to land. So gloss on the edge is free, and gloss across the face is
charged for.

**The panel waits 0.45s for the camera.** With the glass fading in as the flight
began, it was fully present while the room still moved behind it; the owner
preferred the view change first. Whole-room dimming flattened the room, so if
dimming ever returns it belongs in the panel's own backdrop.

## Audio

**Licensing is enforced by construction.** The only track to hand is a
commercial release, so `public/media/` and `*.mp3` are ignored by git and
Docker, the track is named at runtime by `/media/track.json`, and a missing or
invalid manifest is a supported state that the decks panel reports. For a clone
it is the normal state, so it must never be an error path. The same holds for
the purchased `.blend`, which is never committed.

**A manifest can only name files beside itself.** `parseTrack` in
`src/audio/track.ts` builds a `Track` from named fields and refuses any `src` or
`cover` with a slash, a leading dot or a scheme, so an edited manifest cannot
aim the player at another path or origin.

**The player stores intent but renders reality.** `usePlayer` has one `on` flag
(two flags let the HUD speaker and the transport disagree), persisted to
`localStorage`. Every sound control renders `playing`, derived from the
element's own events, and its click sends `setOn(!playing)`. Before the first
gesture `on` is true and nothing plays; a control rendering `on` shows a lit
speaker over silence, a visitor presses it, and `off` is stored for good.
Pressing a silent speaker always produces sound, and the press is itself the
user activation. `verify-player.mjs` guards this in a fresh browser context; a
reload keeps the tab's activation and cannot reproduce it.

**Autoplay with sound is impossible on a cold visit, and the page does not fight
it.** `Preloader.tsx` dismisses itself without a click, so there is no gesture
at load. `bindTrack` tries to play at once (a returning visitor with media
engagement is allowed) and otherwise arms listeners for the first gesture:
`pointerdown`, `keydown`, `wheel` and `touchstart`, plus `mousedown` and `click`
for WebKit before Pointer Events. Muting to force autoplay trades the feature
for silence.

**Audibility must never depend on a volume ramp.** WebKit lets volume-0 media
start and pauses it the moment a non-gesture ramp makes it audible: total
silence in Safari, fine in Chromium. `playAudible()` sets the volume before
`play()`, in the gesture's synchronous turn, with no fade-in. Fading out and the
synth's duck are unrestricted. iOS Safari ignores writes to `volume` outright.

**`play()` resolves after the click that authorised it**, which can be the click
that turned sound off. `start()` re-reads `on` inside `.then()` and bails.

## Wall boards and the Argus proxy

**Everything published is built from named fields, at every level where upstream
data can carry unknown keys.** `publish` and `fetchNames` in `src/server/api.ts`
construct the response; `validate()` is an assertion that checks and strips
nothing. `/me/usage/by-project` is the revealing one (absolute `workingDir`
paths with a username in them, `machineId`, `projectId`, `costUsd`), so names
are resolved on the server: forwarding that endpoint, or looking names up in the
browser, would publish all of it. Scalars and arrays of scalars are safe once
named; objects are not, so `breakdown` is rebuilt rather than copied. A new
upstream field therefore needs a line in `publish` before it can be published,
which is the right trade for a public endpoint. README, "Environment", has the
field table.

**Token counts are published; cost is not.** The proxy reduces upstream `usage`
to `in`/`out`/`cached` instead of spreading it, because `costUsd` sits in the
same object. The raw key names stay on the `FORBIDDEN` lists in
`src/server/api.test.ts` and `tools/verify-api.mjs`, since they can only appear
if someone spreads the whole object. `in` includes cache reads, ~85% of it, so a
single summed figure overstates the work about sevenfold. `rankByTokens` still
orders the ranking board by `in + out`, the plain meaning of "total tokens", so
it ranks context replayed far more than output; ranking by `out` alone would be
a different, equally defensible board.

**Hours won and tokens count different things.** An hour on the pixel board goes
to whichever project was busiest in it (`wonSeconds`); tokens are everything a
project spent in the window, won or lost, so a project can hold two hours and
over a billion tokens. Do not make them look reconcilable; any UI showing both
owes the reader that sentence. Both cover the same six weeks, since
`WINDOW_DAYS` is passed to `/me/usage/by-project` explicitly.

## Server

**A missing file is never answered with HTML.** The SPA fallback serves
`index.html` only to requests that accept `text/html`; everything else gets a
real 404. `GLTFLoader` and the Draco `.wasm` turn an HTML 200 into a parse error
several layers from the cause. Routing is hash-based, so the fallback only saves
a stray URL from a dead end.

**Static caching splits by whether the filename is content-hashed.** `/assets/*`
is immutable, files copied from `public/` get an hour, `index.html` gets
`no-cache`. The hour is deliberate: `serve-static` sends `Last-Modified` but
never answers `If-Modified-Since`, so revalidation re-sends all 4 MB of
`room.glb`. `/media/track.json` is `no-cache` too, because swapping the song is
not a deploy; the audio keeps the hour, which is why each song needs its own
file name.

**Closing a server is not draining it.** `server.close()` waits for keep-alive
sockets to idle out, which turns an instant shutdown into `keepAliveTimeout`
and, under traffic, into the 10s backstop and a non-zero exit that Kubernetes
records as a crash. `closeIdleConnections()` beside it drops idle sockets and
leaves in-flight ones. It is guarded with `in` rather than a cast because
`serve()` returns a union whose HTTP/2 members lack the method.

**Draining needs a delay in front of it.** The ingress learns asynchronously
that an endpoint is going, so it routes new requests to a socket that refuses
them for a moment. The chart's `shutdownDelaySeconds` is a native `preStop`
sleep that holds SIGTERM back; it and the 10s backstop both count against the
30s grace period.

## Packaging, image and chart

**The licensing guard must be repeated for every packaging mechanism.**
`.gitignore` does not reach `docker build`, which reads the working tree: on the
machine that holds the track, Vite copies `public/` into `dist/` and the
recording lands in the image, which CI's fresh checkout never reproduces.
`.dockerignore` carries the same rules, and `image.yml` plants stand-in media
before every build and fails if any `.mp3` or a `dist/media` reaches the image.
Any future packaging path needs the rules again; confirm by listing the
artefact.

**`.dockerignore` is not `.gitignore`.** It matches with Go's `filepath.Match`,
where `*` stops at a path separator, so `*.mp3` matches only the context root.
Patterns meant for any depth need `**/`.

**The chart has nodex's shape and is published from this repo**: one Deployment,
a Service, and an optional Ingress, Secret and media PVC, the same helpers,
`existingSecret` pattern, `validate` template and `helm-publish.yml` as
`kr4t0n/nodex`, so the homelab helmfile treats it like every first-party chart.
`gh-pages` carries only `helm/`; the site is never served from Pages.

**The chart refuses configurations the server would accept.** A URL without a
key, a key without a URL, or a URL without a scheme start cleanly and then 502
on every poll, which looks exactly like an Argus outage, so `homepage.validate`
fails the install. No `argus` values at all stays legal: an unlit board is
supported.

**`runAsNonRoot` cannot be enforced against a named user.** Kubelet cannot prove
`USER node` is not root, and the pod sticks in `CreateContainerConfigError`. The
chart sets `runAsUser: 1000`, `node`'s uid in `node:22-alpine`; check with `id
node` if the base image changes.

**A chart version and its image are released by two different events.**
`appVersion` equals `version` and names a semver image tag. Merging to `main`
publishes the chart and builds the `latest`, `main` and `sha-` images, but the
version-tagged image `appVersion` names is built only when `v<version>` is
pushed. Forget the tag and the chart points at an image that does not exist, and
nothing fails at publish time. Steps: README, "The Helm chart".

**`image.pullPolicy` is empty on purpose**, so Kubernetes picks `Always` for
`latest` and `IfNotPresent` for a version or sha, rather than a hardcoded
`IfNotPresent` serving whichever `latest` a node pulled first.

**The media volume is a directory mount over `dist/media`, read-only, not a
`subPath`**, so a file changed on the volume is visible at once; `subPath`
mounts are fixed at container start.

**A ReadWriteOnce media volume can deadlock a rollout.** With one replica, the
new pod may land on another node and wait on Multi-Attach while the old pod
holds the volume. The homelab release pins the pod to one node with required
affinity; anything else needs the same or `ReadWriteMany`. A loader pod must
also run on the volume's node.

**`kubectl apply --dry-run=client` is not a schema check**: it accepted a
misspelled `preStop.sleep.secondz`. Use `kubeconform -strict`, and keep a
negative control in mind for any validator.

## Tests and verification

**A check that skips is a check that passes.** Every script that talks to a port
first identifies what answers it: `reachProxy()` in `verify-api.mjs` asks
`/api/health` and separates nothing there, not us, us with upstream down, and
live; the browser scripts do the same through `tools/base.mjs`. A script aimed
at someone else's port would otherwise describe that app in this project's
terms, and a security assertion has passed against another app that way.
`VERIFY_STRICT=1` turns a section that could not run into a failure; use it
wherever the result is a gate. Assertions are deliberately outside
`try`/`catch`, so a throw crashes instead of being reported as a connection
error.

**Assert on state, not pixels, and never on chrome.** Pointer parallax moves the
camera, so screenshots taken with the pointer in different places differ almost
everywhere. Read the dev-only handles instead: `window.__orbit` (camera
offsets), `__neon` (sign brightness), `__hover` (hovered id; focusing a pill
drives it too), `__board` (pixel board cells) and `__room` (the cloned scene and
node-to-hotspot map), all behind `import.meta.env.DEV`; confirm a build strips
them with `grep -o "__orbit\|__neon\|__hover\|__board\|__room"
dist/assets/*.js`. Scripts never locate objects by scraping visible text, which
a design change can remove. Conversely, state alone can pass while nothing is
drawn: a test that proves something is *visible* needs one pixel comparison.

**Pixel comparisons need reduced motion.** Idle drift is a time-based sine, so
frames never match and the error grows with zoom. Launch with `reducedMotion:
'reduce'`, park the pointer over non-interactive geometry and blur the active
element, or the neon sign and a focus ring dominate the diff.

**The suite is Chromium-only.** Playwright's WebKit does not install here and is
not Safari anyway; autoplay, volume and codec changes need a manual pass in real
Safari. Headless Chromium's default autoplay policy is laxer than a browser's,
so `verify-player.mjs` passes
`--autoplay-policy=document-user-activation-required`. Chromium fetches media
with range requests and refuses `application/octet-stream`, so
`verify-player.mjs`'s server answers `Range`, and the harnesses' MIME maps send
`audio/mpeg`.

**Popups are rate-limited per page.** `verify-screens.mjs` opens one real popup,
then asserts on recorded `window.open` calls; a third real popup is silently
blocked and looks like a broken link.

**The scripts that serve `dist/` run their own in-process static server**,
because backgrounded processes get killed in some sandboxes. Do not make them
depend on a separately started server.

**`pre-commit run --all-files` scans nothing for secrets and says Passed.** The
gitleaks hook scans the staged diff only. The scan that covers the tree is
`gitleaks git --redact` over every commit, as the `check` job in `ci.yml` runs.
Upstream's `gitleaks-system` hook omits `pass_filenames: false`, so pre-commit
appends file names and `gitleaks git` refuses them; `.pre-commit-config.yaml`
sets it, and must keep it when bumping `rev` until upstream does.

## Conventions

- pnpm only, at the version `packageManager` pins; `pnpm-lock.yaml` is the one
  lockfile. A dependency's install script runs only if `allowBuilds` in
  `pnpm-workspace.yaml` lists it.
- A transitive dependency with an advisory is raised under `overrides` in
  `pnpm-workspace.yaml`, one selector per major line (`brace-expansion@2`), so
  no package gets a major it did not ask for. `pnpm audit` after any dependency
  change should report nothing.
- Every action in `.github/workflows/` is pinned to a full commit SHA with its
  tag in a trailing comment; Dependabot moves both. It cannot see the gitleaks
  download in `ci.yml` or `setup-uv`'s `version`: bump `GITLEAKS_VERSION` with
  `GITLEAKS_SHA256` from the release's checksums file, and the uv version, by
  hand.
- `pre-commit install` once per clone: gitleaks scans every commit before it is
  made, and CI scans the whole history again.
- Unit tests are Vitest, a `*.test.ts` beside the module it covers; `pnpm run
  test` must pass. Whatever runs in Node without a build, a server or a browser
  is tested there, the proxy included (`api.test.ts` drives the Hono app
  in-process against a loopback stub of Argus and crosses the cache TTL by
  faking `Date` alone). `tools/verify-*.mjs` keep what needs the built `dist/`,
  a live server or Chromium; a check that can run under Vitest lives only there.
  A stray `.only` fails in CI, where `allowOnly` is off.
- Nothing in `tools/` writes into the checkout. Screenshots, renders and
  measurements go to a fresh directory under the system temp dir whose path the
  script prints (`captureDir()` in `tools/captures.mjs`, `tempfile.mkdtemp` in
  the Blender scripts). Script output never gets an ignore entry; `.argus/` is
  ignored for the Argus sidecar's uploads, not for anything here.
- The Python in `tools/` is its own uv project (`pyproject.toml`, `uv.lock`,
  `.python-version`), with its environment in `tools/.venv`. Run it from the
  root with `uv run --project tools`. Never `pip install` or `uv pip install`
  into it; use `uv add` and `uv sync`.
- bpy is in the `blender` dependency group, never a default one, so `uv sync`
  and CI install Ruff alone and skip a 357 MB wheel. `requires-python` is
  `==3.11.*` because each bpy release targets one CPython minor (5.0.x is the
  last for 3.11). Moving bpy changes `requires-python`, `.python-version` and
  the lock together, and the owner re-runs the export, since only the owner has
  the `.blend` and a new Blender can export it differently. Headless bpy still
  needs X11's client libraries (`libSM.so.6`).
- Ruff lints and formats `tools/*.py` with the rules named in
  `tools/pyproject.toml`, chosen so a fix never changes what a script does,
  since the pipeline can only be run by whoever has the `.blend`. Line length
  100, as Prettier. No type checker: bpy ships no stubs. CI runs `ruff check`
  and `ruff format --check` through `uv run --locked`, which also fails on a
  stale `uv.lock`; pre-commit runs both on staged files. Both hooks are scoped
  to `tools/`, because unscoped `ruff-format` also rewrites Python examples in
  Markdown. Ruff is pinned exactly in `pyproject.toml` because the hook's `rev`
  must be the same release: bump them together.
- TypeScript strict; `tsc --noEmit` and `oxlint` must pass. Oxlint runs the
  TypeScript, React and jsx-a11y plugins over `src/`, `tools/*.mjs` and the root
  configs, and fails on warnings. A rule turned off, in `.oxlintrc.json` or on a
  line, says why beside it. Three React Compiler rules are off: two flag how
  react-three-fiber code sets fields on three.js objects, and one serves only
  the compiler, which this project does not run.
- Prettier formats everything it can parse except `.prettierignore`, and `pnpm
  run format:check` must pass. Class order is `prettier-plugin-tailwindcss`'s,
  read from the theme in `src/index.css`; do not order classes by hand. The
  chart's YAML keeps Helm's double quotes through an override in
  `prettier.config.js`.
- Tailwind v4 via `@tailwindcss/vite`, tokens in the `@theme` block of
  `src/index.css`. One accent colour (`--color-acid`), one radius scale.
- GSAP only for animation; Motion would fight it over frames in the same tree.
  Use `useGSAP` with a `scope` so cleanup is automatic.
- Icons from `@phosphor-icons/react` only.
- No em-dashes in user-visible copy.
- Every animation honours `prefers-reduced-motion`.
- Placeholder content is visibly labelled as pending, never invented.
- Comments say what the code cannot: invariants, units, and the cause of a
  workaround, in a line or two. Design rationale and history do not go in source
  files; rationale goes here, history in git.

## Technical debt

- The sofa is still 42,836 of the room's 389,978 triangles after decimation,
  second only to the pixel board (README, "The asset pipeline").
- No `<Environment>` map. The hemisphere fill approximates one, but image-based
  lighting would seat the metals and the guitar better and close the gap to the
  offline renders.
- Argus is linked, not embedded. Its host sends no `X-Frame-Options`, so a live
  iframe is possible.
- The backing track is a commercial placeholder, kept out of git and the image
  and credited through the manifest's `artist`; the intended end state is an
  original mixdown. Whatever is on the media volume is published, so keeping a
  recording off the public site is an operational choice, not a property of the
  build.
- The synth (an `AudioContext`) and the player (an `HTMLAudioElement`) have
  separate audio graphs and coordinate only through `duckTrack()`, a volume
  ramp. Recording the keys over the track, or a shared master, means routing the
  element into the context with `createMediaElementSource`.
