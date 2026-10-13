import { sendJson } from "./client.ts";

export interface SavedQuickNote {
  id: string;
  title: string;
  createdAt: string;
}

export const saveQuickNote = (content: string) =>
  sendJson<SavedQuickNote>("POST", "/notes/quick", { content });
