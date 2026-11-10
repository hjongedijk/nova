#!/usr/bin/env bash
# Interactive ComfyUI generator: describe something, pick a type, get the file.
#   scripts/comfy-gen.sh                 (asks everything)
#   COMFY_URL=http://192.168.2.147:8188 OUT=~/comfy-output scripts/comfy-gen.sh
# Types:
#   1 foto      FLUX.1 schnell, 1920x1088 (or portrait/square), a few seconds
#   2 foto 4k   photo + refine pass, 3840x2160
#   3 beweging  short animation (~2 s, animated WebP), Wan 2.2 TI2V-5B
#   4 video     video clip (~5 s, MP4), Wan 2.2 TI2V-5B
# Needs python3 on this machine. Video types need the Wan 2.2 5B files on the ComfyUI PC (the script says which).
set -euo pipefail

COMFY_URL="${COMFY_URL:-http://192.168.2.147:8188}"
OUT="${OUT:-$HOME/comfy-output}"
mkdir -p "$OUT"

if ! curl -s -m 5 "$COMFY_URL/system_stats" >/dev/null; then
  echo "ComfyUI is not reachable at $COMFY_URL. Start run_nvidia_gpu.bat on the PC (with --listen 0.0.0.0)." >&2
  exit 1
fi

echo "ComfyUI: $COMFY_URL   ->   files go to $OUT"
echo
read -r -e -p "Describe what you want: " PROMPT
[ -n "${PROMPT// }" ] || { echo "No description given." >&2; exit 1; }

echo
echo "Type:  1) foto   2) foto 4k   3) beweging (short animation)   4) video"
read -r -p "Choice [1]: " KIND
KIND="${KIND:-1}"

echo "Format:  1) landscape 16:9   2) portrait 9:16   3) square"
read -r -p "Choice [1]: " SHAPE
SHAPE="${SHAPE:-1}"

read -r -p "How many variants [1]: " COUNT
COUNT="${COUNT:-1}"

exec python3 -I - "$COMFY_URL" "$OUT" "$KIND" "$SHAPE" "$COUNT" "$PROMPT" <<'PY'
import json, os, random, re, sys, time, urllib.parse, urllib.request, uuid

host, out, kind, shape, count, prompt = sys.argv[1:7]
count = max(1, min(int(count) if count.isdigit() else 1, 12))

def call(path, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(host + path, data=data, headers={"Content-Type": "application/json"} if data else {})
    return urllib.request.urlopen(req, timeout=timeout).read()

def models(folder):
    try:
        return json.loads(call(f"/models/{folder}"))
    except Exception:
        return []

def pick(folder, *needles):
    for name in models(folder):
        low = name.lower()
        if all(n in low for n in needles):
            return name
    return None

FLUX = pick("checkpoints", "flux") or "flux1-schnell-fp8.safetensors"

def size_photo():
    return {"1": (1920, 1088), "2": (1088, 1920), "3": (1408, 1408)}.get(shape, (1920, 1088))

def size_video():
    return {"1": (1280, 704), "2": (704, 1280), "3": (960, 960)}.get(shape, (1280, 704))

def flux_photo(seed, w, h):
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": FLUX}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["1", 1]}},
        "4": {"class_type": "EmptySD3LatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "5": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0],
              "seed": seed, "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
    }

def photo(seed):
    w, h = size_photo()
    wf = flux_photo(seed, w, h)
    wf["7"] = {"class_type": "SaveImage", "inputs": {"images": ["6", 0], "filename_prefix": "gen"}}
    return wf

def photo4k(seed):
    w, h = size_photo()
    W, H = (3840, 2160) if w > h else (2160, 3840) if h > w else (2880, 2880)
    mw, mh = (W * 2 // 3) // 16 * 16, (H * 2 // 3) // 16 * 16
    wf = flux_photo(seed, w, h)
    wf.update({
        "8": {"class_type": "ImageScale", "inputs": {"image": ["6", 0], "upscale_method": "lanczos", "width": mw, "height": mh, "crop": "center"}},
        "9": {"class_type": "VAEEncodeTiled", "inputs": {"pixels": ["8", 0], "vae": ["1", 2], "tile_size": 1024, "overlap": 64, "temporal_size": 64, "temporal_overlap": 8}},
        "10": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["9", 0],
               "seed": seed, "steps": 6, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 0.3}},
        "11": {"class_type": "VAEDecodeTiled", "inputs": {"samples": ["10", 0], "vae": ["1", 2], "tile_size": 1024, "overlap": 64, "temporal_size": 64, "temporal_overlap": 8}},
        "12": {"class_type": "ImageScale", "inputs": {"image": ["11", 0], "upscale_method": "lanczos", "width": W, "height": H, "crop": "center"}},
        "7": {"class_type": "SaveImage", "inputs": {"images": ["12", 0], "filename_prefix": "gen-4k"}},
    })
    return wf

def wan(seed, frames, as_video):
    unet = pick("diffusion_models", "wan2.2", "5b")
    te = pick("text_encoders", "umt5")
    vae = pick("vae", "wan2.2")
    missing = [n for n, v in (("diffusion_models/wan2.2_ti2v_5B_fp16.safetensors", unet),
                              ("text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", te),
                              ("vae/wan2.2_vae.safetensors", vae)) if not v]
    if missing:
        print("\nFor movement/video, Wan 2.2 TI2V-5B is missing on the ComfyUI PC. Put these files in C:\\ComfyUI\\ComfyUI\\models\\:")
        urls = {
            "diffusion_models": "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors",
            "text_encoders": "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
            "vae": "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors",
        }
        for m in missing:
            print(f"  {m}\n     {urls[m.split('/')[0]]}")
        print("Then restart ComfyUI and run this script again.")
        sys.exit(2)
    w, h = size_video()
    wf = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": unet, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": te, "type": "wan", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": vae}},
        "4": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["1", 0], "shift": 8.0}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry, low quality, static, distorted, watermark, text", "clip": ["2", 0]}},
        "7": {"class_type": "Wan22ImageToVideoLatent", "inputs": {"vae": ["3", 0], "width": w, "height": h, "length": frames, "batch_size": 1}},
        "8": {"class_type": "KSampler", "inputs": {"model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["7", 0],
              "seed": seed, "steps": 20, "cfg": 5.0, "sampler_name": "uni_pc", "scheduler": "simple", "denoise": 1.0}},
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
    }
    if as_video:
        wf["10"] = {"class_type": "CreateVideo", "inputs": {"images": ["9", 0], "fps": 24}}
        wf["11"] = {"class_type": "SaveVideo", "inputs": {"video": ["10", 0], "filename_prefix": "gen-video", "format": "mp4", "codec": "h264"}}
    else:
        wf["11"] = {"class_type": "SaveAnimatedWEBP", "inputs": {"images": ["9", 0], "filename_prefix": "gen-move", "fps": 24,
                    "lossless": False, "quality": 90, "method": "default"}}
    return wf

builders = {"1": photo, "2": photo4k, "3": lambda s: wan(s, 49, False), "4": lambda s: wan(s, 121, True)}
build = builders.get(kind, photo)
slug = re.sub(r"[^a-z0-9]+", "-", prompt.lower())[:40].strip("-") or "gen"

for n in range(count):
    seed = random.randrange(1, 2**31)
    wf = build(seed)
    try:
        pid = json.loads(call("/prompt", {"prompt": wf, "client_id": str(uuid.uuid4())}))["prompt_id"]
    except urllib.error.HTTPError as e:
        print("ComfyUI refused the job:", e.read().decode()[:600]); sys.exit(1)
    t0 = time.time()
    print(f"[{n+1}/{count}] generating (seed {seed}) ...", end="", flush=True)
    while True:
        time.sleep(2)
        hist = json.loads(call(f"/history/{pid}"))
        if pid not in hist:
            print(".", end="", flush=True); continue
        st = hist[pid].get("status", {})
        if st.get("status_str") == "error":
            msgs = [m for m in st.get("messages", []) if m[0] == "execution_error"]
            print("\nError:", (msgs[0][1].get("exception_message", "") if msgs else json.dumps(st))[:600]); sys.exit(1)
        files = [f for node in hist[pid]["outputs"].values() for key in node.values() if isinstance(key, list)
                 for f in key if isinstance(f, dict) and "filename" in f]
        if files:
            for f in files:
                q = urllib.parse.urlencode({"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")})
                ext = os.path.splitext(f["filename"])[1]
                path = os.path.join(out, f"{time.strftime('%Y%m%d-%H%M%S')}-{slug}-{seed}{ext}")
                with open(path, "wb") as fh:
                    fh.write(call(f"/view?{q}", timeout=300))
                print(f" done in {time.time()-t0:.0f} s -> {path}")
            break
        if time.time() - t0 > 1800:
            print("\nTimed out after 30 minutes."); sys.exit(1)
PY
