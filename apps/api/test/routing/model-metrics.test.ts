import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateService } from "../../src/core/state/state.service.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { OmniRouteClient } from "../../src/chat/omniroute-client.service.js";
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";
import { ModelMetricsService } from "../../src/routing/model-metrics.service.js";
import { RoutingService } from "../../src/routing/routing.service.js";
import { createApp } from "../settings/helpers.js";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../../src/app.module.js";
import { IntegrationsHealth } from "../../src/dashboard/integrations-health.service.js";

let config: NovaConfig;
let management: OmniRouteManagement;
let routing: RoutingService;
let metrics: ModelMetricsService;
beforeEach(() => {
  config = new NovaConfig();
  management = new OmniRouteManagement(config);
  management.configure({ password: "fixture-password" });
  routing = new RoutingService(config);
  vi.spyOn(routing, "status").mockReturnValue({
    freeOnly: true,
    ready: true,
    status: "OK",
    enabledModels: ["fixture/model:free"],
  });
  metrics = new ModelMetricsService(management, routing);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const sample = {
  provider: "fixture",
  model: "model:free",
  totalRequests: 5,
  successfulRequests: 3,
  avgLatencyMs: 1200,
  avgTtftMs: 300,
  avgTokensPerSecond: 20,
  apiKey: "private-key",
  prompt: "private-message",
  account: "private-email",
};

describe("private model measurements", () => {
  it("projects only identifiers/numbers and local last-response metadata", async () => {
    const request = vi
      .spyOn(management, "request")
      .mockResolvedValue({ entries: [sample], secret: "private-secret" });
    metrics.observe("model:free", "fixture", 500);
    const report = await metrics.report();
    expect(report).toMatchObject({
      available: true,
      routeReady: true,
      windowHours: 24,
      models: [
        {
          model: "model:free",
          requests: 5,
          failures: 2,
          enabled: true,
          averageMs: 1200,
        },
      ],
      lastResponse: {
        model: "model:free",
        provider: "fixture",
        latencyMs: 500,
      },
    });
    expect(JSON.stringify(report)).not.toContain("private-");
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "/api/usage/model-latency-stats?windowHours=24&minSamples=1&maxRows=10000",
    );
  });
  it("rejects malformed rows and limits the public list", async () => {
    vi.spyOn(management, "request").mockResolvedValue({
      entries: [
        { ...sample, provider: "<script>" },
        { ...sample, totalRequests: -1 },
        { ...sample, successfulRequests: 6 },
        { ...sample, totalRequests: 0.5 },
        {
          ...sample,
          avgLatencyMs: Infinity,
          avgTtftMs: -10,
          avgTokensPerSecond: "9",
        },
        ...Array.from({ length: 300 }, () => sample),
      ],
    });
    const report = await metrics.report();
    expect(report.models).toHaveLength(196);
    expect(report.models[0]).toMatchObject({
      averageMs: null,
      firstTokenMs: null,
      tokensPerSecond: null,
    });
  });
  it.each([new Error("private-key"), { wrong: "private-message" }])(
    "reports failures without upstream details",
    async (failure) => {
      const request = vi.spyOn(management, "request");
      if (failure instanceof Error) request.mockRejectedValue(failure);
      else request.mockResolvedValue(failure);
      expect(await metrics.report()).toMatchObject({
        available: false,
        models: [],
        error: "Modelmetingen zijn nu niet beschikbaar. Probeer later opnieuw.",
      });
      expect(JSON.stringify(await metrics.report())).not.toContain("private-");
    },
  );
  it("does not contact a gateway whose provenance changed or has no management password", async () => {
    const request = vi.spyOn(management, "request");
    vi.mocked(routing.status).mockReturnValue({
      freeOnly: true,
      ready: false,
      status: "GATEWAY_PROVENANCE_UNVERIFIED",
    });
    expect((await metrics.report()).available).toBe(false);
    expect(request).not.toHaveBeenCalled();
    vi.mocked(routing.status).mockReturnValue({
      freeOnly: true,
      ready: false,
      status: "POLICY_UNAVAILABLE",
    });
    management.configure({ password: "" });
    expect((await metrics.report()).available).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
  it("protects model measurements with the settings PIN", async () => {
    vi.spyOn(management, "request").mockResolvedValue({ entries: [] });
    const nova = await createApp({ env: { NOVA_ADMIN_PIN: "fixture-pin" } });
    try {
      vi.spyOn(nova.app.get(ModelMetricsService), "report").mockResolvedValue(
        await metrics.report(),
      );
      expect((await nova.api.get("/api/settings/models/metrics")).status).toBe(
        401,
      );
      expect(
        (
          await nova.api
            .get("/api/settings/models/metrics")
            .set("x-nova-pin", "fixture-pin")
        ).status,
      ).toBe(200);
    } finally {
      await nova.app.close();
    }
  });
  it.each([false, true])(
    "captures a completed NOVA model answer (stream=%s) without messages",
    async (stream) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            stream
              ? 'data: {"model":"model:free","provider":"fixture","choices":[{"delta":{"content":"private-message"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
              : JSON.stringify({
                  model: "model:free",
                  provider: "fixture",
                  choices: [
                    {
                      message: {
                        role: "assistant",
                        content: "private-message",
                      },
                    },
                  ],
                }),
          ),
        ),
      );
      const client = new OmniRouteClient(config, routing, metrics);
      await client.call([{ role: "user", content: "private-input" }], {
        stream,
      });
      vi.spyOn(management, "request").mockResolvedValue({ entries: [] });
      expect((await metrics.report()).lastResponse).toMatchObject({
        model: "model:free",
        provider: "fixture",
      });
      expect(JSON.stringify(await metrics.report())).not.toContain("private-");
    },
  );
  it("uses a role model only after the routing service validates it", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "fixture/model:free",
          choices: [{ message: { role: "assistant", content: "ok" } }],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const validate = vi
      .spyOn(routing, "assertRoleModel")
      .mockReturnValue("fixture/model:free");
    const client = new OmniRouteClient(config, routing, metrics);
    await client.call([{ role: "user", content: "hello" }], {
      roleModel: { role: "conversation", modelId: "fixture/model:free" },
    });
    expect(validate).toHaveBeenCalledWith("conversation", "fixture/model:free");
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).model).toBe(
      "fixture/model:free",
    );

    const deniedFetch = vi.fn();
    vi.stubGlobal("fetch", deniedFetch);
    validate.mockImplementation(() => {
      throw new Error("blocked");
    });
    await expect(
      client.call([{ role: "user", content: "hello" }], {
        roleModel: { role: "conversation", modelId: "paid/model" },
      }),
    ).rejects.toThrow("blocked");
    expect(deniedFetch).not.toHaveBeenCalled();
  });
  it("retries a failed role model with the next verified free preference", async () => {
    const primary = "fixture/primary:free";
    const fallback = "fixture/fallback:free";
    vi.spyOn(routing, "roleModels").mockReturnValue([primary, fallback]);
    vi.spyOn(routing, "assertRoleModel").mockImplementation((_role, id) => {
      if (![primary, fallback].includes(id)) throw new Error("not verified");
      return id;
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: fallback,
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const answer = await new OmniRouteClient(config, routing, metrics).call(
      [{ role: "user", content: "hello" }],
      { roleModel: { role: "conversation", modelId: primary } },
    );
    expect(answer.model).toBe(fallback);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.map(
        (call) => JSON.parse(call[1]!.body as string).model,
      ),
    ).toEqual([primary, fallback]);
    expect(routing.assertRoleModel).toHaveBeenCalledWith(
      "conversation",
      fallback,
    );
  });
  it("preserves the last completed answer after a blocked call", async () => {
    metrics.observe("previous", null, 0);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    vi.mocked(routing.status).mockReturnValue({
      freeOnly: true,
      ready: false,
      status: "POLICY_UNAVAILABLE",
    });
    const client = new OmniRouteClient(config, routing, metrics);
    await expect(
      client.call([{ role: "user", content: "private-input" }]),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    vi.spyOn(management, "request").mockResolvedValue({ entries: [] });
    expect((await metrics.report()).lastResponse?.model).toBe("previous");
  });
  it("keeps the last response behind PIN and out of public health/component state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              model: "private-response:free",
              provider: "private-provider",
              choices: [
                { message: { role: "assistant", content: "private-content" } },
              ],
            }),
          ),
      ),
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(NovaConfig)
      .useValue(Object.assign(config, { adminPin: "fixture-pin" }))
      .compile();
    const app = module.createNestApplication();
    app.setGlobalPrefix("api");
    vi.spyOn(app.get(RoutingService), "status").mockReturnValue({
      freeOnly: true,
      ready: true,
      status: "OK",
    });
    vi.spyOn(app.get(IntegrationsHealth), "report").mockResolvedValue(
      {} as Awaited<ReturnType<IntegrationsHealth["report"]>>,
    );
    vi.spyOn(app.get(OmniRouteManagement), "request").mockResolvedValue({
      entries: [],
    });
    try {
      await app.init();
      await app
        .get(OmniRouteClient)
        .call([{ role: "user", content: "private-input" }]);
      const api = request(app.getHttpServer());
      expect((await api.get("/api/settings/models/metrics")).status).toBe(401);
      const privateReport = await api
        .get("/api/settings/models/metrics")
        .set("x-nova-pin", "fixture-pin");
      expect(privateReport.body.lastResponse.model).toBe(
        "private-response:free",
      );
      const health = await api.get("/api/health");
      expect(health.status).toBe(200);
      expect(JSON.stringify(health.body)).not.toContain("private-");
      expect(JSON.stringify(app.get(StateService).all())).not.toContain(
        "private-",
      );
    } finally {
      await app.close();
    }
  });
});
