import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  shell: { awaiting: false, wakeActive: false },
  chat: { busy: false },
  startListening: vi.fn(),
  startAwait: vi.fn(),
  cancelAwait: vi.fn(),
}));
vi.mock("#lib/stores/chat.svelte.ts", () => ({ chat: mocks.chat }));
vi.mock("#lib/stores/shell.svelte.ts", () => ({ shell: mocks.shell }));
vi.mock("./speaker.ts", () => ({
  isSpeaking: () => false,
  stopSpeech: vi.fn(),
}));
vi.mock("#lib/chat/ask.ts", () => ({ cancelActiveAsk: vi.fn() }));
vi.mock("./recognition.ts", () => ({
  startListening: mocks.startListening,
  finishListening: vi.fn(),
}));
vi.mock("./wake.ts", () => ({
  startAwait: mocks.startAwait,
  cancelAwait: mocks.cancelAwait,
}));
import { beginPushToTalk } from "./core.ts";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.shell.wakeActive = false;
  mocks.shell.awaiting = false;
});
describe("push to talk microphone ownership", () => {
  it("uses the running wake recognizer instead of opening a competing microphone session", () => {
    mocks.shell.wakeActive = true;
    beginPushToTalk();
    expect(mocks.startAwait).toHaveBeenCalledOnce();
    expect(mocks.startListening).not.toHaveBeenCalled();
  });
  it("starts explicit recognition when no wake recognizer owns the microphone", () => {
    beginPushToTalk();
    expect(mocks.startListening).toHaveBeenCalledOnce();
    expect(mocks.startAwait).not.toHaveBeenCalled();
  });
});
