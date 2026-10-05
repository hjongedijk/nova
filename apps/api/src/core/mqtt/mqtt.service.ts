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

/** Publishes NOVA's events on the message bus, for Node-RED flows and other listeners. */
@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private client?: MqttClient;
  private readonly log = new Logger("MQTT");

  constructor(
    private readonly config: NovaConfig,
    private readonly state: StateService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === "test") return;
    this.client = mqtt.connect(this.config.mqttUrl, {
      clientId: `nova-${process.pid}`,
      reconnectPeriod: 5000,
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
    this.client.on("error", () => this.log.warn("connection error"));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.endAsync(true);
  }

  get connected(): boolean {
    return this.client?.connected === true;
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
    this.client.publish(topic, JSON.stringify(this.envelope(type, data)), {
      retain,
    });
  }
}
