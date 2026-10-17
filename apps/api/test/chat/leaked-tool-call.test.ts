import { describe, expect, it } from "vitest";
import {
  findLeakedToolCall,
  LeakedCallGuard,
} from "../../src/chat/leaked-tool-call.js";
import { looksLikePlaceholder } from "../../src/apis/api.source.js";

const LEAK =
  'Ja, ik kan een API en key sturen. Eerst moet ik de API koppelen. {"type": "function", "name": "api_connect", "parameters": {"base_url": "https://api.example.com/v1", "token": "1234567890"}}';

describe("findLeakedToolCall", () => {
  it("finds a call written as text and keeps the words around it", () => {
    const leaked = findLeakedToolCall(LEAK);
    expect(leaked?.name).toBe("api_connect");
    expect(leaked?.args).toMatchObject({
      base_url: "https://api.example.com/v1",
    });
    expect(leaked?.rest).toBe(
      "Ja, ik kan een API en key sturen. Eerst moet ik de API koppelen.",
    );
  });
  it("understands the other common shapes", () => {
    expect(
      findLeakedToolCall('{"name":"timer_list","arguments":{}}')?.name,
    ).toBe("timer_list");
    expect(
      findLeakedToolCall(
        '{"function":{"name":"ha_toggle","arguments":"{\\"entity\\":\\"light.x\\"}"}}',
      )?.args,
    ).toEqual({ entity: "light.x" });
    expect(
      findLeakedToolCall(
        '```json\n{"type":"function","name":"x1","parameters":{}}\n```',
      )?.name,
    ).toBe("x1");
  });
  it("leaves ordinary text and ordinary JSON alone", () => {
    expect(findLeakedToolCall("Hallo, hoe kan ik helpen?")).toBeNull();
    expect(
      findLeakedToolCall('Zo ziet het eruit: {"a": 1, "b": [1,2]}'),
    ).toBeNull();
    expect(findLeakedToolCall('{"name": "Harm"}')).toBeNull();
    expect(findLeakedToolCall('{"unbalanced": ')).toBeNull();
  });
});

describe("LeakedCallGuard", () => {
  const run = (chunks: string[]) => {
    const out: string[] = [];
    const guard = new LeakedCallGuard((t) => out.push(t));
    for (const c of chunks) guard.push(c);
    guard.finish();
    return out.join("");
  };
  it("streams normal text straight through", () => {
    expect(run(["Hoi", ", hoe", " gaat het?"])).toBe("Hoi, hoe gaat het?");
  });
  it("never streams a tool call that arrives token by token", () => {
    const chunks = LEAK.match(/.{1,5}/g)!;
    expect(run(chunks)).toBe(
      "Ja, ik kan een API en key sturen. Eerst moet ik de API koppelen. ",
    );
  });
  it("releases JSON that was not a tool call, and code with braces", () => {
    expect(run(['Dit: {"na', 'me": "Harm"} ok'])).toBe(
      'Dit: {"name": "Harm"} ok',
    );
    expect(run(["function f() {", " return 1; }"])).toBe(
      "function f() { return 1; }",
    );
  });
});

describe("api_connect placeholders", () => {
  it("rejects example hosts and made-up tokens", () => {
    expect(looksLikePlaceholder("api.example.com", "1234567890")).toBe(true);
    expect(looksLikePlaceholder("api.acme.io", "1234567890")).toBe(true);
    expect(looksLikePlaceholder("api.acme.io", "YOUR_API_KEY")).toBe(true);
    expect(looksLikePlaceholder("api.acme.io", "<token>")).toBe(true);
    expect(looksLikePlaceholder("api.acme.io", "sk-live-9f8e7d6c5b4a")).toBe(
      false,
    );
    expect(looksLikePlaceholder("api.acme.io", undefined)).toBe(false);
  });
});
