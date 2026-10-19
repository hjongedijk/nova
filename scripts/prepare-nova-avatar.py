#!/usr/bin/env python3
"""Strip textures and hair meshes from TalkingHead's CC0 MPFB example, preserving rig and visemes.

Usage: python3 scripts/prepare-nova-avatar.py mpfb.glb nova-human.glb
Source and license: docs/third-party-assets.md
"""
import json
from pathlib import Path
import struct
import sys

source = Path(sys.argv[1]).read_bytes()
assert source[:4] == b"glTF"
size = struct.unpack_from("<I", source, 12)[0]
model = json.loads(source[20:20 + size])
binary = source[28 + size:]
allowed = {"base", "high-poly", "teeth_base", "tongue01"}
meshes = {i: m for i, m in enumerate(model["meshes"]) if m.get("name") in allowed}
mesh_map = {old: new for new, old in enumerate(meshes)}
for node in model["nodes"]:
    if "mesh" in node:
        if node["mesh"] in mesh_map:
            node["mesh"] = mesh_map[node["mesh"]]
        else:
            node.pop("mesh")
model["meshes"] = list(meshes.values())
needed = set()
for mesh in model["meshes"]:
    for primitive in mesh["primitives"]:
        primitive["attributes"].pop("TEXCOORD_0", None)
        needed.update(primitive["attributes"].values())
        needed.add(primitive["indices"])
        for target in primitive.get("targets", []):
            needed.update(target.values())
        primitive["material"] = 0
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
model["materials"] = [{"name": "NOVA hologram", "pbrMetallicRoughness": {
    "baseColorFactor": [0.08, 0.45, 0.6, 1], "metallicFactor": 0.15, "roughnessFactor": 0.45}}]
for key in ["images", "textures", "samplers"]:
    model.pop(key, None)
model["asset"]["copyright"] = "MPFB avatar from met4citizen/TalkingHead, CC0; optimized for NOVA"
encoded = json.dumps(model, separators=(",", ":")).encode()
encoded += b" " * (-len(encoded) % 4)
output += b"\x00" * (-len(output) % 4)
result = struct.pack("<4sII", b"glTF", 2, 28 + len(encoded) + len(output))
result += struct.pack("<I4s", len(encoded), b"JSON") + encoded
result += struct.pack("<I4s", len(output), b"BIN\x00") + output
Path(sys.argv[2]).write_bytes(result)
print(f"Preserved {len(model['meshes'])} meshes, rig and morph targets; {len(result)} bytes")
