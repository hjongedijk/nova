import { closeScene, listProviders, openProvider, readScene } from "./api.ts";
import type { VizEventInfo, VizProviderInfo, VizScene } from "./types.ts";

/** State of the holographic view that NOVA opens on a "show me ..." request (or from the menu). */
export const holo = $state({
  open: false,
  scene: null as VizScene | null,
  providers: [] as VizProviderInfo[],
  busy: false,
  error: "",
  /** When the scene was last fetched (ms), for the "bijgewerkt" label. */
  fetchedAt: 0,
});

let timer: ReturnType<typeof setInterval> | undefined;
let inflight = 0;

function stopPolling(): void {
  clearInterval(timer);
  timer = undefined;
}

/** Live scenes are polled while the view is open and the tab is visible; static ones are not. */
function startPolling(): void {
  stopPolling();
  const every = holo.scene?.refreshMs;
  if (!every) return;
  timer = setInterval(() => {
    if (document.hidden || !holo.open || !holo.scene) return;
    void refresh();
  }, every);
}

export async function refresh(): Promise<void> {
  const current = holo.scene;
  if (!current) return;
  const ticket = ++inflight;
  try {
    const answer = await readScene(current.id, current.revision);
    if (ticket !== inflight || holo.scene?.id !== current.id) return;
    holo.fetchedAt = Date.now();
    if (!answer.unchanged && "scene" in answer) {
      holo.scene = answer.scene;
      startPolling();
    }
  } catch {
    // The last scene stays on screen; a missing scene means NOVA restarted or cleared it.
    if (ticket === inflight && holo.scene?.id === current.id)
      holo.error =
        "De verbinding met de bron is even weg; dit is de laatste stand.";
  }
}

export function setScene(scene: VizScene): void {
  holo.scene = scene;
  holo.open = true;
  holo.error = "";
  holo.fetchedAt = Date.now();
  startPolling();
}

export async function showProvider(source: string): Promise<void> {
  holo.busy = true;
  holo.error = "";
  try {
    setScene((await openProvider(source)).scene);
  } catch (error) {
    holo.error =
      error instanceof Error
        ? error.message
        : "De visualisatie kon niet worden geopend.";
  } finally {
    holo.busy = false;
  }
}

export async function loadProviders(): Promise<void> {
  try {
    holo.providers = (await listProviders()).providers;
  } catch {
    holo.providers = [];
  }
}

/** NOVA's chat stream announced a visualisation (create/update/clear tool result). */
export async function handleVizEvent(event: VizEventInfo): Promise<void> {
  if (event.action === "clear") {
    if (holo.scene?.id === event.id) closeHolo(false);
    return;
  }
  holo.open = true;
  holo.error = "";
  const ticket = ++inflight;
  try {
    const answer = await readScene(event.id);
    if (ticket !== inflight || ("unchanged" in answer && answer.unchanged))
      return;
    if ("scene" in answer) setScene(answer.scene);
  } catch {
    holo.error = "De visualisatie kon niet worden opgehaald.";
  }
}

export function closeHolo(remove = false): void {
  const id = holo.scene?.id;
  holo.open = false;
  holo.error = "";
  stopPolling();
  if (remove && id) void closeScene(id).catch(() => undefined);
  if (remove) holo.scene = null;
}

export function toggleHoloMenu(): void {
  holo.open = true;
  if (!holo.providers.length) void loadProviders();
}
