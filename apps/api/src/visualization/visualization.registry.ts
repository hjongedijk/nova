import { Injectable } from "@nestjs/common";
import type { VizProviderInfo } from "@nova/contracts";
import type {
  VisualizationProvider,
  VizTypeDefinition,
} from "./visualization.types.js";

/** Holds the visualisation providers. Other modules register theirs in onModuleInit. */
@Injectable()
export class VisualizationRegistry {
  private readonly providers = new Map<string, VisualizationProvider>();

  register(provider: VisualizationProvider): void {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(provider.id))
      throw new Error(`Ongeldige visualisatie-aanbieder-id ${provider.id}`);
    if (this.providers.has(provider.id))
      throw new Error(`Aanbieder ${provider.id} is al geregistreerd`);
    const seen = new Set<string>();
    for (const type of provider.types) {
      if (seen.has(type.id))
        throw new Error(`Dubbel type ${type.id} in ${provider.id}`);
      seen.add(type.id);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): VisualizationProvider | undefined {
    return this.providers.get(id);
  }

  list(): VisualizationProvider[] {
    return [...this.providers.values()];
  }

  info(): VizProviderInfo[] {
    return this.list().map((provider) => {
      const availability = provider.available();
      return {
        id: provider.id,
        label: provider.label,
        available: availability.ok,
        ...(availability.ok ? {} : { reason: availability.reason }),
        types: provider.types.map(({ id, title, kind, description }) => ({
          id,
          title,
          kind,
          description,
        })),
      };
    });
  }

  /** Find the type for "provider" or "provider:type" (type defaults to the provider's first). */
  resolve(
    ref: string,
  ): { provider: VisualizationProvider; type: VizTypeDefinition } | null {
    const [providerId, typeId] = ref.split(":");
    const provider = this.providers.get(providerId ?? "");
    if (!provider) return null;
    const type = typeId
      ? provider.types.find((item) => item.id === typeId)
      : provider.types[0];
    return type ? { provider, type } : null;
  }
}
