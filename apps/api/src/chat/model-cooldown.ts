const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 15 * 60_000;
const MAX_MODELS = 64;
interface CoolingModel {
  failures: number;
  retryAt: number;
  probing: boolean;
}

/** Bounded process-local transport health; OmniRoute still owns provider accounts and quota. */
export class ModelCooldown {
  private readonly models = new Map<string, CoolingModel>();

  acquire(model: string): { release(): void } | undefined {
    const state = this.models.get(model);
    if (!state) return { release() {} };
    if (state.probing || Date.now() < state.retryAt) return undefined;
    state.probing = true;
    return {
      release: () => {
        if (this.models.get(model) === state) state.probing = false;
      },
    };
  }

  /** True when a request to this model may go out now (not cooling, nobody probing). Does not take the lease. */
  canAcquire(model: string): boolean {
    const state = this.models.get(model);
    return !state || (!state.probing && Date.now() >= state.retryAt);
  }

  /** The candidate that is due to recover first; used as a last resort when every candidate is cooling. */
  soonest(models: string[]): string | undefined {
    let best: string | undefined;
    let bestAt = Infinity;
    for (const model of models) {
      const state = this.models.get(model);
      if (!state) return model;
      if (!state.probing && state.retryAt < bestAt) {
        best = model;
        bestAt = state.retryAt;
      }
    }
    return best;
  }

  /** Takes the lease even though the cooldown has not elapsed; one request at a time. */
  force(model: string): { release(): void } | undefined {
    const state = this.models.get(model);
    if (!state) return { release() {} };
    if (state.probing) return undefined;
    state.probing = true;
    return {
      release: () => {
        if (this.models.get(model) === state) state.probing = false;
      },
    };
  }

  success(model: string): void {
    this.models.delete(model);
  }

  failure(model: string, retryAfter?: string | null): void {
    const failures = Math.min(5, (this.models.get(model)?.failures ?? 0) + 1);
    const now = Date.now();
    let requestedDelay = 0;
    if (retryAfter && retryAfter.length <= 128) {
      const value = /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : Date.parse(retryAfter) - now;
      if (Number.isFinite(value)) requestedDelay = Math.max(0, value);
    }
    const delay = Math.min(
      MAX_DELAY_MS,
      Math.max(BASE_DELAY_MS * 2 ** (failures - 1), requestedDelay),
    );
    this.models.delete(model);
    this.models.set(model, { failures, retryAt: now + delay, probing: false });
    if (this.models.size > MAX_MODELS)
      this.models.delete(this.models.keys().next().value!);
  }
}
