import { sendJson } from "./client.ts";
import { getPin } from "./pin-session.ts";

export type NodeRedEditorGrant = {
  url: "/api/node-red-editor/";
  expiresAt: string;
};

function headers(): Record<string, string> {
  const pin = getPin();
  return { "x-nova-admin": "1", ...(pin ? { "x-nova-pin": pin } : {}) };
}

function validateGrant(value: NodeRedEditorGrant): NodeRedEditorGrant {
  if (
    value?.url !== "/api/node-red-editor/" ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw new Error("Node-RED-editor is niet beschikbaar.");
  }
  return { url: value.url, expiresAt: value.expiresAt };
}

export async function openNodeRedEditor(): Promise<NodeRedEditorGrant> {
  return validateGrant(
    await sendJson<NodeRedEditorGrant>(
      "POST",
      "/node-red-editor/_nova/session",
      {},
      headers(),
    ),
  );
}

export async function renewNodeRedEditor(): Promise<NodeRedEditorGrant> {
  return validateGrant(
    await sendJson<NodeRedEditorGrant>(
      "POST",
      "/node-red-editor/_nova/renew",
      {},
      headers(),
    ),
  );
}

export async function closeNodeRedEditor(): Promise<void> {
  await sendJson("DELETE", "/node-red-editor/_nova/session", {}, headers());
}
