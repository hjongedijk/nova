import type {
  AriChannel,
  AriEndpoint,
  AriEvent,
  AriPort,
} from "../../src/telephony/telephony.types.js";

/** In-memory ARI that records every command, for tests. */
export class FakeAri implements AriPort {
  up = true;
  version = "22.11.0";
  endpointList: AriEndpoint[] = [];
  channelList: AriChannel[] = [];
  commands: Array<{ op: string; [key: string]: unknown }> = [];
  failOriginate = false;
  private handlers = new Set<(event: AriEvent) => void>();
  private counter = 0;

  connected() {
    return this.up;
  }
  async start() {
    this.commands.push({ op: "start" });
  }
  stop() {
    this.commands.push({ op: "stop" });
  }
  async info() {
    if (!this.up) throw new Error("down");
    return { version: this.version };
  }
  async endpoints() {
    return this.endpointList;
  }
  async channels() {
    return this.channelList;
  }
  async originate(input: {
    endpoint: string;
    app: string;
    appArgs: string;
    callerId?: string;
    timeoutSeconds?: number;
  }) {
    if (this.failOriginate) throw new Error("rejected");
    const channel: AriChannel = {
      id: `chan-${++this.counter}`,
      name: input.endpoint,
      state: "Down",
      caller: { name: "NOVA", number: "700" },
    };
    this.channelList.push(channel);
    this.commands.push({ op: "originate", ...input, id: channel.id });
    return channel;
  }
  async hangup(channelId: string) {
    this.commands.push({ op: "hangup", channelId });
    this.channelList = this.channelList.filter((c) => c.id !== channelId);
  }
  async answer(channelId: string) {
    this.commands.push({ op: "answer", channelId });
  }
  async play(channelId: string, media: string) {
    const id = `play-${++this.counter}`;
    this.commands.push({ op: "play", channelId, media, id });
    return { id };
  }
  async createBridge() {
    const id = `bridge-${++this.counter}`;
    this.commands.push({ op: "createBridge", id });
    return { id };
  }
  async addToBridge(bridgeId: string, channelId: string) {
    this.commands.push({ op: "addToBridge", bridgeId, channelId });
  }
  async destroyBridge(bridgeId: string) {
    this.commands.push({ op: "destroyBridge", bridgeId });
  }
  onEvent(handler: (event: AriEvent) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  async emit(event: AriEvent) {
    for (const handler of this.handlers) handler(event);
  }
  ops(op: string) {
    return this.commands.filter((c) => c.op === op);
  }
}
