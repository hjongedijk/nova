import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import type { JarvisStateStore } from "../../src/planning/jarvis-state.store.js";
import { renderAll, renderPjsip } from "../../src/telephony/asterisk-config.js";
import { TelephonyService } from "../../src/telephony/telephony.service.js";
import {
  defaultConfig,
  TelephonyStore,
} from "../../src/telephony/telephony.store.js";
import { FakeAri } from "./fake-ari.js";

const trunk = {
  host: "sip.linphone.org",
  username: "nova-techlepp",
  secret: "geheim-wachtwoord",
  number: "",
  allowExtensionsToDialOut: false,
};

describe("generated pjsip.conf with the SIP relay", () => {
  const config = { ...defaultConfig(), enabled: true, trunk };
  const relay = { host: "nova", port: 5070 };

  it("points registration, calls and texts at the relay and recovers quickly after a NOVA restart", () => {
    const pjsip = renderPjsip(config, relay);
    expect(
      pjsip.match(/^outbound_proxy=sip:nova:5070\\;transport=tcp\\;lr$/gm),
    ).toHaveLength(2);
    expect(pjsip).toContain("identify_by=header");
    expect(pjsip).toContain("match_header=From: /@sip[.]linphone[.]org/");
    expect(pjsip).not.toMatch(/^match=/m);
    for (const line of [
      "retry_interval=15",
      "forbidden_retry_interval=60",
      "fatal_retry_interval=15",
      "auth_rejection_permanent=no",
      "max_retries=1000000",
    ])
      expect(pjsip).toContain(line);
  });

  it("is unchanged apart from the retry options when no relay is used", () => {
    const pjsip = renderPjsip(config);
    expect(pjsip).not.toContain("outbound_proxy");
    expect(pjsip).not.toContain("match_header");
    expect(pjsip).toContain("match=sip.linphone.org");
    expect(pjsip).toContain("retry_interval=15");
  });

  it("refuses a relay address that could inject configuration", () => {
    expect(() =>
      renderAll(config, undefined, null, undefined, {
        host: "nova\nx=y",
        port: 5070,
      }),
    ).toThrow();
    expect(() =>
      renderAll(config, undefined, null, undefined, { host: "nova", port: 80 }),
    ).toThrow();
  });
});

describe("TelephonyService and the relay lifecycle", () => {
  let dir: string;
  let service: TelephonyService;
  let store: TelephonyStore;
  let port: number;
  const state = { emit: () => undefined };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-relay-svc-"));
    const free = net.createServer();
    await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
    port = (free.address() as net.AddressInfo).port;
    await new Promise<void>((r) => free.close(() => r()));
    store = new TelephonyStore({
      dataFile: (name: string) => path.join(dir, name),
    } as unknown as NovaConfig);
    service = new TelephonyService(
      store,
      new FakeAri(),
      state as unknown as JarvisStateStore,
      { speak: vi.fn() } as never,
    );
    service.relaySettings = () => ({
      listenHost: "127.0.0.1",
      listenPort: port,
      proxyHost: "nova",
      upstreamPort: 5060,
      allow: ["127.0.0.1"],
    });
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const pjsip = () =>
    fs.readFileSync(path.join(store.confDir, "pjsip.conf"), "utf8");
  const status = async () => (await service.status()).sipRelay;

  it("runs only while telephony is on and a trunk exists, and follows trunk changes", async () => {
    service.setEnabled(true);
    await service.syncRelay();
    expect(await status()).toBeNull(); // no trunk yet
    expect(pjsip()).not.toContain("outbound_proxy");

    service.setTrunk(trunk);
    await service.syncRelay();
    expect(await status()).toMatchObject({
      listening: true,
      target: "sip.linphone.org:5060",
      activeConnections: 0,
    });
    expect(pjsip()).toContain(
      `outbound_proxy=sip:nova:${port}\\;transport=tcp\\;lr`,
    );

    service.setTrunk({ ...trunk, host: "sip2.linphone.org" });
    await service.syncRelay();
    expect(await status()).toMatchObject({
      listening: true,
      target: "sip2.linphone.org:5060",
    });
    expect(pjsip()).toContain("match_header=From: /@sip2[.]linphone[.]org/");

    service.setTrunk(null);
    await service.syncRelay();
    expect(await status()).toBeNull();
    expect(pjsip()).not.toContain("outbound_proxy");
  });

  it("stops when telephony is switched off and keeps off without relay settings", async () => {
    service.setEnabled(true);
    service.setTrunk(trunk);
    await service.syncRelay();
    expect((await status())?.listening).toBe(true);
    service.setEnabled(false);
    await service.syncRelay();
    expect(await status()).toBeNull();

    service.relaySettings = () => null; // dev setup: NOVA outside docker
    service.setEnabled(true);
    await service.syncRelay();
    expect(await status()).toBeNull();
    expect(pjsip()).not.toContain("outbound_proxy");
  });

  it("reports a port that is already taken as the last error instead of crashing", async () => {
    const taken = net.createServer();
    await new Promise<void>((r) => taken.listen(port, "127.0.0.1", r));
    try {
      service.setEnabled(true);
      service.setTrunk(trunk);
      await service.syncRelay();
      expect(await status()).toMatchObject({
        listening: false,
        lastError: expect.stringContaining("cannot listen"),
      });
    } finally {
      await new Promise<void>((r) => taken.close(() => r()));
    }
  });
});
