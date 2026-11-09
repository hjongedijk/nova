/** One installed skill in the open Agent Skills format (a folder with a SKILL.md). */
export interface AgentSkillSummary {
  name: string;
  description: string;
  enabled: boolean;
  /** Where it came from, e.g. `github:obra/superpowers@brainstorming`, or `local`. */
  source: string;
  license: string | null;
  installedAt: string | null;
  /** Bundled reference files besides SKILL.md that `skill_read` can open. */
  files: string[];
  /** Set when the folder exists but SKILL.md is invalid; the skill is then never offered. */
  error: string | null;
}

export interface AgentSkillsReport {
  skills: AgentSkillSummary[];
  /** Characters the system prompt spends on the skills list right now. */
  promptCharacters: number;
}

/** A skill that can be installed: from the skills.sh search or NOVA's suggestion list. */
export interface AgentSkillCandidate {
  /** What `install` accepts: `owner/repo@skill`. */
  install: string;
  name: string;
  source: string;
  installs: number | null;
  description: string | null;
  license: string | null;
  installed: boolean;
}

export interface AgentSkillSearchResult {
  query: string;
  /** `skills.sh` when the live directory answered, otherwise `suggestions`. */
  origin: "skills.sh" | "suggestions";
  results: AgentSkillCandidate[];
}

export interface AgentSkillInstallResult {
  ok: true;
  skill: AgentSkillSummary;
  replaced: boolean;
  /** Files in the skill folder that were not stored (scripts, binaries, too large). */
  skipped: string[];
  warnings: string[];
}
