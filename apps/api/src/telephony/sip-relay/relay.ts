import dns from "node:dns/promises";
import net from "node:net";
import { decideInbound } from "./rewrite.js";
import {
  DEFAULT_FRAMER_LIMITS,
  type FrameItem,
  type FramerLimits,
  SipFramer,
  SipFramingError,
  stripOwnRoute,
} from "./sip-message.js";

/**
 * A small SIP-aware TCP relay between Asterisk and the registrar. Everything passes through byte for byte except
 * MESSAGE requests towards Asterisk (see rewrite.ts) and the relay's own Route entry on requests towards the registrar.
 * The upstream is fixed at construction: nothing in the traffic can change where the relay connects.
 */

export interface RelayLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface RelayOptions {
  listen: { host: string; port: number };
  /** The only place the relay ever connects to. */
  target: { host: string; port: number };
  /** How Asterisk addresses the relay (its outbound_proxy), so the relay can remove its own Route entry. */
  proxy: { host: string; port: number };
  /** Addresses that may connect (Asterisk's), resolved at connect time. */
  allow: () => Promise<string[]>;
  maxConnections?: number;
  idleMs?: number;
  connectTimeoutMs?: number;
  limits?: FramerLimits;
  logger?: RelayLogger;
  now?: () => number;
}

export interface RelayStatus {
  listening: boolean;
  listen: string;
  target: string;
  activeConnections: number;
  totalConnections: number;
  rejected: number;
  /** Chat messages unwrapped from CPIM to plain text. */
  rewritten: number;
  /** Requests answered 200 OK by the relay itself (typing, delivery reports, unreadable). */
  answered: number;
  /** Messages not passed on to Asterisk. */
  dropped: number;
  /** Dropped messages that carried something NOVA cannot read (files, images, encrypted or too large). */
  unreadable: number;
  lastUnreadableAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

interface Pair {
  down: net.Socket;
  up: net.Socket | null;
  closed: boolean;
  last: number;
  timer: NodeJS.Timeout | null;
}

const noop: RelayLogger = { log: () => undefined, warn: () => undefined };

export const normalizeAddress = (address: string | undefined): string =>
  (address ?? "").replace(/^::ffff:/i, "").toLowerCase();

/** Resolves hostnames (for example `asterisk`) to the addresses that may use the relay; cached for a few seconds. */
export function peerAllowlist(
  hosts: string[],
  ttlMs = 5000,
): () => Promise<string[]> {
  let cache: { at: number; addresses: string[] } | null = null;
  return async () => {
    if (cache && Date.now() - cache.at < ttlMs) return cache.addresses;
    const addresses = new Set<string>();
    for (const host of hosts) {
      if (net.isIP(host)) {
        addresses.add(normalizeAddress(host));
        continue;
      }
      try {
        for (const r of await dns.lookup(host, { all: true }))
          addresses.add(normalizeAddress(r.address));
      } catch {
        /* unresolvable: nothing is allowed for this name */
      }
    }
    cache = { at: Date.now(), addresses: [...addresses] };
    return cache.addresses;
  };
}

export class SipRelay {
  private server: net.Server | null = null;
  private readonly pairs = new Set<Pair>();
  private readonly log: RelayLogger;
  private readonly now: () => number;
  private readonly limits: FramerLimits;
  private readonly maxConnections: number;
  private readonly idleMs: number;
  private readonly connectTimeoutMs: number;
  private counters = {
    total: 0,
    rejected: 0,
    rewritten: 0,
    answered: 0,
    dropped: 0,
    unreadable: 0,
  };
  private lastUnreadableAt: number | null = null;
  private lastError: { message: string; at: number } | null = null;

  constructor(readonly options: RelayOptions) {
    this.log = options.logger ?? noop;
    this.now = options.now ?? Date.now;
    this.limits = options.limits ?? DEFAULT_FRAMER_LIMITS;
    this.maxConnections = options.maxConnections ?? 8;
    this.idleMs = options.idleMs ?? 2 * 60 * 60_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  }

  get port(): number {
    return (this.server?.address() as net.AddressInfo | null)?.port ?? 0;
  }

  status(): RelayStatus {
    const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
    return {
      listening: Boolean(this.server?.listening),
      listen: `${this.options.listen.host}:${this.options.listen.port}`,
      target: `${this.options.target.host}:${this.options.target.port}`,
      activeConnections: this.pairs.size,
      totalConnections: this.counters.total,
      rejected: this.counters.rejected,
      rewritten: this.counters.rewritten,
      answered: this.counters.answered,
      dropped: this.counters.dropped,
      unreadable: this.counters.unreadable,
      lastUnreadableAt: iso(this.lastUnreadableAt),
      lastError: this.lastError?.message ?? null,
      lastErrorAt: iso(this.lastError?.at ?? null),
    };
  }

  private fail(message: string): void {
    this.lastError = { message, at: this.now() };
    this.log.warn(`SIP relay: ${message}`);
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.fail(
          `cannot listen: ${(error as NodeJS.ErrnoException).code ?? "error"}`,
        );
        this.server = null;
        reject(error);
      };
      server.once("error", onError);
      server.listen(this.options.listen.port, this.options.listen.host, () => {
        server.off("error", onError);
        server.on("error", (error) =>
          this.fail(
            `server: ${(error as NodeJS.ErrnoException).code ?? "error"}`,
          ),
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const pair of [...this.pairs]) this.close(pair);
    if (server?.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(down: net.Socket): void {
    down.pause();
    down.on("error", () => undefined);
    const remote = normalizeAddress(down.remoteAddress);
    if (this.pairs.size >= this.maxConnections) {
      this.counters.rejected++;
      this.fail("too many connections");
      down.destroy();
      return;
    }
    const pair: Pair = {
      down,
      up: null,
      closed: false,
      last: this.now(),
      timer: null,
    };
    this.pairs.add(pair);
    down.on("close", () => this.close(pair));
    this.options
      .allow()
      .then((allowed) => {
        if (pair.closed) return;
        if (!remote || !allowed.includes(remote)) {
          this.counters.rejected++;
          this.fail("connection from a non-allowed address rejected");
          this.close(pair);
          return;
        }
        this.open(pair);
      })
      .catch(() => this.close(pair));
  }

  private open(pair: Pair): void {
    const { down } = pair;
    const up = net.connect({
      host: this.options.target.host,
      port: this.options.target.port,
    });
    pair.up = up;
    this.counters.total++;
    up.setNoDelay(true);
    down.setNoDelay(true);
    up.setKeepAlive(true, 30_000);
    down.setKeepAlive(true, 30_000);
    const connectTimer = setTimeout(() => {
      this.fail("upstream connect timeout");
      this.close(pair);
    }, this.connectTimeoutMs);
    connectTimer.unref();
    up.on("error", (error) => {
      this.fail(
        `upstream: ${(error as NodeJS.ErrnoException).code ?? "error"}`,
      );
      this.close(pair);
    });
    up.on("close", () => this.close(pair));
    up.once("connect", () => {
      clearTimeout(connectTimer);
      if (pair.closed) return;
      pair.timer = setInterval(
        () => {
          if (this.now() - pair.last > this.idleMs) this.close(pair);
        },
        Math.max(1000, Math.min(this.idleMs / 4, 60_000)),
      );
      pair.timer.unref();
      // Asterisk may name the relay by its proxy name or, after its own NAT fix-ups, by the relay's address.
      const own = [
        this.options.proxy,
        {
          host: normalizeAddress(down.localAddress),
          port: down.localPort ?? this.options.listen.port,
        },
      ];
      this.pump(pair, down, up, new SipFramer(this.limits), (item) =>
        this.towardsUpstream(item, up, own),
      );
      this.pump(pair, up, down, new SipFramer(this.limits), (item) =>
        this.towardsDownstream(item, up, down),
      );
    });
  }

  /** Reads `from`, frames what arrives and hands whole items to `handle`; a full write buffer pauses `from`. */
  private pump(
    pair: Pair,
    from: net.Socket,
    to: net.Socket,
    framer: SipFramer,
    handle: (item: FrameItem) => boolean,
  ): void {
    from.on("data", (chunk: Buffer) => {
      if (pair.closed) return;
      pair.last = this.now();
      try {
        let ok = true;
        for (const item of framer.push(chunk)) ok = handle(item) && ok;
        if (!ok && !from.isPaused()) {
          from.pause();
          to.once("drain", () => from.resume());
        }
      } catch (error) {
        this.fail(
          error instanceof SipFramingError
            ? `malformed SIP: ${error.message}`
            : "relay error",
        );
        this.close(pair);
      }
    });
    from.resume();
  }

  private towardsUpstream(
    item: FrameItem,
    up: net.Socket,
    own: Array<{ host: string; port: number }>,
  ): boolean {
    if (item.type === "raw") return up.write(item.bytes);
    return up.write(stripOwnRoute(item.message, own));
  }

  private towardsDownstream(
    item: FrameItem,
    up: net.Socket,
    down: net.Socket,
  ): boolean {
    if (item.type === "raw") return down.write(item.bytes);
    const message = item.message;
    const decision = decideInbound(message);
    if (decision.action === "forward") {
      if (decision.rewritten) {
        this.counters.rewritten++;
        this.log.log(
          `SIP relay: MESSAGE message/cpim ${message.raw.length}B rewritten to text/plain ${decision.bytes.length}B`,
        );
      }
      return down.write(decision.bytes);
    }
    this.counters.answered++;
    this.counters.dropped++;
    if (decision.category === "unreadable") {
      this.counters.unreadable++;
      this.lastUnreadableAt = this.now();
    }
    this.log.log(
      `SIP relay: MESSAGE ${decision.contentType || "-"} ${message.body.length}B answered 200 and dropped (${decision.reason})`,
    );
    up.write(decision.response);
    return true;
  }

  private close(pair: Pair): void {
    if (pair.closed) return;
    pair.closed = true;
    if (pair.timer) clearInterval(pair.timer);
    this.pairs.delete(pair);
    pair.down.destroy();
    pair.up?.destroy();
  }
}
