import crypto from "node:crypto";
import {
  type Contact,
  type Extension,
  type TelephonyConfig,
  TelephonyError,
} from "./telephony.types.js";

/** Reserved numbers handled by NOVA itself through the ARI application. */
export const NOVA_EXTENSION = "700";
export const DOORBELL_EXTENSION = "710";
export const ARI_APP = "nova";
export const ARI_USER = "nova";
export const SIP_PORT = 5060;
export const ARI_PORT_NUMBER = 8088;
export const DEFAULT_RTP_START = 10000;
export const DEFAULT_RTP_END = 10100;
export const MAX_EXTENSIONS = 20;

/** Private ranges only: the PBX never answers a SIP client from the public internet. */
export const PRIVATE_RANGES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
] as const;

const CONTACT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;
const CONTACT_SIP =
  /^[A-Za-z0-9._+-]{1,64}@[a-z0-9]([a-z0-9.-]{1,251}[a-z0-9])$/i;
export const MAX_CONTACTS = 20;
export const DEFAULT_MESSAGE_URL =
  "http://nova:8080/api/integrations/asterisk/message";
const MESSAGE_URL =
  /^http:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{2,5})?\/api\/integrations\/asterisk\/message$/i;

/** Text messages from a contact reach NOVA only when the trunk exists and a contact may talk to NOVA. */
export function messagingEnabled(config: TelephonyConfig): boolean {
  return (
    Boolean(config.trunk) &&
    (config.contacts ?? []).some((c) => c.allowConversation)
  );
}

export function validContact(contact: unknown): contact is Contact {
  const c = contact as Partial<Contact> | null;
  return (
    !!c &&
    typeof c.name === "string" &&
    CONTACT_NAME.test(c.name) &&
    typeof c.sip === "string" &&
    CONTACT_SIP.test(c.sip) &&
    typeof c.allowConversation === "boolean"
  );
}

export const contactUser = (sip: string): string => sip.split("@")[0]!;
export const contactDomain = (sip: string): string =>
  sip.split("@")[1]!.toLowerCase();

export const randomSecret = (bytes = 18): string =>
  crypto.randomBytes(bytes).toString("base64url");

const EXTENSION_ID = /^[1-9][0-9]{2,3}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const USER = /^[A-Za-z0-9._+-]{1,64}$/;
/** Printable ASCII without `;` (comment in Asterisk configs), quotes, backslash, `#`, `[`, `]`, `=`. */
const SECRET = /^[A-Za-z0-9!%&()*+,./:<>?@^_{|}~-]{8,128}$/;

export function validExtensionId(id: unknown): id is string {
  if (typeof id !== "string" || !EXTENSION_ID.test(id)) return false;
  const number = Number(id);
  return !(number >= 700 && number <= 799);
}

export function validHost(host: unknown): host is string {
  return typeof host === "string" && HOST.test(host);
}

export function validUser(user: unknown): user is string {
  return typeof user === "string" && USER.test(user);
}

export function validSecret(secret: unknown): secret is string {
  return typeof secret === "string" && SECRET.test(secret);
}

/** A display name that can never break out of a `callerid="..."` value. */
export function safeName(name: string): string {
  return (
    name
      .replace(/[^\p{L}\p{N} ._-]/gu, "")
      .trim()
      .slice(0, 40) || "Toestel"
  );
}

export interface RtpRange {
  start: number;
  end: number;
}

export function rtpRangeFromEnv(env = process.env): RtpRange {
  const start = Number(env.NOVA_RTP_START);
  const end = Number(env.NOVA_RTP_END);
  if (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 1024 &&
    end <= 65000 &&
    end - start >= 20 &&
    end - start <= 1000
  )
    return { start, end };
  return { start: DEFAULT_RTP_START, end: DEFAULT_RTP_END };
}

function endpointSections(extension: Extension): string {
  const context =
    extension.kind === "doorbell" ? "nova-doorbell" : "nova-internal";
  const id = extension.id;
  return [
    `[${id}]`,
    "type=endpoint",
    `context=${context}`,
    "disallow=all",
    "allow=g722,alaw,ulaw",
    `auth=${id}-auth`,
    `aors=${id}`,
    `callerid="${safeName(extension.name)}" <${id}>`,
    "deny=0.0.0.0/0",
    ...PRIVATE_RANGES.map((range) => `permit=${range}`),
    "direct_media=no",
    "rtp_symmetric=yes",
    "force_rport=yes",
    "rewrite_contact=yes",
    "dtmf_mode=rfc4733",
    "",
    `[${id}-auth]`,
    "type=auth",
    "auth_type=userpass",
    `username=${id}`,
    `password=${extension.secret}`,
    "",
    `[${id}]`,
    "type=aor",
    "max_contacts=3",
    "remove_existing=yes",
    "qualify_frequency=30",
    "",
  ].join("\n");
}

/** The SIP relay Asterisk's trunk goes through (see sip-relay/): the host name and port Asterisk uses to reach it. */
export interface RelayProxy {
  host: string;
  port: number;
}

/** `\;lr` marks a loose router; without it PJSIP uses the proxy as Request-URI (strict routing). `\;` keeps the semicolon from starting a comment in the Asterisk configuration. */
export const relayProxyUri = (relay: RelayProxy): string =>
  `sip:${relay.host}:${relay.port}\\;transport=tcp\\;lr`;

export function renderPjsip(
  config: TelephonyConfig,
  relay: RelayProxy | null = null,
): string {
  const parts = [
    "; Generated by NOVA. Do not edit: changes are overwritten from the NOVA settings.",
    "[global]",
    "type=global",
    "user_agent=NOVA-PBX",
    "",
    "[transport-udp]",
    "type=transport",
    "protocol=udp",
    `bind=0.0.0.0:${SIP_PORT}`,
    "",
    "[transport-tcp]",
    "type=transport",
    "protocol=tcp",
    `bind=0.0.0.0:${SIP_PORT}`,
    "",
  ];
  for (const extension of config.extensions)
    parts.push(endpointSections(extension));
  const trunk = config.trunk;
  if (trunk) {
    parts.push(
      "[trunk-auth]",
      "type=auth",
      "auth_type=userpass",
      `username=${trunk.username}`,
      `password=${trunk.secret}`,
      "",
      "[trunk]",
      "type=aor",
      `contact=sip:${trunk.host}`,
      "",
      "[trunk]",
      "type=endpoint",
      "context=nova-trunk-in",
      ...(messagingEnabled(config) ? ["message_context=nova-message"] : []),
      "disallow=all",
      "allow=alaw,ulaw",
      // Linphone and sip.linphone.org insist on encrypted audio (RTP/SAVP with SDES keys); without this the call is
      // refused with 488 "Not Acceptable Here" in both directions.
      "media_encryption=sdes",
      "outbound_auth=trunk-auth",
      ...(relay
        ? [`outbound_proxy=${relayProxyUri(relay)}`, "identify_by=header"]
        : []),
      "aors=trunk",
      `from_user=${trunk.username}`,
      `from_domain=${trunk.host}`,
      "direct_media=no",
      "rtp_symmetric=yes",
      "force_rport=yes",
      "rewrite_contact=yes",
      "",
      "[trunk]",
      "type=identify",
      "endpoint=trunk",
      // Through the relay every request arrives from the relay's address, so the registrar is recognised by its
      // From domain instead (the relay only accepts connections from this Asterisk).
      ...(relay
        ? [`match_header=From: /@${trunk.host.replace(/\./g, "[.]")}/`]
        : [`match=${trunk.host}`]),
      "",
      "[trunk]",
      "type=registration",
      "outbound_auth=trunk-auth",
      ...(relay ? [`outbound_proxy=${relayProxyUri(relay)}`] : []),
      `server_uri=sip:${trunk.host}`,
      `client_uri=sip:${trunk.username}@${trunk.host}`,
      // A restart of NOVA (and with it the relay) takes the registration down: retry quickly and never give up.
      "retry_interval=15",
      "forbidden_retry_interval=60",
      "fatal_retry_interval=15",
      "auth_rejection_permanent=no",
      "max_retries=1000000",
      "expiration=3600",
      "",
    );
  }
  return parts.join("\n");
}

/** Where NOVA's spoken conversation listens (Asterisk AudioSocket); null keeps extension 700 on the short notice. */
export interface ConversationDialplan {
  host: string;
  port: number;
  uuid: string;
}

export function renderExtensions(
  config: TelephonyConfig,
  conversation: ConversationDialplan | null = null,
  messageUrl: string = DEFAULT_MESSAGE_URL,
): string {
  if (
    conversation &&
    (!validHost(conversation.host) ||
      !Number.isInteger(conversation.port) ||
      conversation.port < 1024 ||
      conversation.port > 65535 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        conversation.uuid,
      ))
  )
    throw new TelephonyError("Ongeldige gespreksverbinding.");
  const lines = [
    "; Generated by NOVA. Do not edit.",
    "[nova-internal]",
    ...(conversation
      ? [
          `exten => ${NOVA_EXTENSION},1,Answer()`,
          ` same => n,AudioSocket(${conversation.uuid},${conversation.host}:${conversation.port})`,
          ` same => n,Hangup()`,
        ]
      : [
          `exten => ${NOVA_EXTENSION},1,Stasis(${ARI_APP},inbound)`,
          ` same => n,Hangup()`,
        ]),
    `exten => ${DOORBELL_EXTENSION},1,Stasis(${ARI_APP},doorbell)`,
    ` same => n,Hangup()`,
  ];
  for (const extension of config.extensions) {
    if (extension.kind === "doorbell") continue;
    lines.push(
      `exten => ${extension.id},1,Dial(PJSIP/${extension.id},30)`,
      ` same => n,Hangup()`,
    );
  }
  if (config.trunk?.allowExtensionsToDialOut)
    lines.push(
      "exten => _+X.,1,Dial(PJSIP/${EXTEN}@trunk,60)",
      " same => n,Hangup()",
    );
  lines.push(
    "",
    "[nova-doorbell]",
    `exten => ${DOORBELL_EXTENSION},1,Stasis(${ARI_APP},doorbell)`,
    ` same => n,Hangup()`,
    "",
    ...(conversation
      ? [
          "[nova-converse]",
          "; NOVA calls out and talks: the answered call goes to the spoken conversation.",
          "exten => s,1,Answer()",
          ` same => n,AudioSocket(${conversation.uuid},${conversation.host}:${conversation.port})`,
          " same => n,Hangup()",
          "",
        ]
      : []),
    "[nova-trunk-in]",
    ...trunkInbound(config, conversation),
    "",
    ...messageContext(config, messageUrl),
  );
  return lines.join("\n");
}

/**
 * Inbound calls through the trunk. A contact that is allowed to talk to NOVA goes straight to the spoken conversation
 * (the caller id comes from the provider, which authenticates its users); everyone else keeps the old behaviour:
 * an alert and ringing the configured phones. Without a trunk nothing external is accepted.
 */
function trunkInbound(
  config: TelephonyConfig,
  conversation: ConversationDialplan | null,
): string[] {
  if (!config.trunk)
    return ["; no trunk configured: inbound external calls are not accepted"];
  const lines = ["exten => _.,1,NoOp(NOVA inbound)"];
  const allowed = conversation
    ? (config.contacts ?? []).filter((c) => c.allowConversation)
    : [];
  for (const contact of allowed)
    lines.push(
      ` same => n,GotoIf($["\${CALLERID(num)}"="${contactUser(contact.sip)}"]?converse)`,
    );
  lines.push(` same => n,Stasis(${ARI_APP},external)`, " same => n,Hangup()");
  if (conversation && allowed.length)
    lines.push(
      " same => n(converse),Answer()",
      ` same => n,AudioSocket(${conversation.uuid},${conversation.host}:${conversation.port})`,
      " same => n,Hangup()",
    );
  return lines;
}

/**
 * Text messages from Linphone: Asterisk hands each one to NOVA over the private network (the shared token proves where it
 * came from) and sends NOVA's answer back to the sender through the trunk. NOVA decides what is answered: only allowed
 * contacts, only text, and never anything that needs a confirmation. An empty answer means "send nothing".
 */
function messageContext(config: TelephonyConfig, messageUrl: string): string[] {
  const trunk = config.trunk;
  if (!trunk || !messagingEnabled(config)) return [];
  const token = config.messageToken ?? "";
  return [
    "[nova-message]",
    "exten => _.,1,NoOp(NOVA message)",
    " same => n,Set(CURLOPT(conntimeout)=5)",
    " same => n,Set(CURLOPT(httptimeout)=45)",
    ` same => n,Set(REPLY=\${CURL(${messageUrl},token=${token}&from=\${URIENCODE(\${MESSAGE(from)})}&type=\${URIENCODE(\${MESSAGE_DATA(Content-Type)})}&body=\${URIENCODE(\${MESSAGE(body)})})})`,
    " same => n,GotoIf($[${LEN(${REPLY})}=0]?done)",
    " same => n,Set(MESSAGE(body)=${CUT(REPLY,|,2-)})",
    ` same => n,MessageSend(pjsip:trunk/\${CUT(REPLY,|,1)},sip:${trunk.username}@${trunk.host})`,
    " same => n(done),Hangup()",
    "",
  ];
}

export function renderAri(config: TelephonyConfig): string {
  return [
    "; Generated by NOVA.",
    "[general]",
    "enabled=yes",
    "pretty=no",
    "",
    `[${ARI_USER}]`,
    "type=user",
    "read_only=no",
    "password_format=plain",
    `password=${config.ariSecret}`,
    "",
  ].join("\n");
}

export function renderHttp(): string {
  return [
    "; Generated by NOVA. Published only on the loopback interface by Docker.",
    "[general]",
    "enabled=yes",
    "bindaddr=0.0.0.0",
    `bindport=${ARI_PORT_NUMBER}`,
    "",
  ].join("\n");
}

export function renderRtp(range: RtpRange): string {
  return [
    "; Generated by NOVA.",
    "[general]",
    `rtpstart=${range.start}`,
    `rtpend=${range.end}`,
    "",
  ].join("\n");
}

/** AMI stays off: NOVA uses ARI only, which keeps the attack surface small. */
export function renderManager(): string {
  return "; Generated by NOVA.\n[general]\nenabled=no\n";
}

/** Only what a SIP/ARI PBX needs: legacy channel drivers and database backends stay unloaded. */
export function renderModules(): string {
  const unused = [
    "chan_alsa",
    "chan_console",
    "chan_iax2",
    "chan_skinny",
    "chan_mgcp",
    "chan_unistim",
    "res_config_pgsql",
    "res_config_ldap",
    "cdr_pgsql",
    "cel_pgsql",
    "cdr_tds",
    "cel_tds",
    "cdr_csv",
    "cdr_custom",
    "cdr_sqlite3_custom",
    "cel_custom",
    "cel_sqlite3_custom",
  ];
  return [
    "; Generated by NOVA.",
    "[modules]",
    "autoload=yes",
    ...unused.map((name) => `noload => ${name}.so`),
    "",
  ].join("\n");
}

/** The complete file set that is mounted into the Asterisk container. */
export function renderAll(
  config: TelephonyConfig,
  range: RtpRange = rtpRangeFromEnv(),
  conversation: ConversationDialplan | null = null,
  messageUrl: string = DEFAULT_MESSAGE_URL,
  relay: RelayProxy | null = null,
): Record<string, string> {
  assertValid(config, messageUrl);
  if (
    relay &&
    (!validHost(relay.host) ||
      !Number.isInteger(relay.port) ||
      relay.port < 1024 ||
      relay.port > 65535)
  )
    throw new TelephonyError("Ongeldig adres voor de SIP-relay.");
  return {
    "pjsip.conf": renderPjsip(config, relay),
    "extensions.conf": renderExtensions(config, conversation, messageUrl),
    "ari.conf": renderAri(config),
    "http.conf": renderHttp(),
    "rtp.conf": renderRtp(range),
    "manager.conf": renderManager(),
    "modules.conf": renderModules(),
  };
}

/** Refuses anything that could inject configuration lines. */
export function assertValid(
  config: TelephonyConfig,
  messageUrl: string = DEFAULT_MESSAGE_URL,
): void {
  if (!validSecret(config.ariSecret))
    throw new TelephonyError("Ongeldig ARI-geheim.");
  if (config.extensions.length > MAX_EXTENSIONS)
    throw new TelephonyError("Te veel toestellen.");
  const seen = new Set<string>();
  for (const extension of config.extensions) {
    if (!validExtensionId(extension.id) || seen.has(extension.id))
      throw new TelephonyError("Ongeldig of dubbel toestelnummer.");
    seen.add(extension.id);
    if (!validSecret(extension.secret))
      throw new TelephonyError("Ongeldig toestelwachtwoord.");
  }
  const trunk = config.trunk;
  if (
    trunk &&
    !(
      validHost(trunk.host) &&
      validUser(trunk.username) &&
      validSecret(trunk.secret)
    )
  )
    throw new TelephonyError("Ongeldige SIP-trunkgegevens.");
  if (messagingEnabled(config)) {
    if (!MESSAGE_URL.test(messageUrl))
      throw new TelephonyError("Ongeldig adres voor tekstberichten.");
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(config.messageToken ?? ""))
      throw new TelephonyError("Ongeldig berichtengeheim.");
  }
  const contacts = config.contacts ?? [];
  if (contacts.length > MAX_CONTACTS)
    throw new TelephonyError("Te veel contacten.");
  const names = new Set<string>();
  for (const contact of contacts) {
    if (!validContact(contact) || names.has(contact.name.toLowerCase()))
      throw new TelephonyError("Ongeldig of dubbel contact.");
    names.add(contact.name.toLowerCase());
    if (!trunk || contactDomain(contact.sip) !== trunk.host.toLowerCase())
      throw new TelephonyError(
        "Een contact kan alleen gebeld worden via de ingestelde SIP-trunk: het domein moet de trunkhost zijn.",
      );
  }
}
