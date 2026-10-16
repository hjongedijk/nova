import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeWav, tone } from "../../src/conversation/audio.js";
import { ConversationService } from "../../src/conversation/conversation.service.js";
import { ConversationSettingsStore } from "../../src/conversation/conversation.settings.js";
import {
  KIND,
  type AudioSocketServer,
} from "../../src/conversation/audiosocket.js";
import { renderExtensions } from "../../src/telephony/asterisk-config.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";

/**
 * A real Asterisk 22 container (host network) dials extension 700 from the generated dialplan; the call goes to NOVA
 * over AudioSocket and a "caller" plays speech into it. Opt-in: NOVA_TEST_ASTERISK=1 (needs Docker and andrius/asterisk:22).
 */
const enabled = process.env.NOVA_TEST_ASTERISK === "1";
const NAME = `nova-test-asterisk-${process.pid}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-ast-"));
const SECRET = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 });

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

describe.skipIf(!enabled)("real Asterisk to NOVA conversation", () => {
  let port = 0;
  beforeAll(async () => {
    port = await freePort();
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
    fs.writeFileSync(
      path.join(dir, "extensions.conf"),
      renderExtensions(config, { host: "127.0.0.1", port, uuid: SECRET }),
    );
    // The "caller": 3 s of a 300 Hz tone with a little leading silence, as a 16 kHz WAV Asterisk calls .wav16.
    const lead = new Int16Array(16000 * 0.4);
    const voice = tone(16000, 2500, 300, 9000);
    const tail = new Int16Array(16000 * 1.8); // the line must stay up long enough for the utterance to end
    const all = new Int16Array(lead.length + voice.length + tail.length);
    all.set(lead);
    all.set(voice, lead.length);
    fs.writeFileSync(path.join(dir, "nova-test.wav16"), encodeWav(all, 16000));
    docker(
      "run",
      "-d",
      "--rm",
      "--name",
      NAME,
      "--network",
      "host",
      "-v",
      `${path.join(dir, "extensions.conf")}:/etc/asterisk/extensions.conf:ro`,
      "-v",
      `${path.join(dir, "nova-test.wav16")}:/var/lib/asterisk/sounds/nova-test.wav16:ro`,
      "andrius/asterisk:22",
    );
    await vi.waitFor(
      () => docker("exec", NAME, "asterisk", "-rx", "core waitfullybooted"),
      { timeout: 40_000, interval: 1000 },
    );
  }, 90_000);

  afterAll(() => {
    try {
      docker("rm", "-f", NAME);
    } catch {
      /* already gone */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("answers extension 700 over AudioSocket, hears the caller, runs the chat pipeline and talks back", async () => {
    const cfg = {
      dataFile: (n: string) => path.join(dir, n),
      sttModel: "m",
      sttMode: "transcriptions",
    } as unknown as NovaConfig;
    const settings = new ConversationSettingsStore(cfg);
    settings.update({ enabled: true });
    (
      settings as unknown as { cached: { secretUuid: string } }
    ).cached.secretUuid = SECRET;
    const runs: Record<string, unknown>[] = [];
    const heard: number[] = [];
    const service = new ConversationService(
      settings,
      {
        unavailable: () => null,
        transcribe: async (wav) => {
          heard.push(wav.length);
          return { ok: true as const, text: "Hoe laat is het?" };
        },
      },
      {} as never,
      {
        run: async (input: Record<string, unknown>) => {
          runs.push(input);
          (input.emit as (e: string, d: Record<string, unknown>) => void)(
            "token",
            { text: "Het is bijna drie uur vanmiddag." },
          );
          return { reply: "Het is bijna drie uur vanmiddag." };
        },
      } as never,
      { emit: () => undefined } as never,
      { record: () => undefined } as never,
      cfg,
    );
    service.speak = async () => tone(16000, 400, 220, 6000);
    process.env.NOVA_AUDIOSOCKET_PORT = String(port);
    const server = (service as unknown as { server: AudioSocketServer }).server;
    await server.listen(port, "127.0.0.1");

    // Count what NOVA sends back to Asterisk.
    let audioOut = 0;
    const realWrite = net.Socket.prototype.write;
    vi.spyOn(net.Socket.prototype, "write").mockImplementation(function (
      this: net.Socket,
      ...args: unknown[]
    ) {
      const chunk = args[0];
      if (
        Buffer.isBuffer(chunk) &&
        chunk[0] === KIND.audio &&
        chunk.length === 323
      )
        audioOut++;
      return (realWrite as (...a: unknown[]) => boolean).apply(this, args);
    } as never);

    const out = await new Promise<string>((resolve, reject) =>
      execFile(
        "docker",
        [
          "exec",
          NAME,
          "asterisk",
          "-rx",
          "channel originate Local/700@nova-internal application Playback nova-test",
        ],
        { timeout: 20_000 },
        (e, stdout, stderr) => (e ? reject(e) : resolve(stdout + stderr)),
      ),
    );
    expect(out).not.toMatch(/Unable|No such|failed/i);

    const diagnose = () => {
      try {
        return `status=${JSON.stringify(service.status())} heard=${heard.length} audioOut=${audioOut}\n${docker("logs", "--tail", "40", NAME)}`;
      } catch {
        return "no logs";
      }
    };
    await vi.waitFor(() => expect(runs, diagnose()).toHaveLength(1), {
      timeout: 20_000,
      interval: 250,
    });
    expect(heard[0]!).toBeGreaterThan(16000 * 2); // more than 1 s of speech reached the speech-to-text
    expect(runs[0]).toMatchObject({
      message: "Hoe laat is het?",
      inputMode: "voice",
      readOnlyOnly: true,
    });
    await vi.waitFor(() => expect(audioOut).toBeGreaterThan(20), {
      timeout: 8000,
    });
    vi.restoreAllMocks();
    expect(service.status().calls).toBe(1);
    service.hangUp();
    await server.close();
  }, 60_000);
});
