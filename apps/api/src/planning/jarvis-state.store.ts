import { Injectable, Logger } from "@nestjs/common";
import type { InfrastructureEvent } from "@nova/contracts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../core/config/nova-config.js";
import { MqttService } from "../core/mqtt/mqtt.service.js";

export interface StoredTimer {
  id: string;
  label: string;
  fireAt: number;
  createdAt?: number;
}
export interface StoredListItem {
  id: string;
  text: string;
  addedAt: string;
}
export interface StoredAlert {
  id: string;
  key: string;
  severity: string;
  title: string;
  detail: string;
  at: string;
}
/** The shape of jarvis-state.json, unchanged from the prototype. */
export interface JarvisState {
  timers: StoredTimer[];
  lists: Record<string, StoredListItem[]>;
  alerts: StoredAlert[];
  active: Record<string, boolean>;
  watch: {
    guests: Record<string, string> | null;
    down: Record<string, number>;
    devices?: Record<string, string> | null;
  };
  [extra: string]: unknown;
}

export const MAX_ALERTS = 50;
export const newId = () => crypto.randomBytes(4).toString("hex");

/**
 * jarvis-state.json in the data folder: timers, lists, alerts and watchdog memory. Shared by the
 * planning and checks modules. Events (fired timers, new alerts) go to in-process listeners and
 * to MQTT.
 */
@Injectable()
export class JarvisStateStore {
  private state: JarvisState | null = null;
  private readonly listeners = new Set<(event: InfrastructureEvent) => void>();
  private readonly log = new Logger("JarvisState");

  constructor(
    private readonly config: NovaConfig,
    private readonly mqtt: MqttService,
  ) {}

  get file(): string {
    return this.config.dataFile("jarvis-state.json");
  }

  get data(): JarvisState {
    if (this.state) return this.state;
    let parsed: Partial<JarvisState> = {};
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as JarvisState;
    } catch {
      /* no file yet, or unreadable: start empty */
    }
    const state = { ...parsed } as JarvisState;
    state.timers ||= [];
    state.lists ||= {};
    state.alerts ||= [];
    state.active ||= {};
    state.watch ||= { guests: null, down: {} };
    state.watch.down ||= {};
    this.state = state;
    return state;
  }

  save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
      fs.renameSync(tmp, this.file);
    } catch (error) {
      this.log.warn(`could not save state: ${(error as Error).message}`);
    }
  }

  /** Snapshot only user lists; active timers and system state are intentionally excluded from backups. */
  getListsSnapshot(): Record<string, StoredListItem[]> {
    return structuredClone(this.data.lists);
  }

  /** Replace lists atomically without touching timers, alerts or watchdog state. */
  replaceLists(lists: Record<string, StoredListItem[]>): void {
    const next = { ...this.data, lists: structuredClone(lists) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 1), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.file);
      this.state = next;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  /** Forget the in-memory copy; the next read loads the file again (a restart, in tests). */
  reload(): void {
    this.state = null;
  }

  onEvent(listener: (event: InfrastructureEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: InfrastructureEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a broken listener must not stop the others */
      }
    }
    this.mqtt.publish(event.topic, event.payload);
  }
}
