import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { HomeAssistantService } from "../home/home-assistant.service.js";
import { WindowsPcService } from "../integrations/windows/windows-pc.service.js";

export type HomePresence = "home" | "away" | "unknown" | "ambiguous";

const REFRESH_MS = 30_000;

/** Cached, conservative presence signal for deciding whether unsolicited speech is appropriate. */
@Injectable()
export class SpeechPresenceService implements OnModuleInit, OnModuleDestroy {
  private home: HomePresence = "unknown";
  private helperOpen: boolean | null = null;
  private timer?: NodeJS.Timeout;
  private refreshing: Promise<void> | null = null;
  private readonly transitionListeners = new Set<
    (from: HomePresence, to: HomePresence) => void
  >();

  constructor(
    private readonly homeAssistant: HomeAssistantService,
    private readonly windows: WindowsPcService,
  ) {}

  onModuleInit(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** False only when both signals establish the user is away and the helper is closed. */
  maySpeak(): boolean | null {
    if (this.helperOpen === true || this.home === "home") return true;
    if (this.home === "away" && this.helperOpen === false) return false;
    return null;
  }

  /** Observe confirmed transitions only; unknown/ambiguous readings never imply movement. */
  onTransition(
    listener: (from: HomePresence, to: HomePresence) => void,
  ): () => void {
    this.transitionListeners.add(listener);
    return () => this.transitionListeners.delete(listener);
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.update();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  private async update(): Promise<void> {
    const homeTask = (async () => {
      if (!this.homeAssistant.configured) {
        this.home = "unknown";
        return;
      }
      try {
        await this.homeAssistant.sync();
        if (!this.homeAssistant.health().online) {
          this.home = "unknown";
          return;
        }
        const people = this.homeAssistant
          .visibleEntities()
          .filter((entity) => entity.domain === "person");
        let next: HomePresence;
        if (people.length > 1) next = "ambiguous";
        else if (people.length === 1)
          next =
            people[0]?.state === "home"
              ? "home"
              : people[0]?.state === "not_home"
                ? "away"
                : "unknown";
        else next = "unknown";
        this.setHome(next);
      } catch {
        this.setHome("unknown");
      }
    })();
    const helperTask = this.windows
      .settingsStatus()
      .then((status) => {
        this.helperOpen = status.available ? status.helperOpen : null;
      })
      .catch(() => {
        this.helperOpen = null;
      });
    await Promise.all([homeTask, helperTask]);
  }

  private setHome(next: HomePresence): void {
    const previous = this.home;
    this.home = next;
    if (
      previous === next ||
      (previous !== "home" && previous !== "away") ||
      (next !== "home" && next !== "away")
    )
      return;
    for (const listener of this.transitionListeners) {
      try {
        listener(previous, next);
      } catch {
        // A subscriber cannot break presence refresh or other listeners.
      }
    }
  }
}
