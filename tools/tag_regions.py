#!/usr/bin/env python3
"""Tag objects into named hotspot groups by world-space AABB region, then render
one verification image per group (target group lit red, everything else grey).

Run: ./.venv/bin/python tag_regions.py ../ZEFUHEZF.blend
"""
import json
import os
import sys

import bpy
from mathutils import Vector

BLEND = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "../ZEFUHEZF.blend")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "preview")
os.makedirs(OUT, exist_ok=True)

# name: (xmin,xmax, ymin,ymax, zmin,zmax)  -- first match wins, order matters
REGIONS = [
    ("screens",    (-0.70, 2.90,  0.95, 2.10,  0.95, 1.90)),
    ("desk",       (-1.05, 3.10,  0.35, 2.10, -0.05, 0.95)),
    ("chair",      (-0.20, 1.30, -0.30, 1.00, -0.05, 1.35)),
    ("ringlight",  (-0.30, 0.60,  0.90, 1.90, -0.05, 1.80)),
    ("hexpanels",  ( 2.60, 4.90,  1.60, 2.20,  0.80, 3.00)),
    ("wallart",    (-2.30,-1.60, -1.00, 1.00,  1.40, 3.10)),
    ("shelves",    (-2.30,-1.55, -4.20,-0.20,  1.70, 3.10)),
    ("sofa",       (-2.10,-0.55, -3.00,-0.10, -0.05, 1.20)),
    ("table",      (-0.55, 0.75, -2.10,-0.75, -0.05, 0.80)),
    ("djdeck",     (-0.90, 1.10, -4.80,-3.10, -0.05, 1.30)),
    ("midikeys",   ( 1.20, 3.30, -4.80,-2.90, -0.05, 1.20)),
    ("guitar",     ( 3.30, 4.90, -3.40,-1.40, -0.05, 1.80)),
    ("plants",     ( 3.30, 4.90, -1.20, 2.10, -0.05, 1.90)),
]

bpy.ops.wm.open_mainfile(filepath=BLEND)
scene = bpy.context.scene


def wbb(ob):
    cs = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    return (Vector((min(c.x for c in cs), min(c.y for c in cs), min(c.z for c in cs))),
            Vector((max(c.x for c in cs), max(c.y for c in cs), max(c.z for c in cs))))


props = [o for o in scene.objects if o.type in ("MESH", "CURVE")]
tag = {}
for o in props:
    try:
        mn, mx = wbb(o)
    except Exception:
        continue
    d = mx - mn
    if d.x > 5.5 or d.y > 5.5:          # floor slab / room shell / rug
        tag[o.name] = "shell"
        continue
    c = (mn + mx) / 2
    for name, (x0, x1, y0, y1, z0, z1) in REGIONS:
        if x0 <= c.x <= x1 and y0 <= c.y <= y1 and z0 <= c.z <= z1:
            tag[o.name] = name
            break
    else:
        tag[o.name] = "misc"

by_group = {}
for n, g in tag.items():
    by_group.setdefault(g, []).append(n)

print(f"{'group':<12} {'objs':>4} {'tris':>8}   bbox centre / dims")
report = {}
for g in [r[0] for r in REGIONS] + ["shell", "misc"]:
    names = sorted(by_group.get(g, []))
    if not names:
        print(f"{g:<12} {0:>4}   -- EMPTY --")
        continue
    mn = Vector((1e9,) * 3)
    mx = Vector((-1e9,) * 3)
    tris = 0
    for n in names:
        o = bpy.data.objects[n]
        a, b = wbb(o)
        mn = Vector((min(mn[k], a[k]) for k in range(3)))
        mx = Vector((max(mx[k], b[k]) for k in range(3)))
        if o.type == "MESH":
            tris += sum(len(p.vertices) - 2 for p in o.data.polygons)
    c, d = (mn + mx) / 2, mx - mn
    report[g] = {"objects": names, "tris": tris,
                 "centre": [round(v, 3) for v in c],
                 "dim": [round(v, 3) for v in d],
                 "min": [round(v, 3) for v in mn],
                 "max": [round(v, 3) for v in mx]}
    print(f"{g:<12} {len(names):>4} {tris:>8,}   "
          f"c=({c.x:6.2f},{c.y:6.2f},{c.z:6.2f})  "
          f"d=({d.x:5.2f},{d.y:5.2f},{d.z:5.2f})")

with open(os.path.join(HERE, "regions.json"), "w") as f:
    json.dump(report, f, indent=1)
print("\nwrote regions.json")

# ---- verification renders -------------------------------------------------
grey = bpy.data.materials.new("GREY")
grey.use_nodes = True
gb = grey.node_tree.nodes["Principled BSDF"]
gb.inputs["Base Color"].default_value = (0.10, 0.10, 0.12, 1)
gb.inputs["Roughness"].default_value = 0.9

hot = bpy.data.materials.new("HOT")
hot.use_nodes = True
hb = hot.node_tree.nodes["Principled BSDF"]
hb.inputs["Base Color"].default_value = (1.0, 0.13, 0.20, 1)
hb.inputs["Emission Color"].default_value = (1.0, 0.13, 0.20, 1)
hb.inputs["Emission Strength"].default_value = 2.5

r = scene.render
r.resolution_x, r.resolution_y = 620, 400
r.image_settings.file_format = "PNG"
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 12
scene.cycles.use_denoising = True
scene.camera = bpy.data.objects["Camera"]

for g in [x[0] for x in REGIONS]:
    names = set(by_group.get(g, []))
    if not names:
        continue
    for o in props:
        if not hasattr(o.data, "materials"):
            continue
        o.data.materials.clear()
        o.data.materials.append(hot if o.name in names else grey)
    r.filepath = os.path.join(OUT, f"tag_{g}")
    bpy.ops.render.render(write_still=True)
    print(f"  rendered tag_{g}.png  ({len(names)} objs)")
