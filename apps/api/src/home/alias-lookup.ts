/**
 * Optional hook for long-term memory: a name the user taught NOVA earlier ("de grote lamp is
 * light.woonkamer"). Whoever owns semantic memory may provide it under HOME_ALIAS_LOOKUP;
 * without it only Home Assistant's own names and aliases resolve.
 */
export interface HomeAliasLookup {
  /** The entity id remembered for this name (a LEARNED_ALIAS memory), or null. */
  relatedEntity(reference: string): Promise<string | null>;
}

export const HOME_ALIAS_LOOKUP = Symbol("nova:home-alias-lookup");
