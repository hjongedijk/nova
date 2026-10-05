/** What the header's status dot and the routing notice read from GET /api/health. */
export interface NovaStatus {
  ok: boolean;
  omnirouteConfigured?: boolean;
  /** `ready: false` means no verified free AI route is available. */
  routing?: { ready?: boolean };
}

/** POST /api/actions/confirm answers with the sentence NOVA says about the result. */
export interface ConfirmResult {
  ok?: boolean;
  reply: string;
}

/** The SSE `connected` event that opens POST /api/chat-stream. */
export interface ChatConnected {
  ok: true;
  sessionId: string;
}
