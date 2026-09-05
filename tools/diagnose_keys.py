#!/usr/bin/env python3
"""Three-way render of the MIDI keyboard, to locate where it breaks.

  A  the original .blend, materials as authored
  B  our exported room.glb, materials as exported
  C  our exported room.glb, one uniform DOUBLE-SIDED material

A vs B separates a source problem from an export problem. B vs C separates a
material problem from a winding/normals problem: if C shows keycaps that B does
not, the faces exist but point the wrong way, which this asset has form for.

Run: ./.venv/bin/python diagnose_keys.py
"""
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
BLEND = os.path.join(HERE, "..", "room.blend")
GLB = os.path.join(HERE, "..", "public", "room.glb")
OUT = os.path.join(HERE, "preview")
os.makedirs(OUT, exist_ok=True)

# The MIDI keyboard region, in Blender coords (Z up).
FOCUS = Vector((1.89, -3.70, 0.62))
EYE = Vector((3.30, -6.00, 2.35))


def setup_render():
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = 1100, 780
    sc.render.image_settings.file_format = "PNG"
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 40
    sc.cycles.use_denoising = True
    return sc


def add_camera(sc, eye, look):
    cam_data = bpy.data.cameras.new("Diag")
    cam_data.lens = 50
    cam = bpy.data.objects.new("Diag", cam_data)
    sc.collection.objects.link(cam)
    cam.location = eye
    cam.rotation_euler = (look - eye).to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam
    return cam


def add_light(sc, at):
    d = bpy.data.lights.new("Key", type="AREA")
    d.energy = 900
    d.size = 3
    o = bpy.data.objects.new("Key", d)
    sc.collection.objects.link(o)
    o.location = at + Vector((1.5, -1.5, 3.0))
    o.rotation_euler = (Vector((0, 0, 0)) - Vector((1.5, -1.5, 3.0))).to_track_quat(
        "-Z", "Y"
    ).to_euler()


def strip_lights():
    for o in list(bpy.context.scene.objects):
        if o.type in ("LIGHT", "CAMERA"):
            bpy.data.objects.remove(o, do_unlink=True)


def tri_report(label):
    total = 0
    rows = []
    for o in bpy.context.scene.objects:
        if o.type != "MESH":
            continue
        c = o.matrix_world.translation
        # Only the keyboard neighbourhood.
        if (Vector((c.x, c.y, c.z)) - FOCUS).length > 2.2:
            continue
        t = sum(len(p.vertices) - 2 for p in o.data.polygons)
        total += t
        rows.append((t, o.name))
    rows.sort(reverse=True)
    print(f"\n[{label}] meshes near the keyboard: {len(rows)}, {total:,} tris")
    for t, n in rows[:8]:
        print(f"    {t:>7,}  {n}")


def shoot(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print(f"  wrote {os.path.basename(path)}.png")


# ---- A: the original .blend ----------------------------------------------
bpy.ops.wm.open_mainfile(filepath=BLEND)
tri_report("A source .blend")
strip_lights()
sc = setup_render()
add_camera(sc, EYE, FOCUS)
add_light(sc, FOCUS)
shoot(os.path.join(OUT, "keys_A_source"))

# ---- B: our exported GLB --------------------------------------------------
bpy.ops.wm.read_homefile(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
# glTF is Y-up; the importer rotates it back to Blender's Z-up, so the same
# camera works.
tri_report("B exported .glb")
strip_lights()
sc = setup_render()
add_camera(sc, EYE, FOCUS)
add_light(sc, FOCUS)
shoot(os.path.join(OUT, "keys_B_glb"))

# ---- C: same GLB, uniform double-sided material ---------------------------
flat = bpy.data.materials.new("FLAT")
flat.use_backface_culling = False
flat.use_nodes = True
b = flat.node_tree.nodes["Principled BSDF"]
b.inputs["Base Color"].default_value = (0.62, 0.64, 0.68, 1)
b.inputs["Roughness"].default_value = 0.7
for o in bpy.context.scene.objects:
    if o.type == "MESH" and hasattr(o.data, "materials"):
        o.data.materials.clear()
        o.data.materials.append(flat)
shoot(os.path.join(OUT, "keys_C_glb_doublesided"))

print("\ndone ->", OUT)
