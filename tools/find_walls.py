#!/usr/bin/env python3
"""Locate the room's wall planes and report where things can be mounted.

The shell is merged into `static_shell` at export, so the frontend has no way to
ask where a wall is. This measures the large vertical faces and prints each as a
plane plus in-plane extents, in glTF space (Y up), which is enough to place a
sign flat against one.

Run: ./.venv/bin/python find_walls.py ../room.blend
"""
import json
import os
import sys

import bpy
from mathutils import Vector

BLEND = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "../room.blend")
HERE = os.path.dirname(os.path.abspath(__file__))

bpy.ops.wm.open_mainfile(filepath=BLEND)
scene = bpy.context.scene


def to_gltf(v):
    """Blender Z-up to glTF Y-up: (x, y, z) -> (x, z, -y)."""
    return [round(v.x, 4), round(v.z, 4), round(-v.y, 4)]


faces = []
for ob in scene.objects:
    if ob.type != "MESH":
        continue
    mw = ob.matrix_world
    scale = mw.to_scale()
    for poly in ob.data.polygons:
        area = poly.area * scale.x * scale.y
        if area < 3.0:                       # walls only, not props
            continue
        n = (mw.to_3x3() @ poly.normal).normalized()
        if abs(n.z) > 0.4:                   # skip floors and ceilings
            continue
        wc = mw @ poly.center
        verts = [mw @ ob.data.vertices[i].co for i in poly.vertices]
        u = (verts[1] - verts[0]).normalized()
        v = n.cross(u).normalized()
        us = [(p - wc).dot(u) for p in verts]
        vs = [(p - wc).dot(v) for p in verts]
        faces.append(
            {
                "object": ob.name,
                "area": round(area, 3),
                "centre_gltf": to_gltf(wc),
                "normal_gltf": to_gltf(n),
                "u_axis_gltf": to_gltf(u),
                "u_range": [round(min(us), 3), round(max(us), 3)],
                "v_range": [round(min(vs), 3), round(max(vs), 3)],
                "width": round(max(us) - min(us), 3),
                "height": round(max(vs) - min(vs), 3),
            }
        )

faces.sort(key=lambda f: -f["area"])
print(f"{'object':<12} {'area':>7}  {'w x h':<15} {'centre (glTF)':<26} normal")
for f in faces[:12]:
    c, n = f["centre_gltf"], f["normal_gltf"]
    print(
        f"{f['object']:<12} {f['area']:>7.2f}  {f['width']:5.2f} x {f['height']:5.2f}   "
        f"({c[0]:6.2f},{c[1]:6.2f},{c[2]:6.2f})   ({n[0]:5.2f},{n[1]:5.2f},{n[2]:5.2f})"
    )

out = os.path.join(HERE, "walls.json")
with open(out, "w") as fh:
    json.dump(faces, fh, indent=1)
print(f"\nwrote {out} ({len(faces)} faces)")
