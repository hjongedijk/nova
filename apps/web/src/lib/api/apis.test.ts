import { describe, expect, it } from "vitest";
import { apiStatus, protocolLabel, validApiAddress } from "./apis.ts";

describe("api studio helpers", () => {
  it("maps statuses to plain Dutch labels and tones", () => {
    expect(apiStatus({ status: "ready" })).toEqual({
      tone: "ok",
      label: "werkt",
    });
    expect(apiStatus({ status: "credentials_expired" }).tone).toBe("bad");
    expect(apiStatus({ status: "needs_info" }).label).toMatch(/meer info/);
  });

  it("names protocols", () => {
    expect(protocolLabel("graphql")).toBe("GraphQL");
    expect(protocolLabel("jsonrpc")).toBe("JSON-RPC");
  });

  it("accepts only http(s) addresses", () => {
    expect(validApiAddress("https://api.example.com/v1")).toBe(true);
    expect(validApiAddress(" http://192.168.1.5:8080 ")).toBe(true);
    expect(validApiAddress("ftp://x.example")).toBe(false);
    expect(validApiAddress("api.example.com")).toBe(false);
  });
});
