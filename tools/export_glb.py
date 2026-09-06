#!/usr/bin/env python3
"""Convert the purchased .blend into a web-ready GLB.

  1. strip materials that point at missing image files (kills magenta)
  2. decimate over-dense meshes to a triangle budget
  3. tag every object into a hotspot group by world-space AABB region
  4. join each group into one mesh named `hot_<group>` / `static_<group>`
  5. export GLB (+Y up), then Draco-compress via gltf-transform if available

Run: ./.venv/bin/python export_glb.py ../room.blend ../public/room.glb
"""
import json
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
BLEND = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "../room.blend")
DEST = os.path.abspath(sys.argv[2] if len(sys.argv) > 2
                       else os.path.join(HERE, "..", "public", "room.glb"))
os.makedirs(os.path.dirname(DEST), exist_ok=True)

# ---------------------------------------------------------------- regions --
# Interactive hotspots become their own glTF node so the frontend can raycast
# them individually. Everything else is merged into one static mesh.
REGIONS = [
    ("screens",   (-0.70, 2.90,  0.95, 2.10,  0.95, 1.90), True),
    ("desk",      (-1.05, 3.10,  0.35, 2.10, -0.05, 0.95), True),
    ("chair",     (-0.20, 1.30, -0.30, 1.00, -0.05, 1.35), False),
    ("hexpanels", ( 2.60, 4.90,  1.60, 2.20,  0.80, 3.00), True),
    # The pixel board, added to the source scene later than everything else: a
    # 24x42 grid of individual pixel meshes on the -x wall. It MUST come before
    # `wallart` and `shelves`, because objects land in the first region whose box
    # contains their centre and those two would otherwise split the board three
    # ways -- rows above y=-1.00 into wallart, rows below it into shelves, and
    # the bottom strip below z=1.70 into static. A hotspot cannot be three
    # meshes. The box also catches Plane.068, a zero-vertex degenerate plane that
    # happens to sit on the same wall; it contributes no geometry either way.
    ("pixelboard", (-2.05,-1.85, -2.45,-0.55,  1.40, 2.45), True),
    # The ranking board, added in room-v2 immediately beside the pixel board on
    # the same -x wall. Same ordering trap as the pixel board and worse: the
    # `wallart` box below contains this one entirely, so listed after it the
    # whole board would vanish into a static mesh. The y range stops at -0.52
    # rather than meeting `pixelboard` at -0.55, so the two boxes do not touch
    # and neither can steal a stray object from the other.
    ("ranking",    (-2.01,-1.87, -0.52, 0.06,  1.44, 2.40), True),
    ("wallart",   (-2.30,-1.60, -1.00, 1.00,  1.40, 3.10), True),
    ("shelves",   (-2.30,-1.55, -4.20,-0.20,  1.70, 3.10), True),
    ("sofa",      (-2.10,-0.55, -3.00,-0.10, -0.05, 1.20), True),
    ("table",     (-0.55, 0.75, -2.10,-0.75, -0.05, 0.80), False),
    # Names below describe what these boxes ACTUALLY enclose, verified by
    # hover capture and by listing their contents. The first two were
    # originally guessed from position and were both wrong, which is why the
    # Music hotspot spent a while attached to the DJ controller.
    ("micstand",     (-0.90, 1.10, -4.80,-3.10, -0.05, 1.30), False),
    ("djcontroller", ( 1.20, 3.30, -4.80,-2.90, -0.05, 1.20), True),
    ("synth",        ( 3.30, 4.90, -3.40,-1.40, -0.05, 1.80), True),
    ("plants",    ( 3.30, 4.90, -1.20, 2.10, -0.05, 1.90), False),
]

# per-mesh triangle ceiling; anything above gets a Decimate modifier
TRI_BUDGET = {"sofa": 6000, "plants": 8000, "chair": 6000, "_default": 4000}

bpy.ops.wm.open_mainfile(filepath=BLEND)
scene = bpy.context.scene
view = bpy.context.view_layer


def wbb(ob):
    cs = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    return (Vector((min(c.x for c in cs), min(c.y for c in cs), min(c.z for c in cs))),
            Vector((max(c.x for c in cs), max(c.y for c in cs), max(c.z for c in cs))))


def tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons) if ob.type == "MESH" else 0


# ------------------------------------------------- 1. kill dead textures --
missing = 0
for mat in bpy.data.materials:
    if not mat.node_tree:
        continue
    for node in list(mat.node_tree.nodes):
        if node.type != "TEX_IMAGE":
            continue
        img = node.image
        ok = img and (img.packed_file or
                      os.path.exists(bpy.path.abspath(img.filepath)))
        if ok:
            continue
        missing += 1
        # unlink and drop back to the material's flat viewport colour
        for link in list(mat.node_tree.links):
            if link.from_node is node:
                mat.node_tree.links.remove(link)
        mat.node_tree.nodes.remove(node)
        bsdf = next((n for n in mat.node_tree.nodes
                     if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf and not bsdf.inputs["Base Color"].is_linked:
            c = mat.diffuse_color
            bsdf.inputs["Base Color"].default_value = (c[0], c[1], c[2], 1.0)
print(f"stripped {missing} dead image-texture nodes")

for img in list(bpy.data.images):
    if img.name != "Render Result" and not img.packed_file:
        if not os.path.exists(bpy.path.abspath(img.filepath)):
            bpy.data.images.remove(img)

# ------------------------------------------------- 1a. unlock everything --
# The outliner's selection lock is authoring state, not scene content, and it
# is invisible to every check that matters here. `select_set(True)` on a
# hide_select object is a SILENT no-op: it does not raise, does not warn, and
# `select_get()` simply keeps returning False. The join in step 4 then has
# nothing selected but the active object, returns {'CANCELLED'} rather than
# raising, and the group ends up as whichever single object happened to be
# first.
#
# That is exactly what room-v2 did on arrival: 193 of the ranking board's 205
# objects were locked, so `hot_ranking` exported as a 92-triangle enclosure
# with the other 15,828 triangles scattered across 187 stray top-level nodes.
# It exported cleanly and rendered the board in roughly the right place, which
# is what makes this worth clearing on principle rather than diagnosing twice.
locked = 0
for o in scene.objects:
    if o.hide_select:
        o.hide_select = False
        locked += 1
    o.hide_viewport = False
print(f"cleared the selection lock on {locked} objects")

# ------------------------------------------ 1b. one material per LED slot --
# The ranking board's 160 bar segments all point at a single material in the
# source scene, `Ranking - LED P01 S01`. That is fine for a still render and
# useless for a live one: writing emissive on a shared material lights all 160
# at once, so the bars could only ever be full or empty.
#
# The .blend already contains the complete 5x32 set of `Ranking - LED Pnn Snn`
# materials, with the per-row colour ramp the board was designed around -- row
# one gold, row five green. They were authored and then never assigned, so this
# hooks up what is already there rather than inventing 160 copies. The naming
# convention is the author's; the frontend looks materials up by these names,
# the same way it finds the 1008 `Pixel Light R# C#` cells.
#
# The mesh copy on the first line of the loop is load-bearing and easy to miss:
# all 160 LEDs are linked duplicates of ONE datablock, `Ranking - Shared
# beveled LED`, with 160 users. Assigning through `o.data.materials` without
# breaking that link writes through every LED at once, and the loop finishes
# with all 160 wearing whichever material the last iteration reached.
wired, missing_mats = 0, []
for o in scene.objects:
    if o.type != "MESH" or not o.name.startswith("RankingLED_"):
        continue
    want = "Ranking - LED " + o.name[len("RankingLED_"):].replace("_", " ")
    mat = bpy.data.materials.get(want)
    if mat is None:
        missing_mats.append(want)
        continue
    o.data = o.data.copy()
    o.data.materials.clear()
    o.data.materials.append(mat)
    wired += 1
if missing_mats:
    raise SystemExit(f"ranking LED materials missing from the .blend: "
                     f"{missing_mats[:6]} ({len(missing_mats)} total)")
print(f"wired {wired} ranking LEDs to their own materials")

# --------------------------------------------------------- 2. tag groups --
props = [o for o in scene.objects if o.type in ("MESH", "CURVE", "FONT")]
group_of = {}
for o in props:
    try:
        mn, mx = wbb(o)
    except Exception:
        group_of[o.name] = "static"
        continue
    d, c = mx - mn, (mn + mx) / 2
    if d.x > 5.5 or d.y > 5.5:
        group_of[o.name] = "shell"
        continue
    for name, (x0, x1, y0, y1, z0, z1), _hot in REGIONS:
        if x0 <= c.x <= x1 and y0 <= c.y <= y1 and z0 <= c.z <= z1:
            group_of[o.name] = name
            break
    else:
        group_of[o.name] = "static"

# --------------------------------- 2b. drop text the frontend will replace --
# The ranking board ships with placeholder copy baked into FONT objects:
# `PROJECT 01`..`PROJECT 05`, five geometry-nodes score readouts frozen at
# 92/78/64/46/28, and a `SAMPLE PROJECTS` footer. Once the board is driven by
# live data every one of those is a false statement rendered in geometry, and
# `SAMPLE PROJECTS` is the worst of them: it tells the reader the numbers above
# it are made up, on a board where they no longer are.
#
# They are deleted here rather than in the .blend so the source file stays a
# self-contained mockup that still renders correctly on its own. RankingBoard
# draws live text at the same anchors.
#
# Everything else on the board stays baked, because it stays true regardless of
# the data: the rank digits 01-05, `CURRENT RANKING`, `SCORE / 100`, `ACTIVE`,
# and the 05 entry count are all fixed properties of a five-row board.
placeholders = [f"Ranking Project {i:02d} - Name" for i in range(1, 6)]
placeholders += [f"Ranking Project {i:02d} - Score" for i in range(1, 6)]
# `SAMPLE PROJECTS` tells the reader the numbers above it are invented, on a
# board where they no longer are. `SCORE / 100` and `HIGH SCORE FIRST` describe
# a normalised score, and the right-hand column now prints the token totals the
# rows are actually ranked by -- keeping them would caption the wrong quantity.
placeholders += ["Ranking - Sample label", "Ranking - Metric caption",
                 "Ranking - Footer note"]
doomed = {n for n in placeholders if bpy.data.objects.get(n) is not None}
if doomed != set(placeholders):
    raise SystemExit(
        f"expected to drop {len(placeholders)} ranking placeholders, found "
        f"{len(doomed)}. The .blend renamed or removed one; the frontend draws "
        f"live text at these anchors and would now overlap baked copy.")

# Measure before deleting, and hand the frontend the anchors rather than a set
# of magic numbers copied out of Blender by hand. Those would be correct once
# and then rot silently the first time a row moved: the board would still
# render, with the names a few millimetres off the rows they describe.
#
# Recorded in glTF space (Y up, z = -y) so the frontend can use them directly.
def gltf_box(o):
    mn, mx = wbb(o)
    lo = [round(mn.x, 5), round(mn.z, 5), round(-mx.y, 5)]
    hi = [round(mx.x, 5), round(mx.z, 5), round(-mn.y, 5)]
    return {"min": [min(a, b) for a, b in zip(lo, hi)],
            "max": [max(a, b) for a, b in zip(lo, hi)]}

anchors = {
    "rows": [{"name": gltf_box(bpy.data.objects[f"Ranking Project {i:02d} - Name"]),
              "score": gltf_box(bpy.data.objects[f"Ranking Project {i:02d} - Score"])}
             for i in range(1, 6)],
    "caption": gltf_box(bpy.data.objects["Ranking - Sample label"]),
    "metric": gltf_box(bpy.data.objects["Ranking - Metric caption"]),
    "footer": gltf_box(bpy.data.objects["Ranking - Footer note"]),
    # The face the text sits on, so the overlay can be placed just in front of
    # it instead of guessing a depth and z-fighting with the baked chrome.
    "screen": gltf_box(bpy.data.objects["Ranking - Recessed screen"]),
}
with open(os.path.join(HERE, "..", "src", "ranking-anchors.json"), "w") as f:
    json.dump(anchors, f, indent=1)
print("wrote src/ranking-anchors.json")

# Drop them out of `props` BEFORE deleting the objects. `props` holds live
# StructRNA references, and touching even `.name` on one after its object is
# gone raises ReferenceError several steps later, where it looks unrelated.
props = [o for o in props if o.name not in doomed]
for n in doomed:
    bpy.data.objects.remove(bpy.data.objects[n], do_unlink=True)
    group_of.pop(n, None)
print(f"dropped {len(doomed)} ranking placeholder labels for live text")

# ------------------------------------------- 3. curves -> mesh, decimate --
# Cables are Bezier curves with a bevel. At the seller's authoring resolution
# they tessellate to millions of triangles, so drop the resolution hard first
# -- at the size they occupy on screen nobody can tell.
bpy.ops.object.select_all(action="DESELECT")
# Pass 1: lower the tessellation resolution on every curve FIRST. convert()
# acts on the whole selection, so one call can convert many objects at once --
# any curve still at authoring resolution when that happens explodes.
curves = [o for o in props if o.type == "CURVE"]
for o in curves:
    cu = o.data
    cu.resolution_u = 2
    cu.render_resolution_u = 2
    cu.bevel_resolution = 1
    for sp in cu.splines:
        sp.resolution_u = 2

# Pass 2: convert them all in one go.
for o in curves:
    if o.name in bpy.data.objects and o.type == "CURVE":
        o.select_set(True)
if curves:
    view.objects.active = curves[0]
    try:
        bpy.ops.object.convert(target="MESH")
    except Exception as e:
        print(f"  curve convert failed: {e}")
bpy.ops.object.select_all(action="DESELECT")
print(f"converted {len(curves)} curves to mesh at low resolution")

# Pass 3: text -> mesh. glTF has no text primitive, so a FONT object is dropped
# on export without warning. The pixel board's hour and weekday labels are FONT,
# so without this the board exports as an unlabelled grid. Converted after the
# region pass above, which is why FONT is in `props`: the group is keyed by
# object name and conversion preserves it.
fonts = [o for o in scene.objects if o.type == "FONT"]
for o in fonts:
    o.select_set(True)
if fonts:
    view.objects.active = fonts[0]
    try:
        bpy.ops.object.convert(target="MESH")
    except Exception as e:
        print(f"  font convert failed: {e}")
bpy.ops.object.select_all(action="DESELECT")
print(f"converted {len(fonts)} text objects to mesh")

# ------------------------------------- 3b. bake modifiers before joining --
# bpy.ops.object.join() keeps only the ACTIVE object's modifier stack and
# silently discards everyone else's. Several props here are defined by their
# modifiers rather than by their base mesh, so joining without baking first
# deletes real geometry with no warning: the synth's white keybed is one key
# with an ARRAY of 22, and joining left exactly one key behind.
#
# Subsurf is dropped rather than applied. It only smooths, every one of these
# objects is decimated afterwards anyway, and applying it first is expensive
# for nothing: three props in this scene go from 858 to 167,552 triangles.
# Everything else is baked, because ARRAY, MIRROR and SOLIDIFY change which
# geometry exists at all.
dropped = 0
baked = 0
for o in [x for x in scene.objects if x.type == "MESH" and x.modifiers]:
    for m in list(o.modifiers):
        if m.type == "SUBSURF":
            o.modifiers.remove(m)
            dropped += 1
    if not o.modifiers:
        continue
    view.objects.active = o
    for m in list(o.modifiers):
        try:
            bpy.ops.object.modifier_apply(modifier=m.name)
            baked += 1
        except Exception as e:
            print(f"  could not bake {m.type} on {o.name}: {e}")
print(f"baked {baked} modifiers, dropped {dropped} subsurf")

before = sum(tris(o) for o in scene.objects if o.type == "MESH")
heavy = sorted(((tris(o), o.name) for o in scene.objects if o.type == "MESH"),
               reverse=True)[:8]
print("heaviest meshes pre-decimate: " +
      ", ".join(f"{n}={t:,}" for t, n in heavy))
decimated = 0
for o in [x for x in scene.objects if x.type == "MESH"]:
    g = group_of.get(o.name, "static")
    budget = TRI_BUDGET.get(g, TRI_BUDGET["_default"])
    t = tris(o)
    if t <= budget:
        continue
    m = o.modifiers.new("dec", "DECIMATE")
    m.ratio = max(0.02, budget / t)
    view.objects.active = o
    try:
        bpy.ops.object.modifier_apply(modifier=m.name)
        decimated += 1
    except Exception as e:
        print(f"  decimate failed on {o.name}: {e}")
after = sum(tris(o) for o in scene.objects if o.type == "MESH")
print(f"decimated {decimated} meshes: {before:,} -> {after:,} tris "
      f"({100*(1-after/max(before,1)):.0f}% reduction)")

# ------------------------------------------------------ 4. join by group --
hot_names = {n for n, _b, hot in REGIONS if hot}
buckets = {}
for o in [x for x in scene.objects if x.type == "MESH"]:
    buckets.setdefault(group_of.get(o.name, "static"), []).append(o)

manifest = {}
lost = []
for g, obs in sorted(buckets.items()):
    obs = [o for o in obs if o.name in bpy.data.objects]
    if not obs:
        continue
    want = sum(tris(o) for o in obs)
    bpy.ops.object.select_all(action="DESELECT")
    for o in obs:
        o.select_set(True)
    view.objects.active = obs[0]
    if len(obs) > 1:
        try:
            bpy.ops.object.join()
        except Exception as e:
            print(f"  join failed for {g}: {e}")
    merged = view.objects.active
    # A join that swallowed only some of its group is the failure mode worth
    # guarding: bpy.ops.object.join() returns {'CANCELLED'} rather than raising
    # when nothing but the active object is selected, so the try/except above
    # sees nothing wrong. The group still exports, still lands in the manifest,
    # and still renders in roughly the right place -- with most of its geometry
    # left behind as loose top-level nodes the frontend has no name for.
    # Compare triangles instead of trusting the operator.
    got = tris(merged)
    if got != want:
        lost.append(f"{g}: joined {got:,} of {want:,} tris from {len(obs)} objects")
    prefix = "hot" if g in hot_names else "static"
    merged.name = f"{prefix}_{g}"
    merged.data.name = f"{prefix}_{g}"
    mn, mx = wbb(merged)
    c = (mn + mx) / 2
    manifest[g] = {
        "node": merged.name,
        "interactive": g in hot_names,
        "tris": tris(merged),
        "centre": [round(v, 4) for v in c],
        "min": [round(v, 4) for v in mn],
        "max": [round(v, 4) for v in mx],
    }
    print(f"  {merged.name:<20} {tris(merged):>7,} tris  "
          f"c=({c.x:6.2f},{c.y:6.2f},{c.z:6.2f})")

if lost:
    raise SystemExit("\nJOIN LEFT GEOMETRY BEHIND:\n  " + "\n  ".join(lost) +
                     "\n\nThe usual cause is the outliner's selection lock on the "
                     "source objects; step 1a clears it, so if this fires the "
                     "objects are unselectable for some other reason. Exporting "
                     "anyway would ship a hotspot missing most of its geometry.")

# glTF is Y-up; Blender is Z-up. Record centres in glTF space for the frontend.
for g, d in manifest.items():
    for k in ("centre", "min", "max"):
        x, y, z = d[k]
        d[k] = [round(x, 4), round(z, 4), round(-y, 4)]
    lo, hi = d["min"], d["max"]
    d["min"] = [min(a, b) for a, b in zip(lo, hi)]
    d["max"] = [max(a, b) for a, b in zip(lo, hi)]

with open(os.path.join(HERE, "..", "src", "scene-manifest.json"), "w") as f:
    json.dump(manifest, f, indent=1)
print("wrote src/scene-manifest.json")

# ------------------------------------------------------------- 5. export --
for o in list(scene.objects):
    if o.type in ("LIGHT", "CAMERA"):
        bpy.data.objects.remove(o, do_unlink=True)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(
    filepath=DEST,
    export_format="GLB",
    export_yup=True,
    export_apply=True,
    export_materials="EXPORT",
    export_cameras=False,
    export_lights=False,
    export_animations=False,
    export_skins=False,
    export_morph=False,
    export_tangents=False,
    export_normals=True,
    export_texcoords=True,
    export_extras=False,
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=6,
    export_draco_position_quantization=12,
    export_draco_normal_quantization=8,
    export_draco_texcoord_quantization=10,
)
size = os.path.getsize(DEST)
print(f"\nexported {DEST}  {size/1e6:.2f} MB  "
      f"{sum(m['tris'] for m in manifest.values()):,} tris")
