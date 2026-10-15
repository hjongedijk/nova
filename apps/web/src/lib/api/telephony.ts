import { getJson, sendJson } from "./client.ts";
import { getPin } from "./pin-session.ts";

export type TelephonyExtension = {
  id: string;
  name: string;
  kind: "phone" | "doorbell";
  state: "online" | "offline" | "unknown";
};

export type TelephonyEvent = {
  at: string;
  type: string;
  channelId: string;
  from?: string;
  to?: string;
  detail?: string;
};

export type TelephonyStatus = {
  enabled: boolean;
  connected: boolean;
  version: string | null;
  error: string | null;
  publicHostSet: boolean;
  extensions: TelephonyExtension[];
  trunk: { configured: true; host: string } | { configured: false };
  ringExtensions: string[];
  allowInternalCallsWithoutConfirmation: boolean;
  voice: "edge" | "piper";
  activeCalls: number;
  rtpRange: string;
  novaExtension: string;
  doorbellExtension: string;
  events: TelephonyEvent[];
};

function headers(): Record<string, string> {
  const pin = getPin();
  return { "x-nova-admin": "1", ...(pin ? { "x-nova-pin": pin } : {}) };
}

export const getTelephony = () =>
  getJson<TelephonyStatus>("/telephony/status", { headers: headers() });

export const setTelephonyEnabled = (enabled: boolean) =>
  sendJson<TelephonyStatus>(
    "PUT",
    "/telephony/enabled",
    { enabled },
    headers(),
  );

export const saveTelephonySettings = (body: {
  publicHost?: string;
  allowInternalCallsWithoutConfirmation?: boolean;
  voice?: "edge" | "piper";
  ringExtensions?: string[];
}) => sendJson<TelephonyStatus>("PUT", "/telephony/settings", body, headers());

export const saveTelephonyTrunk = (body: {
  host: string;
  username: string;
  secret?: string;
  number: string;
  allowExtensionsToDialOut: boolean;
}) => sendJson<TelephonyStatus>("PUT", "/telephony/trunk", body, headers());

export const removeTelephonyTrunk = () =>
  sendJson<TelephonyStatus>("DELETE", "/telephony/trunk", undefined, headers());

export const addTelephonyExtension = (
  name: string,
  kind: "phone" | "doorbell",
) =>
  sendJson<{ id: string }>(
    "POST",
    "/telephony/extensions",
    { name, kind },
    headers(),
  );

export const removeTelephonyExtension = (id: string) =>
  sendJson<{ ok: true }>(
    "DELETE",
    `/telephony/extensions/${encodeURIComponent(id)}`,
    undefined,
    headers(),
  );

export const createProvisioningLink = (id: string) =>
  sendJson<{ url: string; expiresAt: string; singleUse: true }>(
    "POST",
    `/telephony/extensions/${encodeURIComponent(id)}/provisioning-link`,
    {},
    headers(),
  );

/** The provisioning file contains the SIP password; it is fetched with the settings headers and saved locally. */
export async function downloadLinphoneFile(id: string): Promise<void> {
  const response = await fetch(
    `/api/telephony/extensions/${encodeURIComponent(id)}/linphone.xml`,
    { cache: "no-store", headers: headers() },
  );
  if (!response.ok) throw new Error("Download mislukt.");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `linphone-${id}.xml`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
