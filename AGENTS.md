# AGENTS.md

Context for AI agents working on this repository.

## What this is

A personal homepage whose landing page is an interactive 3D room. Clicking a
physical object in the room focuses the camera on it and opens a content panel.
The room is a purchased Blender asset, converted by a local pipeline.

## Architecture

Two halves that meet at one generated file.

```
room.blend      --[tools/export_glb.py, headless bpy]-->  public/room.glb
                                                     +-->  src/scene-manifest.json
                                                                   |
                                            src/content.ts  <------+  (node names,
                                                   |                   bounding boxes)
                              +--------------------+--------------------+
                              |                                         |
                      three/ (R3F scene)                        ui/ (DOM overlay)
```

`src/content.ts` is the contract. It maps a hotspot id to a glTF node name and a
panel kind. Both the 3D room and the 2D fallback read from it, so content cannot
drift between them.

There is a third, much smaller half: the two wall boards are the only surfaces
fed by live data, and they have a server.
```
Argus  /me/pixels            --+
       /me/usage/by-project   -+--> src/server/api.ts  -->  /api/pixels  -->  usePixels
       (X-API-Key, never                (Hono)                                    |
        leaves the server)                              +-------------------------+
                                                        |
                              three/PixelBoard.tsx  <---+---> three/RankingBoard.tsx
                              (1008 cells, hours won)   |     (5x32 LEDs, tokens)
                              ui/PixelTooltip.tsx    <---+
                              (per-cell hover readout)

The boards are the whole readout. The signals hotspot is `bare` -- focusing it
opens no panel -- so nothing in the DOM restates them.
```

One handler, mounted twice: `@hono/vite-dev-server` runs it in `npm run dev` and
`@hono/node-server` runs it beside `dist/` in the container, so dev cannot drift
from prod. `src/server/serve.ts` is that second mount and nothing more — it adds
the static tree, a cache policy and a shutdown path, which is exactly the set of
things Vite provides in dev and nothing provides in a container. Adding a route
to `api.ts` gets it in both places; adding one to `serve.ts` gets it only in
production, which is almost never what is wanted. It exists for exactly one reason — `ARGUS_KEY` must never reach the
browser — and everything else in it (9s cache, single-flight, strict validation,
field reduction, a failure log that stays server-side) serves that hop being
cheap and honest.
`src/shared/pixels.ts` is imported by both sides and holds the payload type, the
validator and the grid maths; `src/pixels/ranking.ts` holds the board ordering,
kept pure so `verify-api` can assert on it without a GPU.

## Key design decisions

**The asset is bad and the pipeline compensates rather than the runtime.** The
purchased scene has no usable textures, no object naming, and pathological
geometry. Everything that can be fixed once at export time is fixed there, so
the React code never contains asset workarounds. If something looks wrong in the
room, check `tools/export_glb.py` before touching `src/three/`.

**Flat shading is a decision, not a fallback.** Every texture path in the source
points at the seller's machine and is unrecoverable. Rather than sourcing
replacements, the export drops texture nodes and keeps each material's flat
colour. Combined with ACES tone mapping at low exposure and a dim rig, this
reads as a deliberate stylised night scene. Do not "fix" it by raising the key:
the flat base colours blow out to pale grey immediately, which is exactly what
the first implementation got wrong. Add fill instead, and see the note on
global illumination below.

**three.js has no global illumination, so this asset needs explicit fill.** The
offline renders look right partly because Cycles bounces light off the large
pale floor. three.js gives you only the lights you place, so with a single key
plus a flat ambient, everything not facing that key crushes to black. A
light-grey object like the DJ controller rendered as a black slab with a few
glowing dots. `src/three/lighting.ts` carries a hemisphere term standing in for
sky-and-floor plus a weak opposite-side bounce. When something in the room
looks wrong, compare against an offline render of the same GLB before changing
the model: `tools/diagnose_keys.py` renders source, export and export-with-flat-
material side by side, and `tools/diagnose_lighting.py` renders the GLB under
both a neutral rig and a copy of the site's.

**One owner for the camera.** `CameraDirector` holds a single authored pose that
GSAP tweens on focus change. Idle drift, pointer parallax, and the user's own
orbit and zoom are applied per frame as bounded offsets on top of that pose.
Nothing else writes `camera.position`. An earlier version had drift accumulating
into the position and the camera slowly flew away.

**The camera is spherical, not Cartesian.** Drag and zoom manipulate the same
`theta`/`phi`/`radius` that GSAP tweens for hotspot flights, so manual control
and scripted moves compose instead of fighting. Bolting an `OrbitControls` on
top of a position lerp would have had both writing `camera.position` every frame.

**The user's home view is stashed, not discarded.** Focusing a hotspot eases the
user's orbit to zero so the panel gets its authored framing, but `homeView`
records their offsets first and the return flight restores them. Closing a panel
must not silently throw away the view someone set up.

**A 3D object is not a keyboard target.** The monitors are raycast hit tests with
no `tabIndex`, no `<button>` and no `onKeyDown`, so nothing about them is
reachable without a pointer. That is why the Work panel existed at all — it was
`navOnly` and carried the only tabbable route to the Argus and nodex links. When
it was removed as redundant with the monitors, those links moved into About
rather than disappearing, and `verify-screens.mjs` now asserts they are present
there. Any future content that lives only on a 3D object needs the same
treatment.

**The room is unlabelled on purpose, and the hotspot index is for the keyboard
only.** There is no hero copy, no visible row of hotspot pills and no "drag to
look around" hint. Every object that opens something is meant to be found by
exploring, and a labelled index in the corner gave the whole room away before
anyone had looked at it. The only discovery cue left is the pointer cursor;
the green hover wash went too, for the same reason (see "There is no hover
highlight" below).

The index was not deleted, because it is the only keyboard route into the room.
Without it no hotspot can be focused, the Argus and nodex anchors inside About
become pointer-only, and so does GitHub, whose only keyboard route is the
index's own link entry (see `ROOM_LINKS` below). So the `<nav>` in `Hud.tsx` is `sr-only`
until a pill takes focus (`focus-within:not-sr-only`), then shows in place, so
a keyboard visitor sees what they are tabbing through (WCAG 2.4.7). A pointer
never focuses it, so a mouse visitor never sees it. It stays mounted and fades
while a panel is open rather than unmounting, because the pressed pill has to
keep focus underneath the panel for the next Tab to move into the panel instead
of restarting from the top of the page. `verify-keyboard.mjs` asserts both
halves: hidden at rest, visible once focused.

Two consequences for anyone changing it. Tests cannot hover or click a pill,
because a clipped element takes no pointer events; they `focus()` it or `press`
Enter on it, which is the real route anyway. And do not hide it with `opacity-0`
instead: an invisible pill that still takes pointer events is a dead zone over
the room, and one that is invisible *while focused* fails focus visibility.

**glTF has no text, and the exporter's silence about it is the danger.** A
`FONT` object is neither converted nor warned about — it simply does not appear
in the GLB. The pixel board's hour, weekday and week labels are all text, so the
export pass that converts curves to mesh now converts fonts too, and `FONT` is
included in `props` so those objects get a region before conversion. If a label
ever goes missing from the room, check this first.

**Region order in `export_glb.py` is load-bearing.** An object joins the *first*
region whose box contains its centre. The pixel board sits inside the boxes of
`wallart` and `shelves` as well as its own, so `pixelboard` has to be listed
before both; otherwise the board splits three ways — rows above y=-1.00 into
wallart, rows below into shelves, the bottom strip into static — and a hotspot
cannot be three meshes.

**Hotspot geometry is grouped, not per-object.** The exporter joins objects into
one mesh per semantic group so raycasting touches ~13 meshes instead of 193.

**Audio is licensing-aware by construction, not by discipline.** The room needs a
soundtrack and the only track to hand is a commercial release, so the design
makes shipping it impossible by default rather than relying on someone
remembering not to: `*.mp3` is gitignored, `TRACK.src` is fetched at runtime, and
a 404 is a first-class state that the decks panel reports honestly. The same
reasoning already applied to the purchased `.blend`. A missing track must never
be an error path, because for anyone cloning this repo it is the normal one.

**The player stores intent but renders reality.** `usePlayer` carries a single
`on` flag rather than separate mute and paused flags, because with two the HUD
speaker and the panel transport could disagree about one track — pausing at the
decks left the speaker still claiming sound was on. But `on` is *storage only*:
every control renders `playing`, which is derived from the element's own events.
The two diverge in exactly the window that matters, between page load and the
first gesture, when intent is yes and the browser's answer is still no. A
control that rendered intent there showed a lit "sound is on" speaker over
silence; see the trap in Non-obvious behaviours.

**The licensing guard has to be repeated per packaging mechanism, because
nothing carries it across.** `*.mp3` and `public/cover.webp` are gitignored so
the commercial track cannot be committed. That says nothing about `docker
build`, which reads the working tree rather than the index: on the machine that
owns those files, Vite copies `public/` into `dist/` verbatim and the recording
ends up in the image. CI never reproduces it, because a fresh checkout has no
track in it, so the only build that ships the file is a local one — the exact
case least likely to be checked. `.dockerignore` now carries the same two rules.
Any future packaging path needs them again, and the way to confirm is to list
the artefact rather than to reason about it.

**`.dockerignore` is not `.gitignore`.** It matches with Go's `filepath.Match`,
where `*` does not cross a path separator. `*.mp3` therefore matches only the
context root, and `public/track.mp3` sails straight through. Patterns that need
to match at any depth have to say `**/`. This was got wrong here first and only
showed up by listing the built image.

**Closing an HTTP server is not the same as draining it.** `server.close()`
stops new connections and then waits for every existing socket to go idle by
itself, which for a keep-alive connection means waiting out `keepAliveTimeout`.
Measured here, that turned a shutdown that should be instant into a five second
one, and under real traffic it walks into the 10s backstop and exits non-zero,
so Kubernetes records a routine rolling deploy as a crash.
`server.closeIdleConnections()` alongside it drops the sockets merely being held
open and leaves the ones mid-request: 5000ms to 5ms. It is guarded with an `in`
check rather than a cast because `serve()` is typed as the union of every server
it can build and the HTTP/2 members do not declare the method.

**A missing file must not be answered with HTML.** The SPA fallback serves
`index.html` only to requests that accept `text/html`; everything else gets a
genuine 404. The room is loaded by `GLTFLoader` and the Draco decoder is
instantiated from a `.wasm`, and both fail with a parse error several layers
from the cause when handed an HTML body with a 200 on it. Routing is hash-based
anyway, so the fallback exists only so a stray URL is not a dead end, not to
serve real routes.

**Static caching is split by whether the filename is content-hashed, not by file
type.** `/assets/*` is hashed by Vite and immutable; anything copied from
`public/` keeps its name across builds and so gets an hour; `index.html` gets
`no-cache` because it carries the hashed URLs and a stale copy points at assets a
redeploy has deleted. The hour is deliberate rather than a revalidation:
`serve-static` sends `Last-Modified` but never answers `If-Modified-Since`, so a
revalidating client is served all 4 MB of `room.glb` again instead of a 304,
which makes "always check" the expensive option here rather than the cheap one.

**The chart follows nodex's shape, and it is published from this repo.**
`helm/homepage` is one Deployment, a Service, an optional Ingress and an
optional Secret, with the same helpers, `existingSecret` pattern, `validate`
template and `helm-publish.yml` as `kr4t0n/nodex`, so the homelab helmfile
treats it like every other first-party chart. `gh-pages` therefore exists again,
but it carries only `helm/`; the site is never served from Pages.

**The chart refuses configurations the server would accept.** A URL with no key,
a key with no URL, or a URL with no scheme all start cleanly and then answer
502 on every poll, which reads exactly like an Argus outage. `homepage.validate`
fails the install instead. Running with no `argus` values at all stays legal,
because an unlit board is a supported state.

**Draining needs a delay in front of it, not just behind it.** `serve.ts`
stops accepting the moment SIGTERM lands, but the ingress controller learns
that the endpoint is going away asynchronously, so for a moment it still routes
new requests to a socket that refuses them. `shutdownDelaySeconds` is a native
`preStop` sleep that holds SIGTERM back until routing has moved. It and the
server's 10s backstop both count against the 30s grace period.

## Non-obvious behaviours

**Autoplay with sound is impossible on a cold visit and the page does not fight
it.** Chrome and Safari need a user activation, and `Preloader.tsx` dismisses
itself rather than gating on a click, so there is no gesture at load. `bindTrack`
attempts playback immediately — a returning visitor with media engagement is
allowed it — and otherwise leaves listeners armed on `pointerdown`, `keydown`,
`wheel` and `touchstart`. Anyone "fixing" this by muting the element to force
autoplay is trading the feature for silence.

**A sound control that renders intent instead of real state is a trap, not a
cosmetic bug.** Before the first gesture, `on` is true and nothing is playing. A
speaker button bound to `on` therefore lights up as "sound is on" over total
silence. The honest reading of that is "this control is lying", the natural
response is to press it, and pressing it wrote `off` to `localStorage` — so the
room went permanently silent and no amount of clicking around brought it back,
across reloads. Both the HUD speaker and the panel transport now bind to
`playing` and their click sends `setOn(!playing)`, which means pressing a silent
speaker always produces sound. The press is itself a user activation, so it
works on the very first press of a cold visit. `verify-player.mjs` guards this
with a fresh browser context; a reload will not reproduce it, because navigating
the same tab keeps its user activation and the track just keeps playing.

**Never hand-write a `-webkit-` prefix in this project.** Lightning CSS, which
Tailwind v4 runs, autoprefixes from the build targets *and* treats
`-webkit-backdrop-filter` as an alias of the standard property. Writing both
collapses them to whichever came last, so putting the prefix second shipped a
rule with only `-webkit-backdrop-filter` — which current Chromium does not
recognise. Every other glass property applied, the computed value read `none`,
and the panels rendered translucent but completely unblurred. Nothing warns you.
Write the standard property alone and let the build add prefixes.

**A gradient scrim has to be anchored to the viewport, not to whatever it sits
inside.** These gradients reach full opacity at their own bottom edge, so that
edge is a hard line wherever it lands. The `noPanel` scrim was nested inside the
"Back to the room" button's container, which is `bottom-10` -- so its `bottom-0`
meant the button's bottom, 40px up from the screen. The bottom 40px of the room
stayed undimmed beneath an opaque band, and the seam ran the full width of the
frame in both focused modes, reading as a grey border with the room showing
brighter below it. Measured at rgb(7,10,18) on y=859 against rgb(11,14,25) on
y=860.

It is invisible in the obvious place to look: with the panel closed the block
does not render at all, and the hero scrim that used to sit beside it was fine
because its own container was already at `bottom-0`. So the same class name was
correct in one place and wrong in the other, and only a focused screenshot
showed it. If you
move a scrim, check its measured `getBoundingClientRect().bottom` equals
`innerHeight`; a full-width horizontal step in a screenshot is the symptom.

**A GSAP `pointerEvents` write on a layout wrapper claims its whole box.** The
`Hud` fade tween writes `pointer-events: auto` inline to whatever carries
`data-fade`, which overrides the root's `pointer-events-none`. It used to sit on
the hero's full-width wrapper, so the entire bottom band of the viewport never
reached the canvas: at 1440x900, all 2,160 points probed in the bottom 300px hit
that wrapper, and 0 do now. Nothing looked wrong. Objects in that band simply
could not be hovered or clicked, and a pill was the only way in. Put
`data-fade` on the element that is itself interactive, and check with
`document.elementFromPoint` that the room is what answers where you expect.

**Component base styles belong in `@layer components`, not `@layer utilities`.**
`.glass` sets `position: relative` for its specular pseudo-element. As a utility
it landed in the same layer as Tailwind's own `fixed`, and since this file is
emitted later it won. The panel silently detached from `bottom-6` and rendered at
the top of the viewport. In `components`, utilities on the element always win,
which is the correct precedence for a base style anyway.

**A hotspot can decline to have a panel.** `bare` on a `Hotspot` focuses the
camera and opens nothing; `Hud` renders "Back to the room" as the only chrome,
the same treatment framed monitors already had. Signals uses it because the two
wall boards carry their whole readout and the panel was restating it in words
while covering the bottom of both boards to do so. Two consequences worth
knowing: the framing must then be retuned to fill the frame rather than the top
half of it (`look` went to 0 and the standoff from 4.4 back to 3.1), and the
panel's contrast waiver disappears — `signals` is gone from `verify-glass`,
which is the honest outcome rather than a suppressed one. It also means that
data has no DOM representation at all, so a screen reader gets nothing; see the
known gap in README before adding another `bare` hotspot that carries content.

**A hotspot can own several meshes, and everything must agree on which.**
`nodes` on a `Hotspot` lists extra glTF nodes beyond `node`; picking and
camera framing both read `hotspotNodes(h)` rather than `h.node`. Signals is both
wall boards. Reading `node` directly in either place gives a hotspot that picks
from only half of itself, or picks but frames only half of itself — both of
which look like deliberate design rather than bugs. Framing
takes the union of the boxes, so the shot follows the asset.

**`look` is a world-space offset, not an angle, so it does not survive a change
of standoff.** Widening Signals from 3.2 to 4.4 to fit both boards left the old
-0.3 pushing the subject up by proportionally less, and the panel covered the
pixel board's week labels. Rescale `look` whenever `offset` changes.

**Never assert on pixels to test hover.** Pointer parallax moves the camera, so
two screenshots taken with the pointer in different places differ almost
everywhere: a first attempt at testing the old hover wash reported 158,000
changed pixels for a hotspot that was not washed at all. Read `__hover()`
instead; focusing a nav pill drives the same hover state as pointing at the
object, so both routes can be checked as state.

The converse also bit this repo: state alone can pass while nothing on screen
changes. `__wash()` reported the intended node names correctly for three weeks
in which the wash painted nothing under `npm run dev`. If a test exists to
prove something is *visible*, it needs one pixel comparison taken under
`reducedMotion: 'reduce'`, where the camera ignores the pointer.

**A hotspot's camera is placed relative to its bounding box, so growing the
group re-frames the panel.** `content.ts` stores `offset` and `look` as deltas
from the node's manifest centre, which means anything that changes a group's
extent moves the camera without anyone editing a camera value. In room-v3 the
shelf rail gained a fourth lamp, `hot_shelves` grew, the Writing view shifted,
and the newly-moved pixel board landed behind that panel: contrast fell from
1.64:1 to 1.11:1 with no CSS change anywhere. The glass gate caught it. Fixing
it meant retuning `writing`'s offset, which is the remedy AGENTS already
prescribes — reframe the camera, do not widen the waiver. `verify-glass.mjs`
takes a panel name as an argument for exactly this loop.

**Region boxes are hand-authored AABBs and a Blender nudge relocates objects
silently.** Objects land in the first region containing their centre, so a
board that slides out of its box joins a neighbour and exports as a valid
hotspot full of the wrong things. Both board boxes shifted -0.382 for room-v3.
The export asserts every `Pixel*` and `Ranking*` object landed in its own
region; extend that check when adding a systematically-named group.

**The .blend's lights never reach the site.** `export_lights=False`, and
`src/three/lighting.ts` is a hand-tuned rig that deliberately does not mirror
the Cycles setup. Lamp *housings* are geometry and do sync, so a version bump
can add a visible lamp that casts nothing. Do not read "the lights changed in
Blender" as something the pipeline can carry.

**The outliner's selection lock silently deletes geometry at export, and every
signal it gives you says success.** `select_set(True)` on a `hide_select`
object does not raise and does not warn — `select_get()` just keeps returning
False. `bpy.ops.object.join()` then finds only its active object, returns
`{'CANCELLED'}` rather than raising, and the group becomes whichever single
mesh happened to be first. The ranking board arrived with 193 of its 205
objects locked and exported as a 92-triangle enclosure; the other 15,828
triangles shipped as loose top-level nodes, so the board *rendered correctly*
and was simply not part of its own hotspot. The pixel board had been losing its
74 labels the same way for as long as it had existed. `export_glb.py` clears
the lock in step 1a and compares triangle counts across the join, refusing to
export when they disagree. Never trust a join operator's return value here.

**Linked duplicates share mesh data, so assigning a material writes through
every copy.** All 160 ranking LEDs are duplicates of one datablock with 160
users. `o.data.materials[0] = mat` in a loop over them finishes with all 160
wearing whichever material the last iteration reached, which exports fine and
looks plausible in a still. `o.data = o.data.copy()` first.

**Anchors for runtime text are exported, not transcribed.** `export_glb.py`
deletes the ranking board's baked placeholder labels and writes their
world-space boxes to `src/ranking-anchors.json`, which `RankingBoard.tsx` reads
to place its canvas. Hardcoding those millimetres would be correct once and
then rot the first time a row moved — with the failure being a board that still
renders, still looks designed, and labels the wrong rows. If you add a live
readout to a modelled surface, measure it at export.

**Board text is a canvas texture rather than drei `<Text>`, for a font
reason.** troika only converts WOFF1 and this project ships Geist Mono as WOFF2
only, so `<Text>` would need a committed duplicate font binary or a runtime CDN
fetch of Roboto. The canvas draws with the webfont the page already loaded. It
must wait on `document.fonts.ready`; drawing early falls back to the default
monospace silently and the board ends up in a different face from the room.

**Four panels ship under WCAG AA on purpose, and the gate encodes that as a
waiver rather than going permanently red.** Clear glass in front of the lit
monitors leaves 14px muted text at 1.03:1 to 2.89:1. Dimming each panel's own
backdrop with `brightness(0.16)` cleared AA everywhere at a tightest 5.17:1, but
read as smoked rather than clear; the owner compared both in a real browser and
chose the clear render. `ACCEPTED` in `tools/verify-glass.mjs` holds the measured
ratio per panel, so the gate still fails on a regression, on any panel outside the
list, and on a stale waiver whose panel now passes. Do not silently widen those
numbers to make a run go green — the fix is to reframe the camera over a darker
part of the room, which is why the decks bar passes outright at 5.55:1.

**A check that skips is a check that passes, and this repo has now been bitten
by it twice.** `verify-api` fetched `/api/pixels` inside a `try`/`catch` and
reported every failure as `skip live proxy checks — dev server not reachable`,
then exited 0. With no dev server that silently dropped the six disclosure
assertions the file exists for: the ones proving `workingDir`, `machineId` and
`costUsd` never cross the wire. In CI, where nothing is on that port, they would
have been green on every run without ever executing.

The message was also capable of being false, and was. With an unrelated app on
port 5173 the fetch *succeeded*, the body parsed, `the proxy discloses no path,
machine or cost fields` was evaluated against that app's response and **passed**,
and the run only stopped when `json.projects` came back undefined — which the
catch then reported as the server being unreachable. A security assertion
passing against a different application is worse than one that does not run.

The fix has two halves and both matter. `reachProxy()` identifies what is on the
port via `/api/health` before asserting anything, separating "nothing there",
"not us", "us but upstream is down" and "live" into distinct reported outcomes.
And `VERIFY_STRICT=1` turns a section that could not run into a failure, so a
gate cannot pass by not executing. The assertions themselves are deliberately
no longer inside a `try`/`catch`: if one throws, that is a real defect and it
should crash rather than be laundered into a connection error.

Apply the same suspicion to every other script here. Any of them pointed at a
port something else happens to own will describe what it found in terms of this
project, because that is the only thing it knows how to describe.

**A contrast gate that serves only `dist/` measures the panels' empty states,
not the ones that ship.** `verify-glass.mjs` had no `/api/pixels` route, so the
Signals panel rendered its "board is unlit" fallback on every run: four short
lines of text in front of an unlit board. The gate called it 2.06:1 and green
for months. It ships a twelve-row legend in front of 1008 emissive cells, and
measures 1.02:1. Nothing regressed — the test had never seen the feature.
`PIXEL_FIXTURE` in that file now stands in for the proxy, deliberately as a
fixture and not a live call: a contrast verdict that depends on how busy someone
was last week is not a gate. Apply the same suspicion to any panel whose content
arrives over the network — if the test has no data source, check what it is
actually rendering before trusting the number.

**`wonSeconds` and `tokens` on a project count different things, and the legend
shows both side by side.** An hour on the board goes to whichever project was
busiest in it, so `wonSeconds` is hours *won*; the token counts are every token
that project spent in the window, won or lost. `researchers` has two hours and
over a billion tokens. The two are not reconcilable and should not be made to
look it — the panel spends a sentence saying so, and that sentence is load
bearing. Both do at least cover the same six weeks: `WINDOW_DAYS` is passed
explicitly to `/me/usage/by-project` rather than relying on its default
happening to be 42.

**Everything crossing to the public is built from named fields, and the two
halves of this proxy did not always agree on that.** `fetchNames` constructs its
output field by field, which is the only reason `costUsd` -- sitting in the same
upstream object as the token counts it does publish -- has never been able to
leak. The pixel payload was `JSON.stringify` of whatever Argus returned, so
anything added to `/me/pixels` upstream would have been published silently, with
no change here and nothing to notice it. `validate()` did not help: it is
`asserts p is PixelPayload`, so it checks and throws, and strips nothing.

`publish` closes that. Two invented fields planted in a stubbed upstream used to
arrive intact in the response and now do not, which is the assertion that drove
the change.

The rule when extending it: explicit at every level where upstream data can
carry unknown keys. Scalars and arrays of scalars are safe once named, because
there is nothing to hide in. Objects are not -- `breakdown` is rebuilt rather
than copied for exactly that reason, since naming a key whose contents you have
not examined moves the problem one level down while feeling like a fix. The cost
is that a genuinely new upstream field needs a line adding here before it can be
used, which is the correct trade for a public endpoint.

**Token counts are published; cost is not, and the rename is the guard.** The
proxy reduces upstream `usage` to `in`/`out`/`cached` rather than spreading it,
because `costUsd` sits in the same object and runs to five figures. The raw key
names stay on the `FORBIDDEN` list in `verify-api.mjs` even now that tokens are
a shipped feature: they can only appear in a response that spread the whole
object, which is exactly the mistake worth failing on. Note also that `in`
includes cache reads and they are ~85% of it, so any single summed "tokens"
figure overstates the work by roughly seven times.

**Translucent panels over this room fail WCAG AA by default, and the failure is
invisible from a screenshot of the closed page.** In front of the hexagon light
wall the backdrop behind a content panel reaches rgb(114,132,92), where body text
measured 2.22:1 and muted text 1.15:1. Two remedies were tried before the current
design. A 0.78 full-screen scrim passed AA and looked wrong, because the room
went flat and the panels stopped reading as panes over anything. Dimming inside
each panel's own `backdrop-filter` via `brightness()` passed at better measured
contrast while keeping the room lit, and was then dropped as well, by choice, for
the crystal-clear render; see the waiver paragraph above. What survived is
`--color-mute` lifted off `#7b88a8`, a value chosen against opaque near-black,
and `tools/verify-glass.mjs` as the gate, which exists because none of this can
be eyeballed.

**When measuring contrast on a surface, never sample its own chrome.** Two
separate false failures came from this. First a naive "brightest patch" scan
picked the acid-green *button* inside the panel. Then, after fixing that, the scan
started at the panel boundary and found the border, inset rim and specular sheen —
all bright, all within ~3px of the edge, and none of them a place a glyph can
land. That one only appeared once the fill got thin enough for the rim to become
the brightest thing in frame, so it looked exactly like a real regression and sent
the tuning in the wrong direction for two rounds. The gate now insets past the
padding. Corollary: gloss on the *edge* is free, because the gate correctly
ignores it; gloss across the *face* is charged for.

**No filter rescues a thin panel in front of the light wall; the camera does.**
At 0.34 brightness with a 90px blur the backdrop behind a content panel was still
rgb(73,84,63), where muted text would have had to be *lighter than body text* to
reach AA. That measurement is why there is exactly one `.glass` and no dim
variant: a `.glass-dim` modifier existed for a while and could not close the gap
on the worst surfaces, so the lever is where each hotspot's camera puts its
panel. The decks bar passes outright because it is anchored over the dark floor,
and `writing` was retuned over the sofa for the same reason when room-v3 moved
its framing.

**Blur is what stopped it reading as glass, not opacity.** Several rounds went
into making a frosted panel thinner, which never worked, because a thin frosted
pane is still frosted. Measuring the supplied references settled it: both are
unfiltered, their backdrops pin-sharp through the glass. Removing the blur also
*improved* contrast — it pulls bright pixels in from neighbouring areas — so the
frosting was costing legibility and transparency at once. Do not reintroduce a
blur to "soften" a panel; if a panel needs help, move its camera, which keeps
shapes sharp and keeps every panel in the same family.

**Neither reference meets AA, and that is why they look the way they do.** The
first puts white text at 1.43:1 where a bright object shows through; the second
carries no text at all, only glyphs. Both survive on composition — text placed
over dark areas — which is not available here because the camera moves and the
light wall can end up behind anything.

**There is no scrim behind a panel, but the panel still waits 0.45s for the
camera.** A full-screen dimming layer used to lead each panel by that much so the
glass arrived on a darkened backdrop. It went to zero opacity when the panels
became clear glass and was then deleted. The delay outlived it on purpose: with
the panel fading in the instant the flight began, the glass was fully present
while the room was still moving behind it, and the owner compared both and
preferred the view change first, then the panel. Whole-room dimming was tried
first and made the room go flat, so if dimming ever comes back it belongs in the
panel's own backdrop, not over the scene.

**A looping tween must be built once and paused, never rebuilt per state change.**
The spinning cover is one `paused: true` tween that `play()`/`pause()` toggle. The
tempting shape — recreate `gsap.to(el, {rotation: 360})` whenever `playing`
changes — is subtly broken: it tweens from the *current* angle to 360, so
resuming at 350° crawls the last ten degrees over the full duration, while
resuming near 0° looks correct by luck. Constructing it in `useGSAP` and toggling
it from a separate `useEffect` is deliberate: same-effect toggling would put
`playing` in the dependency array and rebuild the tween. `verify-player.mjs`
distinguishes the two by pausing mid-turn and checking the resumed angle advances
*from* where it stopped rather than from zero.

**A square exactly inscribing a circular mask is tangent, not safely covered.**
Rotation preserves a square's perpendicular distance to its own edges, so a
square sized to its container is tangent to the container's inscribed circle at
four points at every angle — covered in theory, one anti-aliased pixel from
flashing background four times per revolution. The cover image carries a 1px
bleed for this. It is sized with box properties (`-inset-px` plus a `calc` size)
rather than a scale transform, because GSAP owns that element's transform and
would overwrite a Tailwind `scale-*` class.

**Never let audibility depend on a volume ramp: WebKit pauses media that becomes
audible without a gesture.** This is the one bug in this feature that Chromium
cannot catch, and it was shipped and reported from Safari. The first version set
`volume = 0`, called `play()` inside the gesture, and ramped up over 1.6s from a
GSAP tick. Chromium played it. WebKit classifies volume-0 media as silent, allows
it to start, then stops it the instant the ramp makes it audible — because a rAF
callback is not a user gesture. The symptom is total silence in Safari with no
error, while Chromium is perfectly fine, which sends you looking at the wrong
layer entirely. `playAudible()` therefore sets the volume *before* `play()`, in
the same synchronous turn as the gesture, and there is no fade-in. Ramping down
is unrestricted, so the fade-out and the synth duck are fine. iOS Safari
additionally ignores writes to `volume` outright, which is a second reason never
to make audibility contingent on a tween completing.

**Do not assume the verification suite covers Safari.** It is Chromium-only:
Playwright's WebKit will not install on the dev box here (missing ~24 system
libraries), and Playwright WebKit is not Safari anyway — its autoplay policy
differs, so a green run there would not have meant much. Anything touching
autoplay, volume or codecs needs a manual pass in real Safari before it is
believed.

**`play()` resolves after the click that authorised it.** If the authorising
gesture *is* the click that turns sound off, the promise still resolves and would
start a track the visitor just declined. `start()` re-reads `on` inside `.then()`
and bails. Since the controls read "turn on" whenever the room is silent, this is
now hard to reach from the UI, but the ordering hazard is real and the guard is
one branch. Note it is no longer a *silent* abort: volume is set before `play()`
now, so a reachable path here would be a brief blip rather than nothing.

**Chromium serves media over range requests.** A test server that answers `200`
to every request stalls the element forever, and one that sends
`application/octet-stream` makes Chromium refuse to decode. Both cost real
debugging time; `tools/verify-player.mjs` handles `Range` and sets `audio/mpeg`,
and the harness MIME maps now cover `.mp3` and `.jpg`.

**Headless Chromium's default autoplay policy is more permissive than a real
browser's.** `verify-player.mjs` passes
`--autoplay-policy=document-user-activation-required` on purpose: under the
default, the "silent until the visitor interacts" assertion passes even when the
gesture arming is broken, which makes the suite worse than no suite.

**Camera framing is FOV-sensitive and the FOV is narrow.** `Scene.tsx` uses 34°,
so visible half-width is only ~0.49x the standoff distance. The DJ controller is
2.53 units wide and the first offset put it half out of frame. Also: offsetting
the camera sideways while still aiming at the node's centre swings the far end of
a wide object out of frame, so keep the x offset near zero for wide props.

**Aiming at a node's bounding-box centre does not centre it on screen.** The DJ
controller renders ~320px left of frame centre at 1440x900 with `look.x = 0`,
which is why the `player` hotspot carries `look.x = -0.55`. Pointer parallax is
*not* the explanation — it is eased to zero once a hotspot is focused, and the
framing is byte-identical with the pointer parked anywhere, which is worth
knowing before chasing it. Suspect the bbox centre not matching the visual mass,
since these nodes are joined groups that include stands and legs. Either way,
framing offsets are empirical here: change one, screenshot it, look at it.

**The Draco decoder is served from `public/draco/`, and drei would rather fetch
it from Google.** `useGLTF` defaults to `www.gstatic.com` for the decoder, and
`room.glb` cannot be shown without it, so that is a third-party request nothing
in the page declares and the room simply never appears where that host is
blocked. `Room.tsx` sets the decoder path once at module level, before the
preload at the bottom of the file runs; drei keeps one loader for the whole app,
so this covers every `useGLTF` call. `npm run draco` copies the wrapper and wasm
out of three's examples, and `tools/verify-draco.mjs` fails the moment any
request leaves the origin.

**glTF nodes with multiple primitives load as a Group, not a Mesh.** Children get
suffixed names (`hot_desk_0`, `hot_desk_1`, ...). Matching `mesh.name === node`
silently never fires. Use `getObjectByName(node)` then traverse its subtree.
This once made the hover highlight invisible while raycasting still worked,
because raycasting walks up the parent chain.

**`Object3D.clone()` shares material instances, including with drei's cache.**
The source asset reuses one material across unrelated props, so mutating one in
place changes objects on the other side of the room. It also writes into the
cached GLTF, which outlives the component. `verify-hotspots.mjs` tints
through material copies for that reason.

**The scene-clone memo in `Room.tsx` must be pure, because development runs it
twice.** `<StrictMode>` calls a `useMemo` function twice and keeps the first
result. From the first commit, that memo copied only hotspot materials and
then darkened the walls and lifted roughness *in place*, so both runs edited
the same cached materials. Development rendered every non-hotspot surface with
the adjustment applied twice. The floor measured rgb(19,25,37) in dev against
rgb(52,63,88) in production at the home view, and a hot reload of `Room.tsx`
compounded it again. Production was never affected. `lighting.ts` says to tune
in dev, so anything judged by eye there before this fix was judged against a
darker room than visitors saw. The hover wash died of the same cause (see
"There is no hover highlight").

Every material in the clone is now a copy, so no run can write into the cache.
Two properties of *how* they are copied keep production pixel-identical, and
both are load-bearing:

- **Sharing survives the copy.** The roughness lift runs once per mesh, so a
  material shared by k meshes has always been lifted k times. Hotspot meshes
  get one copy per mesh, as before, which also gives the wall boards their own
  materials to write live emissive into. Everything else gets one copy per
  material, shared by exactly the meshes that shared the original.
- **Material ids keep their relative order.** `WebGLRenderLists` sorts opaque
  draws by `material.id`, and where two surfaces are exactly coplanar the
  later draw wins the pixel. Copying in traversal order renumbered the room
  and flipped one pixel on the desk. The shared copies are therefore made
  first, in the originals' own id order, then the hotspot copies, in their old
  order. `id` is set at runtime and is absent from `@types/three`, hence the
  accessor.

Measured against the build before the fix: 0 of 1,024,000 pixels differ at the
home view and at the focused desk view, and dev now matches production
everywhere outside the live wall boards.

**`bpy.ops.object.join()` silently discards every non-active object's
modifiers.** In this asset that deletes real geometry, because several props are
defined by their modifier stack rather than their base mesh: the synth's white
keybed is a single key with an ARRAY of 22, so joining left exactly one key
behind, at the far left. Three more objects use MIRROR and six use SOLIDIFY,
all of which change what geometry exists. `export_glb.py` bakes modifiers
before joining for this reason. Subsurf is dropped instead of baked, since it
only smooths and everything is decimated afterwards anyway.

**`export_apply=True` applies modifiers at export, after any counting you do.**
This made the exporter's own triangle report wrong by 6.5x: it announced
159,662 while shipping 1,033,356, because surviving subsurf stacks were
inflated during export and never counted. Bake and count in the same pass, and
sanity-check the shipped total by reading the accessors out of the GLB rather
than trusting the log.

**Blender's `convert(target='MESH')` acts on the whole selection.** Iterating
objects and converting one at a time will convert everything on the first call,
leaving later iterations holding already-converted objects. Set curve resolution
on all curves before converting any of them.

**Never overwrite an authored `emissiveIntensity`.** Every glowing material in
this asset ships a `KHR_materials_emissive_strength` between 1 and 10, and
three.js applies it on load. Code here once forced a single value on anything
with a non-zero emissive factor, which crushed the DJ controller's LEDs
(authored 5 and 10) while boosting its dim indicators (authored 1), so the whole
object read as broken. If emissive needs adjusting, scale the authored value,
do not replace it.

**Region tagging is approximate and must be verified visually, and the region
NAME is not evidence.** A world-space AABB catches whatever is inside it, and
several boxes here were named from a guess about position that turned out
wrong. `midikeys` enclosed the DJ controller and `guitar` enclosed the synth,
so the Music hotspot sat on the wrong instrument for a while and the real
keyboard was never addressable. They are now named for what they actually
contain. `node tools/verify-hotspots.mjs` tints each hotspot's meshes in turn
and captures them; run it after any region change, and rename a region the moment its
name stops matching its contents.

**The monitor panels' polygon normals point the wrong way.** Blender reports
these faces as normal-into-the-back-wall, away from the chair. Using that
verbatim to place an overlay plane buries it inside the monitor and backface
culls it, so the screen just stays blank with no error anywhere. Negate them: a
screen faces the room, which is +z in glTF here. `tools/find_screens.py` prints
what Blender says; `SCREENS` in `src/content.ts` stores the negated value.

**The monitors are overlays, not the glTF mesh.** All three panels are merged
into `hot_screens`, so no individual screen can be addressed, and the source UVs
did not survive the join. `src/three/Screens.tsx` places an independent plane
over each panel from geometry measured by `tools/find_screens.py`: a transparent
hit plane in front for picking, and a drawn plane behind it for the image, which
sets `raycast={() => null}`. No hotspot points at `hot_screens`, so it is absent
from the pick map and a click on a monitor resolves to a screen, never to the
room behind it.

**Screen images are cover-fitted from the decoded image, not stretched.** The
panels are 2.4:1 and a page screenshot rarely is; the Argus one is 1.68:1, which
filling by scale would stretch 43%. `Screens.tsx` reads `texture.image` for the
real dimensions and crops through the UV window, so replacing an image with a
differently shaped one needs no other change. `anchor: 'top'` keeps the top of a
page screenshot, because a centred crop cut the Argus nav bar off.

**Popups are rate-limited per page, which will break a test before it breaks the
app.** `verify-screens.mjs` proves a real popup once, then asserts on recorded
`window.open` calls for the rest. Three real popups in one page run had the
third silently blocked, which looked exactly like a broken link.

**Screens are a two-stage interaction, and panels are not.** First click frames
the screen dead-on and opens nothing; a second click on the already-framed
screen opens its link. A single click that navigated off-site would be far too
easy to trigger while looking around.

The framed view is deliberately bare: the screen is the content, and the only
chrome is a "Back to the room" button. That is a considered trade. Nothing
states that a second click opens the link, so discoverability rests on the
pointer cursor over the screen. If the two-stage interaction ever needs to be
more obvious, restore a hint rather than collapsing it to a single click.

**Screen framing distance is computed, not authored.** The panels are 2.4:1, so
the limiting dimension flips with the viewport: height constrains a wide window,
width a narrow one. `poseForScreen` derives the distance from the live camera's
fov and aspect rather than a constant.

**Wall-mounted things need the wall's *inner* face.** The back wall is a slab
with faces at z -2.10 and z -1.99, and its reported normals are inverted like
the monitors', so the surface facing the room is the one at z -1.99. Mounting
against -2.10 puts the object inside the wall, where it vanishes with nothing
logged. `tools/find_walls.py` measures the planes; `tools/wall_occupancy.py`
lists what is already mounted and prints the clear bands, which is the only
reliable way to avoid landing a new object on top of existing decor. The
pale-disc panel `Circle.022` covers x -0.66 to 3.41 all the way up, and the
framed picture `Plane.006` covers x 3.48 to 4.73 up to y 1.98, so the only free
space on that wall is the strip above the frame.

Note that `wall_occupancy.py` only reports objects close to the wall plane.
`Plane.006` stands 1.2m proud of it and was missed by an early depth filter,
which is how the wordmark ended up clipping its corner. When checking for
obstructions, search by the x and y span you care about and leave depth open.

**Objects in the room that open URLs live in `ROOM_LINKS`, not `HOTSPOTS`.**
They are not glTF nodes, so putting them in `HOTSPOTS` would break the raycast
map and add pills that try to open a panel. Every such object must also be
reachable some other way: a click target that exists only in the 3D scene cannot
be tabbed to or announced by a screen reader, so it can decorate a route but
never be the only one.

That second route is structural rather than remembered. The keyboard index in
`Hud.tsx` renders every `ROOM_LINKS` entry as a real anchor after the hotspot
pills, labelled by its `label`, and focusing it sets `hover` to the link's id,
so the object it stands for lights up exactly as it does under the pointer.
Adding a room link therefore adds its keyboard route in the same edit.

This matters most for the neon wordmark, because that anchor is now the only
keyboard route to GitHub outside the 2D fallback. It used to be a Contact panel
on the sofa, which was removed as redundant once the sign existed; the Contact
anchor was the route `verify-keyboard.mjs` walked, and it now walks the index
to the GitHub entry instead and asserts the sign lights on focus. Run it before
removing any anchor.

**A clickable object needs a padded, separate hit mesh.** The visible neon plane
is 0.88 x 0.223, which is a hard thing to hit across a room. Picking is handled
by a larger transparent mesh in front of it, and the drawn plane sets
`raycast={() => null}`. The hit mesh also has to `stopPropagation` on
`onPointerMove`: the room's own move handler sits behind it, resolves the wall,
and would otherwise clear the hover every frame.

**Anything clickable must honour `orbit.suppressClick`.** Ending an orbit drag
on a link would otherwise navigate away from the page, which is a much worse
accident than opening the wrong panel. Covered by
`tools/verify-neon-link.mjs`.

**Coordinate spaces differ.** Blender is Z-up; glTF is Y-up. The exporter
converts manifest coordinates with `(x, y, z) -> (x, z, -y)`. Camera offsets in
`content.ts` are in glTF space.

**Backgrounded processes get killed in some sandboxes.** The capture scripts run
their own in-process static server for this reason. Do not rewrite them to
assume a separately-started dev server.

**Screenshot comparison needs reduced motion, or it measures noise.** Idle drift
is a time-based sine, so two frames captured seconds apart never match, and the
mismatch grows with zoom because the same angular drift covers more pixels. A
camera-restore test that ignored this reported a 6.26 mean pixel difference on
a view that was in fact restored exactly. Launch the page with
`reducedMotion: 'reduce'` for any pixel assertion. Also park the pointer over
non-interactive geometry and blur the active element first, or the diff is
dominated by the neon sign brightening and a focus ring.

**Prefer asserting on state over pixels, and never on chrome.** The dev-only
handles are `window.__orbit` (camera offsets), `window.__neon` (sign
brightness tuning), `window.__hover` (hovered id), `window.__board` (pixel
board cells) and `window.__room` (the cloned scene and its node-to-hotspot
map, for `verify-hotspots.mjs`), all behind `import.meta.env.DEV`. Confirm
they are stripped after a build with
`grep -o "__orbit\|__neon\|__hover\|__board\|__room" dist/assets/*.js`.

`__hover` exists because two verification scripts used to locate objects by
scraping the hover readout out of the DOM. When that readout was removed from
the design the scripts broke, for a reason that had nothing to do with what they
were testing. Tests should not depend on visible chrome surviving a design
decision.

**There is no hover highlight, by choice.** Hovering an object changes nothing
about how it looks; the cursor becoming a pointer via `bindCursor` is the whole
of the feedback. The green emissive wash that used to light hovered props was
removed by the owner: the room is meant to be explored, and a wash announced
every interactive object the moment the pointer crossed it. The neon sign still
brightens under the pointer, which is part of the sign rather than a room-wide
affordance. The matching nav pill lights up for a keyboard visitor, since the
index is hidden until focused.

Two things were learned the hard way, if a highlight ever comes back. Blend the
accent into the material's own emissive rather than replacing it, or props
flatten into solid silhouettes and glowing ones lose their glow. And never
clear shared state inside a `useMemo` that clones the scene: under
`<StrictMode>` React runs that function twice in development and keeps the
*first* result, so the second run wiped the wash's baseline map and refilled it
from a clone that was then thrown away. The wash painted nothing under
`npm run dev` for three weeks while working in production, and the only test
checked intent, not pixels.

**`gsap.from()` under reduced motion will hide your UI.** `from()` writes its
start state to the element immediately and animates away from it. If the tween
is skipped or never runs, the element is left parked at that start state, so an
ungated `gsap.from({opacity: 0})` once rendered the whole hero and nav invisible
for anyone with `prefers-reduced-motion: reduce`, and the panel entrance in
`Panel.tsx` would do the same today. The CSS reduced-motion block does
not help; it only caps CSS animations and transitions, and GSAP writes inline
styles. Wrap every `from()` in `gsap.matchMedia()` keyed on
`(prefers-reduced-motion: no-preference)` so the tween is never created. For
`to()` tweens that express a state change, keep the tween and set
`duration: 0` instead, so the state still lands.

**A nav pill cannot be hovered or clicked in a test.** The index is `sr-only`
until focused, so its pills take no pointer events. To drive hover state, either
`focus()` a pill or move the pointer over the object in the canvas, which is
what a visitor does. To open a hotspot, `press` Enter on a pill or click the
object. Hovering a pill never drove the 3D hover state reliably anyway: the
canvas-to-HTML pointer handoff raced.

**`runAsNonRoot` cannot be enforced against a named user.** The Dockerfile says
`USER node`, and kubelet cannot prove a name is not root, so `runAsNonRoot:
true` on its own leaves the pod stuck in `CreateContainerConfigError`. The
chart states `runAsUser: 1000`, which is what `node` is in `node:22-alpine`.
If the base image changes, check the uid with `id node` inside it.

**A chart version and its image are released by two different events.** Chart
0.1.0 shipped with `appVersion: latest`, so the same chart version ran whatever
`main` last built, `helmfile apply` could not see a new build, and a rollback
restored the manifest but not the site. From 0.1.1, `appVersion` equals
`version` and names a semver image tag. The chart is published by merging to
`main`; the image is built only when `v<version>` is pushed as a git tag. Forget
the tag and the published chart points at an image that does not exist. That is
recoverable, since pushing the tag later builds it, but nothing fails at publish
time to remind you.

**An empty `image.pullPolicy` is deliberate.** A hardcoded `IfNotPresent` would
keep serving whichever `latest` a node pulled first if anyone overrides the tag
to `latest`. Leaving the field off lets Kubernetes choose `Always` for `latest`
and `IfNotPresent` for a version or a sha.

**`kubectl apply --dry-run=client` is not a schema check.** It accepted a
Deployment with a misspelled `preStop.sleep.secondz` and reported it as
created. Validate rendered manifests with `kubeconform -strict`, which rejected
the same input, and keep a negative control in mind for any validator you trust.

## Conventions

- TypeScript strict, `tsc --noEmit` and `eslint .` must both pass.
- Tailwind v4 via `@tailwindcss/vite`, tokens in the `@theme` block of
  `src/index.css`. One accent colour (`--color-acid`), one radius scale.
- GSAP only for animation. Do not add Motion; the two fight over frames in the
  same tree. Use `useGSAP` with a `scope` so cleanup is automatic.
- Icons from `@phosphor-icons/react` only.
- No em-dashes in user-visible copy.
- Every animation honours `prefers-reduced-motion`.
- Placeholder content is visibly labelled as pending, never invented.

## Technical debt

- The sofa is still 42k of the 160k triangles after decimation.
- No `<Environment>` map. The hemisphere fill in `lighting.ts` approximates one,
  but real image-based lighting would seat the metals and the guitar better, and
  would close the remaining gap against the offline renders.
- Argus is linked, not embedded. The GitHub Pages host sends no
  `X-Frame-Options`, so a live iframe is possible if that is ever wanted.
- The backing track is a commercial placeholder. It is uncommitted, and the
  panel credits `TRACK.artist`, but the intended end state is an original
  mixdown. Until then the only thing keeping the recording off the public site
  is the `.mp3` gitignore rule, so treat that rule as load-bearing rather than
  housekeeping.
- The synth and the player own separate audio graphs — an `AudioContext` and an
  `HTMLAudioElement`. They only coordinate through `duckTrack()`, which is a
  volume ramp and not a real bus. If the keys ever need to be recorded over the
  track, or the two need a shared master, route the element through the same
  context via `createMediaElementSource`.
