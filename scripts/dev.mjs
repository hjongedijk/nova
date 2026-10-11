import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForNodeRed({
  url = "http://127.0.0.1:1880",
  timeoutMs = 180_000,
  intervalMs = 1_000,
} = {}) {
  const target = new URL(url);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    !["localhost", "127.0.0.1", "node-red"].includes(
      target.hostname.toLowerCase(),
    )
  ) {
    throw new Error("NODE_RED_URL must point to a local Node-RED service");
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(target, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // Compose may still be starting Node-RED.
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Node-RED did not become healthy at ${target.origin}`);
}

async function main() {
  const nodeRedUrl = process.env.NODE_RED_URL || "http://127.0.0.1:1880";
  console.log(`Waiting for Node-RED at ${nodeRedUrl}…`);
  await waitForNodeRed({ url: nodeRedUrl });
  console.log("Node-RED is healthy; starting NOVA API and web app.");

  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : "npm";
  const args = npmExecPath
    ? [npmExecPath, "run", "dev:services"]
    : ["run", "dev:services"];
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, NODE_RED_URL: nodeRedUrl },
  });
  const stop = (signal) => child.kill(signal);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  child.once("error", (error) => {
    console.error(
      `Could not start NOVA development services: ${error.message}`,
    );
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Node-RED unavailable",
    );
    process.exitCode = 1;
  });
}
