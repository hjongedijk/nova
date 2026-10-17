<script lang="ts">
  import { onMount } from "svelte";
  import {
    MAX_INTERVAL,
    MIN_INTERVAL,
    deleteObjective,
    getObjectives,
    intervalLabel,
    objectiveStatus,
    templateLabel,
    updateObjective,
    validInterval,
    validQuietHours,
    type ObjectivePatch,
    type ObjectiveView,
  } from "#lib/api/objectives.ts";
  import { fail, say } from "./state.svelte.ts";
  import SectionCard from "./ui/SectionCard.svelte";
  import Field from "./ui/Field.svelte";
  import StatusPill from "./ui/StatusPill.svelte";
  import Disclosure from "./ui/Disclosure.svelte";
  import DangerZone from "./ui/DangerZone.svelte";

  let objectives = $state<ObjectiveView[]>([]);
  let loaded = $state(false);
  let busy = $state(false);
  let confirming = $state<string | null>(null);
  let interval = $state<Record<string, string>>({});
  let quiet = $state<Record<string, string>>({});

  const when = (value?: string) =>
    value ? new Date(value).toLocaleString("nl-NL") : "nog niet";

  async function load() {
    try {
      objectives = (await getObjectives()).objectives ?? [];
      loaded = true;
    } catch (cause) {
      fail(cause);
    }
  }
  async function act(run: () => Promise<unknown>, message: string) {
    busy = true;
    try {
      await run();
      say(message, "ok");
      confirming = null;
      await load();
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }
  const patch = (o: ObjectiveView, body: ObjectivePatch, message: string) =>
    act(() => updateObjective(o.id, body), message);

  function saveSettings(o: ObjectiveView) {
    const body: ObjectivePatch = {};
    const minutes = Number(interval[o.id] ?? o.intervalMinutes);
    if (minutes !== o.intervalMinutes) {
      if (!validInterval(minutes))
        return say(
          `Kies een heel aantal minuten van ${MIN_INTERVAL} tot ${MAX_INTERVAL}.`,
          "bad",
        );
      body.intervalMinutes = minutes;
    }
    const hours = (quiet[o.id] ?? o.quietHours).trim();
    if (hours !== o.quietHours) {
      if (!validQuietHours(hours))
        return say("Stille uren: “uit” of bijvoorbeeld “23:00-07:00”.", "bad");
      body.quietHours = hours;
    }
    if (!Object.keys(body).length) return say("Niets gewijzigd.", "ok");
    return patch(o, body, "Doel bijgewerkt.");
  }

  onMount(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  });
</script>

<SectionCard
  title="Doelen"
  lead="Een doel is iets dat NOVA blijft controleren, zonder dat je het opnieuw vraagt. NOVA meldt alleen als er iets afwijkt. Een doel maak je door het te zeggen, bijvoorbeeld: “houd mijn servers in de gaten”."
>
  {#if !loaded}
    <p class="hint">Laden…</p>
  {:else if !objectives.length}
    <p class="hint">Je hebt nog geen doelen.</p>
  {:else}
    <ul class="goals">
      {#each objectives as o (o.id)}
        {@const status = objectiveStatus(o)}
        <li>
          <div class="head">
            <strong>{o.title}</strong>
            <StatusPill tone={status.tone} label={status.label} />
          </div>
          <p class="meta">
            {templateLabel(o)} · {intervalLabel(o.intervalMinutes)} · stille uren
            {o.quietHours}
          </p>
          <p class="meta">
            Laatste controle: {when(
              o.lastResult?.at,
            )}{#if o.lastResult?.summary}
              · {o.lastResult.summary}{/if}
          </p>
          {#if o.activeAnomaly && !o.activeAnomaly.dismissed}
            <p role="alert" class="alert">{o.activeAnomaly.detail}</p>
          {/if}
          <p class="meta">
            {o.counters.checks} controles · {o.counters.anomalies} afwijkingen ·
            {o.counters.falseAlarms} valse alarmen
          </p>
          {#if o.lastInvestigation}
            <p class="meta">
              Laatste onderzoek ({when(o.lastInvestigation.at)}): {o
                .lastInvestigation.summary ?? "geen samenvatting"}
            </p>
          {/if}

          <div class="actions">
            {#if !o.fulfilledAt}
              {#if o.enabled}
                <button
                  type="button"
                  disabled={busy}
                  onclick={() =>
                    patch(o, { enabled: false }, "Doel gepauzeerd.")}
                  >Pauzeren</button
                >
              {:else}
                <button
                  type="button"
                  disabled={busy}
                  onclick={() => patch(o, { enabled: true }, "Doel hervat.")}
                  >Hervatten</button
                >
              {/if}
            {/if}
            {#if o.activeAnomaly && !o.activeAnomaly.dismissed}
              <button
                type="button"
                disabled={busy}
                onclick={() =>
                  patch(o, { dismiss: true }, "Gemarkeerd als valse alarm.")}
                >Valse alarm</button
              >
            {/if}
          </div>

          <Disclosure title="Instellingen" hint="Hoe vaak en wanneer niet">
            <Field
              label="Controleren elke (minuten)"
              id="interval-{o.id}"
              hint="Tussen {MIN_INTERVAL} en {MAX_INTERVAL} minuten."
            >
              <input
                id="interval-{o.id}"
                type="number"
                inputmode="numeric"
                min={MIN_INTERVAL}
                max={MAX_INTERVAL}
                value={interval[o.id] ?? String(o.intervalMinutes)}
                oninput={(e) => (interval[o.id] = e.currentTarget.value)}
                aria-describedby="interval-{o.id}-hint"
              />
            </Field>
            <Field
              label="Stille uren"
              id="quiet-{o.id}"
              hint="Dan meldt NOVA niets. Typ “uit” of bijvoorbeeld 23:00-07:00."
            >
              <input
                id="quiet-{o.id}"
                type="text"
                autocomplete="off"
                value={quiet[o.id] ?? o.quietHours}
                oninput={(e) => (quiet[o.id] = e.currentTarget.value)}
                aria-describedby="quiet-{o.id}-hint"
              />
            </Field>
            <button
              type="button"
              class="go"
              disabled={busy}
              onclick={() => saveSettings(o)}>Opslaan</button
            >
          </Disclosure>

          <DangerZone title="Verwijderen">
            {#if confirming === o.id}
              <p role="alert">
                Doel “{o.title}” definitief verwijderen? De bijbehorende
                geschiedenis verdwijnt ook.
              </p>
              <div class="actions">
                <button
                  type="button"
                  disabled={busy}
                  onclick={() =>
                    act(() => deleteObjective(o.id), "Doel verwijderd.")}
                  >Ja, verwijderen</button
                >
                <button
                  type="button"
                  disabled={busy}
                  onclick={() => (confirming = null)}>Annuleren</button
                >
              </div>
            {:else}
              <button
                type="button"
                disabled={busy}
                onclick={() => (confirming = o.id)}>Verwijderen</button
              >
            {/if}
          </DangerZone>
        </li>
      {/each}
    </ul>
  {/if}
</SectionCard>

<style>
  .goals {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 1rem;
  }
  .goals li {
    border: 1px solid var(--line);
    border-radius: var(--radius-s, 8px);
    padding: 1rem;
    min-width: 0;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
    align-items: center;
    justify-content: space-between;
  }
  .head strong {
    font-size: 17px;
    overflow-wrap: anywhere;
  }
  .meta,
  .hint {
    margin: 0.35rem 0;
    font-size: 16px;
    color: var(--dim);
    overflow-wrap: anywhere;
  }
  .alert {
    margin: 0.5rem 0;
    font-size: 16px;
    color: var(--amber);
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.75rem 0;
  }
</style>
