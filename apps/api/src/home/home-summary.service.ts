import { Injectable } from "@nestjs/common";
import type { HaEntity, HomeSummary } from "@nova/contracts";
import { HomeAssistantService } from "./home-assistant.service.js";

/*
 * What the house itself reports, from whatever Home Assistant exposes: people, lights,
 * switches, thermostats, temperature sensors, updates, lists and players. The dashboard shows
 * it, and home_status lets NOVA answer from it instead of guessing entity names.
 */
const ofDomain = (entities: HaEntity[], domain: string) =>
  entities.filter((item) => item.domain === domain);
const attribute = (item: HaEntity, name: string): unknown =>
  item.attributes?.[name];
const numberOrNull = (value: unknown): number | null =>
  value === undefined || value === null ? null : (value as number);

const PERSON_STATE: Record<string, string> = {
  home: "thuis",
  not_home: "weg",
  unknown: "onbekend",
};

/** Sections without data are left out, so a sparse install shows a short summary. */
export function homeSummary(entities: HaEntity[]): HomeSummary | null {
  const lights = ofDomain(entities, "light");
  const switches = ofDomain(entities, "switch");
  const summary: HomeSummary = {
    people: ofDomain(entities, "person").map((item) => ({
      name: item.friendly_name,
      state: item.state,
    })),
    lights: lights.length
      ? {
          on: lights.filter((item) => item.state === "on").length,
          total: lights.length,
        }
      : null,
    switches: switches.length
      ? {
          on: switches.filter((item) => item.state === "on").length,
          total: switches.length,
        }
      : null,
    climate: ofDomain(entities, "climate").map((item) => ({
      name: item.friendly_name,
      current: numberOrNull(attribute(item, "current_temperature")),
      target: numberOrNull(attribute(item, "temperature")),
    })),
    temperatures: entities
      .filter(
        (item) =>
          item.domain === "sensor" &&
          attribute(item, "device_class") === "temperature" &&
          Number.isFinite(Number(item.state)),
      )
      .slice(0, 4)
      .map((item) => ({
        name: item.friendly_name,
        value: Number(item.state),
        unit: (attribute(item, "unit_of_measurement") as string) ?? "°C",
      })),
    updates: ofDomain(entities, "update")
      .filter((item) => item.state === "on")
      .map((item) => item.friendly_name),
    lists: ofDomain(entities, "todo")
      .filter((item) => Number(item.state) > 0)
      .map((item) => ({ name: item.friendly_name, open: Number(item.state) })),
    playing: ofDomain(entities, "media_player")
      .filter((item) => item.state === "playing")
      .map((item) => item.friendly_name),
  };
  const empty =
    !summary.people.length &&
    !summary.lights &&
    !summary.switches &&
    !summary.climate.length &&
    !summary.temperatures.length &&
    !summary.updates.length &&
    !summary.lists.length &&
    !summary.playing.length;
  return empty ? null : summary;
}

/** The same data for the model, plus an explicit list of what does not exist at all. */
export function describeHome(entities: HaEntity[]) {
  const summary = homeSummary(entities);
  const lights = ofDomain(entities, "light");
  const missing: string[] = [];
  if (!lights.length)
    missing.push("Er zijn geen lampen gekoppeld in Home Assistant.");
  if (!ofDomain(entities, "climate").length)
    missing.push("Er zijn geen thermostaten of verwarming gekoppeld.");
  if (
    !entities.some(
      (item) =>
        item.domain === "sensor" &&
        attribute(item, "device_class") === "temperature",
    )
  )
    missing.push(
      "Er is geen temperatuursensor gekoppeld, dus de temperatuur binnen is onbekend.",
    );
  if (!ofDomain(entities, "media_player").length)
    missing.push("Er zijn geen mediaspelers gekoppeld.");
  const domains: Record<string, number> = {};
  for (const item of entities)
    domains[item.domain] = (domains[item.domain] ?? 0) + 1;
  const temperatures = summary?.temperatures ?? [];
  const people = (summary?.people ?? []).map((person) => ({
    name: person.name,
    state: PERSON_STATE[person.state] ?? person.state,
  }));
  const answers = {
    presence: people.length
      ? people
          .map((person) =>
            person.state === "onbekend"
              ? `Ik weet niet of ${person.name} thuis is: Home Assistant ziet geen telefoon of tracker.`
              : `${person.name} is ${person.state}.`,
          )
          .join(" ")
      : "Home Assistant kent geen personen.",
    temperatureInside: temperatures.length
      ? temperatures
          .map(
            (sensor) =>
              `${sensor.name}: ${Math.round(sensor.value * 10) / 10} graden.`,
          )
          .join(" ")
      : "Ik weet de temperatuur binnen niet: er is geen temperatuursensor of thermostaat gekoppeld.",
    lights: lights.length
      ? `${lights.filter((item) => item.state === "on").length} van de ${lights.length} lampen staat aan.`
      : "Er zijn geen lampen gekoppeld in Home Assistant.",
  };
  return {
    answers,
    people,
    lights: lights.length
      ? {
          total: lights.length,
          on: lights
            .filter((item) => item.state === "on")
            .map((item) => item.friendly_name),
        }
      : null,
    switches: summary?.switches ?? null,
    climate: summary?.climate ?? [],
    temperatures,
    updates: summary?.updates ?? [],
    lists: summary?.lists ?? [],
    playing: summary?.playing ?? [],
    missing,
    domains,
    hint: "Beantwoord alleen de gestelde vraag met de bijbehorende zin uit answers (presence, temperatureInside of lights), vrijwel letterlijk. Antwoord alleen hiermee. Staat iets bij missing, zeg dan eerlijk dat het niet in Home Assistant staat en verzin niets. Het weer buiten is nooit de temperatuur binnen.",
  };
}

/** For the dashboard's "Huis" panel and home_status. */
@Injectable()
export class HomeSummaryService {
  constructor(private readonly home: HomeAssistantService) {}

  /** The catalog as the panel shows it, or null when Home Assistant has nothing. Throws when it is unreachable. */
  async current(): Promise<HomeSummary | null> {
    return homeSummary(await this.home.sync());
  }

  summarize(entities: HaEntity[]): HomeSummary | null {
    return homeSummary(entities);
  }

  describe(entities: HaEntity[]) {
    return describeHome(entities);
  }
}
