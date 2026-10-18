<script lang="ts">
  import { ApiError } from "#lib/api/client.ts";
  import type { NodeRedBriefingSchedule } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import { sessionId } from "#components/admin/session.ts";
  import { executeAction } from "#lib/api/admin.ts";
  let {
    briefing,
    onSaved,
  }: { briefing: NodeRedBriefingSchedule; onSaved: () => Promise<void> } =
    $props();
  let time = $state("");
  let timezone = $state("");
  let daily = $state(true);
  let busy = $state(false);
  let message = $state("");
  const label = $derived(
    briefing.kind === "evening_review" ? "Avondoverzicht" : "Ochtendbriefing",
  );
  $effect(() => {
    time = briefing.time || "07:30";
    timezone = briefing.timezone;
    daily = Boolean(briefing.time);
  });
  async function save() {
    busy = true;
    message = "";
    try {
      const result = await executeAction(
        sessionId(),
        "node_red_briefing_schedule",
        { nodeId: briefing.id, time: daily ? time : "", timezone },
      );
      if (!result.ok) {
        if ("accepted" in result && result.accepted === true) await onSaved();
        throw new Error(result.error || "Planning niet gewijzigd.");
      } else {
        message = "Planning opgeslagen.";
        await onSaved();
      }
    } catch (error) {
      message =
        error instanceof ApiError ? error.message : "Planning niet gewijzigd.";
    } finally {
      busy = false;
    }
  }
</script>

<section class="briefing" aria-label={`${label} planning`}>
  <strong>{label}</strong>
  <p>
    {briefing.time
      ? `Dagelijks om ${briefing.time}`
      : "Alleen gekoppelde gebeurtenissen"} · {briefing.timezone}
  </p>
  {#if briefing.manageable}
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label class="daily"
        ><input type="checkbox" bind:checked={daily} disabled={busy} /> Dagelijks
        overzicht</label
      >
      <div class="fields">
        {#if daily}<label
            >Tijd <input
              type="time"
              bind:value={time}
              required
              disabled={busy}
              aria-label={`Tijd voor ${label.toLowerCase()}`}
            /></label
          >{/if}
        <label
          >Tijdzone <input
            type="text"
            bind:value={timezone}
            maxlength="100"
            required
            disabled={busy}
            aria-label={`Tijdzone voor ${label.toLowerCase()}`}
          /></label
        >
        <Button type="submit" disabled={busy}
          >{busy ? "Opslaan…" : "Planning opslaan"}</Button
        >
      </div>
      {#if !daily}<small
          >De briefing blijft beschikbaar voor gekoppelde gebeurtenissen.</small
        >{/if}
    </form>
  {/if}
  {#if message}<p role="status">{message}</p>{/if}
</section>

<style>
  .briefing {
    margin-block: 0.75rem;
    padding: 0.9rem;
    border: 1px solid var(--border, #303742);
    border-radius: 0.65rem;
  }
  p {
    margin: 0.4rem 0;
  }
  .fields {
    display: flex;
    flex-wrap: wrap;
    gap: 0.7rem;
    align-items: end;
    margin-top: 0.65rem;
  }
  .fields label {
    display: grid;
    gap: 0.3rem;
    min-width: 0;
  }
  .fields input {
    max-width: 100%;
  }
  .daily {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
</style>
