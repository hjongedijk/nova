// Checks that the helper header never overlaps itself: the tab list, the status, the orb and the toolbar (with the
// "Scherm" button) keep their own room at 640, 800, 960 and 1280 px wide, at Windows scaling of 100/125/150%, in the
// plain page and in the NOVA Desk look (?desk=1). It also writes screenshots to look at.
//
//   node scripts/check-helper-layout.mjs           (start NOVA's dev server first; NOVA_HELPER_TEST_URL picks another origin)
//   NOVA_HELPER_SHOTS=/some/dir node scripts/check-helper-layout.mjs   (where the screenshots go)
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/* global document, window, getComputedStyle */

const origin = process.env.NOVA_HELPER_TEST_URL || "https://localhost:5173";
const shots =
  process.env.NOVA_HELPER_SHOTS ||
  fs.mkdtempSync(path.join(os.tmpdir(), "helper-layout-"));
fs.mkdirSync(shots, { recursive: true });

const widths = [640, 800, 960, 1280];
const scales = [1, 1.25, 1.5];
const views = ["overview", "notifications", "chat"];
// A wide font with extra spacing stands in for the widest label a real PC could render.
const stress = `.hp, .hp * { font-family: "DejaVu Sans", Verdana, sans-serif !important; letter-spacing: 0.02em !important; }`;

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
const problems = [];
let checked = 0;

function overlap(a, b) {
  const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return x > 0.5 && y > 0.5;
}

try {
  for (const desk of [false, true]) {
    for (const scale of scales) {
      for (const width of widths) {
        for (const view of views) {
          for (const wide of [false, true]) {
            const context = await browser.newContext({
              ignoreHTTPSErrors: true,
              deviceScaleFactor: scale,
              viewport: { width, height: view === "chat" ? 460 : 320 },
            });
            const page = await context.newPage();
            await page.route(
              (url) => new URL(url).pathname.startsWith("/api/"),
              (route) => {
                const pathname = new URL(route.request().url()).pathname;
                if (pathname.endsWith("/settings/helper/displays"))
                  return route.fulfill({
                    json: {
                      available: true,
                      mode: "helper",
                      display: 1,
                      displays: [
                        { index: 1, primary: true, width: 2560, height: 1440 },
                        { index: 2, primary: false, width: 1920, height: 1080 },
                      ],
                    },
                  });
                return route.fulfill({
                  json: { ok: false, events: [], latest: 0, entries: [] },
                });
              },
            );
            await page.goto(
              `${origin}/helper?view=${view}${desk ? "&desk=1" : ""}`,
            );
            await page.waitForSelector(".hp-bar .hp-screen");
            if (wide) await page.addStyleTag({ content: stress });
            await page.waitForTimeout(400);
            const result = await page.evaluate(() => {
              const rect = (el) => {
                const r = el.getBoundingClientRect();
                return {
                  left: r.left,
                  right: r.right,
                  top: r.top,
                  bottom: r.bottom,
                  w: r.width,
                  h: r.height,
                };
              };
              const shown = (el) => {
                const r = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return (
                  r.width > 2 &&
                  r.height > 2 &&
                  style.display !== "none" &&
                  style.visibility !== "hidden"
                );
              };
              const bar = document.querySelector(".hp-bar");
              const label = (el) =>
                (el.getAttribute("aria-label") || el.className || el.tagName)
                  .toString()
                  .slice(0, 40);
              const group = (selector) =>
                [...document.querySelectorAll(selector)]
                  .filter(shown)
                  .map((el) => ({ name: label(el), ...rect(el) }));
              return {
                bar: rect(bar),
                row: group(".hp-bar > *"),
                tabs: group(".hp-tabs > *"),
                tools: group(".hp-tools > *"),
                tabsBox: rect(document.querySelector(".hp-tabs")),
                toolsBox: rect(document.querySelector(".hp-tools")),
                transparent: getComputedStyle(document.documentElement)
                  .backgroundColor,
                panel: rect(document.querySelector(".hp")),
                viewport: { w: window.innerWidth, h: window.innerHeight },
              };
            });
            const where = `${desk ? "desk" : "page"} ${width}px @${scale * 100}% ${view}${wide ? " wide-font" : ""}`;
            const pairs = [];
            const test = (list, scope) => {
              for (let i = 0; i < list.length; i++)
                for (let j = i + 1; j < list.length; j++)
                  if (overlap(list[i], list[j]))
                    pairs.push(
                      `${scope}: "${list[i].name}" overlaps "${list[j].name}"`,
                    );
            };
            test(result.row, "header");
            test(result.tabs, "tabs");
            test(result.tools, "toolbar");
            // The children of the tab list against the toolbar's children: what the user's screenshot showed.
            for (const a of result.tabs)
              for (const b of result.tools)
                if (overlap(a, b))
                  pairs.push(`tab "${a.name}" overlaps toolbar "${b.name}"`);
            for (const item of [...result.row, ...result.tabs, ...result.tools])
              if (
                item.left < result.bar.left - 0.5 ||
                item.right > result.bar.right + 0.5
              )
                pairs.push(
                  `"${item.name}" sticks out of the header (${Math.round(item.left)}..${Math.round(item.right)} in ${Math.round(result.bar.left)}..${Math.round(result.bar.right)})`,
                );
            if (desk && result.transparent !== "rgba(0, 0, 0, 0)")
              pairs.push(
                `the desk page is not transparent (${result.transparent})`,
              );
            if (desk && (result.panel.left < 11.5 || result.panel.top < 11.5))
              pairs.push("the desk panel is not inset by the 12px margin");
            for (const text of pairs) problems.push(`${where}: ${text}`);
            checked++;
            if (!wide && scale === 1 && view === "overview")
              await page.screenshot({
                path: path.join(
                  shots,
                  `helper-${desk ? "desk" : "page"}-${width}.png`,
                ),
              });
            if (
              !wide &&
              scale === 1.5 &&
              view === "notifications" &&
              width === 960
            )
              await page.screenshot({
                path: path.join(
                  shots,
                  `helper-${desk ? "desk" : "page"}-960-at150.png`,
                ),
              });
            await context.close();
          }
        }
      }
    }
  }
} finally {
  await browser.close();
}
console.log(`${checked} layouts checked, screenshots in ${shots}`);
assert.deepEqual(problems, [], problems.join("\n"));
console.log("helper header layout: no overlap");
