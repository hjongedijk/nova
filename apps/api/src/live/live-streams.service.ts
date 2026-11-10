import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import type { LiveStreamKind, LiveStatusMessage } from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { DesktopSettingsStore } from "../desktop/desktop-settings.store.js";
import { frameMeta, MjpegParser } from "./mjpeg.js";

/*
 * One upstream per picture (the browser tab NOVA works in, or one display), shared by every window that watches
 * it. It runs only while someone watches: the last viewer leaving closes it after a short grace period. Frames are
 * never stored or logged; they pass straight from the agent to the viewers' gates.
 *
 * Live first: GET /v1/stream/{browser|desktop} on the Windows agent (MJPEG). An agent without it (404/501) gets a
 * screenshot refresh for the desktop ("snapshot") and nothing for the browser ("offline", with the reason).
 */
export interface LiveFrame {
  seq: number;
  jpeg: Buffer;
  width: number;
  height: number;
  url?: string;
  title?: string;
  tab?: string;
  vw?: number;
  vh?: number;
}

export interface LiveListener {
  frame(frame: LiveFrame): void;
  status(state: LiveStatusMessage["state"], reason?: string): void;
}

export interface LiveSpec {
  stream: LiveStreamKind;
  display?: number;
  tab?: string;
  fps: number;
  maxWidth: number;
}

const GRACE_MS = 4000;
const SNAPSHOT_MS = 1200;
const RETRY_MS = [1000, 2000, 4000, 8000, 10000];
/** What the upstream asks the agent for; viewers' gates take less. */
const UPSTREAM_FPS = { browser: 24, desktop: 15 } as const;

type Upstream = {
  key: string;
  spec: LiveSpec;
  listeners: Set<LiveListener>;
  state: LiveStatusMessage["state"];
  reason?: string;
  controller: AbortController | null;
  closing: ReturnType<typeof setTimeout> | null;
  seq: number;
  last: LiveFrame | null;
};

export const upstreamKey = (spec: LiveSpec) =>
  spec.stream === "desktop"
    ? `desktop:${spec.display ?? 0}`
    : `browser:${spec.tab ?? "current"}`;

@Injectable()
export class LiveStreamsService implements OnModuleDestroy {
  private readonly log = new Logger("NOVA live");
  private readonly upstreams = new Map<string, Upstream>();
  /** Tests replace this. */
  fetcher: typeof fetch = (...args) => fetch(...args);

  constructor(
    private readonly config: NovaConfig,
    private readonly desktopSettings: DesktopSettingsStore,
  ) {}

  get configured(): boolean {
    return Boolean(
      this.config.windowsAgent.url && this.config.windowsAgent.token,
    );
  }

  /** Number of upstream connections that are open now. */
  get active(): number {
    return [...this.upstreams.values()].filter((u) => u.controller).length;
  }

  subscribe(spec: LiveSpec, listener: LiveListener): () => void {
    const key = upstreamKey(spec);
    let upstream = this.upstreams.get(key);
    if (!upstream) {
      upstream = {
        key,
        spec: { ...spec, fps: UPSTREAM_FPS[spec.stream] },
        listeners: new Set(),
        state: "connecting",
        controller: null,
        closing: null,
        seq: 0,
        last: null,
      };
      this.upstreams.set(key, upstream);
    }
    const target = upstream;
    if (target.closing) clearTimeout(target.closing);
    target.closing = null;
    target.listeners.add(listener);
    listener.status(target.state, target.reason);
    // A newcomer sees the last picture at once instead of a blank window.
    if (target.last) listener.frame(target.last);
    if (!target.controller) this.start(target);
    return () => {
      target.listeners.delete(listener);
      if (target.listeners.size || target.closing) return;
      target.closing = setTimeout(() => this.close(target), GRACE_MS);
      target.closing.unref?.();
    };
  }

  onModuleDestroy(): void {
    for (const upstream of this.upstreams.values()) this.close(upstream);
  }

  private close(upstream: Upstream): void {
    if (upstream.closing) clearTimeout(upstream.closing);
    upstream.closing = null;
    if (upstream.listeners.size) return;
    upstream.controller?.abort();
    upstream.controller = null;
    this.upstreams.delete(upstream.key);
  }

  private setState(
    upstream: Upstream,
    state: LiveStatusMessage["state"],
    reason?: string,
  ): void {
    if (upstream.state === state && upstream.reason === reason) return;
    upstream.state = state;
    upstream.reason = reason;
    for (const listener of upstream.listeners) listener.status(state, reason);
  }

  private publish(upstream: Upstream, frame: Omit<LiveFrame, "seq">): void {
    const full = { ...frame, seq: ++upstream.seq };
    upstream.last = full;
    for (const listener of upstream.listeners) listener.frame(full);
  }

  private start(upstream: Upstream): void {
    const controller = new AbortController();
    upstream.controller = controller;
    void this.run(upstream, controller.signal).finally(() => {
      if (upstream.controller === controller) upstream.controller = null;
    });
  }

  private headers() {
    return { authorization: `Bearer ${this.config.windowsAgent.token}` };
  }

  private async run(upstream: Upstream, signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      if (!this.configured) {
        this.setState(
          upstream,
          "offline",
          "De Windows-agent is niet ingesteld.",
        );
        return;
      }
      if (
        upstream.spec.stream === "desktop" &&
        !this.desktopSettings.get().viewEnabled
      ) {
        this.setState(upstream, "offline", "Bureaublad bekijken staat uit.");
        await wait(5000, signal);
        continue;
      }
      const outcome = await this.live(upstream, signal);
      if (signal.aborted) return;
      if (outcome === "unsupported") {
        if (upstream.spec.stream === "desktop") {
          await this.snapshots(upstream, signal);
        } else {
          this.setState(
            upstream,
            "offline",
            "Live browserbeeld vraagt een nieuwere NOVA voor Windows.",
          );
          await wait(15000, signal);
        }
        continue;
      }
      if (outcome === "paused") {
        this.setState(upstream, "offline", "De agent is gepauzeerd.");
        await wait(5000, signal);
        continue;
      }
      if (outcome === "ended") attempt = 0;
      else
        this.setState(
          upstream,
          "connecting",
          "Verbinding met de pc wordt hersteld.",
        );
      await wait(RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]!, signal);
    }
  }

  /** One live connection until it ends. */
  private async live(
    upstream: Upstream,
    signal: AbortSignal,
  ): Promise<"ended" | "unsupported" | "paused" | "failed"> {
    const { spec } = upstream;
    const query = new URLSearchParams({
      fps: String(spec.fps),
      maxWidth: String(Math.min(1600, Math.max(640, spec.maxWidth))),
      quality: spec.stream === "browser" ? "62" : "55",
    });
    if (spec.stream === "desktop")
      query.set("display", String(spec.display ?? 0));
    if (spec.stream === "browser" && spec.tab) query.set("tab", spec.tab);
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.config.windowsAgent.url}/v1/stream/${spec.stream}?${query}`,
        { headers: this.headers(), signal },
      );
    } catch {
      return "failed";
    }
    if (response.status === 404 || response.status === 501) {
      await response.body?.cancel().catch(() => {});
      return "unsupported";
    }
    if (response.status === 409) {
      await response.body?.cancel().catch(() => {});
      return "paused";
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => {});
      return "failed";
    }
    const parser = new MjpegParser();
    const reader = response.body.getReader();
    let first = true;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const part of parser.push(Buffer.from(value))) {
          if (first) {
            first = false;
            this.setState(upstream, "live");
          }
          const [width, height] = (part.headers["x-nova-size"] ?? "0x0")
            .split("x")
            .map(Number);
          this.publish(upstream, {
            jpeg: part.body,
            width: width || 0,
            height: height || 0,
            ...frameMeta(part.headers["x-nova-meta"]),
          });
        }
        if (parser.finished) break;
      }
    } catch (error) {
      if (!signal.aborted)
        this.log.warn(
          `live ${upstream.key} ended: ${(error as Error).message ?? error}`,
        );
      return "failed";
    } finally {
      reader.releaseLock();
      await response.body.cancel().catch(() => {});
    }
    return "ended";
  }

  /** Older agents: a screenshot about every second while someone watches. */
  private async snapshots(upstream: Upstream, signal: AbortSignal) {
    this.setState(
      upstream,
      "snapshot",
      "Momentopnamen: werk NOVA voor Windows bij voor live beeld.",
    );
    const deadline = Date.now() + 60_000;
    while (!signal.aborted && Date.now() < deadline) {
      const started = Date.now();
      try {
        const query = new URLSearchParams({
          display: String(upstream.spec.display ?? 0),
          maxWidth: "1280",
        });
        const response = await this.fetcher(
          `${this.config.windowsAgent.url}/v1/desktop/screenshot?${query}`,
          {
            headers: this.headers(),
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          },
        );
        const body = (await response.json().catch(() => null)) as {
          ok?: boolean;
          image?: unknown;
          width?: unknown;
          height?: unknown;
        } | null;
        if (
          response.status === 200 &&
          body?.ok &&
          typeof body.image === "string"
        ) {
          const jpeg = Buffer.from(body.image, "base64");
          if (jpeg.length <= 1_500_000)
            this.publish(upstream, {
              jpeg,
              width: Number(body.width) || 0,
              height: Number(body.height) || 0,
            });
        } else if (response.status === 409) return;
      } catch {
        if (signal.aborted) return;
      }
      await wait(Math.max(200, SNAPSHOT_MS - (Date.now() - started)), signal);
    }
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
