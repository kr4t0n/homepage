#!/usr/bin/env python3
"""Open the purchased .blend, report a real scene inventory, and render previews.

Run:  ./.venv/bin/python inspect_scene.py ../ZEFUHEZF.blend
"""
import math
import os
import sys

import bpy
from mathutils import Vector

BLEND = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "../ZEFUHEZF.blend")
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "preview"))
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.open_mainfile(filepath=BLEND)
print(f"opened: {BLEND}")

scene = bpy.context.scene
deps = bpy.context.evaluated_depsgraph_get()


def world_bbox(ob):
    """(min Vector, max Vector) of an object's world-space bounding box."""
    corners = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    mn = Vector((min(c.x for c in corners),
                 min(c.y for c in corners),
                 min(c.z for c in corners)))
    mx = Vector((max(c.x for c in corners),
                 max(c.y for c in corners),
                 max(c.z for c in corners)))
    return mn, mx


meshes = [o for o in scene.objects if o.type == "MESH"]
print(f"\nobjects={len(scene.objects)} meshes={len(meshes)} "
      f"materials={len(bpy.data.materials)} images={len(bpy.data.images)}")

# ---- scene bounds ---------------------------------------------------------
gmn = Vector((1e9,) * 3)
gmx = Vector((-1e9,) * 3)
info = []
for o in meshes:
    mn, mx = world_bbox(o)
    d = mx - mn
    info.append({"ob": o, "min": mn, "max": mx, "dim": d,
                 "vol": d.x * d.y * d.z,
                 "ctr": (mn + mx) / 2,
                 "tris": sum(len(p.vertices) - 2 for p in o.data.polygons)})
    # ignore the giant floor plane when computing the "room" bounds
    if d.x < 20 and d.y < 20:
        gmn = Vector((min(gmn.x, mn.x), min(gmn.y, mn.y), min(gmn.z, mn.z)))
        gmx = Vector((max(gmx.x, mx.x), max(gmx.y, mx.y), max(gmx.z, mx.z)))

print(f"room bounds  X[{gmn.x:.2f},{gmx.x:.2f}]  "
      f"Y[{gmn.y:.2f},{gmx.y:.2f}]  Z[{gmn.z:.2f},{gmx.z:.2f}]")
print(f"room size    {gmx.x-gmn.x:.2f} x {gmx.y-gmn.y:.2f} x {gmx.z-gmn.z:.2f} m")
print(f"total tris   {sum(i['tris'] for i in info):,}")

# ---- biggest objects ------------------------------------------------------
print("\n## 30 LARGEST OBJECTS (by bbox volume)")
print(f"  {'name':<20} {'dims (m)':<26} {'centre':<26} {'tris':>7}  materials")
for i in sorted(info, key=lambda x: -x["vol"])[:30]:
    o, d, c = i["ob"], i["dim"], i["ctr"]
    mats = ",".join(m.name for m in o.data.materials if m)[:34]
    print(f"  {o.name:<20} {d.x:6.2f}x{d.y:6.2f}x{d.z:6.2f}      "
          f"{c.x:7.2f},{c.y:7.2f},{c.z:7.2f}   {i['tris']:>7,}  {mats}")

# ---- screen candidates: large, flat, near-vertical -----------------------
print("\n## SCREEN CANDIDATES (flat slabs, area>0.05m^2, thin axis<0.06m)")
cands = []
for i in info:
    d = sorted([i["dim"].x, i["dim"].y, i["dim"].z])
    thin, mid, big = d
    if thin < 0.06 and mid > 0.15 and big > 0.2:
        area = mid * big
        if area > 0.05:
            cands.append((area, i))
for area, i in sorted(cands, key=lambda x: -x[0])[:20]:
    o, d, c = i["ob"], i["dim"], i["ctr"]
    print(f"  {o.name:<20} {d.x:6.3f}x{d.y:6.3f}x{d.z:6.3f}  "
          f"area={area:5.3f}m2  centre=({c.x:6.2f},{c.y:6.2f},{c.z:6.2f})  "
          f"tris={i['tris']:>5,}")

# ---- emissive / bright materials -----------------------------------------
print("\n## MATERIALS WITH EMISSION OR IMAGE TEXTURES")
n = 0
for m in bpy.data.materials:
    if not m.use_nodes:
        continue
    emis, imgs = None, []
    for node in m.node_tree.nodes:
        if node.type == "EMISSION":
            emis = tuple(round(v, 2) for v in node.inputs["Color"].default_value)
        if node.type == "BSDF_PRINCIPLED":
            for key in ("Emission Color", "Emission"):
                if key in node.inputs:
                    st = node.inputs.get("Emission Strength")
                    if st is not None and st.default_value > 0:
                        emis = tuple(round(v, 2)
                                     for v in node.inputs[key].default_value)
        if node.type == "TEX_IMAGE" and node.image:
            imgs.append(node.image.name)
    if emis or imgs:
        n += 1
        users = [o.name for o in meshes if m.name in
                 [mm.name for mm in o.data.materials if mm]][:4]
        print(f"  {m.name:<18} emis={emis} img={imgs} used_by={users}")
if n == 0:
    print("  (none)")

# ---- missing textures -----------------------------------------------------
print("\n## IMAGE FILES")
for im in bpy.data.images:
    if im.name == "Render Result":
        continue
    p = bpy.path.abspath(im.filepath)
    print(f"  {'OK    ' if os.path.exists(p) else 'MISSING'}  "
          f"{im.name:<38} {im.filepath}")

# ---- lights ---------------------------------------------------------------
print("\n## LIGHTS")
for o in scene.objects:
    if o.type == "LIGHT":
        l = o.data
        print(f"  {o.name:<12} {l.type:<6} energy={l.energy:<10.1f} "
              f"color={tuple(round(v,2) for v in l.color)} "
              f"pos=({o.location.x:.2f},{o.location.y:.2f},{o.location.z:.2f})")

# ---- renders --------------------------------------------------------------
r = scene.render
r.resolution_x, r.resolution_y = 1100, 680
r.resolution_percentage = 100
r.film_transparent = False
r.image_settings.file_format = "PNG"

try:
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    engine = "eevee"
except TypeError:
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    engine = "cycles"
print(f"\nrendering with {scene.render.engine}")

ctr = (gmn + gmx) / 2
radius = max((gmx - gmn).x, (gmx - gmn).y) * 1.15

cam_data = bpy.data.cameras.new("PreviewCam")
cam_data.lens = 32
cam = bpy.data.objects.new("PreviewCam", cam_data)
scene.collection.objects.link(cam)


def shoot(name, loc, look_at, lens=32):
    cam_data.lens = lens
    cam.location = Vector(loc)
    d = Vector(look_at) - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    r.filepath = os.path.join(OUT, name)
    bpy.ops.render.render(write_still=True)
    print(f"  wrote {name}.png")


# original camera the seller framed the product shot with
if "Camera" in bpy.data.objects:
    scene.camera = bpy.data.objects["Camera"]
    r.filepath = os.path.join(OUT, "00_seller_camera")
    bpy.ops.render.render(write_still=True)
    print("  wrote 00_seller_camera.png")

shoot("01_iso_front", (ctr.x + radius, ctr.y - radius, ctr.z + radius * 0.75), ctr)
shoot("02_iso_left", (ctr.x - radius, ctr.y - radius, ctr.z + radius * 0.7), ctr)
shoot("03_top", (ctr.x, ctr.y - 0.01, ctr.z + radius * 1.9), ctr, lens=30)
shoot("04_front", (ctr.x, ctr.y - radius * 1.5, ctr.z + 0.6), ctr, lens=40)

print("\ndone ->", OUT)
