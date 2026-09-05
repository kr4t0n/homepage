#!/usr/bin/env python3
"""Source vs export, from an arbitrary camera.

Renders the same framing from the original .blend and from our exported GLB, so
a suspect object can be compared directly. Defaults to the front-right of the
room, where the MIDI keyboard sits.

Run: ./.venv/bin/python compare_view.py [eyeX eyeY eyeZ atX atY atZ] [name]
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

args = sys.argv[1:]
if len(args) >= 6:
    EYE = Vector(tuple(float(v) for v in args[0:3]))
    AT = Vector(tuple(float(v) for v in args[3:6]))
    NAME = args[6] if len(args) > 6 else "view"
else:
    EYE = Vector((-0.9, -8.6, 2.3))
    AT = Vector((2.6, -3.4, 0.80))
    NAME = "midi"


def build(label):
    sc = bpy.context.scene
    for o in list(sc.objects):
        if o.type in ("LIGHT", "CAMERA"):
            bpy.data.objects.remove(o, do_unlink=True)

    sc.render.resolution_x, sc.render.resolution_y = 1200, 760
    sc.render.image_settings.file_format = "PNG"
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 40
    sc.cycles.use_denoising = True

    # Bright and neutral. The point is to see the geometry, not the mood.
    sc.world = sc.world or bpy.data.worlds.new("W")
    sc.world.use_nodes = True
    bg = sc.world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (1, 1, 1, 1)
    bg.inputs["Strength"].default_value = 1.4
    sc.view_settings.view_transform = "Standard"

    cd = bpy.data.cameras.new("C")
    cd.lens = 40
    cam = bpy.data.objects.new("C", cd)
    sc.collection.objects.link(cam)
    cam.location = EYE
    cam.rotation_euler = (AT - EYE).to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam

    path = os.path.join(OUT, f"cmp_{NAME}_{label}")
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print(f"  wrote cmp_{NAME}_{label}.png")


print(f"eye={tuple(round(v,2) for v in EYE)} at={tuple(round(v,2) for v in AT)}")

bpy.ops.wm.open_mainfile(filepath=BLEND)
build("A_source")

bpy.ops.wm.read_homefile(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
build("B_glb")
