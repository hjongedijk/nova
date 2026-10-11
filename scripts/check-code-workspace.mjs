import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const base = process.env.NOVA_CODE_TEST_URL ?? "https://localhost:5173";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const viewport of [
    { width: 1440, height: 900, name: "desktop" },
    { width: 390, height: 844, name: "mobile" },
  ]) {
    const page = await browser.newPage({
      ignoreHTTPSErrors: true,
      viewport: { width: viewport.width, height: viewport.height },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      }),
    );
    await page.route("**/api/settings/workspace/code/tree", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          projectId: "demo",
          files: [{ path: "src/main.ts", bytes: 12 }],
          truncated: false,
        }),
      }),
    );
    await page.route("**/api/settings/workspace/code/latest-run", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "null",
      }),
    );
    await page.route("**/api/settings/workspace/code/file?*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          path: "demo/src/main.ts",
          bytes: 12,
          sha256: "a".repeat(64),
          content: "export {};",
        }),
      }),
    );
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Code" }).click();
    const panel = page.getByRole("complementary", { name: "Codeproject" });
    await panel.getByText("demo", { exact: true }).waitFor();
    await panel.getByRole("button", { name: /src\/main.ts/ }).click();
    await panel.getByText("export {};").waitFor();
    assert.equal(
      await panel
        .getByRole("textbox", { name: "Alleen-lezen testuitvoer" })
        .getAttribute("readonly"),
      "",
    );
    assert.equal(
      await page
        .locator("body")
        .evaluate((node) => node.classList.contains("code-open")),
      true,
    );
    await page.screenshot({
      path: `docs/img/code-workspace-${viewport.name}.png`,
      fullPage: false,
    });
    assert.deepEqual(errors, [], `${viewport.name} browser errors`);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(
  "Code workspace browser checks passed at desktop and mobile sizes.",
);
