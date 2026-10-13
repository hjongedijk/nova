import { afterEach, expect, it, vi } from "vitest";
import { getJson } from "./client.ts";
afterEach(() => vi.unstubAllGlobals());
it("signals app relock only when the API guard rejects before execution", async () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", { dispatchEvent });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { error: "App-toegang vereist." },
        { status: 403, headers: { "x-nova-app-access": "required" } },
      ),
    ),
  );
  await expect(getJson("/settings")).rejects.toThrow();
  expect(dispatchEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: "nova-app-access-required" }),
  );
  dispatchEvent.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "Forbidden" }, { status: 403 })),
  );
  await expect(getJson("/settings")).rejects.toThrow();
  expect(dispatchEvent).not.toHaveBeenCalled();
});
