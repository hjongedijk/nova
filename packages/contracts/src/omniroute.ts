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
export interface NativeSkillModeResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  mode?: NativeSkillMode;
  enabled?: boolean;
  name?: string;
  scope?: "nova" | "global";
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

export interface NativeSkillRemovalResult {
  ok: boolean;
  error?: string;
  name?: string;
  verified?: boolean | null;
  auditWarning?: string;
}

export interface NativePromptReplacement {
  enabled: boolean;
  prefixPrompt: string;
  suffixPrompt: string;
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
  before: NativePromptReplacement;
  after: NativePromptReplacement;
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

export type OmniRouteTokenResetInterval = "daily" | "weekly" | "monthly";
export interface OmniRouteTokenLimit {
  id: string;
  scopeType: "model" | "provider" | "global";
  scopeValue: string;
  tokenLimit: number;
  resetInterval: OmniRouteTokenResetInterval;
  resetTime: string;
  enabled: boolean;
}
export interface OmniRouteTokenLimitsReport {
  available: boolean;
  error?: string;
  keyId?: string;
  keyName?: string;
  limits: OmniRouteTokenLimit[];
  truncated: boolean;
}
export interface OmniRouteTokenLimitResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  auditWarning?: string;
}

export interface OmniRouteKeyModelAccessOptions {
  available: boolean;
  error?: string;
  accessMode: "restricted" | "all" | "unknown";
  allowedModels: string[];
  verifiedFreeModels: string[];
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

export interface OmniRouteKeyModelAccessResult {
  ok: boolean;
  verified?: boolean | null;
  routeReady?: boolean;
  allowedModels?: string[];
  historyWarning?: string;
  error?: string;
}

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
export interface OmniRouteAccountKeyUpdateResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  id?: string;
  routeReady?: boolean;
  auditWarning?: string;
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

export interface OmniRouteComboCreateResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  id?: string;
  name?: string;
  routeReady?: boolean;
  auditWarning?: string;
}
export interface OmniRouteComboRemovalResult {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  routeReady?: boolean;
  auditWarning?: string;
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
  selection: {
    connectionId: string;
    modelId: string;
    officialSource: string;
  }[];
}
export interface FreePolicyResult {
  ok: boolean;
  evidenceSource?: "operator-account";
  nativeQuotaVerified?: false;
  error?: string;
  verified?: boolean | null;
  routeReady?: boolean;
  auditWarning?: string;
  /** Which verification step stopped the change (stage name or model and reason; never upstream text). */
  diagnostic?: string;
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
