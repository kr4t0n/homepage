#!/usr/bin/env python3
"""Cluster the 193 unnamed objects into physical props by spatial proximity,
then render a colour-keyed overview so each cluster can be identified by eye.

Run: ./.venv/bin/python cluster_scene.py ../ZEFUHEZF.blend
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

GAP = 0.06        # bboxes within 6cm are considered the same prop
MIN_TRIS = 0      # keep everything

bpy.ops.wm.open_mainfile(filepath=BLEND)
scene = bpy.context.scene


def world_bbox(ob):
    cs = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    return (Vector((min(c.x for c in cs), min(c.y for c in cs), min(c.z for c in cs))),
            Vector((max(c.x for c in cs), max(c.y for c in cs), max(c.z for c in cs))))


meshes = [o for o in scene.objects if o.type in ("MESH", "CURVE")]
boxes = {}
for o in meshes:
    try:
        boxes[o.name] = world_bbox(o)
    except Exception:
        pass

names = list(boxes)
# the giant floor plane and the room shell must not glue everything together
BIG = set()
for n in names:
    mn, mx = boxes[n]
    d = mx - mn
    if d.x > 5.5 or d.y > 5.5:
        BIG.add(n)


def near(a, b, gap=GAP):
    amn, amx = boxes[a]
    bmn, bmx = boxes[b]
    for i in range(3):
        if amn[i] - gap > bmx[i] or bmn[i] - gap > amx[i]:
            return False
    return True


# union-find
parent = {n: n for n in names}


def find(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


def union(a, b):
    ra, rb = find(a), find(b)
    if ra != rb:
        parent[rb] = ra


small = [n for n in names if n not in BIG]
for i, a in enumerate(small):
    for b in small[i + 1:]:
        if near(a, b):
            union(a, b)

groups = {}
for n in names:
    groups.setdefault(find(n) if n not in BIG else n, []).append(n)

# order clusters by size so the big props get low ids
ordered = sorted(groups.values(), key=lambda g: -sum(
    (boxes[n][1] - boxes[n][0]).length for n in g))

print(f"{len(names)} objects -> {len(ordered)} clusters\n")
print(f"{'id':>3}  {'objs':>4} {'tris':>7}  {'dims (m)':<24} {'centre (x,y,z)':<24}")

manifest = []
for i, g in enumerate(ordered):
    mn = Vector((min(boxes[n][0][k] for n in g) for k in range(3)))
    mx = Vector((max(boxes[n][1][k] for n in g) for k in range(3)))
    d, c = mx - mn, (mn + mx) / 2
    tris = 0
    for n in g:
        ob = bpy.data.objects[n]
        if ob.type == "MESH":
            tris += sum(len(p.vertices) - 2 for p in ob.data.polygons)
    manifest.append({"id": i, "objects": sorted(g), "tris": tris,
                     "min": list(mn), "max": list(mx),
                     "dim": list(d), "centre": list(c)})
    if i < 46:
        print(f"{i:>3}  {len(g):>4} {tris:>7,}  "
              f"{d.x:6.2f}x{d.y:6.2f}x{d.z:6.2f}      "
              f"{c.x:7.2f},{c.y:7.2f},{c.z:7.2f}")

with open(os.path.join(HERE, "clusters.json"), "w") as f:
    json.dump(manifest, f, indent=1)
print(f"\nwrote clusters.json ({len(manifest)} clusters)")

# ---- colour-keyed render --------------------------------------------------
PALETTE = [
    (1.00, 0.15, 0.15), (0.15, 0.55, 1.00), (1.00, 0.85, 0.10),
    (0.20, 1.00, 0.35), (1.00, 0.40, 0.90), (0.10, 1.00, 0.95),
    (1.00, 0.55, 0.10), (0.65, 0.35, 1.00), (0.55, 1.00, 0.10),
    (1.00, 0.10, 0.55), (0.35, 0.75, 0.70), (0.90, 0.70, 0.45),
]

for i, g in enumerate(ordered):
    if i >= 26:      # only key the props that matter; rest go grey
        col = (0.14, 0.14, 0.16, 1)
        emit = 0.0
    else:
        r, gg, b = PALETTE[i % len(PALETTE)]
        # vary brightness per cycle so repeats are distinguishable
        k = 1.0 - 0.45 * (i // len(PALETTE))
        col = (r * k, gg * k, b * k, 1)
        emit = 1.0
    m = bpy.data.materials.new(f"KEY_{i:02d}")
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = col
    if "Emission Color" in bsdf.inputs:
        bsdf.inputs["Emission Color"].default_value = col
        bsdf.inputs["Emission Strength"].default_value = emit
    bsdf.inputs["Roughness"].default_value = 0.85
    for n in g:
        ob = bpy.data.objects[n]
        if not hasattr(ob.data, "materials"):
            continue
        ob.data.materials.clear()
        ob.data.materials.append(m)

r = scene.render
r.resolution_x, r.resolution_y = 1400, 880
r.image_settings.file_format = "PNG"
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 24
scene.cycles.use_denoising = True

if "Camera" in bpy.data.objects:
    scene.camera = bpy.data.objects["Camera"]
    r.filepath = os.path.join(OUT, "10_cluster_key")
    bpy.ops.render.render(write_still=True)
    print("wrote 10_cluster_key.png")

# a second angle looking down the desk wall
cam_data = bpy.data.cameras.new("C2")
cam_data.lens = 40
cam = bpy.data.objects.new("C2", cam_data)
scene.collection.objects.link(cam)
cam.location = Vector((1.2, -6.2, 2.6))
cam.rotation_euler = (Vector((1.2, 1.4, 1.1)) - cam.location).to_track_quat(
    "-Z", "Y").to_euler()
scene.camera = cam
r.filepath = os.path.join(OUT, "11_cluster_desk")
bpy.ops.render.render(write_still=True)
print("wrote 11_cluster_desk.png")
