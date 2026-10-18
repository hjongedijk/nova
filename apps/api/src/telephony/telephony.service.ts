import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import crypto from "node:crypto";
import { ConversationService } from "../conversation/conversation.service.js";
import { sanitize } from "../core/security/sanitize.js";
import { JarvisStateStore } from "../planning/jarvis-state.store.js";
import { TtsService } from "../tts/tts.service.js";
import {
  AnnouncementFiles,
  type AudioDecoder,
  decodeToPhoneWav,
} from "./announce.js";
import {
  ARI_APP,
  DOORBELL_EXTENSION,
  MAX_EXTENSIONS,
  NOVA_EXTENSION,
  randomSecret,
  renderAll,
  rtpRangeFromEnv,
  safeName,
  validExtensionId,
  validHost,
  validSecret,
  validUser,
  assertValid,
  contactUser,
  DEFAULT_MESSAGE_URL,
} from "./asterisk-config.js";
import { linphoneProvisioning } from "./linphone.js";
import {
  SipRelay,
  peerAllowlist,
  type RelayStatus,
} from "./sip-relay/relay.js";
import { type RelaySettings, relaySettings } from "./sip-relay/relay-config.js";
import { TelephonyStore } from "./telephony.store.js";
import {
  ARI_PORT,
  type AriChannel,
  type AriEvent,
  type AriPort,
  type CallEvent,
  type Extension,
  type ExtensionKind,
  TelephonyError,
  type Trunk,
  type Contact,
} from "./telephony.types.js";

const MAX_EVENTS = 50;
const MAX_CONCURRENT_CALLS = 2;
const MESSAGE_MAX = 500;
const TEXT_MAX = 900;
const LINK_TTL_MS = 10 * 60_000;
const RING_TIMEOUT_S = 30;
const EXTERNAL_NUMBER = /^\+?[0-9]{6,15}$/;
const CHANNEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/;

export interface CallSummary {
  id: string;
  peer: string;
  name: string;
  state: string;
  since: string | null;
}

interface PendingAnnouncement {
  text: string;
  media: string;
  file: string;
  to: string;
}

interface RingSession {
  inbound: string;
  legs: Set<string>;
  answered: boolean;
}

export interface TelephonyStatus {
  enabled: boolean;
  connected: boolean;
  version: string | null;
  error: string | null;
  publicHostSet: boolean;
  extensions: Array<{
    id: string;
    name: string;
    kind: ExtensionKind;
    state: "online" | "offline" | "unknown";
  }>;
  trunk: { host: string; configured: true } | { configured: false };
  ringExtensions: string[];
  contacts: { name: string; sip: string; allowConversation: boolean }[];
  allowInternalCallsWithoutConfirmation: boolean;
  voice: "edge" | "piper";
  activeCalls: number;
  rtpRange: string;
  novaExtension: string;
  doorbellExtension: string;
  /** The SIP relay between Asterisk and the trunk (text messages from Linphone); null when it is not in use. */
  sipRelay: RelayStatus | null;
}

/** Telephony on top of Asterisk: status, calls, announcements, inbound alerts and doorbell ringing. */
@Injectable()
export class TelephonyService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("NOVA telephony");
  private readonly events: CallEvent[] = [];
  private readonly pending = new Map<string, PendingAnnouncement>();
  private readonly playbacks = new Map<
    string,
    { channel: string; file?: string }
  >();
  private readonly rings = new Map<string, RingSession>();
  private readonly legToBridge = new Map<string, string>();
  private readonly links = new Map<string, { id: string; expiresAt: number }>();
  private readonly started: number[] = [];
  private offEvents: (() => void) | null = null;
  private relay: SipRelay | null = null;
  private closing = false;
  private relayChain: Promise<void> = Promise.resolve();
  /** Replaced in tests. */
  relaySettings: () => RelaySettings | null = () => relaySettings();
  private files: AnnouncementFiles;
  now = () => Date.now();

  constructor(
    private readonly store: TelephonyStore,
    @Inject(ARI_PORT) private readonly ari: AriPort,
    private readonly state: JarvisStateStore,
    private readonly tts: TtsService,
    @Optional() private readonly decode: AudioDecoder = decodeToPhoneWav,
    @Optional() private readonly conversation?: ConversationService,
  ) {
    this.files = new AnnouncementFiles(this.store.recordingDir);
    // Extension 700 follows the conversation switch, so the dialplan is rewritten when it changes.
    this.conversation?.onChange(() => {
      if (this.enabled) setTimeout(() => this.renderConfig(), 0).unref();
    });
  }

  allowsInternalWithoutConfirmation(): boolean {
    return this.store.get().allowInternalCallsWithoutConfirmation;
  }

  get enabled(): boolean {
    return this.store.get().enabled;
  }

  onModuleInit(): void {
    if (this.enabled) this.activate();
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    this.deactivate();
    await this.syncRelay();
  }

  /** The relay is wanted while telephony is on and a trunk exists (and the stack runs Asterisk next to NOVA). */
  private relayWanted(): { settings: RelaySettings; host: string } | null {
    const config = this.store.get();
    const settings = this.relaySettings();
    if (this.closing || !config.enabled || !config.trunk || !settings)
      return null;
    return { settings, host: config.trunk.host };
  }

  private relayProxy() {
    const wanted = this.relayWanted();
    return wanted
      ? { host: wanted.settings.proxyHost, port: wanted.settings.listenPort }
      : null;
  }

  /** Starts, retargets or stops the relay so it matches the current settings; calls are serialised. */
  syncRelay(): Promise<void> {
    this.relayChain = this.relayChain.then(async () => {
      const wanted = this.relayWanted();
      const current = this.relay;
      if (current && !wanted) {
        this.relay = null;
        await current.stop();
        return;
      }
      if (!wanted) return;
      const { settings, host } = wanted;
      const target = `${host}:${settings.upstreamPort}`;
      const listen = `${settings.listenHost}:${settings.listenPort}`;
      if (
        current &&
        current.status().target === target &&
        current.status().listen === listen &&
        current.status().listening
      )
        return;
      if (current) {
        this.relay = null;
        await current.stop();
      }
      const relay = new SipRelay({
        listen: { host: settings.listenHost, port: settings.listenPort },
        target: { host, port: settings.upstreamPort },
        proxy: { host: settings.proxyHost, port: settings.listenPort },
        allow: peerAllowlist(settings.allow),
        logger: this.log,
      });
      this.relay = relay;
      try {
        await relay.start();
      } catch {
        this.log.warn(
          "SIP relay could not start; text messages will not arrive",
        );
      }
    });
    return this.relayChain;
  }

  private activate(): void {
    this.renderConfig();
    void this.syncRelay();
    this.offEvents ??= this.ari.onEvent((event) => {
      void this.handle(event).catch(() => this.log.warn("ARI event failed"));
    });
    void this.ari.start();
  }

  private deactivate(): void {
    this.offEvents?.();
    this.offEvents = null;
    this.ari.stop();
  }

  // ---- configuration -------------------------------------------------------------------

  /** Writes the generated Asterisk files; the container's sync loop reloads them. */
  renderConfig(): void {
    this.store.writeConf(
      renderAll(
        this.store.get(),
        rtpRangeFromEnv(),
        this.conversation?.dialplan() ?? null,
        process.env.NOVA_ASTERISK_MESSAGE_URL?.trim() || DEFAULT_MESSAGE_URL,
        this.relayProxy(),
      ),
    );
  }

  private commit(change: (draft: ReturnType<TelephonyStore["get"]>) => void) {
    const next = this.store.update(change);
    if (next.enabled) this.renderConfig();
    void this.syncRelay();
    return next;
  }

  setEnabled(enabled: boolean): void {
    this.commit((draft) => {
      draft.enabled = enabled;
    });
    if (enabled) this.activate();
    else this.deactivate();
  }

  setPublicHost(host: string): void {
    if (!validHost(host)) throw new TelephonyError("Ongeldige hostnaam of IP.");
    this.commit((draft) => {
      draft.publicHost = host;
    });
  }

  setPolicy(input: {
    allowInternalCallsWithoutConfirmation?: boolean;
    voice?: "edge" | "piper";
    ringExtensions?: string[];
  }): void {
    this.commit((draft) => {
      if (typeof input.allowInternalCallsWithoutConfirmation === "boolean")
        draft.allowInternalCallsWithoutConfirmation =
          input.allowInternalCallsWithoutConfirmation;
      if (input.voice === "edge" || input.voice === "piper")
        draft.voice = input.voice;
      if (input.ringExtensions) {
        const known = new Set(
          draft.extensions.filter((e) => e.kind === "phone").map((e) => e.id),
        );
        const ring = [...new Set(input.ringExtensions)];
        if (ring.some((id) => !known.has(id)))
          throw new TelephonyError("Onbekend toestel in de belgroep.");
        draft.ringExtensions = ring;
      }
    });
  }

  setTrunk(input: (Omit<Trunk, "secret"> & { secret?: string }) | null): void {
    this.commit((draft) => {
      if (!input) {
        draft.trunk = null;
        draft.contacts = [];
        return;
      }
      const secret = input.secret ?? draft.trunk?.secret ?? "";
      if (!validHost(input.host) || !validUser(input.username))
        throw new TelephonyError("Ongeldige trunkhost of gebruikersnaam.");
      if (!validSecret(secret))
        throw new TelephonyError(
          "Ongeldig trunkwachtwoord (8-128 tekens, geen ; = # [ ] \" ' of \\).",
        );
      // Contacts live on the trunk's domain; a changed trunk host leaves them unreachable, so they are dropped.
      draft.contacts = (draft.contacts ?? []).filter(
        (c) => c.sip.split("@")[1]?.toLowerCase() === input.host.toLowerCase(),
      );
      draft.trunk = {
        host: input.host,
        username: input.username,
        secret,
        number: /^\+?[0-9]{0,15}$/.test(input.number) ? input.number : "",
        allowExtensionsToDialOut: input.allowExtensionsToDialOut === true,
      };
    });
  }

  addExtension(name: string, kind: ExtensionKind = "phone"): Extension {
    let created!: Extension;
    this.commit((draft) => {
      if (draft.extensions.length >= MAX_EXTENSIONS)
        throw new TelephonyError("Het maximum aantal toestellen is bereikt.");
      const used = new Set(draft.extensions.map((e) => e.id));
      const base = kind === "doorbell" ? 801 : 101;
      let id = base;
      while (used.has(String(id)) || !validExtensionId(String(id))) id++;
      created = {
        id: String(id),
        name: safeName(name),
        kind,
        secret: randomSecret(),
        createdAt: new Date(this.now()).toISOString(),
      };
      draft.extensions.push(created);
    });
    return created;
  }

  removeExtension(id: string): boolean {
    let removed = false;
    this.commit((draft) => {
      const before = draft.extensions.length;
      draft.extensions = draft.extensions.filter((e) => e.id !== id);
      draft.ringExtensions = draft.ringExtensions.filter((e) => e !== id);
      removed = draft.extensions.length !== before;
    });
    for (const [token, link] of this.links)
      if (link.id === id) this.links.delete(token);
    return removed;
  }

  /** Public view without any secret. */
  listExtensions(): Array<
    Pick<Extension, "id" | "name" | "kind" | "createdAt">
  > {
    return this.store.get().extensions.map(({ id, name, kind, createdAt }) => ({
      id,
      name,
      kind,
      createdAt,
    }));
  }

  // ---- Linphone provisioning -----------------------------------------------------------

  linphoneXml(id: string): string {
    const config = this.store.get();
    const extension = config.extensions.find((e) => e.id === id);
    if (!extension) throw new TelephonyError("Onbekend toestel.");
    if (!config.publicHost)
      throw new TelephonyError(
        "Stel eerst het adres in waarmee telefoons Asterisk bereiken.",
      );
    return linphoneProvisioning(extension, config.publicHost);
  }

  /** One-time link (10 minutes) so a phone can fetch the provisioning file without the NOVA login. */
  createProvisioningLink(id: string): { token: string; expiresAt: string } {
    this.linphoneXml(id); // validates the extension and public host
    const token = crypto.randomBytes(24).toString("base64url");
    const expiresAt = this.now() + LINK_TTL_MS;
    for (const [key, link] of this.links)
      if (link.expiresAt <= this.now()) this.links.delete(key);
    this.links.set(hash(token), { id, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Consumes the one-time token. */
  redeemProvisioningLink(token: string): string | null {
    const key = hash(token);
    const link = this.links.get(key);
    this.links.delete(key);
    if (!link || link.expiresAt <= this.now()) return null;
    try {
      return this.linphoneXml(link.id);
    } catch {
      return null;
    }
  }

  // ---- status and calls ----------------------------------------------------------------

  async status(): Promise<TelephonyStatus> {
    const config = this.store.get();
    const base: TelephonyStatus = {
      enabled: config.enabled,
      connected: false,
      version: null,
      error: null,
      publicHostSet: Boolean(config.publicHost),
      extensions: config.extensions.map((e) => ({
        id: e.id,
        name: e.name,
        kind: e.kind,
        state: "unknown",
      })),
      trunk: config.trunk
        ? { host: config.trunk.host, configured: true }
        : { configured: false },
      ringExtensions: config.ringExtensions,
      contacts: (config.contacts ?? []).map((c) => ({ ...c })),
      allowInternalCallsWithoutConfirmation:
        config.allowInternalCallsWithoutConfirmation,
      voice: config.voice,
      activeCalls: 0,
      rtpRange: `${rtpRangeFromEnv().start}-${rtpRangeFromEnv().end}/udp`,
      novaExtension: NOVA_EXTENSION,
      doorbellExtension: DOORBELL_EXTENSION,
      sipRelay: this.relay?.status() ?? null,
    };
    if (!config.enabled) return base;
    try {
      const [info, endpoints, channels] = await Promise.all([
        this.ari.info(),
        this.ari.endpoints(),
        this.ari.channels(),
      ]);
      const byId = new Map(endpoints.map((e) => [e.resource, e.state]));
      base.connected = true;
      base.version = info.version;
      base.activeCalls = channels.length;
      for (const extension of base.extensions)
        extension.state = byId.get(extension.id) ?? "unknown";
    } catch (error) {
      base.error =
        error instanceof TelephonyError
          ? error.message
          : "Asterisk is niet bereikbaar.";
    }
    return base;
  }

  async listCalls(): Promise<CallSummary[]> {
    this.requireEnabled();
    const channels = await this.ari.channels();
    return channels.map((c) => ({
      id: c.id,
      peer: plain(c.caller?.number || c.connected?.number, 40),
      name: plain(c.caller?.name, 40),
      state: c.state,
      since: c.creationtime ?? null,
    }));
  }

  recentEvents(): CallEvent[] {
    return [...this.events];
  }

  /** Resolves who a call goes to and whether it is internal. */
  classify(raw: unknown): {
    kind: "internal" | "external";
    number: string;
    endpoint: string;
  } | null {
    const to =
      typeof raw === "string" ? raw.trim().replaceAll(/[\s-]/g, "") : "";
    const config = this.store.get();
    if (validExtensionId(to)) {
      const extension = config.extensions.find((e) => e.id === to);
      return extension?.kind === "phone"
        ? { kind: "internal", number: to, endpoint: `PJSIP/${to}` }
        : null;
    }
    if (EXTERNAL_NUMBER.test(to) && !validExtensionId(to))
      return { kind: "external", number: to, endpoint: `PJSIP/${to}@trunk` };
    // A named contact ("Dylan"), its address ("user@sip.linphone.org") or "sip:user@domain".
    const wanted =
      typeof raw === "string"
        ? raw.trim().replace(/^sip:/i, "").toLowerCase()
        : "";
    const contacts = config.contacts ?? [];
    // "me" / "mij" means the one saved contact, and only when there is exactly one.
    const contact =
      wanted === "me"
        ? contacts.length === 1
          ? contacts[0]
          : undefined
        : contacts.find(
            (c) =>
              c.name.toLowerCase() === wanted || c.sip.toLowerCase() === wanted,
          );
    if (contact)
      return {
        kind: "external",
        number: contact.name,
        endpoint: `PJSIP/${contactUser(contact.sip)}@trunk`,
      };
    return null;
  }

  /** Is this (already normalised) name one of the saved contacts? */
  isContact(name: string): boolean {
    return (this.store.get().contacts ?? []).some(
      (c) => c.name.toLowerCase() === name.toLowerCase(),
    );
  }

  /** Saved contacts that may talk with NOVA ("Mag met NOVA praten"): the only ones she texts on her own initiative. */
  conversationContacts(): string[] {
    return (this.store.get().contacts ?? [])
      .filter((c) => c.allowConversation)
      .map((c) => c.name);
  }

  /** Can a text go out right now? Telephony on, a trunk set, Asterisk reachable and the trunk not reported offline. */
  async textReady(): Promise<{ ready: boolean; reason?: string }> {
    const config = this.store.get();
    if (!config.enabled) return { ready: false, reason: "telefonie staat uit" };
    if (!config.trunk)
      return { ready: false, reason: "er is geen SIP-trunk ingesteld" };
    try {
      const endpoints = await this.ari.endpoints();
      // Asterisk reports "offline" while the trunk registration fails; "unknown" is common before the first qualify.
      if (endpoints.find((e) => e.resource === "trunk")?.state === "offline")
        return { ready: false, reason: "de trunk is niet geregistreerd" };
      return { ready: true };
    } catch {
      return { ready: false, reason: "Asterisk is niet bereikbaar" };
    }
  }

  /** Sends a text (SIP MESSAGE) to a saved contact through the trunk. */
  async sendText(contactName: unknown, body: unknown): Promise<void> {
    this.requireEnabled();
    const config = this.store.get();
    if (!config.trunk)
      throw new TelephonyError("Voor berichten is een SIP-trunk nodig.");
    const wanted =
      typeof contactName === "string" ? contactName.trim().toLowerCase() : "";
    const contact = (config.contacts ?? []).find(
      (c) => c.name.toLowerCase() === wanted,
    );
    if (!contact) throw new TelephonyError("Onbekend contact.");
    const text = sanitize(typeof body === "string" ? body : "").trim();
    if (!text) throw new TelephonyError("Het bericht is leeg.");
    await this.ari.sendMessage({
      to: `pjsip:trunk/sip:${contact.sip}`,
      from: `sip:${config.trunk.username}@${config.trunk.host}`,
      body: text.slice(0, TEXT_MAX),
    });
  }

  /** Replaces the contact list; every contact must live on the trunk's domain. */
  setContacts(input: unknown): void {
    if (!Array.isArray(input))
      throw new TelephonyError("Ongeldige contactenlijst.");
    const contacts = input.map((c) => ({
      name: String((c as Contact)?.name ?? "").trim(),
      sip: String((c as Contact)?.sip ?? "")
        .trim()
        .replace(/^sip:/i, ""),
      allowConversation: (c as Contact)?.allowConversation === true,
    }));
    this.commit((draft) => {
      const next = { ...draft, contacts };
      assertValid(next);
      draft.contacts = contacts;
    });
  }

  /** Calls someone and speaks the message when they answer. */
  async call(
    to: unknown,
    message: unknown,
    options: { conversation?: boolean } = {},
  ): Promise<{ callId: string; to: string; kind: "internal" | "external" }> {
    this.requireEnabled();
    const target = this.classify(to);
    if (!target)
      throw new TelephonyError("Onbekend toestel of ongeldig nummer.");
    if (target.kind === "external" && !this.store.get().trunk)
      throw new TelephonyError(
        "Voor externe nummers is een SIP-trunk nodig; die is niet ingesteld.",
      );
    const text = sanitize(typeof message === "string" ? message : "").trim();
    if (!text || text.length > MESSAGE_MAX)
      throw new TelephonyError(
        `Het bericht moet 1-${MESSAGE_MAX} tekens zijn.`,
      );
    this.requireRate();
    const channels = await this.ari.channels();
    if (channels.length >= MAX_CONCURRENT_CALLS)
      throw new TelephonyError("Er lopen al te veel gesprekken tegelijk.");
    if (options.conversation) return this.callAndTalk(target, text);
    const prepared = await this.prepareAnnouncement(text);
    const token = crypto.randomBytes(12).toString("hex");
    this.pending.set(token, { text, ...prepared, to: target.number });
    const trunk = this.store.get().trunk;
    try {
      const channel = await this.ari.originate({
        endpoint: target.endpoint,
        app: ARI_APP,
        appArgs: `announce,${token}`,
        callerId:
          target.kind === "external" && trunk?.number
            ? trunk.number
            : `NOVA <${NOVA_EXTENSION}>`,
        timeoutSeconds: RING_TIMEOUT_S,
      });
      this.started.push(this.now());
      this.push({ type: "outbound", channelId: channel.id, to: target.number });
      return { callId: channel.id, to: target.number, kind: target.kind };
    } catch (error) {
      this.pending.delete(token);
      this.files.remove(prepared.file);
      throw error;
    }
  }

  /** Calls someone and, once they answer, has a real spoken conversation that opens with `opening`. */
  private async callAndTalk(
    target: { kind: "internal" | "external"; number: string; endpoint: string },
    opening: string,
  ): Promise<{ callId: string; to: string; kind: "internal" | "external" }> {
    if (!this.conversation?.dialplan())
      throw new TelephonyError(
        "Gesprekken staan uit. Zet ze aan bij Instellingen, Gesprekken, en bel dan opnieuw.",
      );
    const unavailable = this.conversation.sttProblem();
    if (unavailable) throw new TelephonyError(unavailable);
    const trunk = this.store.get().trunk;
    this.conversation.expectOutbound(opening);
    try {
      const channel = await this.ari.originate({
        endpoint: target.endpoint,
        context: "nova-converse",
        extension: "s",
        callerId:
          target.kind === "external" && trunk?.number
            ? trunk.number
            : `NOVA <${NOVA_EXTENSION}>`,
        timeoutSeconds: RING_TIMEOUT_S,
      });
      this.started.push(this.now());
      this.push({ type: "outbound", channelId: channel.id, to: target.number });
      return { callId: channel.id, to: target.number, kind: target.kind };
    } catch (error) {
      this.conversation.cancelOutbound();
      throw error;
    }
  }

  async hangup(callId: unknown): Promise<void> {
    this.requireEnabled();
    if (typeof callId !== "string" || !CHANNEL_ID.test(callId))
      throw new TelephonyError("Ongeldig gesprek-id.");
    const known = (await this.ari.channels()).some((c) => c.id === callId);
    if (!known) throw new TelephonyError("Dat gesprek loopt niet meer.");
    await this.ari.hangup(callId);
  }

  private requireEnabled(): void {
    if (!this.enabled) throw new TelephonyError("Telefonie staat uit.");
  }

  private requireRate(): void {
    const cutoff = this.now() - 3_600_000;
    while (this.started.length && this.started[0]! < cutoff)
      this.started.shift();
  }

  private async prepareAnnouncement(
    text: string,
  ): Promise<{ media: string; file: string }> {
    const voice = this.store.get().voice;
    // Piper stays a deliberate choice on the phone page; otherwise the voice saved in Settings is used.
    const speech = await this.tts.speakProfile(text, {
      piper: voice === "piper",
    });
    const wav = await this.decode(speech.audio, speech.contentType);
    return this.files.write(wav);
  }

  // ---- events --------------------------------------------------------------------------

  private push(event: Omit<CallEvent, "at">): void {
    this.events.push({ at: new Date(this.now()).toISOString(), ...event });
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  private alert(
    title: string,
    severity: "info" | "warning" | "critical",
    detail: string,
  ): void {
    const time = new Date(this.now()).toLocaleTimeString("nl-NL", {
      hour: "2-digit",
      minute: "2-digit",
    });
    this.state.emit({
      topic: "jarvis/alerts",
      payload: {
        title,
        detail: `${detail} (${time})`.slice(0, 240),
        severity,
        key: "telephony",
        at: new Date(this.now()).toISOString(),
      },
    });
  }

  private caller(channel?: AriChannel): string {
    const number = plain(channel?.caller?.number, 32);
    const name = plain(channel?.caller?.name, 40);
    return name && number
      ? `${name} (${number})`
      : name || number || "onbekend";
  }

  async handle(event: AriEvent): Promise<void> {
    const channel = event.channel;
    if (event.type === "StasisStart" && channel) {
      const [kind = "", arg = ""] = event.args ?? [];
      if (kind === "announce") return this.onAnnounce(channel, arg);
      if (kind === "inbound") return this.onInbound(channel);
      if (kind === "doorbell") return this.onRing(channel, "doorbell");
      if (kind === "external") return this.onRing(channel, "external");
      if (kind === "ring") return this.onLegAnswered(channel, arg);
      return;
    }
    if (event.type === "PlaybackFinished" && event.playback) {
      const playback = this.playbacks.get(event.playback.id);
      if (!playback) return;
      this.playbacks.delete(event.playback.id);
      if (playback.file) this.files.remove(playback.file);
      await this.ari.hangup(playback.channel).catch(() => undefined);
      return;
    }
    if (
      (event.type === "ChannelDestroyed" || event.type === "StasisEnd") &&
      channel
    ) {
      await this.onGone(channel, event.type === "ChannelDestroyed");
    }
  }

  private async onAnnounce(channel: AriChannel, token: string): Promise<void> {
    const announcement = this.pending.get(token);
    this.pending.delete(token);
    this.push({
      type: "answered",
      channelId: channel.id,
      to: announcement?.to,
    });
    if (!announcement) {
      await this.ari.hangup(channel.id).catch(() => undefined);
      return;
    }
    try {
      const playback = await this.ari.play(channel.id, announcement.media);
      this.playbacks.set(playback.id, {
        channel: channel.id,
        file: announcement.file,
      });
      this.push({
        type: "announcement",
        channelId: channel.id,
        to: announcement.to,
      });
    } catch {
      this.files.remove(announcement.file);
      this.push({
        type: "error",
        channelId: channel.id,
        detail: "play failed",
      });
      await this.ari.hangup(channel.id).catch(() => undefined);
    }
  }

  private async onInbound(channel: AriChannel): Promise<void> {
    const from = this.caller(channel);
    this.push({ type: "inbound", channelId: channel.id, from });
    this.alert("Inkomend gesprek voor NOVA", "info", `Van ${from}`);
    try {
      await this.ari.answer(channel.id);
      const prepared = await this.prepareAnnouncement(
        "Je spreekt met NOVA. Praten via de telefoon is nog niet beschikbaar. Gebruik de chat of de spraakknop in de app. Tot ziens.",
      );
      const playback = await this.ari.play(channel.id, prepared.media);
      this.playbacks.set(playback.id, {
        channel: channel.id,
        file: prepared.file,
      });
    } catch {
      await this.ari.hangup(channel.id).catch(() => undefined);
    }
  }

  /** Doorbell or inbound external call: alert, ring the configured phones, bridge the first to answer. */
  private async onRing(
    channel: AriChannel,
    kind: "doorbell" | "external",
  ): Promise<void> {
    const from = this.caller(channel);
    this.push({
      type: kind === "doorbell" ? "doorbell" : "inbound",
      channelId: channel.id,
      from,
    });
    if (kind === "doorbell")
      this.alert("Er wordt aangebeld", "critical", `Deurbel: ${from}`);
    else this.alert("Inkomend extern gesprek", "warning", `Van ${from}`);
    const config = this.store.get();
    const targets = config.ringExtensions.filter((id) =>
      config.extensions.some((e) => e.id === id && e.kind === "phone"),
    );
    if (!targets.length) {
      await this.ari.hangup(channel.id).catch(() => undefined);
      return;
    }
    try {
      const bridge = await this.ari.createBridge();
      const session: RingSession = {
        inbound: channel.id,
        legs: new Set(),
        answered: false,
      };
      this.rings.set(bridge.id, session);
      this.legToBridge.set(channel.id, bridge.id);
      for (const id of targets) {
        try {
          const leg = await this.ari.originate({
            endpoint: `PJSIP/${id}`,
            app: ARI_APP,
            appArgs: `ring,${bridge.id}`,
            callerId: `${kind === "doorbell" ? "Deurbel" : "Extern"} <${DOORBELL_EXTENSION}>`,
            timeoutSeconds: RING_TIMEOUT_S,
          });
          session.legs.add(leg.id);
          this.legToBridge.set(leg.id, bridge.id);
        } catch {
          /* one unreachable phone must not stop the others */
        }
      }
      if (!session.legs.size) await this.endRing(bridge.id);
    } catch {
      await this.ari.hangup(channel.id).catch(() => undefined);
    }
  }

  private async onLegAnswered(
    channel: AriChannel,
    bridgeId: string,
  ): Promise<void> {
    const session = this.rings.get(bridgeId);
    if (!session || session.answered) {
      await this.ari.hangup(channel.id).catch(() => undefined);
      return;
    }
    session.answered = true;
    try {
      await this.ari.answer(session.inbound);
      await this.ari.addToBridge(bridgeId, session.inbound);
      await this.ari.addToBridge(bridgeId, channel.id);
    } catch {
      await this.endRing(bridgeId);
      return;
    }
    this.push({
      type: "answered",
      channelId: channel.id,
      from: this.caller(channel),
    });
    for (const leg of session.legs)
      if (leg !== channel.id) await this.ari.hangup(leg).catch(() => undefined);
  }

  private async endRing(bridgeId: string): Promise<void> {
    const session = this.rings.get(bridgeId);
    if (!session) return;
    this.rings.delete(bridgeId);
    this.legToBridge.delete(session.inbound);
    for (const leg of session.legs) {
      this.legToBridge.delete(leg);
      await this.ari.hangup(leg).catch(() => undefined);
    }
    await this.ari.hangup(session.inbound).catch(() => undefined);
    await this.ari.destroyBridge(bridgeId).catch(() => undefined);
  }

  private async onGone(channel: AriChannel, destroyed: boolean): Promise<void> {
    const bridgeId = this.legToBridge.get(channel.id);
    if (bridgeId) {
      const session = this.rings.get(bridgeId);
      if (session) {
        session.legs.delete(channel.id);
        const inboundGone = session.inbound === channel.id;
        if (inboundGone || (!session.answered && !session.legs.size))
          await this.endRing(bridgeId);
        else if (session.answered && destroyed) await this.endRing(bridgeId);
      }
      this.legToBridge.delete(channel.id);
    }
    if (destroyed)
      this.push({ type: "ended", channelId: channel.id, detail: "ended" });
  }
}

/** Text from the phone network is shown as plain text: no control characters, bounded. */
const plain = (value: unknown, max: number): string =>
  typeof value === "string"
    ? [...value]
        .filter((char) => {
          const code = char.codePointAt(0) ?? 0;
          return code > 31 && code !== 127 && char !== "<" && char !== ">";
        })
        .join("")
        .trim()
        .slice(0, max)
    : "";

const hash = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");
