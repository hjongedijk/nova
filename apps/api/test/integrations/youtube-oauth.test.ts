import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import {
  YoutubeOAuthService,
  type YoutubeOAuthHttp,
} from "../../src/integrations/youtube/youtube-oauth.service.js";
import { YoutubeOAuthController } from "../../src/integrations/youtube/youtube-oauth.controller.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function setup(http: YoutubeOAuthHttp, publicUrl = "https://nova.example.com") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-youtube-oauth-"));
  dirs.push(dir);
  const config = {
    publicUrl,
    dataFile: (name: string) => path.join(dir, name),
  } as NovaConfig;
  const service = new YoutubeOAuthService(config, http);
  return { service, file: path.join(dir, "youtube-oauth.json") };
}

const client = {
  clientId: "123456789012-abcdef.apps.googleusercontent.com",
  clientSecret: "GOCSPX-example-secret",
};

describe("YouTube OAuth", () => {
  it("stores only private credentials and returns a fixed callback/status without secrets", () => {
    const { service, file } = setup(vi.fn() as YoutubeOAuthHttp);
    expect(service.status()).toEqual({
      configured: false,
      connected: false,
      callbackUrl:
        "https://nova.example.com/api/settings/youtube/oauth/callback",
    });
    expect(service.saveClient(client)).toEqual({
      configured: true,
      connected: false,
      callbackUrl:
        "https://nova.example.com/api/settings/youtube/oauth/callback",
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toContain(client.clientSecret);
    expect(JSON.stringify(service.status())).not.toContain(client.clientSecret);
    expect(() => service.saveClient({ ...client, extra: "x" })).toThrow();
  });

  it("requires an approved public origin and a matching one-use state/cookie before token exchange", async () => {
    const http = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "access-secret",
            refresh_token: "refresh-secret",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/youtube.force-ssl",
          }),
          { status: 200 },
        ),
    ) as YoutubeOAuthHttp;
    const { service, file } = setup(http);
    service.saveClient(client);
    const started = service.begin();
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.origin).toBe("https://accounts.google.com");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      "https://nova.example.com/api/settings/youtube/oauth/callback",
    );
    expect(authorization.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/youtube.force-ssl",
    );
    expect(authorization.searchParams.get("access_type")).toBe("offline");
    expect(authorization.searchParams.get("prompt")).toBe("consent");
    const state = authorization.searchParams.get("state")!;
    await expect(
      service.complete({ state, code: "code", cookie: "wrong" }),
    ).rejects.toThrow();
    await expect(
      service.complete({ state, code: "code", cookie: started.cookieValue }),
    ).rejects.toThrow();
    expect(http).not.toHaveBeenCalled();
    const retry = service.begin();
    await service.complete({
      state: new URL(retry.authorizationUrl).searchParams.get("state"),
      code: "code",
      cookie: retry.cookieValue,
    });
    expect(service.status().connected).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("refresh-secret");
    expect(fs.readFileSync(file, "utf8")).not.toContain("access-secret");
    expect(await service.getAccessToken()).toBe("access-secret");
    expect(http).toHaveBeenCalledTimes(1);
    const request = vi.mocked(http).mock.calls[0]!;
    expect(request[0]).toBe("https://oauth2.googleapis.com/token");
    expect(String(request[1]?.body)).toContain("grant_type=authorization_code");
  });

  it("refreshes from disk, keeps access tokens in memory, and clears locally on disconnect", async () => {
    const http = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/revoke"))
        return new Response(null, { status: 200 });
      return new Response(
        JSON.stringify({ access_token: "new-access-secret", expires_in: 3600 }),
        { status: 200 },
      );
    }) as YoutubeOAuthHttp;
    const { service, file } = setup(http);
    service.saveClient(client);
    fs.writeFileSync(
      file,
      JSON.stringify({ ...client, refreshToken: "saved-refresh-secret" }),
      { mode: 0o600 },
    );
    expect(await service.getAccessToken()).toBe("new-access-secret");
    expect(await service.getAccessToken()).toBe("new-access-secret");
    expect(http).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(file, "utf8")).not.toContain("new-access-secret");
    expect((await service.disconnect()).connected).toBe(false);
    expect(fs.readFileSync(file, "utf8")).not.toContain("saved-refresh-secret");
    expect(await service.getAccessToken()).toBeNull();
    expect(http).toHaveBeenCalledTimes(2);
  });

  it("does not revive a token when disconnect races an in-flight refresh", async () => {
    let releaseToken!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    const http = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/revoke"))
        return new Response(null, { status: 200 });
      await gate;
      return new Response(
        JSON.stringify({ access_token: "late-access", expires_in: 3600 }),
        { status: 200 },
      );
    }) as YoutubeOAuthHttp;
    const { service, file } = setup(http);
    service.saveClient(client);
    fs.writeFileSync(
      file,
      JSON.stringify({ ...client, refreshToken: "saved-refresh" }),
      { mode: 0o600 },
    );
    const pending = service.getAccessToken();
    await service.disconnect();
    releaseToken();
    expect(await pending).toBeNull();
    expect(await service.getAccessToken()).toBeNull();
  });

  it("does not reconnect when disconnect races an authorization callback", async () => {
    let releaseToken!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    const http = vi.fn(async () => {
      await gate;
      return new Response(
        JSON.stringify({
          access_token: "late-access",
          refresh_token: "late-refresh",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/youtube.force-ssl",
        }),
        { status: 200 },
      );
    }) as YoutubeOAuthHttp;
    const { service, file } = setup(http);
    service.saveClient(client);
    const started = service.begin();
    const pending = service.complete({
      state: new URL(started.authorizationUrl).searchParams.get("state"),
      code: "code",
      cookie: started.cookieValue,
    });
    await service.disconnect();
    releaseToken();
    await expect(pending).rejects.toThrow();
    expect(service.status().connected).toBe(false);
    expect(fs.readFileSync(file, "utf8")).not.toContain("late-refresh");
  });

  it("rejects a callback without a refresh token and ignores unsafe public URLs", async () => {
    const http = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "access-secret",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/youtube.force-ssl",
          }),
          { status: 200 },
        ),
    ) as YoutubeOAuthHttp;
    const { service } = setup(http);
    service.saveClient(client);
    const started = service.begin();
    await expect(
      service.complete({
        state: new URL(started.authorizationUrl).searchParams.get("state"),
        code: "code",
        cookie: started.cookieValue,
      }),
    ).rejects.toThrow();
    expect(service.status().connected).toBe(false);
    const unsafe = setup(http, "http://nova.example.com/path").service;
    unsafe.saveClient(client);
    expect(unsafe.callbackUrl()).toBeNull();
    expect(() => unsafe.begin()).toThrow();
  });

  it("sets a restricted nonce cookie and redirects callback without forwarding code", async () => {
    const { service } = setup(vi.fn() as YoutubeOAuthHttp);
    service.saveClient(client);
    const controller = new YoutubeOAuthController(service);
    const cookie = vi.fn();
    const clearCookie = vi.fn();
    const redirect = vi.fn();
    const response = { cookie, clearCookie, redirect } as never;
    const started = controller.start(response);
    expect(cookie).toHaveBeenCalledWith(
      "nova_youtube_oauth",
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/api/settings/youtube/oauth/callback",
      }),
    );
    await controller.callback(
      "bad-state",
      "private-code",
      { headers: {} } as never,
      response,
    );
    expect(clearCookie).toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(
      303,
      "/settings?section=connections&youtubeOAuth=error",
    );
    expect(JSON.stringify(started)).not.toContain(client.clientSecret);
    expect(JSON.stringify(redirect.mock.calls)).not.toContain("private-code");
  });
});
