import { Injectable } from "@nestjs/common";
import type {
  AgentSkillCandidate,
  AgentSkillInstallResult,
  AgentSkillSearchResult,
} from "@nova/contracts";
import { sendRequest } from "../core/security/safe-request.js";
import { AgentSkillError, AgentSkillsService } from "./agent-skills.service.js";
import {
  MAX_REFERENCE_BYTES,
  MAX_REFERENCE_FILES,
  MAX_SKILL_BYTES,
  MAX_SKILL_TOTAL_BYTES,
  parseSkillMarkdown,
  referencePath,
  SkillFormatError,
} from "./skill-format.js";

/** A GET over NOVA's public-only HTTP client. Replaced by a fake in tests. */
export type SkillFetch = (
  url: string,
  options: { maxBytes: number; signal?: AbortSignal; accept?: string },
) => Promise<{ status: number; text: string; truncated: boolean }>;

export const ALLOWED_HOSTS = new Set([
  "api.github.com",
  "raw.githubusercontent.com",
  "skills.sh",
]);

const publicFetch: SkillFetch = async (url, { maxBytes, signal, accept }) => {
  if (!ALLOWED_HOSTS.has(new URL(url).hostname))
    throw new AgentSkillError("Dit adres is geen toegestane skillbron.");
  const response = await sendRequest(url, {
    maxBytes,
    signal,
    timeoutMs: 15_000,
    headers: accept ? { accept } : {},
  });
  return response;
};

export interface SkillSource {
  owner: string;
  repo: string;
  skill?: string;
  /** Folder inside the repository that holds SKILL.md ("" = repository root). */
  path?: string;
  ref?: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SKILL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

function validRepo(owner: string, repo: string): boolean {
  return OWNER.test(owner) && REPO.test(repo) && repo !== "." && repo !== "..";
}

/**
 * Accepts `owner/repo@skill`, `owner/repo/skill` (skills.sh ids), `owner/repo`,
 * `https://github.com/owner/repo[/tree/<ref>/<folder>]` and `https://skills.sh/owner/repo/skill`.
 */
export function parseSkillSource(input: unknown): SkillSource {
  const bad = () =>
    new AgentSkillError(
      "Geef een GitHub-adres of eigenaar/repository@vaardigheid, bijvoorbeeld obra/superpowers@brainstorming.",
    );
  if (typeof input !== "string") throw bad();
  let value = input.trim();
  if (!value || value.length > 400) throw bad();
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw bad();
    }
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    const host = url.hostname.toLowerCase();
    if (host === "skills.sh" || host === "www.skills.sh") {
      if (parts.length !== 3) throw bad();
      value = parts.join("/");
    } else if (host === "github.com" || host === "www.github.com") {
      const [owner = "", rawRepo = "", kind, ref, ...rest] = parts;
      const repo = rawRepo.replace(/\.git$/, "");
      if (!validRepo(owner, repo)) throw bad();
      if (kind === undefined) return { owner, repo };
      if ((kind !== "tree" && kind !== "blob") || !ref || !REF.test(ref))
        throw bad();
      let folder = rest;
      if (folder.at(-1) === "SKILL.md") folder = folder.slice(0, -1);
      if (folder.length > 8 || folder.some((part) => !PATH_SEGMENT.test(part)))
        throw bad();
      return { owner, repo, ref, path: folder.join("/") };
    } else throw bad();
  }
  const at = /^([^/@\s]+)\/([^/@\s]+)@([^/@\s]+)$/.exec(value);
  if (at) {
    const [, owner = "", repo = "", skill = ""] = at;
    if (!validRepo(owner, repo) || !SKILL.test(skill)) throw bad();
    return { owner, repo, skill };
  }
  const parts = value.split("/");
  if (parts.length === 2 && validRepo(parts[0]!, parts[1]!))
    return { owner: parts[0]!, repo: parts[1]! };
  if (
    parts.length === 3 &&
    validRepo(parts[0]!, parts[1]!) &&
    SKILL.test(parts[2]!)
  )
    return { owner: parts[0]!, repo: parts[1]!, skill: parts[2]! };
  throw bad();
}

export function describeSource(source: SkillSource, name: string): string {
  const base = `github:${source.owner}/${source.repo}`;
  if (source.path !== undefined)
    return `${base}${source.ref ? `#${source.ref}` : ""}:${source.path || "."}`;
  return `${base}@${source.skill ?? name}`;
}

/** Hand-picked, license-checked skills that fit a home assistant. Shown when search is unavailable. */
export const SUGGESTED_SKILLS: Omit<AgentSkillCandidate, "installed">[] = [
  {
    install: "obra/superpowers@brainstorming",
    name: "brainstorming",
    source: "obra/superpowers",
    installs: null,
    description:
      "Eerst samen uitzoeken wat je echt wilt voordat er iets gepland of gebouwd wordt (verbouwing, uitje, project).",
    license: "MIT",
  },
  {
    install: "blader/humanizer@humanizer",
    name: "humanizer",
    source: "blader/humanizer",
    installs: null,
    description:
      "Teksten (mails, berichten) herschrijven zodat ze niet als AI klinken, zonder de inhoud te veranderen.",
    license: "MIT",
  },
  {
    install: "anthropics/skills@discernment-nudge",
    name: "discernment-nudge",
    source: "anthropics/skills",
    installs: null,
    description:
      "Na advies of een concept kort aangeven wat je zelf nog moet controleren.",
    license: "Apache-2.0",
  },
];

interface TreeEntry {
  path: string;
  type: string;
  mode: string;
  size?: number;
}

const encodePath = (value: string) =>
  value.split("/").map(encodeURIComponent).join("/");

@Injectable()
export class SkillInstallerService {
  private fetcher: SkillFetch = publicFetch;

  constructor(private readonly skills: AgentSkillsService) {}

  /** Tests swap the network for a fake. */
  useFetch(fetcher: SkillFetch): void {
    this.fetcher = fetcher;
  }

  async search(
    queryInput: unknown,
    limitInput: unknown = 10,
    signal?: AbortSignal,
  ): Promise<AgentSkillSearchResult> {
    const query =
      typeof queryInput === "string" ? queryInput.trim().slice(0, 100) : "";
    const limit = Math.min(
      20,
      Math.max(1, Number.isInteger(limitInput) ? (limitInput as number) : 10),
    );
    const installed = new Set(this.skills.list().map((skill) => skill.name));
    if (query.length >= 2) {
      try {
        const response = await this.fetcher(
          `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=${limit}`,
          { maxBytes: 300_000, signal, accept: "application/json" },
        );
        if (response.status === 200 && !response.truncated) {
          const body = JSON.parse(response.text) as { skills?: unknown };
          if (Array.isArray(body.skills)) {
            const results: AgentSkillCandidate[] = [];
            for (const item of body.skills as Record<string, unknown>[]) {
              const source = typeof item.source === "string" ? item.source : "";
              const skillId =
                typeof item.skillId === "string" ? item.skillId : "";
              const [owner = "", repo = "", extra] = source.split("/");
              if (
                extra !== undefined ||
                !validRepo(owner, repo) ||
                !SKILL.test(skillId)
              )
                continue;
              results.push({
                install: `${owner}/${repo}@${skillId}`,
                name:
                  typeof item.name === "string"
                    ? item.name.slice(0, 100)
                    : skillId,
                source,
                installs:
                  typeof item.installs === "number" ? item.installs : null,
                description: null,
                license: null,
                installed: installed.has(skillId),
              });
              if (results.length >= limit) break;
            }
            return { query, origin: "skills.sh", results };
          }
        }
      } catch {
        // The directory is optional: fall back to the curated list.
      }
    }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results = SUGGESTED_SKILLS.filter(
      (item) =>
        !words.length ||
        words.some((word) =>
          `${item.name} ${item.description}`.toLowerCase().includes(word),
        ),
    ).map((item) => ({ ...item, installed: installed.has(item.name) }));
    return {
      query,
      origin: "suggestions",
      results:
        results.length || words.length === 0
          ? results
          : SUGGESTED_SKILLS.map((item) => ({
              ...item,
              installed: installed.has(item.name),
            })),
    };
  }

  async install(
    input: unknown,
    options: { replace?: boolean; signal?: AbortSignal } = {},
  ): Promise<AgentSkillInstallResult> {
    const source = parseSkillSource(input);
    const ref = source.ref ?? "HEAD";
    const warnings: string[] = [];
    const skipped: string[] = [];
    const located = await this.locate(source, ref, options.signal);
    const raw = (relative: string) =>
      `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodePath(ref)}/${encodePath(relative)}`;
    const prefix = located.folder ? `${located.folder}/` : "";
    const skillText = await this.text(
      raw(`${prefix}SKILL.md`),
      MAX_SKILL_BYTES,
      options.signal,
    );
    let parsed;
    try {
      parsed = parseSkillMarkdown(skillText);
    } catch (error) {
      if (error instanceof SkillFormatError)
        throw new AgentSkillError(`Ongeldige SKILL.md: ${error.message}`);
      throw error;
    }
    const folderName = located.folder.split("/").at(-1) || source.repo;
    if (folderName !== parsed.name)
      warnings.push(
        `De map heet “${folderName}”, de vaardigheid “${parsed.name}”; NOVA bewaart hem als “${parsed.name}”.`,
      );
    if (parsed.ignoredKeys.length)
      warnings.push(
        `Onbekende velden genegeerd: ${parsed.ignoredKeys.join(", ")}.`,
      );
    const existing = this.skills
      .list()
      .find((skill) => skill.name === parsed.name);
    const sourceLabel = describeSource(source, parsed.name);
    if (existing && !options.replace && existing.source !== sourceLabel)
      throw new AgentSkillError(
        `Er is al een vaardigheid “${parsed.name}” (${existing.source}). Kies vervangen om hem te overschrijven.`,
      );
    const references: Record<string, string> = {};
    let total = Buffer.byteLength(skillText);
    for (const entry of located.files) {
      const relative = entry.path.slice(prefix.length);
      if (relative === "SKILL.md") continue;
      const safe = referencePath(relative);
      if (
        entry.mode === "120000" ||
        !safe ||
        (entry.size ?? 0) > MAX_REFERENCE_BYTES ||
        Object.keys(references).length >= MAX_REFERENCE_FILES ||
        total + (entry.size ?? 0) > MAX_SKILL_TOTAL_BYTES
      ) {
        skipped.push(relative);
        continue;
      }
      try {
        const content = await this.text(
          raw(entry.path),
          MAX_REFERENCE_BYTES,
          options.signal,
        );
        references[safe] = content;
        total += Buffer.byteLength(content);
      } catch {
        skipped.push(relative);
      }
    }
    if (
      skipped.some((file) =>
        /\.(?:py|sh|js|ts|mjs|cjs|rb|ps1|bat|exe)$/i.test(file),
      )
    )
      warnings.push(
        "Scripts in deze vaardigheid zijn niet opgeslagen: NOVA voert geen skillscripts uit.",
      );
    if (located.partial)
      warnings.push(
        "Alleen SKILL.md is opgehaald; de bestandslijst van de repository was niet beschikbaar.",
      );
    const { summary, replaced } = this.skills.write(
      { skill: skillText, references },
      sourceLabel,
    );
    return {
      ok: true,
      skill: summary,
      replaced,
      skipped: skipped.slice(0, 50),
      warnings,
    };
  }

  private async text(
    url: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.fetcher(url, {
      maxBytes,
      signal,
      accept: "text/plain, */*;q=0.5",
    });
    if (response.status === 404)
      throw new AgentSkillError("Bestand niet gevonden op GitHub.");
    if (response.status !== 200)
      throw new AgentSkillError(
        `GitHub antwoordde met status ${response.status}.`,
      );
    if (response.truncated)
      throw new AgentSkillError("Een bestand in de vaardigheid is te groot.");
    if (response.text.includes("\0"))
      throw new AgentSkillError("Een bestand in de vaardigheid is geen tekst.");
    return response.text;
  }

  /** Find the skill folder and its files with one GitHub tree request; guess paths when that fails. */
  private async locate(
    source: SkillSource,
    ref: string,
    signal?: AbortSignal,
  ): Promise<{ folder: string; files: TreeEntry[]; partial: boolean }> {
    let tree: TreeEntry[] | null = null;
    try {
      const response = await this.fetcher(
        `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        { maxBytes: 8_000_000, signal, accept: "application/vnd.github+json" },
      );
      if (response.status === 404 || response.status === 422)
        throw new AgentSkillError(
          `Repository ${source.owner}/${source.repo}${source.ref ? ` (${source.ref})` : ""} niet gevonden op GitHub.`,
        );
      if (response.status === 200 && !response.truncated) {
        const body = JSON.parse(response.text) as {
          tree?: unknown;
          truncated?: unknown;
        };
        if (Array.isArray(body.tree) && body.truncated !== true)
          tree = (body.tree as TreeEntry[]).filter(
            (entry) =>
              entry &&
              typeof entry.path === "string" &&
              entry.type === "blob" &&
              typeof entry.mode === "string",
          );
      }
    } catch (error) {
      if (error instanceof AgentSkillError) throw error;
      tree = null;
    }
    if (!tree) {
      // Rate-limited or very large repository: try the usual folders directly.
      const guesses =
        source.path !== undefined
          ? [source.path]
          : source.skill
            ? [
                `skills/${source.skill}`,
                source.skill,
                `.claude/skills/${source.skill}`,
              ]
            : [""];
      for (const folder of guesses) {
        const prefix = folder ? `${folder}/` : "";
        try {
          const response = await this.fetcher(
            `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodePath(ref)}/${encodePath(`${prefix}SKILL.md`)}`,
            { maxBytes: 1, signal },
          );
          if (response.status === 200)
            return { folder, files: [], partial: true };
        } catch {
          /* try the next folder */
        }
      }
      throw new AgentSkillError(
        "Kon de vaardigheid niet vinden (GitHub gaf geen bestandslijst). Geef het volledige GitHub-adres van de map.",
      );
    }
    const folders = tree
      .filter(
        (entry) =>
          entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md"),
      )
      .map((entry) =>
        entry.path.slice(0, -"SKILL.md".length).replace(/\/$/, ""),
      );
    let folder: string | undefined;
    if (source.path !== undefined) {
      folder = folders.find((item) => item === source.path);
      if (folder === undefined)
        throw new AgentSkillError(
          `Geen SKILL.md gevonden in ${source.path || "de hoofdmap"}.`,
        );
    } else if (source.skill) {
      folder = folders
        .filter(
          (item) => (item.split("/").at(-1) || source.repo) === source.skill,
        )
        .sort((a, b) => a.split("/").length - b.split("/").length)[0];
      if (folder === undefined)
        throw new AgentSkillError(
          `Vaardigheid “${source.skill}” niet gevonden in ${source.owner}/${source.repo}.${folders.length ? ` Wel: ${this.names(folders, source.repo)}.` : ""}`,
        );
    } else if (folders.length === 1) folder = folders[0]!;
    else if (!folders.length)
      throw new AgentSkillError(
        `${source.owner}/${source.repo} bevat geen SKILL.md.`,
      );
    else
      throw new AgentSkillError(
        `${source.owner}/${source.repo} bevat ${folders.length} vaardigheden; kies er één, bijvoorbeeld ${source.owner}/${source.repo}@${folders[0]!.split("/").at(-1) || source.repo}. Beschikbaar: ${this.names(folders, source.repo)}.`,
      );
    const prefix = folder ? `${folder}/` : "";
    const files = tree.filter(
      (entry) =>
        entry.path.startsWith(prefix) &&
        !entry.path.slice(prefix.length).includes("/SKILL.md") &&
        // Never pull in a nested skill or anything deeper than the format recommends.
        entry.path.slice(prefix.length).split("/").length <= 4,
    );
    return { folder, files, partial: false };
  }

  private names(folders: string[], repo: string): string {
    const list = folders.map((item) => item.split("/").at(-1) || repo);
    return `${list.slice(0, 25).join(", ")}${list.length > 25 ? ", …" : ""}`;
  }
}
