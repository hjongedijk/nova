# Getting started

This guide installs NOVA from the published Docker image with the production compose file. For a development setup see [Development](development.md).

## What you need

- A Linux host (or any machine) with Docker and the Docker Compose plugin. The image is built for `linux/amd64` and `linux/arm64`.
- Outbound internet access (the language-model providers, speech and the public data APIs).
- Optional: Proxmox, Home Assistant (the stack can run one), a Windows PC for the [Windows agent](windows-agent.md).
- For the free-model routing: accounts at free providers, set up in OmniRoute (step 5).

NOVA has no login of its own. Install it on a trusted network or behind an authenticating reverse proxy; read [Tools and safety](tools-and-safety.md#what-nova-does-not-do) first.

## 1. Get the compose file and the environment file

Make a folder for the installation and download the two files into it. The compose file is attached to every [GitHub release](https://github.com/hjongedijk/nova/releases) and lives in the repository as `deploy/docker-compose.yml`; `.env.example` is in the repository root.

```sh
mkdir nova && cd nova
curl -fsSLO https://raw.githubusercontent.com/hjongedijk/nova/main/deploy/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/hjongedijk/nova/main/.env.example -o .env
```

Everything NOVA and its services write ends up in folders next to the compose file (`nova-data`, `omniroute-data`, `qdrant-data`, `mosquitto-data`, `home-assistant-data`, `nodered-data`).

## 2. Fill in `.env`

Edit `.env`. Secrets have no default. The minimum for a first start:

```dotenv
NOVA_VERSION=latest             # or a released version such as 0.1.5 (see the releases page)
NOVA_PUBLIC_URL=                # https://nova.example.com when behind a reverse proxy, otherwise empty
NOVA_ADMIN_PIN=                 # optional PIN for the settings screen
TZ=Europe/Amsterdam
OMNIROUTE_API_KEY=              # filled in at step 5
OMNIROUTE_MODEL=auto
```

Integrations (Proxmox, Home Assistant, Windows agent, Termix, Pangolin) are filled in when you have them. Every variable is explained in [Configuration](configuration.md). `JARVIS_ENABLE_ACTIONS` stays `false` until you are ready for NOVA to change things.

## 3. Prepare the data folders

NOVA runs as the unprivileged user `node` (uid 1000) in the container; give it its folder:

```sh
mkdir -p nova-data && sudo chown -R 1000:1000 nova-data
```

The other containers run as root and create their own folders.

Mosquitto is started without a configuration file by the compose file. MQTT is optional for NOVA (it publishes status and tool events there; chat, tools and the dashboard work without it). If you want it, create `mosquitto-data/config/mosquitto.conf` for your network before starting, for example with `listener 1883` and `allow_anonymous true` for a closed internal network.

## 4. Start the stack

```sh
docker compose pull
docker compose up -d
docker compose ps
```

The `nova` container has a health check on `GET /api/nova/health`. Check it:

```sh
curl http://localhost:8080/api/nova/health
```

Open `http://<nova-host>:8080` in a browser. The interface appears, but the AI will not answer yet.

## 5. Set up OmniRoute and the free route

1. Open the OmniRoute dashboard at `http://<nova-host>:20128` and create the admin account as OmniRoute asks. Add your provider accounts (free tiers only).
2. Create an API key for NOVA, restricted to the model `auto` and to your verified connections, and put it in `.env` as `OMNIROUTE_API_KEY`. Put the dashboard password in `OMNIROUTE_ADMIN_PASSWORD`.
3. Provide the routing policy file `nova-data/free-routing-policy.json`.
4. Recreate NOVA: `docker compose up -d nova`.

The details, including the structure of the policy file and everything NOVA checks, are in [OmniRoute and free routing](omniroute.md). Until the check passes NOVA refuses to send anything to a model and the interface says so; `GET /api/providers` shows why.

## 6. Optional integrations

- **Home Assistant**: the stack includes one on port 8123 with host networking. Finish its onboarding at `http://<nova-host>:8123`, create a long-lived access token in your profile, set `HOME_ASSISTANT_TOKEN` (and `HOME_ASSISTANT_URL` if yours runs elsewhere).
- **Proxmox**: create an API token in Proxmox and set `PROXMOX_URL`, `PROXMOX_TOKEN_ID`, `PROXMOX_TOKEN_SECRET` (and `PROXMOX_VERIFY_TLS=false` for a self-signed certificate).
- **Windows PC**: install the [Windows agent](windows-agent.md) and set `WINDOWS_AGENT_URL` and `WINDOWS_AGENT_TOKEN`.
- **Long-term memory**: see [Configuration](configuration.md#memory).

After any `.env` change run `docker compose up -d`. When you are ready for NOVA to act, set `JARVIS_ENABLE_ACTIONS=true`; risky actions still need your confirmation.

## 7. HTTPS, the microphone and installing as an app

Browsers only allow the microphone ("Hey NOVA") and installing NOVA as an app on a secure origin: HTTPS, or `localhost`. Two ways:

- **Reverse proxy** (recommended): terminate TLS in front of port 8080 and set `NOVA_PUBLIC_URL=https://nova.example.com`. The proxy must pass through server-sent events without buffering (`/api/chat-stream`).
- **NOVA's own HTTPS port** (8443): put `cert.pem` and `key.pem` in `nova-data/certs/` and restart. NOVA starts HTTPS only when both files exist. For a LAN with a private certificate authority, also put its public certificate there as `nova-ca.crt`; NOVA serves it at `/nova-ca.crt` so phones and PCs can install and trust it. A self-signed example (replace the names with yours; your devices will need to trust it):

  ```sh
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout nova-data/certs/key.pem -out nova-data/certs/cert.pem \
    -subj "/CN=nova.example.com" -addext "subjectAltName=DNS:nova.example.com,IP:192.168.1.10"
  ```

On a phone, open NOVA over HTTPS and use the browser's "install app" / "add to home screen"; NOVA is a PWA with its own icon and standalone display.

## 8. Where data lives, back-ups and updates

- All NOVA state is in `nova-data/` (see [Configuration](configuration.md#the-data-folder)); OmniRoute's accounts and keys are in `omniroute-data/`, Qdrant in `qdrant-data/`, Home Assistant in `home-assistant-data/`. Back these folders up. **Settings, More, Back-up** exports and imports NOVA's own settings as one file.
- Update: set `NOVA_VERSION` in `.env` to the new version, then `docker compose pull && docker compose up -d`.
- Logs: `docker compose logs -f nova`. The action log is `nova-data/actions.jsonl`.

## Troubleshooting

| Symptom                                          | Look at                                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| "Geen geverifieerde gratis AI-route beschikbaar" | `curl http://<nova-host>:8080/api/providers`: the `status` and `reason` fields. See [OmniRoute](omniroute.md). |
| Tools answer "Device actions are disabled"       | `JARVIS_ENABLE_ACTIONS` is `false`.                                                                            |
| A tool says the integration is unavailable       | Its variables are not set; check **Settings, Wat NOVA kan** and `GET /api/integrations`.                       |
| The microphone or "Hey NOVA" does not work       | The page is not on HTTPS (or `localhost`), or the browser has no speech recognition.                           |
| Writes to `/data` fail                           | `sudo chown -R 1000:1000 nova-data`.                                                                           |
| The settings screen asks for a PIN               | You set `NOVA_ADMIN_PIN`.                                                                                      |
