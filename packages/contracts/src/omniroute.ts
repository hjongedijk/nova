import type { PendingConfirmation } from "./chat.js";

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
  memory: {
    enabled: boolean | null;
    backend: string | null;
    maxTokens: number | null;
  };
}

export interface NativeMemoryPrepared {
  ok: boolean;
  error?: string;
  enabled?: boolean;
  action?: PendingConfirmation;
}
export interface NativeMemoryResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  enabled?: boolean;
  auditWarning?: string;
}
export interface NativeMemoryRevision {
  id: string;
  at: string;
  before: boolean;
  after: boolean;
  revertedFrom?: string;
}
export interface NativeMemoryHistory {
  revisions: NativeMemoryRevision[];
  truncated: boolean;
}

export interface NativeMemoryRecords {
  memories: {
    id: string;
    text: string;
    created_at?: string;
    updated_at?: string;
  }[];
  next: number | null;
  error?: string;
}
export interface NativeMemoryRecordPrepared {
  ok: boolean;
  error?: string;
  action?: PendingConfirmation;
}
export interface NativeMemoryRecordsDeletePrepared extends NativeMemoryRecordPrepared {
  count?: number;
}
export interface NativeMemoryRecordResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
}

export interface NativeSkillDocument {
  available: boolean;
  error?: string;
  id?: string;
  name?: string;
  documentation?: string;
}
export type NativeSkillMode = "on" | "off" | "auto";
export interface NativeSkillModePrepared {
  ok: boolean;
  error?: string;
  name?: string;
  scope?: "nova" | "global";
  action?: PendingConfirmation;
}
export interface NativeSkillModeResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  mode?: NativeSkillMode;
  enabled?: boolean;
  auditWarning?: string;
  historyWarning?: string;
}
export interface NativeSkillModeRevision {
  id: string;
  at: string;
  before: NativeSkillMode;
  after: NativeSkillMode;
  scope: "nova" | "global";
  revertedFrom?: string;
}
export interface NativeSkillModeHistory {
  revisions: NativeSkillModeRevision[];
  truncated: boolean;
}

export interface NativeSkillRemovalPrepared {
  ok: boolean;
  error?: string;
  name?: string;
  action?: PendingConfirmation;
}
export interface NativeSkillRemovalResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
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
export interface NativePromptRevision {
  id: string;
  at: string;
  before: Omit<NativePromptReplacement, "acknowledgeGlobal">;
  after: Omit<NativePromptReplacement, "acknowledgeGlobal">;
}
export interface NativePromptHistory {
  revisions: NativePromptRevision[];
  truncated: boolean;
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
  combos: {
    id: string;
    name: string;
    displayName: string;
    active: boolean | null;
    strategy: string;
    models: string[];
  }[];
  billingVerified: false;
}

export interface OmniRouteApiKeyInventory {
  available: boolean;
  error?: string;
  truncated: boolean;
  keys: {
    id: string;
    name: string;
    active: boolean | null;
    isNovaKey: boolean;
    accessMode: "restricted" | "all" | "unknown";
    allowedModelCount: number | null;
    allowedComboCount: number | null;
    allowedConnectionCount: number | null;
    expiresAt: string | null;
  }[];
}

export interface OmniRouteKeyModelAccessOptions {
  available: boolean;
  error?: string;
  accessMode: "restricted" | "all" | "unknown";
  allowedModels: string[];
  verifiedFreeModels: string[];
  revision: string | null;
}
export interface OmniRouteKeyModelAccessHistory {
  revisions: {
    id: string;
    at: string;
    keyId: string;
    name: string;
    beforeMode: "all" | "restricted";
    beforeModels: string[];
    afterMode: "all" | "restricted";
    afterModels: string[];
    revertedFrom?: string;
  }[];
  truncated: boolean;
}

export interface OmniRouteKeyModelAccessPrepared {
  ok: true;
  name: string;
  modelCount: number;
  warning?: string;
  action: PendingConfirmation;
}
export type OmniRouteKeyModelAccessPrepareResult =
  OmniRouteKeyModelAccessPrepared | { ok: false; error: string };

export interface OmniRouteKeyModelAccessResult {
  ok: boolean;
  cancelled?: boolean;
  verified?: boolean | null;
  routeReady?: boolean;
  allowedModels?: string[];
  historyWarning?: string;
  error?: string;
}

export interface OmniRouteKeyActivationPrepared {
  ok: true;
  name: string;
  currentEnabled: boolean;
  enabled: boolean;
  action: PendingConfirmation;
}
export type OmniRouteKeyActivationPrepareResult =
  OmniRouteKeyActivationPrepared | { ok: false; error: string };
export interface OmniRouteKeyActivationResult {
  ok: boolean;
  verified?: boolean | null;
  enabled?: boolean;
  routeReady?: boolean;
  auditWarning?: string;
  historyWarning?: string;
  error?: string;
}

export interface OmniRouteModelVisibilityReport {
  available: boolean;
  error?: string;
  truncated: boolean;
  hidden: { provider: string; modelId: string }[];
}

export interface OmniRouteUsageReport {
  available: boolean;
  error?: string;
  truncated: boolean;
  intervalMinutes: number | null;
  lastAutoSyncAt: string | null;
  billingVerified: false;
  connections: {
    id: string;
    provider: string;
    name: string;
    fetchedAt: string;
    stale: boolean | null;
    quotas: {
      window: string;
      limit: number | null;
      remaining: number | null;
      remainingPercentage: number | null;
      resetAt: string | null;
      unlimited: boolean | null;
    }[];
  }[];
}

export interface OmniRouteAccountRemovalPrepared {
  ok: boolean;
  error?: string;
  name?: string;
  action?: PendingConfirmation;
}
export interface OmniRouteAccountCreatePrepared {
  ok: boolean;
  error?: string;
  provider?: string;
  name?: string;
  action?: PendingConfirmation;
}
export interface OmniRouteAccountCreateResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  id?: string;
  provider?: string;
  name?: string;
  active?: boolean;
  routeReady?: boolean;
  auditWarning?: string;
}
export interface OmniRouteAccountKeyUpdatePrepared {
  ok: boolean;
  error?: string;
  id?: string;
  provider?: string;
  name?: string;
  action?: PendingConfirmation;
}
export interface OmniRouteAccountKeyUpdateResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  id?: string;
  routeReady?: boolean;
  auditWarning?: string;
}
export interface OmniRouteAccountRenamePrepared {
  ok: boolean;
  error?: string;
  id?: string;
  provider?: string;
  oldName?: string;
  newName?: string;
  action?: PendingConfirmation;
}
export interface OmniRouteAccountRenameHistoryEntry {
  id: string;
  at: string;
  accountId: string;
  provider: string;
  beforeName: string;
  afterName: string;
  revertedFrom?: string;
}
export interface OmniRouteAccountRenameHistory {
  revisions: OmniRouteAccountRenameHistoryEntry[];
}
export interface OmniRouteAccountRenameResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  id?: string;
  provider?: string;
  name?: string;
  auditWarning?: string;
  historyWarning?: string;
}
export interface OmniRouteAccountRemovalResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  routeReady?: boolean;
  auditWarning?: string;
}

export interface OmniRouteComboActivationPrepared {
  ok: boolean;
  error?: string;
  name?: string;
  currentEnabled?: boolean;
  enabled?: boolean;
  action?: PendingConfirmation;
}

export type OmniRouteComboCreatePrepared =
  | {
      ok: true;
      name: string;
      models: string[];
      action: PendingConfirmation;
    }
  | { ok: false; error: string };
export interface OmniRouteComboCreateResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  id?: string;
  name?: string;
  routeReady?: boolean;
  auditWarning?: string;
}
export interface OmniRouteComboRemovalPrepared {
  ok: boolean;
  error?: string;
  name?: string;
  action?: PendingConfirmation;
}
export interface OmniRouteComboRemovalResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  routeReady?: boolean;
  auditWarning?: string;
}
export interface OmniRouteComboUpdatePrepared {
  ok: boolean;
  error?: string;
  name?: string;
  models?: string[];
  action?: PendingConfirmation;
}
export interface OmniRouteComboUpdateHistoryEntry {
  id: string;
  at: string;
  comboId: string;
  beforeName: string;
  afterName: string;
  beforeModels: string[];
  afterModels: string[];
  revertedFrom?: string;
}
export interface OmniRouteComboUpdateHistory {
  revisions: OmniRouteComboUpdateHistoryEntry[];
}
export interface OmniRouteComboUpdateResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  routeReady?: boolean;
  auditWarning?: string;
  historyWarning?: string;
}
export interface OmniRouteComboActivationResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  enabled?: boolean;
  routeReady?: boolean;
  auditWarning?: string;
  historyWarning?: string;
}

export interface OmniRouteAccountActivationPrepared {
  ok: boolean;
  error?: string;
  name?: string;
  currentEnabled?: boolean;
  enabled?: boolean;
  action?: PendingConfirmation;
}
export interface OmniRouteAccountActivationResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  enabled?: boolean;
  routeReady?: boolean;
  auditWarning?: string;
  historyWarning?: string;
}

export interface OmniRouteActivationHistoryEntry {
  id: string;
  kind: "account" | "combo" | "key";
  entityId: string;
  name: string;
  at: string;
  beforeEnabled: boolean;
  afterEnabled: boolean;
}

export interface FreePolicyOptions {
  inventoryToken?: string;
  available: boolean;
  error?: string;
  accounts: { id: string; provider: string; name: string }[];
  models: {
    provider: string;
    modelId: string;
    name: string;
    freeType: string;
    tos: string;
  }[];
  verified: false;
}
export interface FreePolicySelection {
  inventoryToken: string;
  selection: {
    connectionId: string;
    modelId: string;
    officialSource: string;
  }[];
  acknowledgeBillingDisabled: true;
  acknowledgeHardStop: true;
  acknowledgeTerms: true;
  acknowledgeAllClients: true;
  acknowledgeQuotaRefresh: true;
}
export interface FreePolicyPrepared {
  ok: boolean;
  error?: string;
  action?: PendingConfirmation;
}
export interface FreePolicyResult {
  ok: boolean;
  evidenceSource?: "operator-account";
  nativeQuotaVerified?: false;
  error?: string;
  verified?: boolean | null;
  routeReady?: boolean;
  auditWarning?: string;
}
export interface FreePolicyHistorySnapshot {
  settings: Record<string, unknown>;
  key: Record<string, unknown>;
  policy: Record<string, unknown> | null;
}
export interface FreePolicyHistory {
  revisions: {
    id: string;
    at: number;
    before: FreePolicyHistorySnapshot;
    after: FreePolicyHistorySnapshot;
  }[];
  truncated: boolean;
}
