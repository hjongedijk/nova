import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every test file gets its own empty data folder and no network side effects.
process.env.NODE_ENV = "test";
process.env.NOVA_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "nova-test-"),
);
process.env.MQTT_URL = "mqtt://127.0.0.1:1";
