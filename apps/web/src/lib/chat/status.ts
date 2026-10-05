import { getStatus } from "#lib/api/shell.ts";
import { shell } from "#lib/stores/shell.svelte.ts";

async function checkHealth(): Promise<void> {
  try {
    const data = await getStatus();
    const routingDown = data.routing?.ready === false;
    shell.statusText = routingDown
      ? "Gratis AI niet beschikbaar"
      : data.omnirouteConfigured
        ? "Online"
        : "Setup nodig";
    shell.statusTone = !routingDown && data.omnirouteConfigured ? "ok" : "bad";
    shell.routingNotice = routingDown
      ? "Geen geverifieerde gratis AI-route. Controleer Gratis AI onder Status & geheugen."
      : "";
  } catch (error) {
    console.error("Health check failed:", error);
    shell.statusText = "Offline";
    shell.statusTone = "bad";
  }
}

/** The header's status dot and the routing notice, checked every 10 seconds. Returns the cleanup. */
export function startStatus(): () => void {
  void checkHealth();
  const timer = setInterval(checkHealth, 10000);
  return () => clearInterval(timer);
}
