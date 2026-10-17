import { ARI_HOSTS } from "../ari.client.js";

/** Where the relay listens, where Asterisk finds it, and where it forwards to. All of it fixed by NOVA, never by traffic. */
export interface RelaySettings {
  listenHost: string;
  listenPort: number;
  /** Name Asterisk uses for the relay (the NOVA container's name on the docker network). */
  proxyHost: string;
  upstreamPort: number;
  /** Hostnames or addresses that may connect: Asterisk. */
  allow: string[];
}

export const DEFAULT_RELAY_PORT = 5070;

/**
 * NOVA_SIP_RELAY=on|off|auto (default auto): auto means on when NOVA reaches Asterisk as `asterisk`, which is the compose
 * stack where both containers share the `nova` network. In a dev setup with NOVA on the host it stays off.
 */
export function relaySettings(
  env: NodeJS.ProcessEnv = process.env,
): RelaySettings | null {
  const mode = (env.NOVA_SIP_RELAY ?? "auto").trim().toLowerCase();
  let ariHost = "asterisk";
  try {
    ariHost = new URL(
      env.NOVA_ASTERISK_ARI_URL?.trim() || "http://127.0.0.1:8088",
    ).hostname;
  } catch {
    /* validated elsewhere */
  }
  if (mode === "off" || (mode === "auto" && ariHost !== "asterisk"))
    return null;
  const port = (name: string, fallback: number) => {
    const n = Number(env[name]);
    return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : fallback;
  };
  const proxyHost = env.NOVA_SIP_RELAY_PROXY_HOST?.trim() || "nova";
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(proxyHost)) return null;
  return {
    listenHost: env.NOVA_SIP_RELAY_BIND?.trim() || "0.0.0.0",
    listenPort: port("NOVA_SIP_RELAY_PORT", DEFAULT_RELAY_PORT),
    proxyHost,
    upstreamPort: Number.isInteger(Number(env.NOVA_SIP_RELAY_UPSTREAM_PORT))
      ? Math.min(
          65535,
          Math.max(1, Number(env.NOVA_SIP_RELAY_UPSTREAM_PORT) || 5060),
        )
      : 5060,
    allow: ARI_HOSTS.has(ariHost) ? [ariHost] : ["asterisk"],
  };
}
