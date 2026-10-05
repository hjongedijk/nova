import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type {
  InfrastructureEvent,
  ListsOverview,
  TimerInfo,
} from "@nova/contracts";
import {
  JarvisStateStore,
  newId,
  type StoredListItem,
  type StoredTimer,
} from "./jarvis-state.store.js";

export const MAX_TIMERS = 20;
export const MAX_LIST_ITEMS = 100;

const listKey = (name: string) => name.trim().toLowerCase();

export function describeTimer(timer: StoredTimer, now = Date.now()): TimerInfo {
  return {
    id: timer.id,
    label: timer.label,
    fireAt: new Date(timer.fireAt).toISOString(),
    remainingSeconds: Math.max(0, Math.round((timer.fireAt - now) / 1000)),
  };
}

/** Timers (which fire and announce by themselves) and lists. Errors are Dutch messages. */
@Injectable()
export class PlanningService implements OnModuleInit, OnModuleDestroy {
  private pump?: NodeJS.Timeout;

  constructor(private readonly store: JarvisStateStore) {}

  onModuleInit(): void {
    this.pump = setInterval(() => this.fireDueTimers(), 1000);
    this.pump.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.pump);
  }

  /** Listen for fired timers and alerts. Returns the unsubscribe function. */
  onEvent(listener: (event: InfrastructureEvent) => void): () => void {
    return this.store.onEvent(listener);
  }

  /** Active timers, soonest first. */
  timers(): TimerInfo[] {
    const now = Date.now();
    return this.store.data.timers.map((timer) => describeTimer(timer, now));
  }

  /** All lists with their first 20 items. */
  lists(): ListsOverview {
    return Object.fromEntries(
      Object.entries(this.store.data.lists).map(([name, items]) => [
        name,
        items.slice(0, 20).map((item) => item.text),
      ]),
    );
  }

  fireDueTimers(now = Date.now()): void {
    const state = this.store.data;
    const due = state.timers.filter((timer) => timer.fireAt <= now);
    if (!due.length) return;
    state.timers = state.timers.filter((timer) => timer.fireAt > now);
    for (const timer of due)
      this.store.emit({
        topic: "jarvis/events/timer",
        payload: {
          type: "timer_fired",
          id: timer.id,
          label: timer.label,
          firedAt: new Date().toISOString(),
          late: now - timer.fireAt > 5000,
        },
      });
    this.store.save();
  }

  setTimer(args: { seconds?: number; at?: string; label?: string }) {
    const state = this.store.data;
    if ((args.seconds === undefined) === (args.at === undefined))
      throw new Error(
        "Geef óf seconds óf at op, niet allebei en niet geen van beide.",
      );
    const fireAt =
      args.seconds !== undefined
        ? Date.now() + args.seconds * 1000
        : Date.parse(args.at ?? "");
    if (!Number.isFinite(fireAt))
      throw new Error("at is geen geldige ISO-tijd.");
    if (fireAt <= Date.now() + 500)
      throw new Error("Dat tijdstip is al voorbij.");
    if (fireAt > Date.now() + 7 * 86400 * 1000)
      throw new Error("Timers kunnen maximaal 7 dagen vooruit.");
    if (state.timers.length >= MAX_TIMERS)
      throw new Error("Er staan al te veel timers.");
    const timer: StoredTimer = {
      id: newId(),
      label: args.label || "timer",
      fireAt,
      createdAt: Date.now(),
    };
    state.timers.push(timer);
    state.timers.sort((a, b) => a.fireAt - b.fireAt);
    this.store.save();
    return { timer: describeTimer(timer) };
  }

  cancelTimer(args: { id?: string; label?: string }) {
    const state = this.store.data;
    if (!args.id && !args.label) throw new Error("Geef een id of label op.");
    const matches = state.timers.filter((timer) =>
      args.id
        ? timer.id === args.id
        : timer.label.toLowerCase().includes((args.label ?? "").toLowerCase()),
    );
    if (!matches.length) throw new Error("Geen timer gevonden.");
    if (matches.length > 1 && !args.id)
      throw new Error(
        `Meerdere timers passen: ${matches.map((timer) => timer.label).join(", ")}. Welke bedoel je?`,
      );
    const [match] = matches as [StoredTimer];
    state.timers = state.timers.filter((timer) => timer !== match);
    this.store.save();
    return { cancelled: describeTimer(match) };
  }

  addItem(listName: string, item: string) {
    const state = this.store.data;
    const key = listKey(listName);
    const items = (state.lists[key] ||= []);
    if (
      items.some(
        (entry) => entry.text.toLowerCase() === item.trim().toLowerCase(),
      )
    )
      return {
        list: key,
        added: false,
        reason: "Staat er al op.",
        count: items.length,
      };
    if (items.length >= MAX_LIST_ITEMS) throw new Error("Die lijst is vol.");
    items.push({
      id: newId(),
      text: item.trim(),
      addedAt: new Date().toISOString(),
    });
    this.store.save();
    return { list: key, added: true, count: items.length };
  }

  showList(listName?: string) {
    if (listName) {
      const key = listKey(listName);
      return {
        list: key,
        items: (this.store.data.lists[key] || []).map(({ id, text }) => ({
          id,
          text,
        })),
      };
    }
    return { lists: this.lists() };
  }

  removeItem(listName: string, item: string) {
    const state = this.store.data;
    const key = listKey(listName);
    const items = state.lists[key] || [];
    const needle = item.trim().toLowerCase();
    const byId = items.filter((entry) => entry.id === needle);
    const exact = items.filter((entry) => entry.text.toLowerCase() === needle);
    const matches = byId.length
      ? byId
      : exact.length
        ? exact
        : items.filter((entry) => entry.text.toLowerCase().includes(needle));
    if (!matches.length)
      throw new Error(
        `Niets gevonden op de lijst ${key} dat past bij "${item}".`,
      );
    if (matches.length > 1)
      throw new Error(
        `Meerdere items passen: ${matches.map((entry) => entry.text).join(", ")}. Welke bedoel je?`,
      );
    const [match] = matches as [StoredListItem];
    const left = items.filter((entry) => entry !== match);
    if (left.length) state.lists[key] = left;
    else delete state.lists[key];
    this.store.save();
    return { list: key, removed: match.text };
  }

  clearList(listName: string) {
    const state = this.store.data;
    const key = listKey(listName);
    const count = (state.lists[key] || []).length;
    delete state.lists[key];
    this.store.save();
    return { list: key, cleared: count };
  }
}
