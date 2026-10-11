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
