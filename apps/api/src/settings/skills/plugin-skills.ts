import fs from "node:fs";
import path from "node:path";
import { normalizeSkill, type StoredWebhookSkill } from "./skills.js";

const MAX_PLUGINS = 20;
const MAX_MANIFEST_BYTES = 16 * 1024;
const FILENAME = /^[a-z0-9][a-z0-9_-]{0,59}\.json$/;

/** Load declarative webhook tools only. Executable files and unsafe permissions are ignored. */
export function loadPluginSkills(directory: string): StoredWebhookSkill[] {
  let folder: fs.Stats;
  try {
    folder = fs.lstatSync(directory);
  } catch {
    return [];
  }
  if (!folder.isDirectory() || (folder.mode & 0o077) !== 0) return [];
  let names: string[];
  try {
    names = fs
      .readdirSync(directory)
      .filter((name) => FILENAME.test(name))
      .sort();
  } catch {
    return [];
  }
  const skills: StoredWebhookSkill[] = [];
  const taken: string[] = [];
  for (const name of names.slice(0, MAX_PLUGINS)) {
    const file = path.join(directory, name);
    try {
      const stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.size > MAX_MANIFEST_BYTES ||
        (stat.mode & 0o077) !== 0
      )
        continue;
      const input = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      const skill = normalizeSkill(input, { takenIds: taken });
      if (skill.type !== "webhook") continue;
      skills.push(skill);
      taken.push(skill.id);
    } catch {
      // Invalid manifests cannot prevent NOVA from starting or load executable code.
    }
  }
  return skills;
}
