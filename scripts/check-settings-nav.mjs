/* Shared helpers for the settings browser checks (new two-level navigation). */
/* global document, MutationObserver */
export const GROUP_OF = {
  general: "algemeen",
  personality: "algemeen",
  memory: "algemeen",
  documents: "algemeen",
  voice: "stem",
  conversation: "stem",
  connections: "huis",
  devices: "huis",
  desktop: "huis",
  telephony: "telefoon",
  models: "ai",
  abilities: "ai",
  skills: "ai",
  code: "ai",
  autonomy: "automatisering",
  automation: "automatisering",
  setup: "beheer",
  safety: "beheer",
  services: "beheer",
  system: "beheer",
};

/** Client-side navigation to a settings page: group link first, then the page tab. */
export async function clickSection(page, id) {
  const current = new URL(page.url()).searchParams.get("section") ?? "general";
  const group = GROUP_OF[id];
  if (GROUP_OF[current] !== group) {
    await page.locator(`.settings-groups a[data-group="${group}"]`).click();
    await page.waitForURL(/\/settings\?section=/);
    if (new URL(page.url()).searchParams.get("section") === id) return;
  } else if (current === id) return;
  await page
    .locator(`.settings-parts a[href="/settings?section=${id}"]`)
    .click();
}

/**
 * The browser gate exercises every editor, so it keeps the collapsible
 * areas (Geavanceerd, Wijzigingsgeschiedenis) open. `verifyCollapsed` checks
 * the real, collapsed default separately.
 */
export const OPEN_ALL_DISCLOSURES = () => {
  const open = () =>
    document
      .querySelectorAll("details.ds-disclosure:not([open])")
      .forEach((node) => node.setAttribute("open", ""));
  new MutationObserver(open).observe(document, {
    childList: true,
    subtree: true,
  });
  document.addEventListener("DOMContentLoaded", open);
};
