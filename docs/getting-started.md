# Getting started

This guide installs NOVA from the published Docker image with the production compose file. For a development setup see [Architecture and development](architecture.md#development).

## What you need

- A Linux host (or any machine) with Docker and the Docker Compose plugin. The image is built for `linux/amd64` and `linux/arm64`.
- Outbound internet access (the language-model providers, speech and the public data APIs).
- Optional: Proxmox, Home Assistant (the stack can run one), a Windows PC for the [Windows agent](windows-agent.md).
- For the free-model routing: accounts at free providers, set up in OmniRoute (step 5).

NOVA runs unrestricted: no login, no PIN, no approval prompts, and it acts first and reports afterwards. The only access control is the reverse proxy in front of it, so install it on a trusted network or behind an authenticating reverse proxy; read [Tools and safety](tools-and-safety.md#access-and-exposure) first.

## 1. Get the compose file and the environment file

Make a folder for the installation and download the compose file, environment template, and Node-RED seed files into it. The compose file is attached to every [GitHub release](https://github.com/hjongedijk/nova/releases) and lives in the repository as `deploy/docker-compose.yml`; `.env.example` is in the repository root.

```sh
mkdir nova && cd nova
curl -fsSLO https://raw.githubusercontent.com/hjongedijk/nova/main/deploy/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/hjongedijk/nova/main/.env.example -o .env
mkdir -p nodered
for file in flows.json settings.js package.json seed-entrypoint.sh; do
  curl -fsSL "https://raw.githubusercontent.com/hjongedijk/nova/main/deploy/nodered/$file" -o "nodered/$file"
done
```

Everything NOVA and its services write ends up in folders next to the compose file (`nova-data`, `nova-backups`, `omniroute-data`, `qdrant-data`, `mosquitto-data`, `home-assistant-data`, `nodered-data`). Node-RED copies the repository's initial `flows.json`, `settings.js`, and node manifest only when those files are absent. Updates preserve the persistent copies and all operator-created flows. See [Backups](#backups) for schedule, retention, permissions, and coverage limits.

## 2. Fill in `.env`

Edit `.env`. Secrets have no default. The minimum for a first start:

```dotenv
NOVA_VERSION=latest             # or a released version such as 0.1.5 (see the releases page)
NOVA_PUBLIC_URL=                # https://nova.example.com when behind a reverse proxy, otherwise empty
TZ=Europe/Amsterdam
OMNIROUTE_API_KEY=              # filled in at step 5
OMNIROUTE_MODEL=auto
```

Integrations (Proxmox, Home Assistant, Windows agent, Termix, Pangolin) are filled in when you have them. Every variable is explained in [Configuration](configuration.md).

## 3. Prepare the data folders

NOVA runs as the unprivileged user `node` (uid 1000) in the container; give it its folder:

```sh
mkdir -p nova-data nova-backups nodered-data && sudo chown -R 1000:1000 nova-data nova-backups nodered-data
```

NOVA and Node-RED run as uid 1000 and need write access to their data folders. For an existing installation, adjust the ownership of `nodered-data/` once before upgrading to this compose file. Other service folders are created by Compose. Node-RED's editor is not published on a host port in production; NOVA reaches its API on the private Compose network. Do not publish port 1880 to an untrusted network.

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
3. Recreate NOVA so it can use the new key: `docker compose up -d nova`.
4. Open NOVA's **Instellingen → Slimme modellen → Gratis beleid maken**. Load the available accounts and models, select only verified recurring free options, complete the account checks, and confirm. NOVA writes the policy and checks it against OmniRoute.

The details, including the structure of the policy file and everything NOVA checks, are in [OmniRoute and free routing](integrations.md#language-models-omniroute). Until the check passes NOVA refuses to send anything to a model and the interface says so; `GET /api/providers` shows why.

## 6. Optional integrations

- **Home Assistant**: the stack includes one on port 8123 with host networking. Finish its onboarding at `http://<nova-host>:8123`, create a long-lived access token in your profile, set `HOME_ASSISTANT_TOKEN` (and `HOME_ASSISTANT_URL` if yours runs elsewhere).
- **Proxmox**: create an API token in Proxmox and set `PROXMOX_URL`, `PROXMOX_TOKEN_ID`, `PROXMOX_TOKEN_SECRET` (and `PROXMOX_VERIFY_TLS=false` for a self-signed certificate).
- **Windows PC**: install the [Windows agent](windows-agent.md) and set `WINDOWS_AGENT_URL` and `WINDOWS_AGENT_TOKEN`.
- **Long-term memory**: see [Configuration](configuration.md#memory).

After any `.env` change run `docker compose up -d`. NOVA acts as soon as it is connected: there is no switch to enable actions and nothing asks for confirmation, so connect only what you want it to control.

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

## Operate

Running, monitoring and backing up NOVA. Releases and the development workflow are in [Architecture and development](architecture.md#releasing).

### Updating

Set `NOVA_VERSION` in `.env` to the new version (without the `v`), then:

```sh
docker compose pull && docker compose up -d
```

The running version is reported by `GET /api/nova/health`. NOVA also checks GitHub's public latest stable release every six hours when it runs a numbered release and raises one informational alert for a newer version; development builds such as `dev` cannot be compared. That check is read-only and never pulls an image or edits `NOVA_VERSION`. Read the matching [release notes](release-notes/) first.

If the Windows app changed, run the new NOVA installer or replace the portable `nova.exe` while it is closed; settings stay in `%LOCALAPPDATA%\NOVA`. The app can also update itself, see [Windows agent](windows-agent.md#updates-from-github).

### Logs and health

- `docker compose logs -f nova` for the API; `docker compose ps` for the stack. The `nova` container has a health check on `GET /api/nova/health`.
- The action log is `nova-data/actions.jsonl` (append-only, secrets masked).
- **Instellingen → Koppelingen** shows the fixed Compose stack status and can restart one service. This needs `NOVA_STACK_CONTROL_TOKEN`; only the private `stack-control` broker holds the Docker socket and NOVA sees fixed service ids, state, health and start time.
- Node-RED's recent container log is available in its settings panel, see [Node-RED](integrations.md#logs).

### Backups

NOVA writes compressed archives of its own data directory: a daily archive at 02:30 and a weekly one on Sunday at 03:30 in the `TZ` time zone (default `Europe/Amsterdam`). If NOVA starts after a scheduled time and that period has no archive, it catches up once. Success and failure appear in the alert feed (and the helper when connected). A failed slot is retried twice, five minutes apart, and only a third failure raises a critical alert.

- **Where.** `./nova-backups` on the host, mounted at `/backups`; `NOVA_BACKUP_DIR` selects another destination (outside Compose the default is next to, not inside, `NOVA_DATA_DIR`). The folder is mode `0700`, each archive `0600`. Create and own it as UID 1000 before first start: `mkdir -p nova-data nova-backups nodered-data && sudo chown -R 1000:1000 nova-data nova-backups nodered-data`.
- **Retention.** 14 daily and 8 weekly archives; an archive is capped at 1 GiB and the collection at 5 GiB.
- **Coverage.** Only NOVA's data directory, which may include credentials stored there, so keep the folder on a trusted local disk. Qdrant, OmniRoute, Node-RED, Home Assistant and other volumes are not included; back up `omniroute-data/`, `qdrant-data/`, `nodered-data/`, `home-assistant-data/` and `mosquitto-data/` yourself before calling this a full-stack backup.
- **Restore.** There is no automatic restore. Stop NOVA, then extract an archive into the data directory by hand.
- **Settings backup.** **Instellingen → Geheugen en privacy → Back-up** exports and imports NOVA's settings (including household profiles) as one file, separate from these archives.

### Monitoring

A watchdog runs once per minute and writes alerts to the feed (see [Features](features.md#proactive-behavior) for delivery). All checks are read-only.

| Check              | Behavior                                                                                                                                                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Internet and DNS   | Separate probes: HTTPS to `1.1.1.1` and DNS resolution of `cloudflare.com`. An alert needs two consecutive failures and a recovery alert follows success. `NOVA_CHECK_TARGETS` (`name=url`, comma-separated, for example `nas=tcp://192.0.2.10:445`) adds or replaces service checks while both probes stay on. |
| HTTPS certificate  | When `NOVA_PUBLIC_URL` is a reachable HTTPS address NOVA reads its peer certificate; warning at 30 days, critical at 7 days or after expiry. Only that endpoint is checked, NOVA never renews anything, and it must be able to reach its own public URL when TLS ends at a reverse proxy.                       |
| Containers         | Via the stack-control broker: the first complete status is the baseline, then a stopped or missing container, recovery, or a changed NOVA/Compose start time raises an alert. A broker outage or incomplete status is ignored, not treated as an outage. Needs a valid `NOVA_STACK_CONTROL_TOKEN`.              |
| Node-RED           | Availability from the Admin API plus the seeded heartbeat flow, see [Node-RED](integrations.md#health-heartbeat).                                                                                                                                                                                               |
| Energy and devices | With Home Assistant connected, see [Integrations](integrations.md#home-assistant).                                                                                                                                                                                                                              |
| Phone push         | Critical alerts can go to ntfy, see [Integrations](integrations.md#urgent-phone-notifications-ntfy).                                                                                                                                                                                                            |

## Troubleshooting

| Symptom                                          | Look at                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| "Geen geverifieerde gratis AI-route beschikbaar" | `curl http://<nova-host>:8080/api/providers`: the `status` and `reason` fields. See [OmniRoute](integrations.md#language-models-omniroute). |
| A tool says the integration is unavailable       | Its variables are not set; check **Instellingen → Wat NOVA mag doen** and `GET /api/integrations`.                                          |
| The microphone or "Hey NOVA" does not work       | The page is not on HTTPS (or `localhost`), or the browser has no speech recognition.                                                        |
| Writes to `/data` fail                           | `sudo chown -R 1000:1000 nova-data`.                                                                                                        |
