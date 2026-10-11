# Optional local Piper voice

NOVA can use the medium English voice from [jgkawell/jarvis](https://huggingface.co/jgkawell/jarvis) through a separate, local Piper service. Edge voices remain the default. The model and Piper runtime are not included in NOVA's application image or Git repository.

The model repository describes this as an emulation of the JARVIS movie voice and lists MIT for the model. The voice is an optional personal installation; NOVA itself remains named NOVA. Piper is installed in its own container because Piper's runtime is GPL-3.0-or-later.

For development, download the pinned medium model (about 61 MiB) into the ignored `dev-data` folder:

```sh
node scripts/download-jarvis-voice.mjs
```

Start the optional development service from the repository root. Its port is bound to loopback only:

```sh
docker compose -f docker-compose.dev.yml --profile personal-voice up -d --build piper
```

Set `NOVA_PIPER_TTS_URL=http://127.0.0.1:5000/synthesize` in the local API environment and restart the API. The voice then appears in Settings → Geluid as “Engels (lokale Piper-stem)”. Its audio is synthesized locally as WAV. For a personal deployment, copy the two downloaded files into `nova-data/piper-voices` on the deployment host before starting the production profile:

```sh
mkdir -p nova-data/piper-voices
cp dev-data/piper/en_GB-jarvis-medium.onnx* nova-data/piper-voices/
```

Add `NOVA_PIPER_TTS_URL=http://piper:5000/synthesize` to that host's private `.env`, then run `docker compose --profile personal-voice up -d --build piper nova` from the deployment directory. Keep the downloaded model and that `.env` on the personal host; neither belongs in a release or repository commit.
