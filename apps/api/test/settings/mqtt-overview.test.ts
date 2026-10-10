import { describe, expect, it, vi } from "vitest";
import { MqttService } from "../../src/core/mqtt/mqtt.service.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { StateService } from "../../src/core/state/state.service.js";

function fixture() {
  const service = new MqttService({} as NovaConfig, {} as StateService);
  const callbacks: ((error?: Error) => void)[] = [];
  const client = {
    connected: true,
    publish: vi.fn(
      (
        _topic: string,
        _payload: string,
        _options: { retain: boolean },
        callback: (error?: Error) => void,
      ) => {
        callbacks.push(callback);
      },
    ),
  };
  (service as unknown as { client: typeof client }).client = client;
  return { service, client, callbacks };
}

describe("private MQTT overview", () => {
  it("lists fixed topics and summarizes outbound messages without payload data", () => {
    const { service, callbacks } = fixture();
    service.publish("jarvis/events/timer", {
      type: "timer_fired",
      label: "private label",
    });
    callbacks[0]!();
    const overview = service.overview();
    expect(overview.topics).toContain("jarvis/events/timer");
    expect(overview.recent[0]).toMatchObject({
      topic: "jarvis/events/timer",
      summary: "Timergebeurtenis · label verborgen",
      delivery: "accepted",
    });
    expect(JSON.stringify(overview)).not.toContain("private label");
  });

  it("keeps only the newest fifty entries and records delivery failure", () => {
    const { service, callbacks } = fixture();
    for (let index = 0; index < 51; index++)
      service.publish("jarvis/events/tool", { ok: true, durationMs: index });
    callbacks[1]!(new Error("broker detail"));
    const { recent } = service.overview();
    expect(recent).toHaveLength(50);
    expect(recent.at(-1)?.delivery).toBe("failed");
    expect(JSON.stringify(recent)).not.toContain("broker detail");
  });

  it("does not record messages for unlisted topics or disconnected broker", () => {
    const { service, client } = fixture();
    service.publish("private/topic", { secret: "hidden" });
    client.connected = false;
    service.publish("jarvis/events/tool", { secret: "hidden" });
    expect(service.overview().recent).toEqual([]);
    expect(client.publish).not.toHaveBeenCalled();
  });
});
