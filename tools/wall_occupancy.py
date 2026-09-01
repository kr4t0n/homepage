#!/usr/bin/env python3
"""List what is mounted on the back wall, so a sign can be placed in a gap.

Reports every object sitting near the wall plane with its glTF-space extents,
then scans for horizontal bands of clear wall.

Run: ./.venv/bin/python wall_occupancy.py ../ZEFUHEZF.blend
"""
import os
import sys

import bpy
from mathutils import Vector

BLEND = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "../ZEFUHEZF.blend")
bpy.ops.wm.open_mainfile(filepath=BLEND)
scene = bpy.context.scene

# Room-facing surface of the back wall, and how far out to count as "mounted".
WALL_Z = -1.99
DEPTH = 0.55
WALL_X = (-2.09, 4.49)
WALL_Y = (-0.21, 2.61)


def gltf_bounds(ob):
    mw = ob.matrix_world
    pts = [mw @ Vector(c) for c in ob.bound_box]
    xs = [p.x for p in pts]
    ys = [p.z for p in pts]          # Blender Z -> glTF Y
    zs = [-p.y for p in pts]         # Blender Y -> glTF -Z
    return (min(xs), max(xs)), (min(ys), max(ys)), (min(zs), max(zs))


mounted = []
for ob in scene.objects:
    if ob.type != "MESH":
        continue
    (x0, x1), (y0, y1), (z0, z1) = gltf_bounds(ob)
    if x1 - x0 > 5.5 or y1 - y0 > 5.5:      # the shell itself
        continue
    # Near the wall plane, in front of it.
    if not (WALL_Z - 0.2 <= z1 <= WALL_Z + DEPTH):
        continue
    if x1 < WALL_X[0] or x0 > WALL_X[1]:
        continue
    mounted.append((x0, x1, y0, y1, ob.name))

mounted.sort()
print(f"{'object':<14} {'x range':<18} {'y range':<18}")
for x0, x1, y0, y1, name in mounted:
    print(f"{name:<14} {x0:6.2f} .. {x1:6.2f}   {y0:6.2f} .. {y1:6.2f}")

# Find clear vertical bands in the upper half of the wall.
print(f"\nclear x bands above y=1.55 (wall x {WALL_X[0]} .. {WALL_X[1]}):")
STEP = 0.05
band = None
bands = []
x = WALL_X[0]
while x <= WALL_X[1]:
    blocked = any(
        x0 - 0.12 <= x <= x1 + 0.12 and y1 > 1.55 for x0, x1, y0, y1, _ in mounted
    )
    if not blocked and band is None:
        band = x
    elif blocked and band is not None:
        bands.append((band, x))
        band = None
    x += STEP
if band is not None:
    bands.append((band, WALL_X[1]))

for a, b in bands:
    if b - a >= 0.5:
        print(f"  x {a:6.2f} .. {b:6.2f}   width {b - a:.2f}   centre {(a + b) / 2:.2f}")
