import { describe, expect, it } from "vitest";
import {
  intervalLabel,
  objectiveStatus,
  templateLabel,
  validInterval,
  validQuietHours,
  type ObjectiveView,
} from "./objectives.ts";

const base: ObjectiveView = {
  id: "aabbccdd",
  title: "Houd mijn servers in de gaten",
  kind: "monitor",
  template: "servers_gezond",
  enabled: true,
  intervalMinutes: 10,
  quietHours: "23:00-07:00",
  counters: {
    checks: 0,
    anomalies: 0,
    falseAlarms: 0,
    notifications: 0,
    suppressed: 0,
    investigations: 0,
  },
  anomaliesLast7Days: 0,
};

describe("objective helpers", () => {
  it("derives the status", () => {
    expect(objectiveStatus(base).label).toBe("ok");
    expect(objectiveStatus({ ...base, enabled: false }).label).toBe(
      "gepauzeerd",
    );
    const anomaly = {
      since: "x",
      urgency: "warn",
      detail: "d",
      dismissed: false,
    };
    expect(objectiveStatus({ ...base, activeAnomaly: anomaly }).label).toBe(
      "afwijking",
    );
    expect(
      objectiveStatus({
        ...base,
        activeAnomaly: { ...anomaly, dismissed: true },
      }).label,
    ).toBe("ok");
  });
  it("words interval and template", () => {
    expect(intervalLabel(10)).toBe("elke 10 minuten");
    expect(intervalLabel(60)).toBe("elk uur");
    expect(intervalLabel(120)).toBe("elke 2 uur");
    expect(templateLabel({ template: "agenda_leeg", kind: "followup" })).toBe(
      "Lege agenda (eenmalig)",
    );
  });
  it("validates what the PUT accepts", () => {
    expect(validInterval(5)).toBe(true);
    expect(validInterval(4)).toBe(false);
    expect(validInterval(1441)).toBe(false);
    expect(validQuietHours("23:00-07:00")).toBe(true);
    expect(validQuietHours("uit")).toBe(true);
    expect(validQuietHours("25:00-07:00")).toBe(false);
    expect(validQuietHours("nacht")).toBe(false);
  });
});
