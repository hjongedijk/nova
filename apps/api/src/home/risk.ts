import type { Risk } from "@nova/contracts";

/** The service data and entity as far as the risk decision looks at them. */
export type ServiceData = Record<string, unknown>;
export interface RiskEntity {
  entity_id?: string;
  friendly_name?: string;
  attributes?: Record<string, unknown>;
}

const ALWAYS_CONFIRM_DOMAINS = ["lock", "cover", "scene", "script", "sonos"];
const DANGEROUS_SWITCH =
  /server|proxmox|router|network|nas|pump|pomp|heater|boiler|verwarm|outlet|stopcontact/i;

/**
 * The real risk of one Home Assistant call, decided from what is actually being called:
 * unlock is DANGEROUS, locks/covers/scenes/scripts/toggles/announcements/grouping need
 * confirmation, switches that look like servers or heaters are DANGEROUS, big temperature
 * and volume changes need confirmation, everything else is SAFE.
 */
export function actionRisk(
  domain: string,
  service: string,
  data: ServiceData = {},
  entity: RiskEntity = {},
): Risk {
  if (domain === "lock" && service === "unlock") return "DANGEROUS";
  if (
    ALWAYS_CONFIRM_DOMAINS.includes(domain) ||
    service === "toggle" ||
    data.announce ||
    ["join", "unjoin"].includes(service)
  )
    return "CONFIRM";
  if (
    domain === "switch" &&
    DANGEROUS_SWITCH.test(
      `${entity.entity_id} ${entity.friendly_name} ${entity.attributes?.device_class}`,
    )
  )
    return "DANGEROUS";
  if (domain === "climate") {
    const current = Number(entity.attributes?.temperature);
    if (typeof data.temperature !== "number") return "CONFIRM";
    if (
      !Number.isFinite(current) ||
      Math.abs(data.temperature - current) > 2 ||
      data.temperature < 16 ||
      data.temperature > 26
    )
      return "CONFIRM";
  }
  if (
    service === "volume_set" &&
    (typeof data.volume_level !== "number" ||
      data.volume_level > 0.5 ||
      Math.abs(
        data.volume_level - Number(entity.attributes?.volume_level || 0),
      ) > 0.2)
  )
    return "CONFIRM";
  return "SAFE";
}
