import { Logger } from "@nestjs/common";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditEnvironment } from "../../../src/core/config/env-audit.js";
import { NovaConfig } from "../../../src/core/config/nova-config.js";

describe("environment audit messages", () => {
  it("names variables Settings owns, never their values", () => {
    const messages = auditEnvironment(
      { NTFY_TOPIC: "secret-topic", PROXMOX_TOKEN_SECRET: "hunter2" },
      {},
      {},
    );
    expect(messages).toContain(
      "NTFY_TOPIC is now managed in Settings; remove it from .env.",
    );
    expect(messages).toContain(
      "PROXMOX_TOKEN_SECRET is now managed in Settings; remove it from .env.",
    );
    expect(messages.join("\n")).not.toMatch(/secret-topic|hunter2/);
  });

  it("stays quiet for the .env bootstrap values and internal wiring", () => {
    expect(
      auditEnvironment(
        {
          OMNIROUTE_API_KEY: "k",
          OMNIROUTE_ADMIN_PASSWORD: "p",
          NODE_RED_EVENT_TOKEN: "t",
          OMNIROUTE_URL: "http://omniroute:20128/v1",
          QDRANT_URL: "http://qdrant:6333",
          NOVA_PUBLIC_URL: "https://nova.example.com",
        },
        {},
        {},
      ),
    ).toEqual([]);
  });

  it("reports a mismatch with Settings, including for bootstrap keys", () => {
    const messages = auditEnvironment(
      { OMNIROUTE_API_KEY: "old", PROXMOX_VERIFY_TLS: "true" },
      {
        omniroute: { apiKey: "new" },
        proxmox: { verifyTls: true },
      },
      {},
    );
    expect(messages).toEqual([
      "OMNIROUTE_API_KEY in .env differs from the value saved in Settings; the Settings value is used.",
      "PROXMOX_VERIFY_TLS is now managed in Settings; remove it from .env.",
    ]);
  });

  it("flags the dead embedding key and settings owned elsewhere", () => {
    const messages = auditEnvironment(
      { EMBEDDING_GATEWAY_API_KEY: "x", CALDAV_URL: "u", TTS_VOICE: "v" },
      {},
      {},
    );
    expect(
      messages.some((m) => m.startsWith("EMBEDDING_GATEWAY_API_KEY")),
    ).toBe(true);
    expect(messages).toContain(
      "CALDAV_URL is now managed in Settings; remove it from .env.",
    );
    expect(messages).toContain(
      "TTS_VOICE is now managed in Settings; remove it from .env.",
    );
  });
});

describe("NovaConfig runtime precedence and startup audit", () => {
  const names = [
    "NOVA_DATA_DIR",
    "NOVA_STT_MODEL",
    "NOVA_STT_FREE_VERIFIED",
    "EMBEDDING_MODEL",
    "NOVA_NEWS_FEEDS",
    "NTFY_TOPIC",
    "NTFY_URL",
    "NOVA_CHECK_TARGETS",
    "NOVA_HOME_LAT",
    "NOVA_HOME_LON",
    "QDRANT_COLLECTION",
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  afterEach(() => {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.restoreAllMocks();
  });
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "nova-runtime-"));
  const write = (directory: string, groups: object) =>
    fs.writeFileSync(
      path.join(directory, "runtime-settings.json"),
      JSON.stringify({ version: 1, groups }),
    );

  it("uses jarvis_memory as the single collection default", () => {
    for (const name of names) delete process.env[name];
    process.env.NOVA_DATA_DIR = dir();
    expect(new NovaConfig().qdrantCollection).toBe("jarvis_memory");
  });

  it("keeps the environment as default and lets Settings win", () => {
    const directory = dir();
    process.env.NOVA_DATA_DIR = directory;
    process.env.NOVA_STT_MODEL = "env-whisper";
    process.env.NOVA_STT_FREE_VERIFIED = "true";
    process.env.EMBEDDING_MODEL = "env-embed";
    process.env.NTFY_URL = "https://ntfy.example";
    process.env.NTFY_TOPIC = "env-topic";
    process.env.NOVA_CHECK_TARGETS = "nas=tcp://10.0.0.2:445";
    process.env.NOVA_HOME_LAT = "52.1";
    process.env.NOVA_HOME_LON = "5.1";
    const env = new NovaConfig();
    expect(env.sttModel).toBe("env-whisper");
    expect(env.embeddingModel).toBe("env-embed");
    expect(env.ntfy.topic).toBe("env-topic");
    expect(env.homeLocation).toEqual({ latitude: 52.1, longitude: 5.1 });

    write(directory, {
      stt: { model: "saved-whisper", freeVerified: false },
      embeddings: { model: "saved-embed", dimensions: "768" },
      ntfy: { topic: "saved-topic" },
      checks: { targets: "router=http://192.168.1.1/" },
      news: { feeds: '[{"name":"NOS","url":"https://feeds.nos.nl/x"}]' },
      home: { latitude: "51.5", longitude: "4.5" },
    });
    const saved = new NovaConfig();
    expect(saved.sttModel).toBe("saved-whisper");
    expect(saved.sttFreeVerified).toBe(false);
    expect(saved.embeddingModel).toBe("saved-embed");
    expect(saved.embeddingDimensions).toBe(768);
    expect(saved.ntfy).toEqual({
      url: "https://ntfy.example",
      topic: "saved-topic",
      token: "",
    });
    expect(saved.checkTargets).toBe("router=http://192.168.1.1/");
    expect(saved.newsFeeds).toContain("NOS");
    expect(saved.homeLocation).toEqual({ latitude: 51.5, longitude: 4.5 });
  });

  it("warns once per owned variable and on a services.json mismatch", () => {
    const directory = dir();
    process.env.NOVA_DATA_DIR = directory;
    vi.stubEnv("TERMIX_API_KEY", "t");
    fs.writeFileSync(
      path.join(directory, "services.json"),
      JSON.stringify({
        version: 1,
        services: { proxmox: { url: "https://pve.saved" } },
        history: [],
      }),
    );
    vi.stubEnv("PROXMOX_URL", "https://pve.env");
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    new NovaConfig();
    new NovaConfig();
    const texts = warn.mock.calls.map((call) => String(call[0]));
    const count = (text: string) => texts.filter((t) => t === text).length;
    expect(
      count("TERMIX_API_KEY is now managed in Settings; remove it from .env."),
    ).toBe(1);
    expect(
      count(
        "PROXMOX_URL in .env differs from the value saved in Settings; the Settings value is used.",
      ),
    ).toBe(1);
    expect(texts.join("\n")).not.toContain("pve.env");
  });
});
