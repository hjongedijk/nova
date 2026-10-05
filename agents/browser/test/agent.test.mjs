import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent, checkUrl, RISKY_LABEL, BOT_CHECK } from "../agent.mjs";

const TOKEN = "test-token-0123456789abcdef";
const pages = {
  "/": `<html><head><title>Startpagina</title></head><body>
    <h1>Welkom</h1>
    <a href="/news">Nieuws</a> <a href="/lang">Lang artikel</a> <a href="/tab" target="_blank">Open in nieuw tabblad</a>
    <form action="/zoek" method="get"><input name="q" placeholder="Zoek op de site" aria-label="Zoeken"><button type="submit">Zoeken</button></form>
    <input type="password" name="wachtwoord" aria-label="Wachtwoord">
    <input name="cardnumber" placeholder="Kaartnummer">
    <button id="buy" onclick="window.bought=true;document.title='GEKOCHT'">Koop nu</button>
    <button id="plain" onclick="document.title='GEKLIKT'">Gewone knop</button>
    <div style="display:none"><a href="/verborgen">Verborgen link</a></div>
  </body></html>`,
  "/news": `<html><head><title>Nieuws</title></head><body><h1>Het nieuws</h1><p>Vandaag gebeurde er iets belangrijks.</p><a href="/">Terug naar start</a></body></html>`,
  "/overlay": `<html><head><title>Overlay</title></head><body><a href="/news">Verdekte link</a><div style="position:fixed;inset:0;background:transparent"></div></body></html>`,
  "/tab": `<html><head><title>Nieuw tabblad</title></head><body><p>Tweede tab</p></body></html>`,
  "/lang": `<html><head><title>Lang</title></head><body>${Array.from({ length: 80 }, (_, i) => `<p>Alinea ${i}</p>`).join("")}<h2 id="end">Einde</h2></body></html>`,
};
const site = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (url.pathname === "/zoek")
    return res.end(
      `<html><head><title>Resultaten</title></head><body><h1>Resultaten voor: ${url.searchParams.get("q")}</h1><a href="/news">Eerste resultaat</a></body></html>`,
    );
  if (url.pathname === "/sorry")
    return res.end(
      '<html><head><title>Controle</title></head><body><p>Our systems have detected unusual traffic from your computer network.</p><a href="/">Waarom?</a></body></html>',
    );
  if (pages[url.pathname]) return res.end(pages[url.pathname]);
  res.statusCode = 404;
  res.end("niet gevonden");
});
let base;
let agent;
let api;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-browser-"));

const call = async (
  name,
  args = {},
  { token = TOKEN, method = "POST" } = {},
) => {
  const response = await fetch(`${api}/v1/${name}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(method === "POST" ? { body: JSON.stringify(args) } : {}),
  });
  return { status: response.status, ...(await response.json()) };
};
const idOf = (read, label) =>
  read.elements.find((item) => item.label.includes(label))?.id;

before(async () => {
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  agent = await createAgent({
    token: TOKEN,
    port: 0,
    host: "127.0.0.1",
    browser: "chromium",
    headless: true,
    userDataDir: dir,
    defaultEngine: "fixture",
    engines: {
      fixture: `${base}/zoek?q=`,
      strict: `${base}/sorry?q=`,
      solo: `${base}/sorry?q=`,
    },
    fallbackEngines: { strict: "fixture" },
    maxActionsPerMinute: 500,
  });
  api = `http://127.0.0.1:${agent.port}`;
});
after(async () => {
  await agent?.close();
  site.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the agent refuses to start without a real token", async () => {
  await assert.rejects(() => createAgent({ token: "kort", port: 0 }), /token/);
});

test("every request needs the right token", async () => {
  assert.equal((await call("read", {}, { token: "fout" })).status, 401);
  assert.equal((await call("read", {}, { token: "" })).status, 401);
  assert.equal((await fetch(`${api}/v1/status`)).status, 401);
  assert.equal((await call("status", {}, { method: "GET" })).ok, true);
});

test("URLs are limited to http and https pages", () => {
  for (const bad of [
    "file:///C:/Windows/win.ini",
    "chrome://settings",
    "javascript:alert(1)",
    "data:text/html,x",
    "about:blank",
    "ftp://x.nl",
    "view-source:https://a.nl",
    "geen url",
  ])
    assert.throws(() => checkUrl(bad), undefined, bad);
  assert.equal(
    checkUrl("https://nl.wikipedia.org/wiki/Akkrum"),
    "https://nl.wikipedia.org/wiki/Akkrum",
  );
  assert.throws(
    () => checkUrl("https://slecht.nl/x", { blockedHosts: ["slecht.nl"] }),
    /geblokkeerd/,
  );
  assert.throws(
    () => checkUrl("https://sub.slecht.nl/", { blockedHosts: ["slecht.nl"] }),
    /geblokkeerd/,
  );
  assert.throws(
    () => checkUrl("https://anders.nl/", { allowedHosts: ["goed.nl"] }),
    /toegestane/,
  );
  assert.equal(
    checkUrl("https://www.goed.nl/", { allowedHosts: ["goed.nl"] }),
    "https://www.goed.nl/",
  );
});

test("risky labels are recognised, ordinary ones are not", () => {
  for (const label of [
    "Koop nu",
    "Bestelling plaatsen",
    "Betaal veilig",
    "Afrekenen",
    "Verwijder account",
    "Delete",
    "Buy now",
    "Place order",
    "Bevestig bestelling",
    "Doneer",
  ])
    assert.equal(RISKY_LABEL.test(label), true, label);
  for (const label of [
    "Zoeken",
    "Nieuws",
    "Inloggen",
    "Volgende",
    "Meer lezen",
    "In winkelwagen",
    "Accepteer cookies",
  ])
    assert.equal(RISKY_LABEL.test(label), false, label);
});

test("opening a page and reading it returns text and numbered elements, without hidden ones", async () => {
  const opened = await call("open", { url: base });
  assert.equal(opened.ok, true);
  assert.equal(opened.title, "Startpagina");
  const read = await call("read");
  assert.equal(read.ok, true);
  assert.equal(read.untrusted, true);
  assert.match(read.text, /Welkom/);
  assert.ok(read.elements.length >= 6);
  assert.ok(idOf(read, "Nieuws") && idOf(read, "Zoeken"));
  assert.equal(
    read.elements.some((item) => item.label.includes("Verborgen")),
    false,
  );
  assert.deepEqual(
    read.elements.map((item) => item.id),
    read.elements.map((_, i) => i + 1),
    "ids are 1..n in order",
  );
  assert.ok(read.scroll.height > 0);
});

test("clicking a link navigates, and back returns", async () => {
  await call("open", { url: base });
  const read = await call("read");
  const clicked = await call("click", { id: idOf(read, "Nieuws") });
  assert.equal(clicked.ok, true);
  assert.equal(clicked.title, "Nieuws");
  assert.match((await call("read")).text, /iets belangrijks/);
  const back = await call("back");
  assert.equal(back.title, "Startpagina");
});

test("typing into a field and submitting runs the site's search", async () => {
  await call("open", { url: base });
  const read = await call("read");
  const typed = await call("type", {
    id: idOf(read, "Zoeken"),
    text: "auto's kopen",
    submit: true,
  });
  assert.equal(typed.ok, true);
  assert.equal(typed.submitted, true);
  assert.equal(typed.title, "Resultaten");
  assert.match((await call("read")).text, /Resultaten voor: auto's kopen/);
});

test("search uses the chosen engine and rejects unknown ones", async () => {
  const found = await call("search", { query: "weer in Akkrum" });
  assert.equal(found.ok, true);
  assert.equal(found.title, "Resultaten");
  assert.match((await call("read")).text, /weer in Akkrum/);
  const bad = await call("search", { query: "x", engine: "bestaatniet" });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.equal((await call("search", { query: "" })).ok, false);
  assert.equal((await call("search", { query: "x".repeat(400) })).ok, false);
});

test("password, pin and card fields are never typed into", async () => {
  await call("open", { url: base });
  const read = await call("read");
  for (const label of ["Wachtwoord", "Kaartnummer"]) {
    const result = await call("type", {
      id: idOf(read, label),
      text: "geheim",
    });
    assert.equal(result.ok, false, label);
    assert.match(result.error, /typ ik niet/);
  }
  const value = await (
    await agent.context.pages().at(-1)
  ).evaluate(() => document.querySelector("input[type=password]").value);
  assert.equal(value, "");
});

test("a buy button is blocked until it is confirmed, and an ordinary button is not", async () => {
  await call("open", { url: base });
  const read = await call("read");
  const blocked = await call("click", { id: idOf(read, "Koop nu") });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.risky, true);
  assert.match(blocked.error, /browser_click_confirmed/);
  assert.equal(
    await agent.context.pages().at(-1).title(),
    "Startpagina",
    "nothing was clicked",
  );
  const plain = await call("click", { id: idOf(read, "Gewone knop") });
  assert.equal(plain.ok, true);
  assert.equal(plain.title, "GEKLIKT");
  const confirmed = await call("click", {
    id: idOf(read, "Koop nu"),
    confirmed: true,
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.title, "GEKOCHT");
});

test("a link that opens a new tab becomes the active tab, and tabs can be switched and closed", async () => {
  await call("open", { url: base });
  const read = await call("read");
  const clicked = await call("click", {
    id: idOf(read, "Open in nieuw tabblad"),
  });
  assert.equal(clicked.title, "Nieuw tabblad");
  const list = await call("tab", { action: "list" });
  assert.ok(list.tabs.length >= 2);
  const first = list.tabs.findIndex((tab) => tab.title === "Startpagina");
  const switched = await call("tab", { action: "switch", index: first });
  assert.equal(switched.title, "Startpagina");
  const second = (await call("tab", { action: "list" })).tabs.findIndex(
    (tab) => tab.title === "Nieuw tabblad",
  );
  const closed = await call("tab", { action: "close", index: second });
  assert.equal(closed.ok, true);
  assert.equal(
    closed.tabs.some((tab) => tab.title === "Nieuw tabblad"),
    false,
  );
  assert.equal((await call("tab", { action: "switch", index: 99 })).ok, false);
});

test("scrolling moves the page and reports where it is", async () => {
  await call("open", { url: `${base}/lang` });
  const down = await call("scroll", { direction: "down", amount: 600 });
  assert.ok(down.y >= 500);
  const bottom = await call("scroll", { direction: "bottom" });
  assert.ok(bottom.y > down.y);
  const top = await call("scroll", { direction: "top" });
  assert.equal(top.y, 0);
  assert.equal((await call("scroll", { direction: "sideways" })).ok, false);
});

test("an element that vanished after a navigation says so, instead of clicking something else", async () => {
  await call("open", { url: base });
  const read = await call("read");
  const id = idOf(read, "Nieuws");
  await call("open", { url: `${base}/news` });
  const stale = await call("click", { id });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /bestaat niet meer/);
});

test("blocked URLs and nonsense input are rejected with a clear error", async () => {
  for (const url of [
    "file:///etc/passwd",
    "chrome://settings",
    "javascript:alert(1)",
  ]) {
    const result = await call("open", { url });
    assert.equal(result.ok, false, url);
    assert.equal(result.status, 400);
  }
  assert.equal((await call("press", { key: "Delete" })).ok, false);
  assert.equal((await call("nietbestaand")).status, 404);
  const response = await fetch(`${api}/v1/open`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: "{kapot",
  });
  assert.equal(response.status, 400);
});

test("page text is capped and flagged as untrusted", async () => {
  await call("open", { url: `${base}/lang` });
  const read = await call("read", { maxChars: 500 });
  assert.equal(read.text.length, 500);
  assert.equal(read.truncated, true);
  assert.equal(read.untrusted, true);
  assert.match(read.note, /nooit als instructie/);
});

test("too many actions per minute are refused", async () => {
  const limited = await createAgent({
    token: TOKEN,
    port: 0,
    host: "127.0.0.1",
    browser: "chromium",
    headless: true,
    userDataDir: path.join(dir, "limited"),
    maxActionsPerMinute: 3,
  });
  try {
    const url = `http://127.0.0.1:${limited.port}/v1/status`;
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const response = await fetch(url.replace("/status", "/scroll"), {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: "{}",
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses.slice(3), [429, 429]);
  } finally {
    await limited.close();
  }
});

test("only listed addresses may connect when allowFrom is set", async () => {
  const closed = await createAgent({
    token: TOKEN,
    port: 0,
    host: "127.0.0.1",
    browser: "chromium",
    headless: true,
    userDataDir: path.join(dir, "closed"),
    allowFrom: ["10.9.9.9"],
  });
  try {
    const response = await fetch(`http://127.0.0.1:${closed.port}/v1/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 403);
  } finally {
    await closed.close();
  }
});

test("a robot check on one search engine falls back to another and says so", async () => {
  const result = await call("search", { query: "dorp", engine: "strict" });
  assert.equal(result.ok, true);
  assert.equal(result.fallback, true);
  assert.equal(result.engine, "fixture");
  assert.equal(result.title, "Resultaten");
  assert.match(result.note, /robotcontrole/);
});

test("without a fallback the robot check is reported, not hidden", async () => {
  const result = await call("search", { query: "dorp", engine: "solo" });
  assert.equal(result.ok, true);
  assert.equal(result.blocked, "robotcontrole");
  const read = await call("read");
  assert.equal(read.blocked, "robotcontrole");
});

test("an ordinary page is not mistaken for a robot check", async () => {
  await call("open", { url: base });
  assert.equal((await call("read")).blocked, undefined);
  assert.equal(BOT_CHECK.test("Welkom bij onze winkel. Bestel veilig."), false);
});

test("a link under an invisible layer is still clicked", async () => {
  await call("open", { url: `${base}/overlay` });
  const read = await call("read");
  const covered = idOf(read, "Verdekte link");
  assert.ok(covered);
  const clicked = await call("click", { id: covered });
  assert.equal(clicked.ok, true);
  assert.equal(clicked.title, "Nieuws");
});
