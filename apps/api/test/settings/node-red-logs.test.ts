import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { registerSecrets } from "../../src/core/security/sanitize.js";
import { StackControlService } from "../../src/settings/stack-control.service.js";

const unavailable = {
  available: false,
  reason: "Node-RED-logboek is niet beschikbaar.",
  entries: [],
  limited: true,
  truncated: false,
};
const row = (text = "15 Oct 10:20:30 - [info] [function:My flow] Ready") => ({
  at: "2026-10-15T10:20:30.123456789Z",
  stream: "stdout",
  text,
});
const report = (entries: unknown[] = [row()]) => ({
  entries,
  limited: true,
  truncated: false,
});

describe("Node-RED log projection", () => {
  let service: StackControlService;
  let audit: { record: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    audit = { record: vi.fn() };
    service = new StackControlService(
      {
        stackControlUrl: "http://broker:8090",
        stackControlToken: "a".repeat(64),
      } as NovaConfig,
      { create: vi.fn() } as never,
      audit as never,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(report())),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses only the fixed read endpoint with a six-second timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const result = await service.nodeRedLogs();
    expect(result).toEqual({
      available: true,
      entries: [
        {
          ...row(),
          level: "info",
          source: { type: "function", label: "My flow" },
        },
      ],
      limited: true,
      truncated: false,
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://broker:8090/services/node-red/logs",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: `Bearer ${"a".repeat(64)}` },
      }),
    );
    expect(timeout).toHaveBeenCalledWith(6000);
    expect(audit.record).not.toHaveBeenCalled();
    timeout.mockRestore();
  });

  it("redacts configured and registered secrets, URL credentials, Bearer, passwords and JWTs before projection", async () => {
    vi.stubEnv("NOVA_LOG_TEST_PASSWORD", "configured-log-secret");
    registerSecrets(["retired-log-secret"]);
    const jwt = "eyJabcdefghijklmno.abcdefghijklmno.signature";
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        report([
          row(
            `15 Oct 10:20:30 - [error] [function:retired-log-secret] configured-log-secret https://user:private@example.test/a Bearer hidden-bearer password=hidden-password ${jwt}`,
          ),
        ]),
      ),
    );
    const result = await service.nodeRedLogs();
    expect(result.available).toBe(true);
    expect(result.entries[0]?.source).toBeNull();
    expect(result.entries[0]?.level).toBe("error");
    const output = JSON.stringify(result);
    for (const secret of [
      "configured-log-secret",
      "retired-log-secret",
      "user:private",
      "hidden-bearer",
      "hidden-password",
      jwt,
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain("[redacted]");
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("preserves multiline text while removing terminal and direction controls before a second secret screen", async () => {
    registerSecrets(["joined-log-secret"]);
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        report([
          row(
            "\u001b[31m[warn]\u001b[0m joined-\u0000log-secret\r\nline\tvalue\u202e\u009b",
          ),
        ]),
      ),
    );
    expect((await service.nodeRedLogs()).entries[0]?.text).toBe(
      "[warn] [redacted]\nline\tvalue",
    );
  });

  it.each(["info", "warn", "error", "debug", "trace", "fatal"])(
    "recognizes %s severity",
    async (level) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json(
          report([
            row(`15 Oct 10:20:30 - [${level}] [http request:API] Failed`),
          ]),
        ),
      );
      const entry = (await service.nodeRedLogs()).entries[0];
      expect(entry?.level).toBe(level);
      expect(entry?.source).toEqual({ type: "http request", label: "API" });
    },
  );

  it.each([
    [
      "15 Oct 10:20:30 - [error] [mqtt-broker:Office] Failed",
      { type: "mqtt-broker", label: "Office" },
    ],
    [
      "15 Oct 2026 10:20:30 - [info] [function:] Ready",
      { type: "function", label: "" },
    ],
    ["payload [error] [function:Office]", null],
    ["15 Oct 10:20:30 - [info] nested [function:Office]", null],
    [`15 Oct 10:20:30 - [error] [${"x".repeat(129)}:Office]`, null],
    [`15 Oct 10:20:30 - [error] [function:${"x".repeat(129)}]`, null],
    ["normal message", null],
  ])(
    "extracts source only from an anchored standard prefix: %s",
    async (text, source) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json(report([row(text)])),
      );
      const entry = (await service.nodeRedLogs()).entries[0];
      expect(entry?.source).toEqual(source);
      if (text === "normal message") expect(entry?.level).toBe("unknown");
    },
  );

  it("preserves bounded truncation metadata and stderr", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        entries: [
          { ...row("x".repeat(2048)), stream: "stderr", truncated: true },
        ],
        limited: true,
        truncated: true,
      }),
    );
    expect(await service.nodeRedLogs()).toMatchObject({
      available: true,
      truncated: true,
      entries: [{ stream: "stderr", truncated: true }],
    });
  });

  it("hides truncated raw text so a cut credential prefix cannot leak", async () => {
    const secret = "registered-long-secret-that-crosses-the-boundary";
    registerSecrets([secret]);
    const prefix = secret.slice(0, 16);
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        report([{ ...row(`${"x".repeat(2032)}${prefix}`), truncated: true }]),
      ),
    );
    const result = await service.nodeRedLogs();
    expect(result.entries[0]).toMatchObject({
      text: "[Logregel te lang; inhoud verborgen.]",
      source: null,
      level: "unknown",
      truncated: true,
    });
    expect(JSON.stringify(result)).not.toContain(prefix);
  });

  it.each(["http request", "http in", "mqtt in", "mqtt out"])(
    "recognizes standard node type %s",
    async (type) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json(
          report([row(`15 Oct 10:20:30 - [info] [${type}:Office] Ready`)]),
        ),
      );
      expect((await service.nodeRedLogs()).entries[0]?.source).toEqual({
        type,
        label: "Office",
      });
    },
  );

  it("hides the batch when a known multiline secret spans log rows", async () => {
    registerSecrets(["first-secret-line\nsecond-secret-line"]);
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        report([
          row("first-secret-line"),
          row("second-secret-line"),
          row("safe text"),
        ]),
      ),
    );
    const result = await service.nodeRedLogs();
    expect(result.entries).toHaveLength(3);
    for (const entry of result.entries)
      expect(entry).toMatchObject({
        text: "[Meerregelige geheime inhoud verborgen.]",
        level: "unknown",
        source: null,
      });
    expect(JSON.stringify(result)).not.toContain("secret-line");
  });

  it.each([
    "PRIVATE KEY",
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY",
  ])("hides complete multiline %s blocks across log rows", async (kind) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        report([
          row(`-----BEGIN ${kind}-----`),
          row("private-key-content"),
          row(`-----END ${kind}-----`),
          row("safe later text"),
        ]),
      ),
    );
    const result = await service.nodeRedLogs();
    expect(result.entries.map((entry) => entry.text)).toEqual([
      "[Privésleutel verborgen.]",
      "[Privésleutel verborgen.]",
      "[Privésleutel verborgen.]",
      "safe later text",
    ]);
    expect(JSON.stringify(result)).not.toContain("private-key-content");
  });

  it("hides inline PEM blocks and all remaining rows after an unclosed block", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        report([
          row("-----BEGIN PRIVATE KEY----- secret -----END PRIVATE KEY-----"),
          row("safe middle text"),
          row("-----BEGIN PRIVATE KEY-----"),
          row("unclosed-secret"),
        ]),
      ),
    );
    expect(
      (await service.nodeRedLogs()).entries.map((entry) => entry.text),
    ).toEqual([
      "[Privésleutel verborgen.]",
      "safe middle text",
      "[Privésleutel verborgen.]",
      "[Privésleutel verborgen.]",
    ]);
  });

  it("hides window prefix before a PEM terminator whose header fell outside the tail", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        report([
          row("secret continuation"),
          row("-----END RSA PRIVATE KEY-----"),
          row("safe later message"),
        ]),
      ),
    );
    expect(
      (await service.nodeRedLogs()).entries.map((entry) => entry.text),
    ).toEqual([
      "[Privésleutel verborgen.]",
      "[Privésleutel verborgen.]",
      "safe later message",
    ]);
  });

  it("hides pure long base64 lines when both PEM boundaries fall outside the window", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        report([
          row("QUJDREVGSElKS0xNTk9QUVJTVFVWV1hZWg=="),
          row("safe later message"),
        ]),
      ),
    );
    expect(
      (await service.nodeRedLogs()).entries.map((entry) => entry.text),
    ).toEqual(["[Privésleutel verborgen.]", "safe later message"]);
  });

  it.each([
    null,
    [],
    {},
    { ...report(), limited: false },
    { ...report(), truncated: "true" },
    { ...report(), private: "do not expose" },
    report([null]),
    report([[]]),
    report([{ ...row(), at: "yesterday" }]),
    report([{ ...row(), at: "2026-02-30T10:20:30Z" }]),
    report([{ ...row(), at: "2026-10-15T25:20:30Z" }]),
    report([{ ...row(), stream: "stdin" }]),
    report([{ ...row(), stream: ["stdout"] }]),
    report([{ ...row(), text: 42 }]),
    report([row("x".repeat(2049))]),
    report([{ ...row(), truncated: "true" }]),
    report([{ ...row(), secret: "do not expose" }]),
    report(Array.from({ length: 101 }, () => row())),
  ])("fails closed for malformed broker payload %#", async (payload) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(payload));
    expect(await service.nodeRedLogs()).toEqual(unavailable);
  });

  it("rejects oversized JSON even when every row meets the character bound", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        report(Array.from({ length: 100 }, () => row("界".repeat(2048)))),
      ),
    );
    expect(await service.nodeRedLogs()).toEqual(unavailable);
  });

  it.each(["http", "network", "json"])(
    "returns only a fixed message after %s failure",
    async (failure) => {
      if (failure === "http")
        vi.mocked(fetch).mockResolvedValueOnce(
          new Response("private upstream body", { status: 503 }),
        );
      else if (failure === "json")
        vi.mocked(fetch).mockResolvedValueOnce(
          new Response("private malformed JSON"),
        );
      else
        vi.mocked(fetch).mockRejectedValueOnce(
          new Error("private network diagnostics"),
        );
      expect(await service.nodeRedLogs()).toEqual(unavailable);
      expect(audit.record).not.toHaveBeenCalled();
    },
  );
});
