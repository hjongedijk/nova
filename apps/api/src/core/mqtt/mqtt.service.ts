import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import mqtt, { type MqttClient } from "mqtt";
import { NovaConfig } from "../config/nova-config.js";
import { sanitize } from "../security/sanitize.js";
import { StateService } from "../state/state.service.js";

const ALLOWED_TOPIC =
  /^jarvis\/(events\/(tool|proxmox|system|conversation|web|timer)|status\/(api|node-red|proxmox)|alerts)$/;

const TOPICS = [
  "jarvis/events/tool",
  "jarvis/events/proxmox",
  "jarvis/events/system",
  "jarvis/events/conversation",
  "jarvis/events/web",
  "jarvis/events/timer",
  "jarvis/status/api",
  "jarvis/status/node-red",
  "jarvis/status/proxmox",
  "jarvis/alerts",
] as const;

export interface MqttRecentMessage {
  topic: (typeof TOPICS)[number];
  at: string;
  summary: string;
  delivery: "pending" | "accepted" | "failed";
}

/** Publishes NOVA's events on the message bus, for Node-RED flows and other listeners. */
@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private client?: MqttClient;
  private watchdog?: NodeJS.Timeout;
  private readonly log = new Logger("MQTT");
  private readonly recent: MqttRecentMessage[] = [];

  constructor(
    private readonly config: NovaConfig,
    private readonly state: StateService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === "test") return;
    this.client = mqtt.connect(this.config.mqttUrl, {
      clientId: `nova-${process.pid}`,
      reconnectPeriod: 5000,
      keepalive: 30,
      connectTimeout: 10_000,
      will: {
        topic: "jarvis/status/api",
        payload: Buffer.from(
          JSON.stringify(this.envelope("offline", {}, "warning")),
        ),
        retain: true,
        qos: 0,
      },
    });
    this.client.on("connect", () => {
      this.log.log("connected");
      this.state.update("mqtt", { connected: true });
      this.publish("jarvis/status/api", { type: "online" }, true);
    });
    this.client.on("offline", () =>
      this.state.update("mqtt", { connected: false }),
    );
    this.client.on("close", () => {
      this.state.update("mqtt", { connected: false });
      this.log.warn("connection closed, reconnecting");
    });
    this.client.on("error", () => this.log.warn("connection error"));
    // The status must not go stale while the connection is quietly up, and a
    // client that stopped retrying is pushed to reconnect.
    this.watchdog = setInterval(() => {
      const connected = this.connected;
      this.state.update("mqtt", { connected });
      if (!connected && this.client && !this.client.reconnecting) {
        this.log.warn("not connected, forcing a reconnect");
        this.client.reconnect();
      }
    }, 20_000);
    this.watchdog.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.watchdog);
    await this.client?.endAsync(true);
  }

  get connected(): boolean {
    return this.client?.connected === true;
  }

  overview() {
    return {
      connected: this.connected,
      topics: TOPICS,
      recent: this.recent.map((message) => ({ ...message })),
    };
  }

  private messageSummary(topic: string, data: Record<string, unknown>): string {
    if (topic === "jarvis/events/tool") {
      const result =
        typeof data.ok === "boolean"
          ? data.ok
            ? "geslaagd"
            : "mislukt"
          : "resultaat onbekend";
      const duration =
        typeof data.durationMs === "number" && Number.isFinite(data.durationMs)
          ? ` · ${Math.max(0, Math.min(3_600_000, Math.round(data.durationMs)))} ms`
          : "";
      return `Tool ${result}${duration}`;
    }
    if (topic === "jarvis/events/conversation")
      return "Gesprek afgerond · inhoud verborgen";
    if (topic === "jarvis/events/timer")
      return "Timergebeurtenis · label verborgen";
    if (topic === "jarvis/alerts") return "Melding · details verborgen";
    if (topic.startsWith("jarvis/status/")) return "Status bijgewerkt";
    if (topic === "jarvis/events/proxmox") return "Proxmox-gebeurtenis";
    if (topic === "jarvis/events/system") return "Systeemgebeurtenis";
    return "Gebeurtenis gepubliceerd";
  }

  envelope(type: string, data: unknown, severity = "info") {
    return {
      type,
      source: "nova",
      severity,
      timestamp: new Date().toISOString(),
      data: sanitize(data),
    };
  }

  publish(topic: string, data: Record<string, unknown>, retain = false): void {
    if (!ALLOWED_TOPIC.test(topic) || !this.client?.connected) return;
    const type = typeof data.type === "string" ? data.type : "update";
    const entry: MqttRecentMessage = {
      topic: topic as MqttRecentMessage["topic"],
      at: new Date().toISOString(),
      summary: this.messageSummary(topic, data),
      delivery: "pending",
    };
    this.recent.unshift(entry);
    this.recent.length = Math.min(this.recent.length, 50);
    this.client.publish(
      topic,
      JSON.stringify(this.envelope(type, data)),
      { retain },
      (error) => {
        entry.delivery = error ? "failed" : "accepted";
      },
    );
  }
}
