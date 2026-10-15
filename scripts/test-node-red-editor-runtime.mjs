import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  access,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

// Only a new disposable Node-RED container and a local fixture API are contacted.
// Build first: npm run build -w @nova/api
const repo = fileURLToPath(new URL("../", import.meta.url));
const apiDist = new URL("../apps/api/dist/", import.meta.url);
const require = createRequire(join(repo, "package.json"));
const execute = promisify(execFile);
const image = process.env.NOVA_EDITOR_TEST_IMAGE || "nodered/node-red:4.1";
const name = `nova-editor-runtime-${randomBytes(8).toString("hex")}`;
const token = randomBytes(32).toString("hex");
const proof = {
  nativeEditor: false,
  privateAuthentication: false,
  websocket: false,
  deployedFixture: false,
  renewed: false,
  revoked: false,
  noPageErrors: false,
  noFailedRequests: false,
  noBrowserToken: true,
  cleanedUp: false,
};
let directory;
let containerAttempted = false;
let browser;
let app;
let proxy;
let listener;
let cleanupPromise;
let failureMessage = "Node-RED editor runtime fixture failed.";

async function docker(args, timeout = 30_000) {
  const result = await execute("docker", args, {
    timeout,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    let clean = true;
    for (const action of [
      () => browser?.close(),
      () => proxy?.onModuleDestroy(),
      async () => {
        if (!listener) return;
        listener.closeAllConnections();
        await new Promise((resolve) => listener.close(resolve));
      },
      () => app?.close(),
      () => containerAttempted && docker(["rm", "-f", name]),
      () => directory && rm(directory, { recursive: true, force: true }),
    ]) {
      try {
        await action();
      } catch {
        clean = false;
      }
    }
    proof.cleanedUp = clean;
  })();
  return cleanupPromise;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(1));
  });
}

async function until(check, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error("Fixture deadline exceeded");
}

async function browserExecutable(chromium) {
  if (process.env.NOVA_TEST_CHROMIUM) {
    await access(process.env.NOVA_TEST_CHROMIUM);
    return process.env.NOVA_TEST_CHROMIUM;
  }
  const candidates = [chromium.executablePath()];
  const cache = join(homedir(), ".cache", "ms-playwright");
  for (const entry of await readdir(cache).catch(() => [])) {
    if (!/^chromium-\d+$/.test(entry)) continue;
    for (const binary of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      candidates.push(join(cache, entry, binary));
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* Try another installed Playwright browser. */
    }
  }
  throw new Error("Missing browser");
}

async function run() {
  failureMessage = "Build required: npm run build -w @nova/api";
  const modules = [
    "core/config/nova-config.js",
    "access/access.service.js",
    "settings/node-red-management.service.js",
    "settings/node-red-editor-access.service.js",
    "settings/node-red-editor-proxy.service.js",
    "settings/node-red-editor.controller.js",
    "settings/settings.guard.js",
  ];
  for (const module of modules) await access(new URL(module, apiDist));
  require("reflect-metadata");
  const [
    configModule,
    accessModule,
    managementModule,
    editorAccessModule,
    proxyModule,
    controllerModule,
    guardModule,
  ] = await Promise.all(
    modules.map((module) => import(new URL(module, apiDist).href)),
  );
  const { chromium } = require("playwright-core");
  failureMessage =
    "Chromium required: install the Playwright browser or set NOVA_TEST_CHROMIUM.";
  const executablePath = await browserExecutable(chromium);
  failureMessage =
    "A cached Node-RED image is required; set NOVA_EDITOR_TEST_IMAGE or cache nodered/node-red:4.1. No image is pulled.";
  await docker(["image", "inspect", image]);
  failureMessage = "Node-RED editor runtime fixture failed.";

  directory = await mkdtemp(join(tmpdir(), "nova-editor-runtime-"));
  await chmod(directory, 0o755);
  const settings = join(directory, "settings.js");
  await writeFile(
    settings,
    `module.exports = {
    uiPort: 1880,
    flowFile: 'flows.json',
    adminAuth: { type: 'credentials', users: [], tokens: async value =>
      value === ${JSON.stringify(token)} ? { username: 'fixture', permissions: '*' } : null },
    editorTheme: { tours: false, palette: { editable: false } },
    telemetry: false,
    logging: { console: { level: 'warn', metrics: false, audit: false } },
    externalModules: { autoInstall: false, palette: { allowInstall: false, allowUpload: false }, modules: { allowInstall: false } }
  };\n`,
    { mode: 0o644 },
  );
  containerAttempted = true;
  await docker([
    "run",
    "--pull=never",
    "-d",
    "--name",
    name,
    "--label",
    "nova.test=editor",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "-p",
    "127.0.0.1::1880",
    "--tmpfs",
    "/data:rw,uid=1000,gid=1000",
    "--mount",
    `type=bind,src=${settings},dst=/usr/src/node-red/fixture-settings.js,readonly`,
    "--entrypoint",
    "/usr/local/bin/node",
    image,
    "node_modules/node-red/red.js",
    "--userDir",
    "/data",
    "--settings",
    "/usr/src/node-red/fixture-settings.js",
  ]);
  const ports = JSON.parse(
    await docker([
      "inspect",
      name,
      "--format",
      "{{json .NetworkSettings.Ports}}",
    ]),
  );
  const port = ports["1880/tcp"]?.find(
    (binding) => binding.HostIp === "127.0.0.1",
  )?.HostPort;
  assert.match(port ?? "", /^\d+$/);
  const nodeRedUrl = `http://127.0.0.1:${port}`;
  failureMessage =
    "Isolated Node-RED fixture did not become ready within 60 seconds.";
  await until(async () => {
    try {
      const response = await fetch(`${nodeRedUrl}/settings`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2000),
      });
      return (
        response.ok && (await response.json()).user?.username === "fixture"
      );
    } catch {
      return false;
    }
  }, 60_000);
  failureMessage = "Isolated Node-RED fixture authentication check failed.";
  const unauthenticated = await fetch(`${nodeRedUrl}/settings`, {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(unauthenticated.status, 401);
  await unauthenticated.body?.cancel();

  const { Module } = require("@nestjs/common");
  failureMessage =
    "Isolated NOVA editor test application failed to initialize.";
  const { NestFactory } = require("@nestjs/core");
  const { ExpressAdapter } = require("@nestjs/platform-express");
  const express = require("express");
  const { NovaConfig } = configModule;
  const { AppAccessService } = accessModule;
  const { NodeRedManagement } = managementModule;
  const { NodeRedEditorAccess } = editorAccessModule;
  const { NodeRedEditorProxy } = proxyModule;
  const { NodeRedEditorController } = controllerModule;
  const { SettingsGuard } = guardModule;
  const config = {
    nodeRedUrl,
    nodeRedAdminToken: token,
    appToken: "",
    reverseProxyAuth: true,
    adminPin: "",
  };
  class FixtureModule {}
  Module({
    controllers: [NodeRedEditorController],
    providers: [
      { provide: NovaConfig, useValue: config },
      AppAccessService,
      NodeRedManagement,
      NodeRedEditorAccess,
      NodeRedEditorProxy,
      SettingsGuard,
    ],
  })(FixtureModule);
  const server = express();
  app = await NestFactory.create(FixtureModule, new ExpressAdapter(server), {
    logger: false,
    abortOnError: false,
  });
  app.setGlobalPrefix("api");
  proxy = app.get(NodeRedEditorProxy);
  server.use("/api/node-red-editor", proxy.middleware);
  app.useBodyParser("json");
  await app.init();
  server.get("/", (_request, response) =>
    response.type("html").send(`<!doctype html>
    <button id="open">Open editor</button>
    <script>document.querySelector('button').onclick=async()=>{
      const response=await fetch('/api/node-red-editor/_nova/session',{
        method:'POST',headers:{'content-type':'application/json','x-nova-admin':'1'},body:'{}'});
      const grant=await response.json();
      if(!response.ok||grant.url!=='/api/node-red-editor/')return;
      const frame=document.createElement('iframe');frame.src=grant.url;
      frame.title='Node-RED-floweditor';frame.style='width:1200px;height:850px';
      document.body.append(frame);
    }</script>`),
  );
  listener = createServer(server);
  listener.on("upgrade", (request, socket, head) => {
    if (!proxy.sockets.upgrade(request, socket, head)) socket.destroy();
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const origin = `http://127.0.0.1:${listener.address().port}`;
  failureMessage = "Native Node-RED editor browser proof failed.";
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox"],
    timeout: 15_000,
  });
  const context = await browser.newContext({
    viewport: { width: 1500, height: 1000 },
  });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.setDefaultNavigationTimeout(30_000);
  let pageErrors = 0;
  let failedResponses = 0;
  let expectedRevocation = false;
  page.on("pageerror", () => {
    pageErrors += 1;
  });
  page.on("request", (request) => {
    if (
      request.url().includes(token) ||
      Object.values(request.headers()).some((value) => value.includes(token))
    )
      proof.noBrowserToken = false;
  });
  page.on("response", (response) => {
    if (
      response.status() >= 400 &&
      !(
        expectedRevocation &&
        response.status() === 403 &&
        response.url() === `${origin}/api/node-red-editor/flows`
      )
    )
      failedResponses += 1;
  });
  page.on("websocket", (socket) => {
    for (const event of ["framesent", "framereceived"])
      socket.on(event, ({ payload }) => {
        const text = String(payload);
        if (text.includes(token)) proof.noBrowserToken = false;
        if (event === "framereceived" && text.includes('"topic"'))
          proof.websocket = true;
      });
  });
  await page.goto(origin);
  assert.equal(await page.locator("iframe").count(), 0);
  await page.click("#open");
  const element = await page.waitForSelector("iframe");
  const native = await element.contentFrame();
  assert.ok(native);
  await native.waitForFunction(
    () =>
      globalThis.RED?.nodes &&
      globalThis.RED.workspaces?.active() &&
      globalThis.document.querySelector("#red-ui-header-button-deploy"),
    undefined,
    { timeout: 30_000 },
  );
  proof.nativeEditor = true;
  failureMessage = "Native editor notification or tour dismissal failed.";
  const notifications = native.getByRole("button", {
    name: "No, do not enable notifications",
    exact: true,
  });
  await notifications
    .waitFor({ state: "visible", timeout: 2000 })
    .then(() => notifications.click())
    .catch(() => {});
  await native
    .locator(".red-ui-tourGuide-shade")
    .waitFor({ state: "visible", timeout: 2000 })
    .then(() => native.locator("body").press("Escape"))
    .catch(() => {});
  await native
    .locator(".red-ui-tourGuide-shade")
    .waitFor({ state: "hidden", timeout: 5000 });
  await until(() => proof.websocket);
  failureMessage = "Editor browser cookie attributes failed verification.";
  const cookies = await context.cookies();
  assert.ok(
    cookies.some(
      (cookie) =>
        cookie.name === "nova_node_red_editor" &&
        cookie.httpOnly &&
        cookie.path === "/api/node-red-editor/",
    ),
  );
  proof.privateAuthentication = true;
  failureMessage = "Isolated native editor deployment proof failed.";
  await native.evaluate(() => {
    const editor = globalThis.RED;
    editor.nodes.workspace(editor.workspaces.active()).label =
      "Isolated NOVA editor proof";
    editor.nodes.dirty(true);
    editor.view.redraw();
  });
  const deployment = page.waitForResponse(
    (response) =>
      response.url() === `${origin}/api/node-red-editor/flows` &&
      response.request().method() === "POST",
  );
  deployment.catch(() => {});
  await native.click("#red-ui-header-button-deploy");
  assert.equal((await deployment).status(), 200);
  const stored = await fetch(`${nodeRedUrl}/flows`, {
    headers: { authorization: `Bearer ${token}`, "node-red-api-version": "v2" },
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(stored.status, 200);
  assert.ok(
    (await stored.json()).flows.some(
      (flow) => flow.label === "Isolated NOVA editor proof",
    ),
  );
  proof.deployedFixture = true;
  failureMessage = "Isolated editor session renewal proof failed.";
  const renewed = await page.evaluate(async () => {
    const response = await fetch("/api/node-red-editor/_nova/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.url, "/api/node-red-editor/");
  proof.renewed = true;
  failureMessage = "Isolated editor session revocation proof failed.";
  expectedRevocation = true;
  const revoked = await page.evaluate(async () => {
    globalThis.document.querySelector("iframe")?.remove();
    const response = await fetch("/api/node-red-editor/_nova/session", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const denied = await fetch("/api/node-red-editor/flows");
    return { status: response.status, denied: denied.status };
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.denied, 403);
  proof.revoked = true;
  failureMessage = "Isolated editor browser error or token-leak checks failed.";
  proof.noPageErrors = pageErrors === 0;
  proof.noFailedRequests = failedResponses === 0;
  assert.ok(
    proof.noPageErrors && proof.noFailedRequests && proof.noBrowserToken,
  );
}

try {
  await run();
} catch {
  console.error(failureMessage);
  process.exitCode = 1;
} finally {
  await cleanup();
  if (!proof.cleanedUp) process.exitCode = 1;
  console.log(JSON.stringify(proof));
}
