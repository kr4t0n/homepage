#!/usr/bin/env python3
"""Diff two .blend scenes: what objects appeared, vanished or moved.

Run: tools/.venv/bin/python tools/diff_blend.py room.blend room-v2.blend
"""
import os
import sys

import bpy
from mathutils import Vector


def world_bbox(ob):
    cs = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    mn = Vector((min(c.x for c in cs), min(c.y for c in cs), min(c.z for c in cs)))
    mx = Vector((max(c.x for c in cs), max(c.y for c in cs), max(c.z for c in cs)))
    return mn, mx


def scan(path):
    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(path))
    out = {}
    for o in bpy.context.scene.objects:
        if o.type not in {"MESH", "FONT"}:
            out[o.name] = (o.type, None, None, 0, "")
            continue
        mn, mx = world_bbox(o)
        tris = 0
        if o.type == "MESH":
            tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
        body = o.data.body if o.type == "FONT" else ""
        out[o.name] = (o.type, tuple(round(v, 3) for v in mn),
                       tuple(round(v, 3) for v in mx), tris, body)
    return out


a = scan(sys.argv[1])
b = scan(sys.argv[2])

added = sorted(set(b) - set(a))
removed = sorted(set(a) - set(b))
print(f"{sys.argv[1]}: {len(a)} objects    {sys.argv[2]}: {len(b)} objects")
print(f"added={len(added)} removed={len(removed)}\n")

if removed:
    print("REMOVED:", ", ".join(removed[:40]), "\n")

# Group added objects by rounded position so a board of many tiles reads as one.
print("ADDED:")
gmn = Vector((1e9,) * 3)
gmx = Vector((-1e9,) * 3)
by_type = {}
fonts = []
for n in added:
    t, mn, mx, tris, body = b[n]
    by_type.setdefault(t, []).append(n)
    if mn:
        gmn = Vector((min(gmn.x, mn[0]), min(gmn.y, mn[1]), min(gmn.z, mn[2])))
        gmx = Vector((max(gmx.x, mx[0]), max(gmx.y, mx[1]), max(gmx.z, mx[2])))
    if t == "FONT":
        fonts.append((n, body))
for t, names in by_type.items():
    tris = sum(b[n][3] for n in names)
    print(f"  {t:6} x{len(names):<5} tris={tris:,}")
    print(f"         e.g. {', '.join(names[:8])}")
print(f"\n  combined bbox  X[{gmn.x:.3f},{gmx.x:.3f}]  "
      f"Y[{gmn.y:.3f},{gmx.y:.3f}]  Z[{gmn.z:.3f},{gmx.z:.3f}]")
print(f"  size           {gmx.x-gmn.x:.3f} x {gmx.y-gmn.y:.3f} x {gmx.z-gmn.z:.3f}")

if fonts:
    print(f"\n  FONT bodies ({len(fonts)}):")
    for n, body in fonts[:80]:
        print(f"    {n:28} {body!r}")
