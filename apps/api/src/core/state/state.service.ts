import { Injectable } from "@nestjs/common";

export type ComponentState = Record<string, unknown> & {
  updatedAt: string;
  stale: boolean;
};

/** What NOVA last saw of each component (Proxmox, MQTT, TTS, ...). Older than a minute is stale. */
@Injectable()
export class StateService {
  private readonly values = new Map<
    string,
    Record<string, unknown> & { updatedAt: string }
  >();

  update(component: string, data: Record<string, unknown>): void {
    this.values.set(component, {
      ...this.values.get(component),
      ...data,
      updatedAt: new Date().toISOString(),
    });
  }

  get(component: string): ComponentState | undefined {
    return this.all()[component];
  }

  all(): Record<string, ComponentState> {
    return Object.fromEntries(
      [...this.values].map(([key, value]) => [
        key,
        { ...value, stale: Date.now() - Date.parse(value.updatedAt) > 60000 },
      ]),
    );
  }
}
