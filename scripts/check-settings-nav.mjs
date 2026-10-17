/* Shared helpers for the settings browser checks (six task pages plus Geavanceerd). */
/* global document, location, MutationObserver */
/** Where each older section id lives now: a page of the six-item navigation or "geavanceerd". */
export const PAGE_OF = {
  general: "gesprek",
  voice: "gesprek",
  conversation: "gesprek",
  personality: "gesprek",
  connections: "huis",
  devices: "huis",
  desktop: "huis",
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
  automation: "geavanceerd",
  services: "geavanceerd",
  system: "geavanceerd",
  backup: "geheugen",
  tools: "geavanceerd",
  windowsagent: "geavanceerd",
  sidebar: "geavanceerd",
  // the page ids themselves
  gesprek: "gesprek",
  huis: "huis",
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
  automation: "koppelingen",
  services: "services",
  system: "updates",
  tools: "gereedschappen",
  windowsagent: "windows-agent",
  sidebar: "zijbalk",
};

/** Client-side navigation to the page that holds `id` (an old section id or a page id). */
export async function clickSection(page, id) {
  const wanted = PAGE_OF[id];
  const current = new URL(page.url()).searchParams.get("section");
  if (current !== wanted) {
    await page.locator(`.settings-groups a[data-group="${wanted}"]`).click();
    await page.waitForURL(new RegExp(`section=${wanted}`));
  }
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
      .forEach((node) => node.setAttribute("open", ""));
  new MutationObserver(open).observe(document, {
    childList: true,
    subtree: true,
  });
  document.addEventListener("DOMContentLoaded", open);
};
