import { describe, expect, it } from "vitest";
import {
  findSecrets,
  interceptChatBody,
  interceptSecrets,
  looksLikeSecret,
} from "../../src/chat/secret-intercept.js";

const store = (value: string, host: string | undefined) =>
  `sec_${value.length.toString(16).padStart(2, "0")}${host ? `@${host}` : ""}`;

describe("secret interception in chat", () => {
  const cases: [string, string, string | null][] = [
    [
      "api key after keyword",
      "Koppel https://api.acme.io/v1 met api key sk-test-0000 alsjeblieft",
      "sk-test-0000",
    ],
    [
      "token is",
      "verbind met https://api.acme.io, het token is Zx81kd92Lm0pQ4",
      "Zx81kd92Lm0pQ4",
    ],
    [
      "authorization header",
      "gebruik https://api.acme.io met Authorization: Bearer abc123def456ghi789",
      "abc123def456ghi789",
    ],
    [
      "sleutel",
      "De sleutel voor https://x.example/api is a1b2c3d4e5f6",
      "a1b2c3d4e5f6",
    ],
    [
      "github prefix",
      "koppel https://api.github.com token ghp_0123456789abcdefghij",
      "ghp_0123456789abcdefghij",
    ],
    [
      "quoted",
      `integreer https://api.acme.io api_key: "k9f8e7d6c5b4a3"`,
      "k9f8e7d6c5b4a3",
    ],
    ["no url", "mijn token is sk-test-0000", null],
    ["no keyword", "kijk eens naar https://example.com/abc123def456ghi", null],
    [
      "plain word after keyword",
      "wat is een token? zie https://example.com/uitleg",
      null,
    ],
    [
      "secret inside the url path is not touched",
      "check https://example.com/token/abc123def456ghi",
      null,
    ],
    ["short value", "token is 1234 voor https://a.example", null],
    ["pure word", "het wachtwoord is gewoonweg voor https://a.example", null],
  ];
  it.each(cases)("%s", (_name, message, expected) => {
    const found = findSecrets(message).map((s) => s.value);
    if (expected === null) expect(found).toEqual([]);
    else expect(found).toEqual([expected]);
  });

  it("replaces the value, binds it to the single URL host and tells the model to use the reference", () => {
    const result = interceptSecrets(
      "Koppel https://api.acme.io/v1 met api key sk-test-0000 alsjeblieft",
      store,
    );
    expect(result.message).toContain(
      "[geheim opgeslagen als sec_0c@api.acme.io]",
    );
    expect(result.message).not.toContain("sk-test-0000");
    expect(result.message).toContain("credential_ref");
    expect(result.refs).toHaveLength(1);
  });

  it("does not bind to a host when the message names several", () => {
    const result = interceptSecrets(
      "token sk-test-0000 voor https://a.example en https://b.example",
      store,
    );
    expect(result.refs[0]).toBe("sec_0c");
  });

  it("stays fast on long messages", () => {
    const text = `https://a.example ${"token aaaa bbbb cccc dddd eeee ".repeat(300)}`;
    const started = Date.now();
    findSecrets(text);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("looksLikeSecret table", () => {
    expect(
      ["sk-test-0000", "abc123def456", "ghp_0123456789abcd"].map(
        looksLikeSecret,
      ),
    ).toEqual([true, true, true]);
    expect(
      [
        "short",
        "gewoonwoord",
        "https://x.example/abc123",
        "ALLUPPERCASEWORD",
      ].map(looksLikeSecret),
    ).toEqual([false, false, false, false]);
  });

  it("the controller hook rewrites only the message and fails closed", () => {
    const vault = { put: (value: string) => `sec_${value.length}` };
    const body = interceptChatBody(
      {
        message: "koppel https://a.example token sk-test-0000",
        sessionId: "s",
      },
      vault,
    );
    expect(body.message).not.toContain("sk-test-0000");
    expect(body.sessionId).toBe("s");
    const same = { message: "hallo", sessionId: "s" };
    expect(interceptChatBody(same, vault)).toBe(same);
    const broken = interceptChatBody(
      { message: "koppel https://a.example token sk-test-0000" },
      {
        put: () => {
          throw new Error("vault down");
        },
      },
    );
    expect(broken.message).not.toContain("sk-test-0000");
  });
});
