# AGENTS.md

Context for AI agents working on this repository.

## What this is

A personal homepage whose landing page is an interactive 3D room. Clicking a
physical object in the room focuses the camera on it and opens a content panel.
The room is a purchased Blender asset, converted by a local pipeline.

## Architecture

Two halves that meet at one generated file.

```
ZEFUHEZF.blend  --[tools/export_glb.py, headless bpy]-->  public/room.glb
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

## Key design decisions

**The asset is bad and the pipeline compensates rather than the runtime.** The
purchased scene has no usable textures, no object naming, and pathological
geometry. Everything that can be fixed once at export time is fixed there, so
the React code never contains asset workarounds. If something looks wrong in the
room, check `tools/export_glb.py` before touching `src/three/`.

**Flat shading is a decision, not a fallback.** Every texture path in the source
points at the seller's machine and is unrecoverable. Rather than sourcing
replacements, the export drops texture nodes and keeps each material's flat
colour. Combined with ACES tone mapping at low exposure and a very dim light
rig, this reads as a deliberate stylised night scene. Do not "fix" this by
adding bright lights: the flat base colours blow out to pale grey immediately,
which is exactly what the first implementation got wrong.

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

**Hotspot geometry is grouped, not per-object.** The exporter joins objects into
one mesh per semantic group so raycasting touches ~13 meshes instead of 193.

## Non-obvious behaviours

**glTF nodes with multiple primitives load as a Group, not a Mesh.** Children get
suffixed names (`hot_desk_0`, `hot_desk_1`, ...). Matching `mesh.name === node`
silently never fires. Use `getObjectByName(node)` then traverse its subtree.
This caused the hover highlight to be invisible while raycasting still worked,
because raycasting walks up the parent chain.

**`Object3D.clone()` shares material instances.** The source asset reuses one
material across unrelated props, so mutating a material for hover highlighting
lights up objects on the other side of the room. Interactive nodes get their
materials cloned explicitly in `Room.tsx`.

**Blender's `convert(target='MESH')` acts on the whole selection.** Iterating
objects and converting one at a time will convert everything on the first call,
leaving later iterations holding already-converted objects. Set curve resolution
on all curves before converting any of them.

**Region tagging is approximate and must be verified visually.** A world-space
AABB catches whatever is inside it. Two hotspots shipped pointing at the wrong
object before anyone looked. `node tools/verify-hotspots.mjs` hovers each
hotspot and captures what actually lights up. Run it after any region change.

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
dominated by the hover wash and a focus ring.

**Prefer asserting on state over pixels.** `src/three/orbit.ts` exposes
`window.__orbit` under `import.meta.env.DEV`, so the verification scripts can
read the camera offsets directly. The branch and the hook are both stripped from
production builds; there is a check for that in the commit history.

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

- The `signals` hotspot is marked `unverified` and hidden from the room. The hex
  light panels and the upright piano are both stuck inside `static_static`;
  isolating them means tightening the regions in `export_glb.py`.
- The sofa is still 42k of the 160k triangles after decimation.
- No `<Environment>` map, so metals read flat. Adding a small HDRI would help
  the monitors and the guitar without much cost.
- Argus is linked, not embedded. The GitHub Pages host sends no
  `X-Frame-Options`, so a live iframe is possible if that is ever wanted.
