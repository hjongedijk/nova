import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { McpSecretsStore } from "../../src/integrations/mcp/mcp-secrets.store.js";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-mcp-secrets-"));
  roots.push(root);
  const config = {
    dataFile: (name: string) => path.join(root, name),
  } as NovaConfig;
  const record = vi.fn(() => ({}));
  return {
    root,
    record,
    store: new McpSecretsStore(config, { record } as never),
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("MCP private configuration", () => {
  it("stores fixed CalDAV/IMAP values privately and only returns configured flags", () => {
    const { root, store, record } = fixture();
    store.save("caldav", {
      CALDAV_URL: "https://calendar.example.test/dav/",
      CALDAV_USERNAME: "nova@example.test",
      CALDAV_PASSWORD: "caldav-secret",
    });
    store.save("imap", {
      IMAP_HOST: "mail.example.test",
      IMAP_USER: "nova@example.test",
      IMAP_PASSWORD: "imap-secret",
    });

    expect(
      store.status("caldav").fields.every((field) => field.configured),
    ).toBe(true);
    expect(store.status("imap").fields.every((field) => field.configured)).toBe(
      true,
    );
    expect(store.environment()).toMatchObject({
      CALDAV_PASSWORD: "caldav-secret",
      IMAP_PASSWORD: "imap-secret",
    });
    const file = fs.readFileSync(path.join(root, "mcp-secrets.json"), "utf8");
    expect(file).toContain("caldav-secret");
    expect(fs.statSync(path.join(root, "mcp-secrets.json")).mode & 0o777).toBe(
      0o600,
    );
    expect(JSON.stringify(store.status("imap"))).not.toMatch(
      /nova@example|imap-secret/,
    );
    expect(JSON.stringify(record.mock.calls)).not.toMatch(
      /nova@example|imap-secret|caldav-secret/,
    );
  });

  it("preserves blank replacement fields and clears only on explicit request", () => {
    const { store } = fixture();
    store.save("imap", {
      IMAP_HOST: "mail.example.test",
      IMAP_USER: "nova@example.test",
      IMAP_PASSWORD: "imap-secret",
    });
    store.save("imap", { IMAP_PASSWORD: "" });
    expect(store.environment().IMAP_PASSWORD).toBe("imap-secret");
    store.save("imap", {}, true);
    expect(store.status("imap").fields.some((field) => field.configured)).toBe(
      false,
    );
  });

  it("rejects non-HTTPS CalDAV URLs, URL credentials, invalid IMAP hosts, and arbitrary fields", () => {
    const { store } = fixture();
    expect(() =>
      store.save("caldav", {
        CALDAV_URL: "http://calendar.example.test/",
        CALDAV_USERNAME: "nova",
        CALDAV_PASSWORD: "secret",
      }),
    ).toThrow("HTTPS");
    expect(() =>
      store.save("caldav", {
        CALDAV_URL: "https://nova:secret@calendar.example.test/",
        CALDAV_USERNAME: "nova",
        CALDAV_PASSWORD: "secret",
      }),
    ).toThrow("inloggegevens");
    expect(() =>
      store.save("imap", {
        IMAP_HOST: "mail.example.test/evil",
        IMAP_USER: "nova",
        IMAP_PASSWORD: "secret",
      }),
    ).toThrow("hostnaam");
    expect(() => store.save("imap", { arbitrary: "secret" })).toThrow(
      "Onbekend",
    );
  });

  it("stops a secret update when the audit log is unavailable", () => {
    const { root, store, record } = fixture();
    record.mockImplementation(() => {
      throw new Error("audit unavailable");
    });
    expect(() =>
      store.save("imap", {
        IMAP_HOST: "mail.example.test",
        IMAP_USER: "nova@example.test",
        IMAP_PASSWORD: "imap-secret",
      }),
    ).toThrow("Auditlog niet beschikbaar");
    expect(fs.existsSync(path.join(root, "mcp-secrets.json"))).toBe(false);
  });
});
