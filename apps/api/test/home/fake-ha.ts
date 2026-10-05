import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

interface FakeEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_updated: string;
}

const entity = (
  entity_id: string,
  state: string,
  attributes: Record<string, unknown>,
): FakeEntity => ({
  entity_id,
  state,
  attributes,
  last_updated: "2026-01-01",
});

interface Body extends Record<string, unknown> {
  entity_id?: string;
  temperature?: number;
  source?: string;
  volume_level?: number;
  is_volume_muted?: boolean;
  group_members?: string[];
  brightness_pct?: number;
  rgb_color?: number[];
  media_content_id?: string;
  media_id?: string;
}

export const TOKEN = "fixture-ha";

/** A fake Home Assistant: REST states/services and the WebSocket registries, like the prototype's. */
export async function fakeHomeAssistant() {
  const actions: { path: string; body: Record<string, unknown> }[] = [];
  let verifyFailure = false;
  let offline = false;
  let hideMusic = false;
  const entities = [
    entity("light.office", "off", {
      friendly_name: "Kantoor lamp",
      brightness: 100,
    }),
    entity("light.living", "off", { friendly_name: "Woonkamer lamp" }),
    entity("media_player.office", "paused", {
      friendly_name: "Kantoor Sonos",
      volume_level: 0.2,
      media_content_id: "track:1",
      source_list: ["Favorite"],
    }),
    entity("climate.office", "heat", {
      friendly_name: "Kantoor thermostaat",
      temperature: 20,
    }),
    entity("lock.front", "locked", { friendly_name: "Voordeur" }),
    entity("script.evening", "off", { friendly_name: "Avond" }),
    entity("media_player.living", "paused", {
      friendly_name: "Woonkamer Sonos",
      volume_level: 0.2,
    }),
    entity("tts.fixture", "unknown", { friendly_name: "Test TTS" }),
    entity("switch.server_rack", "on", { friendly_name: "Server rek" }),
  ];
  const serviceNames = (domain: string): string[] =>
    domain === "media_player"
      ? [
          "media_play",
          "media_pause",
          "media_stop",
          "media_next_track",
          "media_previous_track",
          "select_source",
          "volume_set",
          "volume_mute",
          "play_media",
          "join",
          "unjoin",
        ]
      : domain === "music_assistant"
        ? ["play_media"]
        : domain === "climate"
          ? ["set_temperature"]
          : domain === "lock"
            ? ["lock", "unlock"]
            : ["turn_on", "turn_off", "toggle"];
  const services = () =>
    [
      "light",
      "switch",
      "fan",
      "climate",
      "scene",
      "script",
      "lock",
      "cover",
      "media_player",
      "music_assistant",
    ]
      .filter((domain) => !(hideMusic && domain === "music_assistant"))
      .map((domain) => ({
        domain,
        services: Object.fromEntries(
          serviceNames(domain).map((name) => [name, {}]),
        ),
      }));

  const apply = (item: FakeEntity, service: string, body: Body) => {
    const attributes = item.attributes;
    if (service === "turn_on") item.state = "on";
    if (service === "turn_off") item.state = "off";
    if (service === "toggle") item.state = item.state === "on" ? "off" : "on";
    if (service === "set_temperature")
      attributes.temperature = body.temperature;
    if (service === "select_source") attributes.source = body.source;
    if (service === "volume_set") attributes.volume_level = body.volume_level;
    if (service === "volume_mute")
      attributes.is_volume_muted = body.is_volume_muted;
    if (service === "media_play" || service === "play_media")
      item.state = "playing";
    if (service === "media_pause") item.state = "paused";
    if (service === "media_stop") item.state = "idle";
    if (service.includes("track"))
      attributes.media_content_id = `track:${Date.now()}`;
    if (service === "join")
      attributes.group_members = [
        item.entity_id,
        ...(body.group_members ?? []),
      ];
    if (service === "unjoin") attributes.group_members = [item.entity_id];
    if (service === "unlock") item.state = "unlocked";
    if (service === "lock") item.state = "locked";
    if (body.brightness_pct !== undefined)
      attributes.brightness = (body.brightness_pct * 255) / 100;
    if (body.rgb_color) attributes.rgb_color = body.rgb_color;
    if (body.media_content_id)
      attributes.media_content_id = body.media_content_id;
    if (body.media_id) attributes.media_content_id = body.media_id;
    item.last_updated = new Date().toISOString();
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = raw ? (JSON.parse(raw) as Body) : {};
      const path = new URL(req.url ?? "/", "http://fixture").pathname;
      const json = (data: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (offline) return json({ error: "offline" }, 503);
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json({}, 401);
      if (path === "/api/states") return json(entities);
      if (path === "/api/services") return json(services());
      if (path.startsWith("/api/states/")) {
        const found = entities.find(
          (item) =>
            item.entity_id === decodeURIComponent(path.split("/").at(-1)!),
        );
        return json(found ?? {}, found ? 200 : 404);
      }
      if (path.startsWith("/api/services/")) {
        actions.push({ path, body });
        const found = entities.find(
          (item) => item.entity_id === body.entity_id,
        );
        if (found && !verifyFailure)
          apply(found, path.split("/").at(-1)!, body);
        return json([]);
      }
      return json({}, 404);
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  const wss = new WebSocketServer({ server, path: "/api/websocket" });
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "auth_required" }));
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as {
        type: string;
        id?: number;
        access_token?: string;
      };
      if (message.type === "auth") {
        socket.send(
          JSON.stringify({
            type: message.access_token === TOKEN ? "auth_ok" : "auth_invalid",
          }),
        );
        return;
      }
      const result =
        message.type === "config/area_registry/list"
          ? [
              { area_id: "office", name: "Kantoor" },
              { area_id: "living", name: "Woonkamer" },
            ]
          : message.type === "config/device_registry/list"
            ? [
                {
                  id: "sonos-office",
                  name: "Kantoor Sonos",
                  manufacturer: "Sonos",
                  area_id: "office",
                },
                {
                  id: "sonos-living",
                  name: "Woonkamer Sonos",
                  manufacturer: "Sonos",
                  area_id: "living",
                },
              ]
            : entities.map((item) => ({
                entity_id: item.entity_id,
                area_id: item.entity_id.includes("office") ? "office" : null,
                device_id: item.entity_id.startsWith("media_player")
                  ? item.entity_id === "media_player.living"
                    ? "sonos-living"
                    : "sonos-office"
                  : null,
                aliases: item.entity_id === "light.office" ? ["Werklicht"] : [],
              }));
      socket.send(
        JSON.stringify({
          id: message.id,
          type: "result",
          success: true,
          result,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    actions,
    entities,
    setVerificationFailure: (value: boolean) => (verifyFailure = value),
    setOffline: (value: boolean) => (offline = value),
    hideMusicAssistant: (value: boolean) => (hideMusic = value),
    close: async () => {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(() => server.close(resolve)));
    },
  };
}
