import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UnauthorizedException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinphoneChatController } from "../../src/telephony/messaging.controller.js";
import { TelephonyMessaging } from "../../src/telephony/messaging.js";
import { TelephonyStore } from "../../src/telephony/telephony.store.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";

delete process.env.COREPACK_ENABLE_AUTO_PIN;
let dir: string;
const audits: Record<string, unknown>[] = [];
const runs: Record<string, unknown>[] = [];
let reply: () => Promise<Record<string, unknown>>;

function boot() {
  const cfg = {
    dataFile: (n: string) => path.join(dir, n),
    defaultLanguage: "nl-NL",
  } as unknown as NovaConfig;
  const store = new TelephonyStore(cfg);
  store.update((d) => {
    d.contacts = [
      {
        name: "Harm",
        sip: "hjongedijk@sip.linphone.org",
        allowConversation: true,
      },
      { name: "Gast", sip: "gast@sip.linphone.org", allowConversation: false },
    ];
  });
  const orchestrator = {
    run: vi.fn(async (input: Record<string, unknown>) => {
      runs.push(input);
      return reply();
    }),
  };
  const service = new TelephonyMessaging(
    store,
    orchestrator as never,
    { record: (r: Record<string, unknown>) => audits.push(r) } as never,
    cfg,
  );
  return { controller: new LinphoneChatController(service), store, service };
}

/** What the Python bridge sends (deploy/linphone-chat/bridge.py): JSON with the token in the body. */
const bridge = (
  b: ReturnType<typeof boot>,
  over: Record<string, unknown> = {},
) =>
  b.controller.message({
    token: b.store.get().messageToken,
    from: "sip:hjongedijk@sip.linphone.org",
    text: "Wat is het weer?",
    ...over,
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-lpchat-"));
  audits.length = 0;
  runs.length = 0;
  reply = async () => ({ reply: "Het is **14 graden**." });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("Linphone encrypted chat bridge contract", () => {
  it("answers an allowed contact as { reply } with plain text and read-only tools", async () => {
    const b = boot();
    expect(await bridge(b)).toEqual({ reply: "Het is 14 graden." });
    expect(runs[0]).toMatchObject({
      message: "Wat is het weer?",
      inputMode: "text",
      readOnlyOnly: true,
      sessionId: "sipchat_harm",
    });
    expect(JSON.stringify(audits)).not.toContain("weer");
  });

  it("rejects a wrong or missing token with 401 on both endpoints", async () => {
    const b = boot();
    await expect(bridge(b, { token: "nope" })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(bridge(b, { token: undefined })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(() => b.controller.allowlist({ token: "nope" })).toThrow(
      UnauthorizedException,
    );
    expect(runs).toHaveLength(0);
  });

  it("returns an empty reply for unknown or not-allowed senders, empty text and non-strings", async () => {
    const b = boot();
    expect(await bridge(b, { from: "sip:vreemde@sip.linphone.org" })).toEqual({
      reply: "",
    });
    expect(await bridge(b, { from: "sip:gast@sip.linphone.org" })).toEqual({
      reply: "",
    });
    expect(await bridge(b, { from: 42 })).toEqual({ reply: "" });
    expect(await bridge(b, { text: "   " })).toEqual({ reply: "" });
    expect(await bridge(b, { text: { a: 1 } })).toEqual({ reply: "" });
    expect(runs).toHaveLength(0);
  });

  it("rate limits to 10 per minute and then answers with a notice", async () => {
    const b = boot();
    for (let i = 0; i < 10; i += 1) await bridge(b);
    const out = await bridge(b);
    expect(out.reply).toMatch(/erg snel/);
    expect(runs).toHaveLength(10);
  });

  it("does not run a second message while the first is still busy", async () => {
    const b = boot();
    let release: (v: Record<string, unknown>) => void = () => {};
    reply = () => new Promise((r) => (release = r));
    const first = bridge(b);
    const second = await bridge(b, { text: "nog iets" });
    expect(second.reply).toMatch(/nog bezig/);
    release({ reply: "klaar" });
    expect(await first).toEqual({ reply: "klaar" });
  });

  it("says confirmations need the screen and hides failures", async () => {
    const b = boot();
    reply = async () => ({ reply: "Zal ik?", confirmation: { id: "c1" } });
    expect((await bridge(b)).reply).toMatch(/scherm bevestigen/);
    reply = async () => {
      throw new Error("boom");
    };
    expect((await bridge(b)).reply).toMatch(/ging iets mis/);
  });

  it("lists only contacts that may talk to NOVA, lower case", () => {
    const b = boot();
    expect(
      b.controller.allowlist({ token: b.store.get().messageToken }),
    ).toEqual({ contacts: ["hjongedijk@sip.linphone.org"] });
  });
});
