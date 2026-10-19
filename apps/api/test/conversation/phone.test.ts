import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bufferFromPcm, tone } from "../../src/conversation/audio.js";
import {
  AudioSocketServer,
  FrameParser,
  KIND,
  frame,
  isPrivateAddress,
  uuidToBuffer,
  type AudioSocketTransport,
} from "../../src/conversation/audiosocket.js";
import { ConversationService } from "../../src/conversation/conversation.service.js";
import { ConversationSettingsStore } from "../../src/conversation/conversation.settings.js";
import { renderExtensions } from "../../src/telephony/asterisk-config.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";

const SECRET = "11111111-2222-3333-4444-555555555555";
let dir: string;
const open: net.Socket[] = [];
const servers: { close(): Promise<void> }[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-conv-"));
});
afterEach(async () => {
  for (const s of open.splice(0)) s.destroy();
  for (const s of servers.splice(0)) await s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function connect(port: number): Promise<{
  socket: net.Socket;
  frames: { kind: number; payload: Buffer }[];
  closed: Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const parser = new FrameParser();
      const frames: { kind: number; payload: Buffer }[] = [];
      const closed = new Promise<void>((r) => socket.once("close", () => r()));
      socket.on("data", (d) => frames.push(...parser.push(d)));
      open.push(socket);
      resolve({ socket, frames, closed });
    });
    socket.once("error", reject);
  });
}
const listenPort = (s: AudioSocketServer) =>
  s.listen(0, "127.0.0.1").then(() => s.address()!.port);
const speech = (ms: number) => tone(8000, ms, 300, 9000);
const sendAudio = (socket: net.Socket, pcm: Int16Array) => {
  for (let i = 0; i < pcm.length; i += 160)
    socket.write(frame(KIND.audio, bufferFromPcm(pcm.subarray(i, i + 160))));
};

describe("AudioSocket protocol", () => {
  it("frames and parses across arbitrary chunking and refuses oversized frames", () => {
    const wire = Buffer.concat([
      frame(KIND.uuid, uuidToBuffer(SECRET)),
      frame(KIND.audio, Buffer.alloc(320, 1)),
      frame(KIND.hangup),
    ]);
    const parser = new FrameParser();
    const out = [];
    for (let i = 0; i < wire.length; i += 7)
      out.push(...parser.push(wire.subarray(i, i + 7)));
    expect(out.map((f) => f.kind)).toEqual([
      KIND.uuid,
      KIND.audio,
      KIND.hangup,
    ]);
    expect(out[1]!.payload).toHaveLength(320);
    expect(() =>
      new FrameParser(100).push(frame(KIND.audio, Buffer.alloc(200))),
    ).toThrow(/too large/);
  });

  it("accepts private addresses only", () => {
    for (const ok of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.9",
      "172.31.255.1",
      "192.168.1.5",
      "100.64.1.1",
      "::1",
      "::ffff:192.168.0.2",
      "fd12::1",
      "fe80::1",
    ])
      expect(isPrivateAddress(ok), ok).toBe(true);
    for (const bad of [
      "8.8.8.8",
      "172.32.0.1",
      "100.128.0.1",
      "2001:db8::1",
      "",
      undefined,
      "garbage",
    ])
      expect(isPrivateAddress(bad as string), String(bad)).toBe(false);
  });

  it("only lets a connection in that proves the secret in its first frame", async () => {
    const calls: string[] = [];
    const server = new AudioSocketServer(() => SECRET, {
      onCall: () => (
        calls.push("call"),
        { onAudio: () => undefined, onHangup: () => undefined }
      ),
    });
    servers.push(server);
    const port = await listenPort(server);

    const wrong = await connect(port);
    wrong.socket.write(
      frame(KIND.uuid, uuidToBuffer("99999999-2222-3333-4444-555555555555")),
    );
    await wrong.closed;
    const audioFirst = await connect(port);
    audioFirst.socket.write(frame(KIND.audio, Buffer.alloc(320)));
    await audioFirst.closed;
    const shortId = await connect(port);
    shortId.socket.write(frame(KIND.uuid, Buffer.alloc(4)));
    await shortId.closed;
    expect(calls).toEqual([]);

    const good = await connect(port);
    good.socket.write(frame(KIND.uuid, uuidToBuffer(SECRET)));
    await vi.waitFor(() => expect(calls).toEqual(["call"]));
  });

  it("drops a connection that never sends the id", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const server = new AudioSocketServer(() => SECRET, {
        onCall: () => null,
      });
      servers.push(server);
      vi.useRealTimers();
      const port = await listenPort(server);
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const c = await connect(port);
      vi.advanceTimersByTime(3500);
      vi.useRealTimers();
      await c.closed;
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers caller audio, paces playback at 20 ms frames, and clear() stops it", async () => {
    let transport!: AudioSocketTransport;
    const heard: number[] = [];
    const ended: string[] = [];
    const server = new AudioSocketServer(() => SECRET, {
      onCall: (t) => (
        (transport = t),
        { onAudio: (s) => heard.push(s.length), onHangup: (r) => ended.push(r) }
      ),
    });
    servers.push(server);
    const port = await listenPort(server);
    const c = await connect(port);
    c.socket.write(frame(KIND.uuid, uuidToBuffer(SECRET)));
    sendAudio(c.socket, speech(100));
    await vi.waitFor(() => expect(heard.length).toBe(5));
    expect(heard.every((n) => n === 160)).toBe(true);

    const started = Date.now();
    transport.play(tone(8000, 400)); // 20 frames
    expect(transport.queuedMs()).toBeGreaterThan(300);
    await vi.waitFor(() =>
      expect(
        c.frames.filter((f) => f.kind === KIND.audio).length,
      ).toBeGreaterThanOrEqual(10),
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThan(120); // not a burst
    transport.clear();
    const after = c.frames.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(c.frames.length - after).toBeLessThanOrEqual(1);
    expect(
      c.frames.every((f) => f.kind !== KIND.audio || f.payload.length === 320),
    ).toBe(true);

    c.socket.write(frame(KIND.hangup));
    await vi.waitFor(() => expect(ended).toEqual(["hangup"]));
  });
});

describe("dialplan", () => {
  const config = {
    version: 1,
    enabled: true,
    publicHost: "h",
    ariSecret: "s".repeat(10),
    extensions: [],
    trunk: null,
    ringExtensions: [],
    allowInternalCallsWithoutConfirmation: false,
    voice: "edge",
  } as never;
  it("routes extension 700 to AudioSocket when conversations are on, otherwise to the short notice", () => {
    const on = renderExtensions(config, {
      host: "nova",
      port: 8093,
      uuid: SECRET,
    });
    expect(on).toContain(`exten => 700,1,Answer()`);
    expect(on).toContain(`AudioSocket(${SECRET},nova:8093)`);
    expect(renderExtensions(config, null)).toContain("Stasis(nova,inbound)");
  });
  it("refuses a dialplan target that could inject configuration", () => {
    expect(() =>
      renderExtensions(config, {
        host: "nova\nexten => 1,1,System(x)",
        port: 8093,
        uuid: SECRET,
      }),
    ).toThrow();
    expect(() =>
      renderExtensions(config, { host: "nova", port: 80, uuid: SECRET }),
    ).toThrow();
    expect(() =>
      renderExtensions(config, {
        host: "nova",
        port: 8093,
        uuid: "x),Hangup(",
      }),
    ).toThrow();
  });
});

describe("conversation service on the phone link", () => {
  function boot(over: { enabled?: boolean; replies?: string[] } = {}) {
    const cfg = {
      dataFile: (n: string) => path.join(dir, n),
      sttModel: "m",
      sttMode: "transcriptions",
    } as unknown as NovaConfig;
    const settings = new ConversationSettingsStore(cfg);
    settings.update({ enabled: over.enabled ?? true });
    // fixed secret for the test
    (
      settings as unknown as { cached: { secretUuid: string } }
    ).cached.secretUuid = SECRET;
    const runs: Record<string, unknown>[] = [];
    const remembered: [string, string, string][] = [];
    const events: { topic: string; payload: Record<string, unknown> }[] = [];
    const audits: Record<string, unknown>[] = [];
    const service = new ConversationService(
      settings,
      {
        unavailable: () => null,
        transcribe: async () => ({
          ok: true as const,
          text: "Wat is de temperatuur buiten?",
        }),
      },
      {
        speakProfile: async () => ({
          audio: Buffer.alloc(0),
          contentType: "audio/wav",
        }),
      } as never,
      {
        run: async (input: Record<string, unknown>) => {
          runs.push(input);
          (input.emit as (e: string, d: Record<string, unknown>) => void)(
            "token",
            { text: "Het is twaalf graden buiten vandaag." },
          );
          return { reply: "Het is twaalf graden buiten vandaag." };
        },
      } as never,
      {
        emit: (e: { topic: string; payload: Record<string, unknown> }) =>
          events.push(e),
      } as never,
      { record: (r: Record<string, unknown>) => audits.push(r) } as never,
      cfg,
      {
        add: (s: string, r: string, c: string) => remembered.push([s, r, c]),
      } as never,
    );
    // synthesize a short tone instead of calling a TTS engine
    service.speak = async () => tone(16000, 120);
    return { service, settings, runs, events, audits, remembered };
  }

  it("is closed to everyone while conversations are off", async () => {
    const { service } = boot({ enabled: false });
    const server = (service as unknown as { server: AudioSocketServer }).server;
    servers.push(server);
    const port = await listenPort(server);
    const c = await connect(port);
    c.socket.write(frame(KIND.uuid, uuidToBuffer(SECRET)));
    await c.closed;
    expect(service.dialplan()).toBeNull();
  });

  it("takes one conversation at a time and tells a second caller", async () => {
    const { service } = boot();
    const server = (service as unknown as { server: AudioSocketServer }).server;
    servers.push(server);
    const port = await listenPort(server);
    const first = await connect(port);
    first.socket.write(frame(KIND.uuid, uuidToBuffer(SECRET)));
    await vi.waitFor(() => expect(service.status().active).not.toBeNull());
    const second = await connect(port);
    second.socket.write(frame(KIND.uuid, uuidToBuffer(SECRET)));
    await vi.waitFor(() =>
      expect(second.frames.some((f) => f.kind === KIND.audio)).toBe(true),
    );
    expect(service.status().calls).toBe(1);
    expect(service.hangUp()).toBe(true);
  });

  it("publishes the dialplan target only while enabled and tells telephony when settings change", async () => {
    const { service } = boot();
    expect(service.dialplan()).toMatchObject({
      host: "nova",
      port: 8093,
      uuid: SECRET,
    });
    const changed = vi.fn();
    service.onChange(changed);
    await service.setSettings({ enabled: false });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(service.dialplan()).toBeNull();
    const file = path.join(dir, "conversation-settings.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("conversation response time", () => {
  it("gives new calls 25 seconds before the first idle prompt and preserves saved choices", () => {
    const config = {
      dataFile: (name: string) => path.join(dir, name),
    } as NovaConfig;
    const settings = new ConversationSettingsStore(config);
    expect(settings.get().idleSeconds).toBe(25);
    settings.update({ idleSeconds: 8 });
    expect(new ConversationSettingsStore(config).get().idleSeconds).toBe(8);
  });
});
