"""Is the DJ controller dark because of its materials, or because of our lights?

Loads the exported GLB, prints the base colours of the controller's materials,
then renders it twice: once with a bright neutral light, and once under the
site's key and ambient at its exposure, read from src/three/, with none of the
site's fill.

If the colours are light and only the second render goes black, the asset is
fine and the scene lighting is the problem.

Run: uv run --project tools --group blender python tools/diagnose_lighting.py
"""

import math
import os
import re
import tempfile

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
GLB = os.path.join(HERE, "..", "public", "room.glb")
OUT = tempfile.mkdtemp(prefix="homepage-diagnose_lighting-")

FOCUS = Vector((1.89, -3.70, 0.62))
EYE = Vector((3.30, -6.00, 2.35))

with open(os.path.join(HERE, "..", "src", "three", "Scene.tsx")) as f:
    SCENE = f.read()
with open(os.path.join(HERE, "..", "src", "three", "lighting.ts")) as f:
    RIG = f.read()


def find(pattern, text):
    m = re.search(pattern, text)
    if not m:
        raise SystemExit(f"nothing in src/three/ matches {pattern}; update this script")
    return m.group(1)


def site_light(tag, level):
    """Strength, linear colour and JSX element of the site's light at `lighting.<level>`."""
    el = find(rf"(<{tag}\b[^>]*intensity=\{{lighting\.{level}\}}[^>]*>)", SCENE)
    name = find(r"color=\{(\w+)\}", el)
    hex_ = find(rf"\b{name} = new THREE\.Color\('#([0-9a-fA-F]{{6}})'\)", RIG)
    # three.js converts an sRGB hex to linear, the space Blender's colours are in.
    srgb = (int(hex_[i : i + 2], 16) / 255 for i in (0, 2, 4))
    colour = tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb)
    return float(find(rf"\b{level}: ([\d.]+),", RIG)), colour, el


KEY, KEY_COLOUR, key_el = site_light("directionalLight", "key")
AMBIENT, AMBIENT_COLOUR, _ = site_light("ambientLight", "ambient")
x, y, z = (float(v) for v in find(r"position=\{\[([^\]]+)\]\}", key_el).split(","))
KEY_AT = (x, -z, y)  # the site's position is glTF's Y-up
EXPOSURE = float(find(r"\bexposure: ([\d.]+),", RIG))

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
        e = (
            b.inputs["Emission Color"].default_value
            if "Emission Color" in b.inputs
            else (0, 0, 0, 1)
        )
        es = b.inputs["Emission Strength"].default_value if "Emission Strength" in b.inputs else 0
        lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
        seen.append(
            (
                lum,
                m.name,
                tuple(round(v, 3) for v in c[:3]),
                tuple(round(v, 2) for v in e[:3]),
                round(es, 2),
            )
        )
    seen.sort(reverse=True)
    print(f"{'material':<18}{'luma':<8}{'base colour':<26}{'emission':<20}strength")
    for lum, name, c, e, es in seen:
        print(f"{name:<18}{lum:<8.3f}{str(c):<26}{str(e):<20}{es}")
    print(f"\n{len(seen)} materials, mean luma {sum(s[0] for s in seen) / max(len(seen), 1):.3f}")


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

# The site's key and ambient, no fill; AgX stands in for the site's ACES. three.js
# lights a diffuse surface by intensity/pi from both, as Cycles does from a sun,
# but Cycles lights it by a world's full strength.
clear_lights()
world(AMBIENT / math.pi, AMBIENT_COLOUR)
sun(KEY, KEY_AT, KEY_COLOUR)
sc.view_settings.view_transform = "AgX"
sc.view_settings.exposure = math.log2(EXPOSURE)
sc.render.filepath = os.path.join(OUT, "light_2_site_key")
bpy.ops.render.render(write_still=True)
print("wrote light_2_site_key.png (the site's key and ambient, none of its fill, AgX for ACES)")

print("\ndone ->", OUT)
