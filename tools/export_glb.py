#!/usr/bin/env python3
"""Convert the purchased .blend into a web-ready GLB.

  1. strip materials that point at missing image files (kills magenta)
  2. decimate over-dense meshes to a triangle budget
  3. tag every object into a hotspot group by world-space AABB region
  4. join each group into one mesh named `hot_<group>` / `static_<group>`
  5. export GLB (+Y up), then Draco-compress via gltf-transform if available

Run: ./.venv/bin/python export_glb.py ../ZEFUHEZF.blend ../public/room.glb
"""
import json
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
BLEND = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "../ZEFUHEZF.blend")
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
    ("wallart",   (-2.30,-1.60, -1.00, 1.00,  1.40, 3.10), True),
    ("shelves",   (-2.30,-1.55, -4.20,-0.20,  1.70, 3.10), True),
    ("sofa",      (-2.10,-0.55, -3.00,-0.10, -0.05, 1.20), True),
    ("table",     (-0.55, 0.75, -2.10,-0.75, -0.05, 0.80), False),
    ("djdeck",    (-0.90, 1.10, -4.80,-3.10, -0.05, 1.30), True),
    ("midikeys",  ( 1.20, 3.30, -4.80,-2.90, -0.05, 1.20), True),
    ("guitar",    ( 3.30, 4.90, -3.40,-1.40, -0.05, 1.80), True),
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

# --------------------------------------------------------- 2. tag groups --
props = [o for o in scene.objects if o.type in ("MESH", "CURVE")]
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
for g, obs in sorted(buckets.items()):
    obs = [o for o in obs if o.name in bpy.data.objects]
    if not obs:
        continue
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
