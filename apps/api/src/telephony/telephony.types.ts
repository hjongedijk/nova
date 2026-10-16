/** Shared types for NOVA's telephony (Asterisk over ARI). No secrets leave the store through these types. */

export type ExtensionKind = "phone" | "doorbell";

export interface Extension {
  /** 3-4 digits, 100-699 and 800-9999; 700-799 is reserved for NOVA's own services. */
  id: string;
  name: string;
  kind: ExtensionKind;
  secret: string;
  createdAt: string;
}

export interface Trunk {
  host: string;
  username: string;
  secret: string;
  /** Our own number at the provider (used as caller id). */
  number: string;
  /** Let internal extensions dial out through the trunk themselves (toll-fraud risk, default off). */
  allowExtensionsToDialOut: boolean;
}

/** A person NOVA can call by name through the SIP trunk, for example a Linphone account at sip.linphone.org. */
export interface Contact {
  name: string;
  /** user@domain; the domain must be the trunk's host. */
  sip: string;
  /** This contact may call NOVA (through the trunk) and have a conversation. Off unless chosen. */
  allowConversation: boolean;
}

export interface TelephonyConfig {
  version: 1;
  /** Master switch; default OFF. */
  enabled: boolean;
  /** Host name or IP address phones use to reach Asterisk (used in provisioning). */
  publicHost: string;
  ariSecret: string;
  extensions: Extension[];
  trunk: Trunk | null;
  /** Extensions that ring for the doorbell and (when a trunk exists) inbound external calls. */
  ringExtensions: string[];
  /** Named people reachable through the trunk. */
  contacts?: Contact[];
  /** Internal extension calls may then run without a confirmation (external numbers never). */
  allowInternalCallsWithoutConfirmation: boolean;
  voice: "edge" | "piper";
}

export interface AriChannel {
  id: string;
  name: string;
  state: string;
  caller: { name: string; number: string };
  connected?: { name: string; number: string };
  creationtime?: string;
  dialplan?: { context?: string; exten?: string };
}

export interface AriEndpoint {
  technology: string;
  resource: string;
  state: "online" | "offline" | "unknown";
  channel_ids: string[];
}

export interface AriEvent {
  type: string;
  channel?: AriChannel;
  args?: string[];
  playback?: { id: string; state: string; target_uri?: string };
  cause?: number;
  cause_txt?: string;
}

/** The narrow slice of Asterisk REST Interface NOVA uses; replaced by a fake in tests. */
export interface AriPort {
  connected(): boolean;
  start(): Promise<void>;
  stop(): void;
  info(): Promise<{ version: string }>;
  endpoints(): Promise<AriEndpoint[]>;
  channels(): Promise<AriChannel[]>;
  originate(input: {
    endpoint: string;
    app?: string;
    appArgs?: string;
    /** Run this dialplan extension when answered instead of a Stasis application (spoken conversation). */
    context?: string;
    extension?: string;
    callerId?: string;
    timeoutSeconds?: number;
  }): Promise<AriChannel>;
  hangup(channelId: string): Promise<void>;
  answer(channelId: string): Promise<void>;
  play(channelId: string, media: string): Promise<{ id: string }>;
  createBridge(): Promise<{ id: string }>;
  addToBridge(bridgeId: string, channelId: string): Promise<void>;
  destroyBridge(bridgeId: string): Promise<void>;
  onEvent(handler: (event: AriEvent) => void): () => void;
}

export const ARI_PORT = Symbol("nova:ari-port");

export interface CallEvent {
  at: string;
  type:
    | "inbound"
    | "doorbell"
    | "outbound"
    | "answered"
    | "announcement"
    | "ended"
    | "error";
  channelId: string;
  from?: string;
  to?: string;
  detail?: string;
}

export class TelephonyError extends Error {}
