#!/usr/bin/env python3
"""Extract NOVA's portrait from VTubeMe Sky, preserving textures, rig and expressions.

Usage: python3 scripts/prepare-nova-avatar.py sky.glb nova-human.glb
Source, pinned hash and attribution: docs/third-party-assets.md
"""
import hashlib
import json
from pathlib import Path
import struct
import sys

source = Path(sys.argv[1]).read_bytes()
assert hashlib.sha256(source).hexdigest() == "fe4cfc38504b586ba750fd872723091bec962b988b826b457e42f25e8c524bfc", "Unexpected source avatar"
assert source[:4] == b"glTF"
size = struct.unpack_from("<I", source, 12)[0]
model = json.loads(source[20:20 + size])
binary = source[28 + size:]
allowed = {"AvatarHead", "AvatarEyelashes", "AvatarLeftEyeball", "AvatarRightEyeball", "AvatarTeethLower", "AvatarTeethUpper", "outfit_shoes"}
keep = {node["mesh"] for node in model["nodes"] if node.get("name") in allowed}
mesh_map = {old: new for new, old in enumerate(sorted(keep))}
for node in model["nodes"]:
    if "mesh" in node:
        if node["mesh"] in mesh_map:
            node["mesh"] = mesh_map[node["mesh"]]
        else:
            node.pop("mesh")
model["meshes"] = [model["meshes"][i] for i in sorted(keep)]
# TalkingHead balances the hips from geometry bounds. Keep the hidden foot anchor,
# with a shared material so its clothing textures are not bundled.
anchor = next(node["mesh"] for node in model["nodes"] if node.get("name") == "outfit_shoes")
shared = model["meshes"][0]["primitives"][0]["material"]
for primitive in model["meshes"][anchor]["primitives"]:
    primitive["material"] = shared
used_materials = sorted({p["material"] for m in model["meshes"] for p in m["primitives"]})
material_map = {old: new for new, old in enumerate(used_materials)}
model["materials"] = [model["materials"][i] for i in used_materials]

def texture_refs(material):
    for container in [material, material.get("pbrMetallicRoughness", {})]:
        for key, value in container.items():
            if key.endswith("Texture") and isinstance(value, dict):
                yield value

used_textures = sorted({ref["index"] for m in model["materials"] for ref in texture_refs(m)})
texture_map = {old: new for new, old in enumerate(used_textures)}
model["textures"] = [model["textures"][i] for i in used_textures]
for material in model["materials"]:
    for ref in texture_refs(material):
        ref["index"] = texture_map[ref["index"]]
used_images = sorted({texture["source"] for texture in model["textures"]})
image_map = {old: new for new, old in enumerate(used_images)}
retained_images = [model["images"][i] for i in used_images]
for texture in model["textures"]:
    texture["source"] = image_map[texture["source"]]
needed = set()
for mesh in model["meshes"]:
    for primitive in mesh["primitives"]:
        needed.update(primitive["attributes"].values())
        needed.add(primitive["indices"])
        for target in primitive.get("targets", []):
            needed.update(target.values())
        primitive["material"] = material_map[primitive["material"]]
for skin in model.get("skins", []):
    if "inverseBindMatrices" in skin:
        needed.add(skin["inverseBindMatrices"])
for animation in model.get("animations", []):
    for sampler in animation["samplers"]:
        needed.update([sampler["input"], sampler["output"]])
accessor_map = {old: new for new, old in enumerate(sorted(needed))}
for mesh in model["meshes"]:
    for primitive in mesh["primitives"]:
        primitive["attributes"] = {k: accessor_map[v] for k, v in primitive["attributes"].items()}
        primitive["indices"] = accessor_map[primitive["indices"]]
        primitive["targets"] = [{k: accessor_map[v] for k, v in t.items()} for t in primitive.get("targets", [])]
for skin in model.get("skins", []):
    if "inverseBindMatrices" in skin:
        skin["inverseBindMatrices"] = accessor_map[skin["inverseBindMatrices"]]
for animation in model.get("animations", []):
    for sampler in animation["samplers"]:
        for key in ["input", "output"]:
            sampler[key] = accessor_map[sampler[key]]
accessors = [model["accessors"][old] for old in sorted(needed)]
views = set()
for accessor in accessors:
    if "bufferView" in accessor:
        views.add(accessor["bufferView"])
    for part in accessor.get("sparse", {}).values():
        if isinstance(part, dict) and "bufferView" in part:
            views.add(part["bufferView"])
views.update(image["bufferView"] for image in retained_images)
view_map = {old: new for new, old in enumerate(sorted(views))}
output = bytearray()
new_views = []
for old in sorted(views):
    view = dict(model["bufferViews"][old])
    offset = view.get("byteOffset", 0)
    while len(output) % 4:
        output.append(0)
    view["byteOffset"] = len(output)
    output.extend(binary[offset:offset + view["byteLength"]])
    new_views.append(view)
for accessor in accessors:
    if "bufferView" in accessor:
        accessor["bufferView"] = view_map[accessor["bufferView"]]
    for part in accessor.get("sparse", {}).values():
        if isinstance(part, dict) and "bufferView" in part:
            part["bufferView"] = view_map[part["bufferView"]]
model["accessors"] = accessors
model["bufferViews"] = new_views
model["buffers"] = [{"byteLength": len(output)}]
for image in retained_images:
    image["bufferView"] = view_map[image["bufferView"]]
model["images"] = retained_images
model["asset"]["copyright"] = "Sky by VTubeMe (https://vtubeme.com/free-vrm-avatars/sky), CC BY 4.0; portrait extraction and holographic rendering by NOVA"
encoded = json.dumps(model, separators=(",", ":")).encode()
encoded += b" " * (-len(encoded) % 4)
output += b"\x00" * (-len(output) % 4)
result = struct.pack("<4sII", b"glTF", 2, 28 + len(encoded) + len(output))
result += struct.pack("<I4s", len(encoded), b"JSON") + encoded
result += struct.pack("<I4s", len(output), b"BIN\x00") + output
Path(sys.argv[2]).write_bytes(result)
print(f"Preserved {len(model['meshes'])} meshes, rig and morph targets; {len(result)} bytes")
