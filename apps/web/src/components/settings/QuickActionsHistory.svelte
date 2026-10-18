<script lang="ts">
  import type { QuickAction, QuickActionHistory } from "@nova/contracts";
  import { onMount } from "svelte";
  import { ApiError } from "#lib/api/client.ts";
  import {
    getQuickActionsHistory,
    rollbackQuickActions,
  } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";
  import { afterChange } from "./state.svelte.ts";

  let {
    onRestored,
    loadOnMount = false,
  }: {
    onRestored?: (items: QuickAction[]) => void;
    loadOnMount?: boolean;
  } = $props();
  let history = $state<QuickActionHistory | null>(null);
  let busy = $state(false);
  let visible = $state(false);
  let message = $state("");
  let requestVersion = 0;

  onMount(() => {
    if (loadOnMount) void load();
  });

  export function isBusy(): boolean {
    return busy;
  }

  export function clear(): void {
    requestVersion++;
    history = null;
    visible = false;
    message = "";
    busy = false;
  }

  export async function load(): Promise<void> {
    if (busy) return;
    const version = ++requestVersion;
    visible = true;
    busy = true;
    message = "";
    history = null;
    try {
      const loaded = await getQuickActionsHistory();
      if (version === requestVersion) history = loaded;
    } catch (error) {
      if (version === requestVersion)
        message =
          error instanceof ApiError
            ? error.message
            : "De wijzigingsgeschiedenis is niet beschikbaar. Probeer opnieuw.";
    } finally {
      if (version === requestVersion) busy = false;
    }
  }

  async function rollback(id: string): Promise<void> {
    if (busy) return;
    busy = true;
    message = "";
    try {
      const result = await rollbackQuickActions(id);
      onRestored?.(result.quickActions);
      await afterChange(
        `Snelle opdrachten hersteld.${result.auditWarning ? ` ${result.auditWarning}` : ""}`,
        {
          kind: "quick-actions",
          items: result.quickActions,
          operation: "rollback",
        },
      );
      message = result.auditWarning
        ? "Snelle opdrachten hersteld; de auditmelding kon niet worden bevestigd."
        : "Snelle opdrachten hersteld.";
      history = await getQuickActionsHistory();
    } catch (error) {
      message =
        error instanceof ApiError
          ? error.message
          : "Herstellen of controleren is niet gelukt. Controleer de instellingen en probeer opnieuw.";
    } finally {
      busy = false;
    }
  }
</script>

{#if visible}
  <section aria-label="Geschiedenis snelle opdrachten">
    <h3>Geschiedenis</h3>
    {#if message}<p role="status">{message}</p>{/if}
    {#if busy}<p class="hint">Even wachten…</p>{/if}
    {#if history}
      {#if history.revisions.length}
        {#each history.revisions as revision (revision.id)}
          <details>
            <summary><time datetime={revision.at}>{revision.at}</time></summary>
            <p><strong>Voor</strong></p>
            {#each revision.before.items as action, index (`before-${index}`)}<p
              >
                {action.label}: {action.prompt}
              </p>{/each}
            <p><strong>Na</strong></p>
            {#each revision.after.items as action, index (`after-${index}`)}<p>
                {action.label}: {action.prompt}
              </p>{/each}
            <Button disabled={busy} onclick={() => rollback(revision.id)}
              >Herstel deze versie</Button
            >
          </details>
        {/each}
      {:else}<p class="hint">Nog geen wijzigingen bewaard.</p>{/if}
      {#if history.truncated}<p class="hint">
          Oudere wijzigingen ontbreken.
        </p>{/if}
    {/if}
  </section>
{/if}
