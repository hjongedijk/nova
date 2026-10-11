import type { ChatAttachment } from "@nova/contracts";
import { getJson, sendJson } from "./client.ts";

export interface IndexedDocument {
  id: string;
  name: string;
  chunks: number;
  createdAt: string;
}

export interface DocumentSearchHit {
  documentId: string;
  name: string;
  text: string;
  score: number;
  chunk: number;
}

export const listDocuments = () =>
  getJson<{ configured: boolean; documents: IndexedDocument[] }>("/documents");

export const indexDocuments = (attachments: ChatAttachment[]) =>
  sendJson<{ documents: IndexedDocument[]; truncated: boolean }>(
    "POST",
    "/documents/index",
    { attachments },
  );

export const searchDocuments = (query: string) =>
  sendJson<{
    results: DocumentSearchHit[];
    count: number;
    untrusted: true;
  }>("POST", "/documents/search", { query });
