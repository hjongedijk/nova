/* Shared helpers for the settings browser checks (service/task pages plus Geavanceerd). */
/* global document, location, MutationObserver */
/** Where each older section id lives now: its service/task page or "geavanceerd". */
export const PAGE_OF = {
  general: "gesprek",
  voice: "gesprek",
  conversation: "gesprek",
  personality: "gesprek",
  connections: "huis",
  devices: "windows",
  desktop: "windows",
  telephony: "telefoon",
  models: "modellen",
  autonomy: "zelf",
  abilities: "zelf",
  safety: "zelf",
  objectives: "zelf",
  memory: "geheugen",
  documents: "geheugen",
  setup: "geavanceerd",
  skills: "geavanceerd",
  code: "geavanceerd",
  automation: "huis",
  services: "huis",
  system: "geavanceerd",
  backup: "geheugen",
  tools: "geavanceerd",
  windowsagent: "windows",
  sidebar: "geavanceerd",
  runtime: "geavanceerd",
  // the page ids themselves
  gesprek: "gesprek",
  huis: "huis",
  windows: "windows",
  telefoon: "telefoon",
  modellen: "modellen",
  zelf: "zelf",
  geheugen: "geheugen",
  geavanceerd: "geavanceerd",
};

/** The expert group (on Geavanceerd) that holds an older section id. */
export const GROUP_ANCHOR = {
  setup: "installatie",
  skills: "vaardigheden",
  code: "codeprojecten",
  automation: "connection-node-red",
  services: "services",
  system: "updates",
  tools: "gereedschappen",
  windowsagent: "windows-agent",
  sidebar: "zijbalk",
  runtime: "voorkeuren",
};

/** Client-side navigation to the page that holds `id` (an old section id or a page id). */
export async function clickSection(page, id) {
  const wanted = PAGE_OF[id];
  if (!wanted) throw new Error(`Unknown settings section: ${id}`);
  const current = new URL(page.url()).searchParams.get("section");
  if (current !== wanted) {
    await page.locator(`.settings-groups a[data-group="${wanted}"]`).click();
    await page.waitForURL(new RegExp(`section=${wanted}`));
  }
  // URL can update before Svelte has replaced the previous page content.
  // A selected link belongs to the mounted settings shell, so error pages
  // cannot accidentally pass a screenshot/layout assertion.
  await page
    .locator(`.settings-groups a[data-group="${wanted}"][aria-current="page"]`)
    .waitFor();
  const anchor = GROUP_ANCHOR[id];
  if (anchor) {
    await page.evaluate((hash) => {
      location.hash = hash;
    }, anchor);
    await page.locator(`details#${anchor}[open]`).waitFor();
  }
}

/**
 * The browser gate exercises every editor, so it keeps the collapsible
 * areas (Meer uitleg, Wijzigingsgeschiedenis) open. The expert groups on the
 * Geavanceerd page stay closed until a link or `clickSection` opens one, so a
 * test only sees the group it asked for. `verifyCollapsed` checks
 * the real, collapsed default separately.
 */
export const OPEN_ALL_DISCLOSURES = () => {
  const open = () =>
    document
      .querySelectorAll(
        "details.ds-disclosure:not([open]):not(.advanced[data-lazy])",
      )
      .forEach((node) => {
        // This editor fixture intentionally expands all sections. The default
        // UI keeps one named section open; compact-layout checks cover that.
        node.removeAttribute("name");
        node.setAttribute("open", "");
      });
  new MutationObserver(open).observe(document, {
    childList: true,
    subtree: true,
  });
  document.addEventListener("DOMContentLoaded", open);
};
