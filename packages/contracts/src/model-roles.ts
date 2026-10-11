export type ModelRoleId =
  "conversation" | "code" | "planning" | "summary" | "vision" | "embedding";

export interface ModelRolePreference {
  preferred: string[];
  fallback: string | null;
}

export type ModelRolePreferences = Record<ModelRoleId, ModelRolePreference>;

export interface ModelRolesSettings {
  available: boolean;
  error?: string;
  historyWarning?: string;
  verifiedFreeModels: string[];
  roles: ModelRolePreferences;
}

export interface ModelRoleRevision {
  id: string;
  at: string;
  before: ModelRolePreferences;
  after: ModelRolePreferences;
  revertedFrom?: string;
}

export interface ModelRoleHistory {
  revisions: ModelRoleRevision[];
  truncated: boolean;
}
