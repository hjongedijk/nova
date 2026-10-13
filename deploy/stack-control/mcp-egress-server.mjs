import fs from "node:fs";
import { createContext7Relay } from "./mcp-egress.mjs";

// The trusted relay alone has internet access. Each worker sees only its own Unix socket directory.
export async function startContext7Relay(directory = "/relay-host/context7") {
  const socketPath = `${directory}/relay.sock`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  if (
    fs.lstatSync(directory).isSymbolicLink() ||
    fs.realpathSync(directory) !== directory
  )
    throw new Error("MCP relay directory unavailable");
  try {
    const socket = fs.lstatSync(socketPath);
    if (!socket.isSocket()) throw new Error("MCP relay path unavailable");
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (error?.code !== "ENOENT")
      throw new Error("MCP relay path unavailable", { cause: error });
  }
  const server = createContext7Relay();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o660);
        resolve();
      } catch (error) {
        server.close();
        reject(error);
      }
    });
  });
  return server;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const server = await startContext7Relay();
  const shutdown = () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
