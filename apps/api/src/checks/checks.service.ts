import {
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type {
  AlertInfo,
  HaEntity,
  ServiceCheckResult,
  StackServiceStatus,
} from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import {
  JarvisStateStore,
  MAX_ALERTS,
  newId,
} from "../planning/jarvis-state.store.js";
import { ProxmoxService } from "../proxmox/proxmox.service.js";
import { HomeAssistantService } from "../home/home-assistant.service.js";
import { StackControlService } from "../settings/stack-control.service.js";
import { UpdatesService } from "../settings/updates.service.js";
import { parseTargets, probe } from "./probe.js";
import tls from "node:tls";
import net from "node:net";

interface Raise {
  key: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail?: string;
}

/** Inventory only Home Assistant's explicit device_tracker entities; no IP/MAC data is kept. */
export function trackerInventory(entities: HaEntity[]): Record<string, string> {
  return Object.fromEntries(
    entities
      .filter((entity) => entity.domain === "device_tracker")
      .map((entity) => [
        entity.entity_id,
        String(entity.friendly_name || entity.entity_id).slice(0, 80),
      ]),
  );
}

export function trackerChanges(
  previous: Record<string, string>,
  current: Record<string, string>,
) {
  return {
    added: Object.entries(current).filter(([id]) => !(id in previous)),
    removed: Object.entries(previous).filter(([id]) => !(id in current)),
  };
}

type ContainerSnapshot = { state: string; startedAt: string | null };
type ContainerChange = {
  kind: "stopped" | "recovered" | "restarted";
  service: StackServiceStatus;
};
export function containerChanges(
  previous: Record<string, ContainerSnapshot>,
  current: StackServiceStatus[],
) {
  return current.flatMap<ContainerChange>((service) => {
    const was = previous[service.id];
    if (!was) return [];
    if (was.state === "running" && service.state !== "running")
      return [{ kind: "stopped" as const, service }];
    if (was.state !== "running" && service.state === "running")
      return [{ kind: "recovered" as const, service }];
    if (
      was.state === "running" &&
      service.state === "running" &&
      was.startedAt &&
      service.startedAt &&
      was.startedAt !== service.startedAt
    )
      return [{ kind: "restarted" as const, service }];
    return [];
  });
}

type PowerSensor = { id: string; name: string; watts: number };
type PowerSample = { at: number; watts: number };
type PowerHistory = { samples: PowerSample[]; alertedAt?: number };
export function certificateDaysRemaining(
  validTo: string,
  now = Date.now(),
): number | null {
  const expiry = Date.parse(validTo);
  return Number.isFinite(expiry)
    ? Math.ceil((expiry - now) / 86_400_000)
    : null;
}

export function certificateExpiry(
  urlText: string,
  timeoutMs = 5000,
): Promise<string | null> {
  let target: URL;
  try {
    target = new URL(urlText);
    if (target.protocol !== "https:" || target.username || target.password)
      return Promise.resolve(null);
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = tls.connect({
      host: target.hostname,
      port: Number(target.port || 443),
      ...(net.isIP(target.hostname) ? {} : { servername: target.hostname }),
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });
    socket.once("secureConnect", () => {
      const validTo = socket.getPeerCertificate().valid_to;
      finish(typeof validTo === "string" ? validTo : null);
    });
    socket.once("timeout", () => finish(null));
    socket.once("error", () => finish(null));
  });
}
export function powerSensors(entities: HaEntity[]): PowerSensor[] {
  return entities
    .filter(
      (entity) =>
        entity.domain === "sensor" &&
        entity.attributes?.device_class === "power",
    )
    .flatMap((entity) => {
      const value = Number(entity.state);
      const unit = String(entity.attributes?.unit_of_measurement ?? "")
        .trim()
        .toLowerCase();
      const factor =
        unit === "w" ? 1 : unit === "kw" ? 1000 : unit === "mw" ? 0.001 : 0;
      if (!Number.isFinite(value) || value < 0 || !factor) return [];
      return [
        {
          id: entity.entity_id,
          name: String(entity.friendly_name || entity.entity_id).slice(0, 80),
          watts: value * factor,
        },
      ];
    })
    .slice(0, 100);
}

export function highPowerEvents(
  sensors: PowerSensor[],
  history: Record<string, PowerHistory>,
  now: number,
): {
  events: { id: string; name: string; watts: number; average: number }[];
  next: Record<string, PowerHistory>;
} {
  const next: Record<string, PowerHistory> = {};
  const events: { id: string; name: string; watts: number; average: number }[] =
    [];
  for (const sensor of sensors) {
    const previous = history[sensor.id] ?? { samples: [] };
    const samples = previous.samples.filter(
      (sample) => now - sample.at <= 30 * 60_000,
    );
    const average = samples.length
      ? samples.reduce((sum, sample) => sum + sample.watts, 0) / samples.length
      : 0;
    const last = samples.at(-1);
    if (!last || now - last.at >= 5 * 60_000)
      samples.push({ at: now, watts: sensor.watts });
    const alerting =
      samples.length >= 6 &&
      sensor.watts >= 1500 &&
      average > 0 &&
      sensor.watts >= average * 2.5;
    const cooldown =
      !previous.alertedAt || now - previous.alertedAt >= 60 * 60_000;
    const alertedAt = alerting && cooldown ? now : previous.alertedAt;
    if (alerting && cooldown)
      events.push({
        id: sensor.id,
        name: sensor.name,
        watts: sensor.watts,
        average,
      });
    next[sensor.id] = {
      samples: samples.slice(-7),
      ...(alertedAt ? { alertedAt } : {}),
    };
  }
  return { events, next };
}

/** Reachability checks and the watchdog that raises (and closes) alerts. */
@Injectable()
export class ChecksService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;

  constructor(
    private readonly config: NovaConfig,
    private readonly store: JarvisStateStore,
    private readonly proxmox: ProxmoxService,
    @Optional() private readonly home?: HomeAssistantService,
    @Optional() private readonly stack?: StackControlService,
    @Optional() private readonly updates?: UpdatesService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === "test") return;
    const run = () => void this.watchdog().catch(() => undefined);
    this.first = setTimeout(run, 10_000);
    this.timer = setInterval(run, 60_000);
    this.first.unref();
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  targets(): Record<string, string> {
    return parseTargets(this.config.checkTargets, this.config.proxmox.url);
  }

  /** Probe all targets, or only `only`. Unknown names throw a Dutch message. */
  async check(only?: string): Promise<ServiceCheckResult[]> {
    const targets = this.targets();
    const wanted = only?.toLowerCase();
    if (wanted && !targets[wanted])
      throw new Error(
        `Onbekend doel. Bekende doelen: ${Object.keys(targets).join(", ")}`,
      );
    const names = wanted ? [wanted] : Object.keys(targets);
    return Promise.all(
      names.map(async (name) => ({
        name,
        ...(await probe(targets[name] ?? "")),
      })),
    );
  }

  /** Recent alerts, newest first, with whether each is still open. */
  alerts(limit = 10): AlertInfo[] {
    const state = this.store.data;
    return state.alerts.slice(0, limit).map((alert) => ({
      ...alert,
      severity: alert.severity as AlertInfo["severity"],
      open: !!state.active[alert.key],
    }));
  }

  private raise({ key, severity, title, detail }: Raise): void {
    const state = this.store.data;
    const alert = {
      id: newId(),
      key,
      severity,
      title,
      detail: detail || "",
      at: new Date().toISOString(),
    };
    state.alerts.unshift(alert);
    state.alerts.length = Math.min(state.alerts.length, MAX_ALERTS);
    if (severity !== "info") state.active[key] = true;
    this.store.emit({
      topic: "jarvis/alerts",
      payload: { type: "alert", ...alert },
    });
    this.store.save();
  }

  private resolve(key: string): void {
    delete this.store.data.active[key];
  }

  /** One watchdog round: Proxmox transitions, then service reachability. */
  async watchdog(): Promise<void> {
    const state = this.store.data;
    const firstRun = !state.watch.guests;
    if (this.proxmox.configured) {
      try {
        const [guests, nodes, storage] = await Promise.all([
          this.proxmox.resources("vm"),
          this.proxmox.rawNodes(),
          this.proxmox.resources("storage"),
        ]);
        this.resolve("proxmox-down");
        const previous = state.watch.guests || {};
        const next: Record<string, string> = {};
        for (const guest of guests) {
          next[String(guest.vmid)] = guest.status ?? "";
          const was = previous[String(guest.vmid)];
          if (firstRun || was === undefined) continue;
          const key = `vm-${guest.vmid}-stopped`;
          if (was === "running" && guest.status !== "running")
            this.raise({
              key,
              severity: "warning",
              title: `${guest.name} is gestopt`,
              detail: `VM ${guest.vmid} draaide net nog.`,
            });
          if (was !== "running" && guest.status === "running") {
            this.resolve(key);
            this.raise({
              key,
              severity: "info",
              title: `${guest.name} draait weer`,
              detail: `VM ${guest.vmid} is gestart.`,
            });
          }
        }
        state.watch.guests = next;
        for (const node of nodes) {
          const key = `node-${node.node}`;
          if (node.status !== "online" && !state.active[key])
            this.raise({
              key,
              severity: "critical",
              title: `Node ${node.node} is offline`,
              detail: "De Proxmox-node reageert niet.",
            });
          if (node.status === "online") this.resolve(key);
        }
        for (const store of storage) {
          if (!((store.maxdisk ?? 0) > 0)) continue;
          const used = (store.disk ?? 0) / (store.maxdisk ?? 1);
          const key = `storage-${store.storage}`;
          if (used >= 0.9 && !state.active[key])
            this.raise({
              key,
              severity: "warning",
              title: `Opslag ${store.storage} zit bijna vol`,
              detail: `${Math.round(used * 100)}% in gebruik.`,
            });
          if (used < 0.85) this.resolve(key);
        }
      } catch {
        if (!state.active["proxmox-down"])
          this.raise({
            key: "proxmox-down",
            severity: "warning",
            title: "Proxmox is niet bereikbaar",
            detail: "De API gaf geen antwoord.",
          });
        state.watch.guests ||= {};
      }
    }
    for (const result of await this.check()) {
      const key = `service-${result.name}`;
      if (result.ok) {
        state.watch.down[result.name] = 0;
        if (state.active[key]) {
          this.resolve(key);
          this.raise({
            key,
            severity: "info",
            title: `${result.name} is weer bereikbaar`,
            detail: `Antwoordt weer binnen ${result.ms} ms.`,
          });
        }
      } else {
        state.watch.down[result.name] =
          (state.watch.down[result.name] || 0) + 1;
        // Two misses in a row, so one slow request does not wake anyone.
        if ((state.watch.down[result.name] ?? 0) >= 2 && !state.active[key])
          this.raise({
            key,
            severity: "warning",
            title: `${result.name} reageert niet`,
            detail: result.detail,
          });
      }
    }
    if (this.home?.configured) {
      try {
        const entities = await this.home.sync();
        const next = trackerInventory(entities);
        const previous = state.watch.devices;
        if (previous) {
          const changes = trackerChanges(previous, next);
          for (const [id, name] of changes.added)
            this.raise({
              key: `device-tracker-${id}`,
              severity: "info",
              title: `Nieuw apparaat gevonden: ${name}`,
              detail: "Home Assistant meldt een nieuwe device tracker.",
            });
          for (const [id, name] of changes.removed)
            this.raise({
              key: `device-tracker-${id}`,
              severity: "info",
              title: `Apparaat niet meer gevonden: ${name}`,
              detail: "De device tracker staat niet meer in Home Assistant.",
            });
        }
        state.watch.devices = next;
        const energy = highPowerEvents(
          powerSensors(entities),
          state.watch.energy ?? {},
          Date.now(),
        );
        state.watch.energy = energy.next;
        for (const event of energy.events)
          this.raise({
            key: `high-power-${event.id}`,
            severity: "warning",
            title: `Hoog stroomverbruik: ${event.name}`,
            detail: `${Math.round(event.watts)} W; gemiddeld ${Math.round(event.average)} W in de meetperiode.`,
          });
      } catch {
        // A failed Home Assistant sync must not look like mass device removal.
      }
    }
    if (this.stack && this.config.stackControlToken) {
      const status = await this.stack.status();
      if (status.available) {
        const previous = state.watch.containers;
        if (previous) {
          for (const { kind, service } of containerChanges(
            previous,
            status.services,
          )) {
            const key = `container-${service.id}`;
            if (kind === "stopped") {
              this.raise({
                key,
                severity: "critical",
                title: `${service.label} container is gestopt`,
                detail: `Containerstatus: ${service.state}.`,
              });
            } else if (kind === "recovered") {
              this.resolve(key);
              this.raise({
                key,
                severity: "info",
                title: `${service.label} container draait weer`,
              });
            } else {
              this.raise({
                key,
                severity: "info",
                title: `${service.label} container is herstart`,
                detail: "De starttijd is veranderd sinds de vorige controle.",
              });
            }
          }
        }
        state.watch.containers = Object.fromEntries(
          status.services.map((service) => [
            service.id,
            { state: service.state, startedAt: service.startedAt ?? null },
          ]),
        );
      }
    }
    if (
      this.updates &&
      Date.now() - (state.watch.releaseCheckAt ?? 0) >= 6 * 60 * 60 * 1000
    ) {
      state.watch.releaseCheckAt = Date.now();
      try {
        const report = await this.updates.check();
        const version = report.latest?.version;
        if (
          report.updateAvailable &&
          version &&
          state.watch.latestRelease !== version
        ) {
          state.watch.latestRelease = version;
          this.raise({
            key: "nova-update",
            severity: "info",
            title: `NOVA ${version} is beschikbaar`,
            detail: "Bekijk de release in Systeem om de wijzigingen te lezen.",
          });
        } else if (!report.updateAvailable) {
          state.watch.latestRelease = null;
        }
      } catch {
        // Release metadata is optional; a failed check is not an outage alert.
      }
    }
    if (this.config.publicUrl) {
      const expiry = await certificateExpiry(this.config.publicUrl);
      if (expiry) {
        const oldExpiry = state.watch.certExpiresAt ?? null;
        if (expiry !== oldExpiry) {
          state.watch.certExpiresAt = expiry;
          if (oldExpiry) this.resolve("nova-certificate");
        }
        const days = certificateDaysRemaining(expiry);
        if (days !== null && days <= 30) {
          if (!state.active["nova-certificate"])
            this.raise({
              key: "nova-certificate",
              severity: days <= 7 ? "critical" : "warning",
              title:
                days < 0
                  ? "TLS-certificaat is verlopen"
                  : `TLS-certificaat verloopt over ${days} dagen`,
              detail:
                "Controleer de certificaatvernieuwing van NOVA's HTTPS-adres.",
            });
        } else {
          this.resolve("nova-certificate");
        }
      }
    }
    this.store.save();
  }
}
