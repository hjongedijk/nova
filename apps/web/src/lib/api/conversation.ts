import { getJson, sendJson } from "./client.ts";

export interface ConversationSettings {
  version: 1;
  enabled: boolean;
  language: "nl" | "en";
  greeting: string;
  idleSeconds: number;
  maxMinutes: number;
}
export interface ConversationStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  dialTarget: string;
  speechToText: {
    ready: boolean;
    problem: string | null;
    model: string | null;
    mode: string;
  };
  active: {
    id: string;
    state: string;
    turns: number;
    seconds: number;
  } | null;
  calls: number;
}
export interface ConversationOverview {
  settings: ConversationSettings;
  status: ConversationStatus;
}

const headers = (): Record<string, string> => {
  return {};
};

export const getConversation = () =>
  getJson<ConversationOverview>("/settings/conversation", {
    headers: headers(),
  });
export const saveConversation = (patch: Partial<ConversationSettings>) =>
  sendJson<ConversationOverview>(
    "PUT",
    "/settings/conversation",
    patch,
    headers(),
  );
export const hangUpConversation = () =>
  sendJson<{ hungUp: boolean }>(
    "POST",
    "/settings/conversation/hangup",
    {},
    headers(),
  );
