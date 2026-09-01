#!/usr/bin/env python3
"""Locate the monitor screen faces and emit their world-space placement.

The screens are merged into one node at export, so the frontend cannot address
an individual panel. Instead of splitting the mesh, this reports each screen's
centre, normal and in-plane axes, which is enough to lay an independent textured
plane exactly over it in the scene.

Emits glTF-space (Y up) values, matching src/scene-manifest.json.

Run: ./.venv/bin/python find_screens.py ../ZEFUHEZF.blend
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

BLEND = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "../ZEFUHEZF.blend")
HERE = os.path.dirname(os.path.abspath(__file__))

bpy.ops.wm.open_mainfile(filepath=BLEND)
scene = bpy.context.scene

# Same box the exporter uses for the `screens` group.
BOX = (-0.70, 2.90, 0.95, 2.10, 0.95, 1.90)


def in_box(c):
    x0, x1, y0, y1, z0, z1 = BOX
    return x0 <= c.x <= x1 and y0 <= c.y <= y1 and z0 <= c.z <= z1


def to_gltf(v):
    """Blender Z-up to glTF Y-up: (x, y, z) -> (x, z, -y)."""
    return [round(v.x, 4), round(v.z, 4), round(-v.y, 4)]


found = []
for ob in scene.objects:
    if ob.type != "MESH":
        continue
    mw = ob.matrix_world
    corners = [mw @ Vector(c) for c in ob.bound_box]
    centre = sum(corners, Vector()) / 8
    if not in_box(centre):
        continue

    # The screen is the largest planar face on the object.
    best = None
    for poly in ob.data.polygons:
        area = poly.area * (mw.to_scale().x * mw.to_scale().y)
        if best is None or area > best[0]:
            best = (area, poly)
    if best is None:
        continue
    _, poly = best

    wc = mw @ poly.center
    # World normal, ignoring translation.
    n = (mw.to_3x3() @ poly.normal).normalized()

    # In-plane axes from the face's own edges, so width/height match the panel
    # rather than the world axes.
    verts = [mw @ ob.data.vertices[i].co for i in poly.vertices]
    if len(verts) < 3:
        continue
    u = (verts[1] - verts[0]).normalized()
    v = n.cross(u).normalized()
    us = [(p - wc).dot(u) for p in verts]
    vs = [(p - wc).dot(v) for p in verts]
    width = max(us) - min(us)
    height = max(vs) - min(vs)
    if width < 0.05 or height < 0.05:
        continue

    # Screens face roughly horizontally; skip desk surfaces and shelves.
    if abs(n.z) > 0.75:
        continue

    found.append(
        {
            "object": ob.name,
            "area": round(best[0], 4),
            "width": round(width, 4),
            "height": round(height, 4),
            "aspect": round(width / height, 3) if height else 0,
            "centre_gltf": to_gltf(wc),
            "normal_gltf": to_gltf(n),
            "u_axis_gltf": to_gltf(u),
            "yaw_deg": round(math.degrees(math.atan2(n.x, -n.y)), 2),
            "materials": [m.name for m in ob.data.materials if m],
        }
    )

found.sort(key=lambda f: -f["area"])
print(f"{'object':<14} {'w x h':<16} {'aspect':<7} {'centre (glTF)':<26} yaw")
for f in found:
    c = f["centre_gltf"]
    print(
        f"{f['object']:<14} {f['width']:.3f} x {f['height']:.3f}    "
        f"{f['aspect']:<7} ({c[0]:6.2f},{c[1]:6.2f},{c[2]:6.2f})   {f['yaw_deg']:>7.1f}"
    )

out = os.path.join(HERE, "screens.json")
with open(out, "w") as fh:
    json.dump(found, fh, indent=1)
print(f"\nwrote {out} ({len(found)} faces)")
