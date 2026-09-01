# kr4t0n.github.io

Personal homepage. An explorable 3D diorama of a studio room: click an object,
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

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck then production build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm run lint` | ESLint (flat config) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run room` | Re-export `room.glb` from the `.blend` |

## The asset pipeline

The source file is `ZEFUHEZF.blend`, a purchased isometric studio scene.

**It is not in this repo, by design.** This repository is public, and committing
the `.blend` would redistribute a purchased asset rather than use it, which
essentially every marketplace licence forbids. The derived `public/room.glb` is
committed, so the site builds and runs without it. If you need to re-run the
pipeline, drop your copy of the `.blend` at the repo root; `*.blend` is
gitignored.

It arrives in poor shape: 193 objects all named `Plane.041`-style, 157 materials
named `Material.088`-style, and every texture path pointing at the seller's
Windows RAR extraction temp folder, so no texture resolves. It is also 2.8 GB of
triangles once the cable curves are tessellated.

`tools/export_glb.py` fixes all of that headlessly:

1. Strips image-texture nodes whose files are missing, falling back to each
   material's flat viewport colour. This is why the room is flat-shaded, and
   why it looks deliberate rather than broken.
2. Drops curve resolution before converting cables to mesh. At authoring
   resolution they alone produce 3.5M triangles.
3. Decimates anything over a per-group triangle budget. The sofa shipped at
   158k triangles.
4. Tags every object into a semantic group by world-space AABB region and joins
   each group into one mesh named `hot_<group>` or `static_<group>`.
5. Exports GLB with Draco compression and writes `src/scene-manifest.json`,
   which carries each group's bounding box in glTF space for camera framing.

Result: **1.6 GB to 3.6 MB, 159,662 triangles.**

### Re-running it

```bash
cd tools
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python bpy
cd .. && npm run room
```

No Blender install needed; `bpy` is Blender as a Python module.

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

Requires a one-time `npx playwright install chromium`.

## Adding or changing content

Everything the page says lives in `src/content.ts`. Add a hotspot by adding an
entry pointing at a node that exists in `src/scene-manifest.json`, then run the
verification script to confirm it highlights the object you expect. A hotspot
marked `unverified: true` is excluded from the 3D room but still renders in the
2D fallback.

## Deployment

Pushing to `main` builds and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. For a user page (`kr4t0n.github.io`) keep
`base: '/'` in `vite.config.ts`; for a project repo set it to `/<repo>/`.

## Project structure

```
src/
  content.ts            all copy, projects, hotspot -> node map
  scene-manifest.json   generated: bounding boxes per group
  store.ts              focus/hover state, hash routing
  three/
    Scene.tsx           canvas, lighting, tone mapping
    Room.tsx            GLB load, raycasting, hover highlight
    CameraDirector.tsx  GSAP camera choreography + idle drift
  ui/
    Hud.tsx             hero, hotspot nav, hover readout
    Panel.tsx           focused content panels
    Preloader.tsx       real GLB load progress
    Fallback2D.tsx      no-WebGL / small-screen page
  audio/synth.ts        Web Audio synth for the music hotspot
tools/
  export_glb.py         the asset pipeline
  inspect_blend.py      dependency-free .blend parser
  inspect_scene.py      bpy scene report + preview renders
  verify-hotspots.mjs   hover verification captures
  shoot.mjs             full walkthrough captures
```

## Known gaps

- The `signals` hotspot has no verified node yet and is hidden from the room.
  The hex light panels and the upright piano are both still inside the merged
  static mesh; isolating them is a region-tuning pass in `export_glb.py`.
- Writing, CV and the stats board are marked placeholders in the UI rather than
  filled with invented content.
- The source `.blend` shipped with a `minion.jpg` texture reference among
  others. All missing textures are stripped at export, so nothing
  rights-encumbered ships, but the asset's provenance is not clean.
