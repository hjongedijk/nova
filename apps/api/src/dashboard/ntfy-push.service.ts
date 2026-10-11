import { Injectable, Logger } from "@nestjs/common";
import type { FeedEvent } from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";

const MAX_RECENT = 300;
const DEDUPE_MS = 15 * 60_000;

/** Sends only critical alert titles to a privately authenticated ntfy topic. */
@Injectable()
export class NtfyPushService {
  private readonly log = new Logger("NtfyPush");
  private readonly sent = new Map<string, number>();

  constructor(private readonly config: NovaConfig) {}

  get configured(): boolean {
    const { url, topic, token } = this.config.ntfy;
    if (!url || !/^[A-Za-z0-9_-]{1,128}$/.test(topic) || token.length < 12)
      return false;
    try {
      const parsed = new URL(url);
      const localHttp = ["localhost", "127.0.0.1", "ntfy"].includes(
        parsed.hostname.toLowerCase(),
      );
      return (
        (parsed.protocol === "https:" ||
          (parsed.protocol === "http:" && localHttp)) &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  }

  async notify(event: FeedEvent): Promise<void> {
    if (
      !this.configured ||
      event.kind !== "alert" ||
      event.severity !== "critical"
    )
      return;
    const now = Date.now();
    for (const [key, at] of this.sent)
      if (now - at >= DEDUPE_MS) this.sent.delete(key);
    const key = `${event.key || "alert"}:${event.title}`;
    if (this.sent.has(key)) return;
    this.sent.set(key, now);
    while (this.sent.size > MAX_RECENT)
      this.sent.delete(this.sent.keys().next().value!);

    const { url, topic, token } = this.config.ntfy;
    const base = new URL(url);
    const endpoint = new URL(
      `${base.pathname.replace(/\/$/, "")}/${encodeURIComponent(topic)}`,
      base,
    );
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "text/plain; charset=utf-8",
          priority: "5",
        },
        body: sanitize(event.title).slice(0, 120),
      });
      if (!response.ok) {
        this.sent.delete(key);
        this.log.warn("ntfy rejected a critical alert");
      }
    } catch {
      this.sent.delete(key);
      this.log.warn("ntfy delivery failed");
    }
  }
}
