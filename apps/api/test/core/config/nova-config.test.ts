import { Logger } from "@nestjs/common";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NovaConfig } from "../../../src/core/config/nova-config.js";

const names = [
  "NOVA_DATA_DIR",
  "NOVA_ENABLE_ACTIONS",
  "JARVIS_ENABLE_ACTIONS",
  "NOVA_MAX_TOOL_ITERATIONS",
  "JARVIS_MAX_TOOL_ITERATIONS",
  "NOVA_DEFAULT_LANGUAGE",
  "JARVIS_DEFAULT_LANGUAGE",
  "NOVA_OMNIROUTE_COMPRESSION",
  "JARVIS_OMNIROUTE_COMPRESSION",
  "NOVA_TOOL_TIMEOUT_MS",
  "JARVIS_TOOL_TIMEOUT_MS",
  "NOVA_AUTO_EXECUTE_SAFE_ACTIONS",
  "JARVIS_AUTO_EXECUTE_SAFE_ACTIONS",
  "NOVA_EXTENSIONS",
  "JARVIS_EXTENSIONS",
  "NOVA_MCP_CONFIG",
  "NOVA_MCP_DEFAULT",
  "JARVIS_MCP_CONFIG",
  "NOVA_HOME_LAT",
  "JARVIS_HOME_LAT",
  "NOVA_HOME_LON",
  "JARVIS_HOME_LON",
  "NOVA_MEMORY_BACKEND",
  "JARVIS_MEMORY_BACKEND",
  "NOVA_CHECK_TARGETS",
  "JARVIS_CHECK_TARGETS",
  "JARVIS_DATA_DIR",
];
const previous = new Map(names.map((name) => [name, process.env[name]]));

beforeEach(() => {
  for (const name of names) delete process.env[name];
});

afterEach(() => {
  for (const name of names) {
    const value = previous.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
});

describe("NOVA environment names", () => {
  it("prefers NOVA names when both current and legacy values exist", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-config-"));
    const warning = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    process.env.NOVA_DATA_DIR = directory;
    process.env.NOVA_ENABLE_ACTIONS = "true";
    process.env.JARVIS_ENABLE_ACTIONS = "false";
    process.env.NOVA_MAX_TOOL_ITERATIONS = "4";
    process.env.JARVIS_MAX_TOOL_ITERATIONS = "9";
    try {
      const config = new NovaConfig();
      expect(config.actionsEnabled).toBe(true);
      expect(config.maxToolRounds).toBe(4);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps legacy values as a warned fallback", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-config-"));
    const warning = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    process.env.NOVA_DATA_DIR = directory;
    delete process.env.NOVA_DEFAULT_LANGUAGE;
    process.env.JARVIS_DEFAULT_LANGUAGE = "nl-BE";
    try {
      const config = new NovaConfig();
      expect(config.defaultLanguage).toBe("nl-BE");
      expect(warning).toHaveBeenCalledWith(
        "JARVIS_DEFAULT_LANGUAGE is deprecated; use NOVA_DEFAULT_LANGUAGE.",
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("owned MCP catalog initialization", () => {
  function fixture() {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nova-mcp-config-"),
    );
    const data = path.join(directory, "data");
    const shipped = path.join(directory, "shipped.json");
    const content = JSON.stringify({
      servers: { existing: { enabled: true } },
    });
    fs.writeFileSync(shipped, content, { mode: 0o444 });
    process.env.NOVA_DATA_DIR = data;
    process.env.NOVA_MCP_DEFAULT = shipped;
    return {
      directory,
      data,
      shipped,
      content,
      own: path.join(data, "mcp-servers.json"),
    };
  }

  it("copies shipped defaults into a private owned file once without changing the source", () => {
    const f = fixture();
    try {
      expect(new NovaConfig().mcpConfig).toBe(f.own);
      expect(fs.readFileSync(f.own, "utf8")).toBe(f.content);
      expect(fs.statSync(f.own).mode & 0o777).toBe(0o600);
      fs.writeFileSync(f.own, "user edits");
      expect(new NovaConfig().mcpConfig).toBe(f.own);
      expect(fs.readFileSync(f.own, "utf8")).toBe("user edits");
      expect(fs.readFileSync(f.shipped, "utf8")).toBe(f.content);
    } finally {
      fs.rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("leaves explicitly external catalogs read-only and uncreated", () => {
    const f = fixture();
    const external = path.join(f.directory, "external.json");
    process.env.NOVA_MCP_CONFIG = external;
    try {
      expect(new NovaConfig().mcpConfig).toBe(f.shipped);
      expect(fs.existsSync(external)).toBe(false);
      fs.writeFileSync(external, "external");
      expect(new NovaConfig().mcpConfig).toBe(external);
      expect(fs.readFileSync(external, "utf8")).toBe("external");
    } finally {
      fs.rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("preserves a catalog created concurrently before exclusive creation", () => {
    const f = fixture();
    const open = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation(
      (...args: Parameters<typeof fs.openSync>) => {
        if (args[0] === f.own && args[1] === "wx") {
          fs.writeFileSync(f.own, "concurrent user edits");
        }
        return open(...args);
      },
    );
    try {
      expect(new NovaConfig().mcpConfig).toBe(f.own);
      expect(fs.readFileSync(f.own, "utf8")).toBe("concurrent user edits");
    } finally {
      fs.rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("falls back to the shipped catalog and removes its incomplete file on a write error", () => {
    const f = fixture();
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation(
      (...args: Parameters<typeof fs.writeFileSync>) => {
        if (typeof args[0] === "number")
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        return write(...args);
      },
    );
    try {
      expect(new NovaConfig().mcpConfig).toBe(f.shipped);
      expect(fs.existsSync(f.own)).toBe(false);
    } finally {
      fs.rmSync(f.directory, { recursive: true, force: true });
    }
  });
});
