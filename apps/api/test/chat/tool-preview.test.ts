import { describe, expect, it } from "vitest";
import {
  capPreview,
  PREVIEW_MAX_BYTES,
  previewDomain,
  toolResultPreview,
  toolStartPreview,
} from "../../src/chat/tool-preview.js";

const size = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

describe("tool previews for the live activity windows", () => {
  it("shows a search query and the result titles with domains only", () => {
    expect(
      toolStartPreview("web_search", { query: "ijsvogel broedtijd" }),
    ).toEqual({ kind: "search", query: "ijsvogel broedtijd" });
    const preview = toolResultPreview(
      "web_search",
      { query: "ijsvogel" },
      {
        ok: true,
        result: {
          query: "ijsvogel",
          results: [
            {
              title: "IJsvogel – Vogelbescherming",
              url: "https://www.vogelbescherming.nl/ontdek/ijsvogel?ref=1#x",
              snippet: "lang verhaal",
            },
            {
              title: "Ijsvogel",
              url: "https://nl.wikipedia.org/wiki/IJsvogel",
            },
          ],
        },
      },
    );
    expect(preview).toEqual({
      kind: "search",
      query: "ijsvogel",
      results: [
        { title: "IJsvogel – Vogelbescherming", domain: "vogelbescherming.nl" },
        { title: "Ijsvogel", domain: "nl.wikipedia.org" },
      ],
      total: 2,
    });
    expect(JSON.stringify(preview)).not.toContain("lang verhaal");
  });

  it("keeps only a short snippet of a page, never the body", () => {
    const body = "Zin. ".repeat(1200);
    const preview = toolResultPreview(
      "web_read",
      { url: "https://user:pw@example.com/a/b?token=x" },
      { ok: true, result: { title: "Voorbeeld", text: body } },
    );
    expect(preview).toMatchObject({
      kind: "page",
      title: "Voorbeeld",
      domain: "example.com",
    });
    expect((preview as { snippet: string }).snippet.length).toBeLessThanOrEqual(
      360,
    );
    expect(JSON.stringify(preview)).not.toContain("pw");
    expect(previewDomain("javascript:alert(1)")).toBe("");
  });

  it("masks secrets in commands and output", () => {
    const start = toolStartPreview("termix_run_command", {
      host: "pve",
      command:
        "curl -H 'Authorization: Bearer abcdefghijklmnop1234' https://x.test --password=hunter2secret",
    });
    const text = JSON.stringify(start);
    expect(text).not.toContain("abcdefghijklmnop1234");
    expect(text).not.toContain("hunter2secret");
    const result = toolResultPreview(
      "termix_run_command",
      { host: "pve", command: "env" },
      {
        ok: true,
        result: {
          host: "pve",
          exitCode: 0,
          output:
            "HOME=/root\nAPI_TOKEN=sk-AbCdEfGhIjKlMnOpQrStUv123456\nKEY=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo\nsha 3f2a9c0d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c\n",
        },
      },
    );
    const out = JSON.stringify(result);
    expect(out).not.toContain("sk-AbCd");
    expect(out).not.toContain("Zm9vYmFy");
    expect(out).toContain("3f2a9c0d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c");
    expect(result).toMatchObject({
      kind: "terminal",
      host: "pve",
      exitCode: 0,
    });
  });

  it("keeps the tail of long output and stays under 2 KB", () => {
    const output = Array.from(
      { length: 400 },
      (_, i) => `regel ${i} ${"x".repeat(60)}`,
    ).join("\n");
    const preview = toolResultPreview(
      "termix_run_command",
      { command: "journalctl" },
      { ok: true, result: { output } },
    ) as { output: string };
    expect(preview.output).toContain("regel 399");
    expect(preview.output).not.toContain("regel 1 ");
    expect(size(preview)).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
  });

  it("caps huge previews, non-Latin text included", () => {
    const results = Array.from({ length: 50 }, (_, i) => ({
      title: `東京の天気予報 ${i} `.repeat(20),
      url: `https://例え.jp/${i}`,
    }));
    const preview = toolResultPreview(
      "web_search",
      { query: "天気" },
      { ok: true, result: { results } },
    ) as { results: unknown[]; total: number };
    expect(size(preview)).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
    expect(preview.total).toBe(50);
    expect(preview.results.length).toBeGreaterThan(0);
    expect(capPreview({ kind: "status", message: "" })).toBeUndefined();
  });

  it("turns device, VM, weather and calendar results into data cards", () => {
    expect(
      toolResultPreview(
        "ha_turn_on",
        { entity_id: "light.keuken" },
        {
          ok: true,
          result: {
            entity_id: "light.keuken",
            state: "on",
            attributes: { friendly_name: "Keukenlamp" },
          },
        },
      ),
    ).toEqual({
      kind: "data",
      title: "Keukenlamp",
      rows: [{ label: "Status", value: "on" }],
    });
    expect(
      toolResultPreview(
        "proxmox_guests",
        {},
        {
          ok: true,
          result: {
            summary: {
              total: 3,
              running: 2,
              stopped: 1,
              runningNames: ["nova", "ha"],
              stoppedNames: ["test"],
            },
          },
        },
      ),
    ).toMatchObject({ kind: "data", title: "2 van 3 actief" });
    expect(
      toolResultPreview(
        "weather_forecast",
        {},
        {
          ok: true,
          result: {
            location: { name: "Utrecht" },
            current: { temperature: 7.6, condition: "bewolkt", windKmh: 18.2 },
          },
        },
      ),
    ).toEqual({
      kind: "data",
      title: "Utrecht",
      rows: [
        { label: "Nu", value: "8°" },
        { label: "Lucht", value: "bewolkt" },
        { label: "Wind", value: "18 km/u" },
      ],
    });
    expect(
      toolResultPreview(
        "calendar_events",
        {},
        {
          ok: true,
          result: { events: [{ summary: "Tandarts", start: "10:30" }] },
        },
      ),
    ).toMatchObject({ kind: "data", title: "1 afspraak" });
  });

  it("never forwards tool errors, and nothing for unknown tools", () => {
    expect(
      toolResultPreview(
        "web_search",
        {},
        { ok: false, error: "private upstream diagnostic /srv/x" },
      ),
    ).toBeUndefined();
    expect(
      toolResultPreview("notes_save", { text: "x" }, { ok: true }),
    ).toBeUndefined();
    expect(toolStartPreview("notes_save", { text: "geheim" })).toBeUndefined();
  });

  it("describes the screen in text only", () => {
    expect(
      toolResultPreview(
        "desktop_screenshot",
        { question: "Welk venster?" },
        {
          ok: true,
          screenDescription: "Een browser met de NOS-site.",
          image: "data:image/png;base64,AAAA",
        },
      ),
    ).toEqual({
      kind: "screen",
      question: "Welk venster?",
      text: "Een browser met de NOS-site.",
    });
  });
});
