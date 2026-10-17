import { Logger } from "@nestjs/common";
import { ARI_APP, ARI_USER } from "./asterisk-config.js";
import {
  type AriChannel,
  type AriEndpoint,
  type AriEvent,
  type AriPort,
  TelephonyError,
} from "./telephony.types.js";

export const ARI_HOSTS = new Set(["localhost", "127.0.0.1", "asterisk"]);

/** The ARI URL is a private service address, never a general proxy target. */
export function validateAriUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TelephonyError("NOVA_ASTERISK_ARI_URL is ongeldig.");
  }
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    !ARI_HOSTS.has(url.hostname) ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  )
    throw new TelephonyError(
      "NOVA_ASTERISK_ARI_URL moet http://localhost, 127.0.0.1 of asterisk zijn.",
    );
  return url;
}

const MAX_BODY = 1_000_000;

/** Asterisk REST Interface over HTTP + WebSocket events, with reconnects. */
export class AriHttpClient implements AriPort {
  private readonly log = new Logger("NOVA ARI");
  private readonly handlers = new Set<(event: AriEvent) => void>();
  private socket: WebSocket | null = null;
  private open = false;
  private stopped = true;
  private retry: NodeJS.Timeout | null = null;
  private backoff = 2000;

  constructor(
    private readonly baseUrl: URL,
    private readonly secret: () => string,
  ) {}

  connected(): boolean {
    return this.open;
  }

  private auth(): string {
    return `Basic ${Buffer.from(`${ARI_USER}:${this.secret()}`).toString("base64")}`;
  }

  private async call<T>(
    method: string,
    path: string,
    query: Record<string, string | number | undefined> = {},
    signal = AbortSignal.timeout(8000),
  ): Promise<T> {
    const url = new URL(`/ari${path}`, this.baseUrl);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { authorization: this.auth(), accept: "application/json" },
        signal,
        redirect: "error",
      });
    } catch {
      throw new TelephonyError("Asterisk is niet bereikbaar.");
    }
    const text = (await response.text()).slice(0, MAX_BODY);
    if (!response.ok)
      throw new TelephonyError(
        `Asterisk weigerde het verzoek (${response.status}).`,
      );
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async info() {
    const data = await this.call<{ system?: { version?: string } }>(
      "GET",
      "/asterisk/info",
      { only: "system" },
    );
    return { version: String(data.system?.version ?? "onbekend") };
  }

  /** Asterisk answers 404 for the PJSIP technology while no endpoint is configured yet: that means none, not "down". */
  async endpoints() {
    try {
      return await this.call<AriEndpoint[]>("GET", "/endpoints/PJSIP");
    } catch (error) {
      if (error instanceof TelephonyError && error.message.includes("(404)"))
        return [];
      throw error;
    }
  }

  channels() {
    return this.call<AriChannel[]>("GET", "/channels");
  }

  originate(input: {
    endpoint: string;
    /** Either a Stasis application (with appArgs)... */
    app?: string;
    appArgs?: string;
    /** ...or a dialplan context and extension that runs when the call is answered. */
    context?: string;
    extension?: string;
    callerId?: string;
    timeoutSeconds?: number;
  }) {
    const target = input.context
      ? {
          context: input.context,
          extension: input.extension ?? "s",
          priority: 1,
        }
      : { app: input.app, appArgs: input.appArgs };
    return this.call<AriChannel>("POST", "/channels", {
      endpoint: input.endpoint,
      ...target,
      callerId: input.callerId,
      timeout: input.timeoutSeconds ?? 30,
    });
  }

  async sendMessage(input: { to: string; from: string; body: string }) {
    await this.call("PUT", "/endpoints/sendMessage", {
      to: input.to,
      from: input.from,
      body: input.body,
    });
  }

  async hangup(channelId: string) {
    await this.call("DELETE", `/channels/${encodeURIComponent(channelId)}`);
  }

  async answer(channelId: string) {
    await this.call(
      "POST",
      `/channels/${encodeURIComponent(channelId)}/answer`,
    );
  }

  play(channelId: string, media: string) {
    return this.call<{ id: string }>(
      "POST",
      `/channels/${encodeURIComponent(channelId)}/play`,
      { media },
    );
  }

  createBridge() {
    return this.call<{ id: string }>("POST", "/bridges", { type: "mixing" });
  }

  async addToBridge(bridgeId: string, channelId: string) {
    await this.call(
      "POST",
      `/bridges/${encodeURIComponent(bridgeId)}/addChannel`,
      { channel: channelId },
    );
  }

  async destroyBridge(bridgeId: string) {
    await this.call("DELETE", `/bridges/${encodeURIComponent(bridgeId)}`);
  }

  onEvent(handler: (event: AriEvent) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.socket?.close();
    this.socket = null;
    this.open = false;
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    const url = new URL("/ari/events", this.baseUrl);
    url.protocol = "ws:";
    url.searchParams.set("app", ARI_APP);
    url.searchParams.set("api_key", `${ARI_USER}:${this.secret()}`);
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.open = true;
      this.backoff = 2000;
    };
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(String(message.data)) as AriEvent;
        for (const handler of this.handlers) handler(event);
      } catch {
        /* ignore malformed event */
      }
    };
    const lost = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.open = false;
      if (this.stopped) return;
      this.retry = setTimeout(() => {
        this.retry = null;
        this.connect();
      }, this.backoff);
      this.retry.unref();
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
    socket.onclose = lost;
    socket.onerror = () => {
      this.log.debug("ARI event socket error");
    };
  }
}
