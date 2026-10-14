import { sanitize } from "../core/security/sanitize.js";

export const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export type Flow = Record<string, unknown>;
export interface BriefingSchedule {
  id: string;
  kind: "morning_briefing" | "evening_review";
  time: string;
  timezone: string;
}
export function validId(value: unknown): value is string {
  return (
    typeof value === "string" && ID.test(value) && sanitize(value) === value
  );
}
export function validTime(value: unknown): value is string {
  return typeof value === "string" && (value === "" || TIME.test(value));
}
export function validTimezone(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 80 ||
    !/^(?:UTC|GMT|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(value)
  )
    return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
export function flowRows(value: unknown): Flow[] | null {
  if (!Array.isArray(value) || value.length > 5000) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 2_000_000)
      return null;
  } catch {
    return null;
  }
  const ids = new Set<string>();
  for (const row of value) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      !validId(row.id) ||
      ids.has(row.id) ||
      typeof row.type !== "string" ||
      row.type.length > 128
    )
      return null;
    ids.add(row.id);
  }
  return value as Flow[];
}
/** Validate once and project every tab in linear time; never expose arbitrary node fields. */
export function projectBriefingInventory(
  flows: unknown,
): Map<string, BriefingSchedule[]> {
  const rows = flowRows(flows);
  const inventory = new Map<string, BriefingSchedule[]>();
  if (!rows) return inventory;
  const tabs = new Set<string>();
  const overflow = new Set<string>();
  const timezones = new Map<string, boolean>();
  for (const row of rows) {
    if (row.type === "tab") {
      tabs.add(row.id as string);
      if (!inventory.has(row.id as string)) inventory.set(row.id as string, []);
      continue;
    }
    if (
      row.type !== "nova-briefing" ||
      typeof row.z !== "string" ||
      overflow.has(row.z) ||
      !["morning_briefing", "evening_review"].includes(row.kind as string) ||
      !validTime(row.time) ||
      typeof row.timezone !== "string"
    )
      continue;
    if (!timezones.has(row.timezone))
      timezones.set(row.timezone, validTimezone(row.timezone));
    if (!timezones.get(row.timezone)) continue;
    const schedules = inventory.get(row.z) ?? [];
    schedules.push({
      id: row.id as string,
      kind: row.kind as BriefingSchedule["kind"],
      time: row.time,
      timezone: row.timezone,
    });
    if (schedules.length > 32) {
      overflow.add(row.z);
      inventory.set(row.z, []);
    } else inventory.set(row.z, schedules);
  }
  for (const tabId of inventory.keys())
    if (!tabs.has(tabId)) inventory.delete(tabId);
  return inventory;
}
/** Public single-tab compatibility projection. */
export function projectBriefingSchedules(
  flows: unknown,
  tabId: string,
): BriefingSchedule[] {
  return validId(tabId)
    ? (projectBriefingInventory(flows).get(tabId) ?? [])
    : [];
}
