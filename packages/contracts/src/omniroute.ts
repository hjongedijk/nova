export interface NativeGatewayReport {
  available: boolean;
  error?: string;
  truncated: boolean;
  skills: {
    id: string;
    name: string;
    version: string;
    scope: "nova" | "global";
    enabled: boolean | null;
    mode: "on" | "off" | "auto" | null;
  }[];
  documentation: { id: string; name: string; description: string }[];
  prompt: {
    enabled: boolean | null;
    prefixCharacters: number | null;
    suffixCharacters: number | null;
  };
}

export interface NativeSkillDocument {
  available: boolean;
  error?: string;
  id?: string;
  name?: string;
  documentation?: string;
}
import type { PendingConfirmation } from "./chat.js";

export type NativeSkillMode = "on" | "off" | "auto";
export interface NativeSkillModePrepared {
  ok: boolean;
  error?: string;
  name?: string;
  action?: PendingConfirmation;
}
export interface NativeSkillModeResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  mode?: NativeSkillMode;
  enabled?: boolean;
  auditWarning?: string;
}

export interface NativePromptReplacement {
  enabled: boolean;
  prefixPrompt: string;
  suffixPrompt: string;
  acknowledgeGlobal: true;
}
export interface NativePromptPrepared {
  ok: boolean;
  error?: string;
  action?: PendingConfirmation;
}
export interface NativePromptResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  auditWarning?: string;
}

export interface OmniRouteAccountsReport {
  available: boolean;
  error?: string;
  truncated: boolean;
  connections: {
    id: string;
    provider: string;
    name: string;
    active: boolean | null;
    credentialPresent: boolean;
  }[];
  models: {
    provider: string;
    modelId: string;
    name: string;
    freeType: string;
    monthlyTokens: number | null;
    creditTokens: number | null;
  }[];
  billingVerified: false;
}
