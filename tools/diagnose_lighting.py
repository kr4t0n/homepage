#!/usr/bin/env python3
"""Is the DJ controller dark because of its materials, or because of our lights?

Loads the exported GLB, prints the base colours of the controller's materials,
then renders it twice: once with a bright neutral light, and once with a rig
matching the site's (dim ambient plus one directional, ACES-ish exposure).

If the colours are light and only the second render goes black, the asset is
fine and the scene lighting is the problem.

Run: ./.venv/bin/python diagnose_lighting.py
"""
import os

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
GLB = os.path.join(HERE, "..", "public", "room.glb")
OUT = os.path.join(HERE, "preview")
os.makedirs(OUT, exist_ok=True)

FOCUS = Vector((1.89, -3.70, 0.62))
EYE = Vector((3.30, -6.00, 2.35))

bpy.ops.wm.read_homefile(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
sc = bpy.context.scene

# ---- what colour is it, really? -------------------------------------------
deck = next((o for o in sc.objects if o.name.startswith("hot_djcontroller")), None)
print(f"object: {deck.name if deck else 'NOT FOUND'}")
if deck:
    seen = []
    for m in deck.data.materials:
        if not m or not m.node_tree:
            continue
        b = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if not b:
            continue
        c = b.inputs["Base Color"].default_value
        e = b.inputs["Emission Color"].default_value if "Emission Color" in b.inputs else (0, 0, 0, 1)
        es = b.inputs["Emission Strength"].default_value if "Emission Strength" in b.inputs else 0
        lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
        seen.append((lum, m.name, tuple(round(v, 3) for v in c[:3]),
                     tuple(round(v, 2) for v in e[:3]), round(es, 2)))
    seen.sort(reverse=True)
    print(f"{'material':<18}{'luma':<8}{'base colour':<26}{'emission':<20}strength")
    for lum, name, c, e, es in seen:
        print(f"{name:<18}{lum:<8.3f}{str(c):<26}{str(e):<20}{es}")
    print(f"\n{len(seen)} materials, mean luma "
          f"{sum(s[0] for s in seen) / max(len(seen), 1):.3f}")


def camera():
    d = bpy.data.cameras.new("C")
    d.lens = 50
    o = bpy.data.objects.new("C", d)
    sc.collection.objects.link(o)
    o.location = EYE
    o.rotation_euler = (FOCUS - EYE).to_track_quat("-Z", "Y").to_euler()
    sc.camera = o


def clear_lights():
    for o in list(sc.objects):
        if o.type == "LIGHT":
            bpy.data.objects.remove(o, do_unlink=True)


def world(strength, colour):
    sc.world = sc.world or bpy.data.worlds.new("W")
    sc.world.use_nodes = True
    bg = sc.world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (*colour, 1)
    bg.inputs["Strength"].default_value = strength


def sun(energy, at, colour):
    d = bpy.data.lights.new("Sun", type="SUN")
    d.energy = energy
    d.color = colour
    o = bpy.data.objects.new("Sun", d)
    sc.collection.objects.link(o)
    o.rotation_euler = (Vector((0, 0, 0)) - Vector(at)).to_track_quat("-Z", "Y").to_euler()


sc.render.resolution_x, sc.render.resolution_y = 1100, 780
sc.render.image_settings.file_format = "PNG"
sc.render.engine = "CYCLES"
sc.cycles.device = "CPU"
sc.cycles.samples = 40
sc.cycles.use_denoising = True
camera()

# Bright neutral reference.
clear_lights()
world(1.6, (1, 1, 1))
sc.view_settings.view_transform = "Standard"
sc.view_settings.exposure = 0
sc.render.filepath = os.path.join(OUT, "light_1_neutral")
bpy.ops.render.render(write_still=True)
print("\nwrote light_1_neutral.png (bright neutral)")

# The site's rig: dim cool ambient, one directional, ACES at low exposure.
clear_lights()
world(0.18, (0.486, 0.573, 0.8))
sun(0.75, (7, 10, 7), (0.804, 0.851, 1.0))
sc.view_settings.view_transform = "AgX"
sc.view_settings.exposure = -0.47          # roughly toneMappingExposure 0.72
sc.render.filepath = os.path.join(OUT, "light_2_site_rig")
bpy.ops.render.render(write_still=True)
print("wrote light_2_site_rig.png (matching the site)")
