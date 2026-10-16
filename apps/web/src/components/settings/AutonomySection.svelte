<script lang="ts">
  import { onMount } from "svelte";
  import Button from "#components/ui/Button.svelte";
  import {
    approveAutonomyTask,
    cancelAutonomyTask,
    getAutonomyTasks,
    type AutonomyTask,
  } from "#lib/api/autonomy.ts";
  import { fail, say } from "./state.svelte.ts";

  let tasks = $state<AutonomyTask[]>([]);
  let loaded = $state(false);
  let busy = $state(false);

  const STATUS: Record<string, string> = {
    scheduled: "gepland",
    running: "bezig",
    waiting_approval: "wacht op goedkeuring",
    completed: "klaar",
    failed: "mislukt",
    cancelled: "geannuleerd",
  };
  const when = (value: string | null) =>
    value ? new Date(value).toLocaleString("nl-NL") : "-";

  async function load() {
    try {
      tasks = (await getAutonomyTasks()).tasks ?? [];
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
      await load();
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  });
</script>

<section class="autonomy" aria-label="Zelfstandige taken">
  <h2>Zelfstandige taken</h2>
  <p class="hint">
    Taken die NOVA zelf uitvoert, ook zonder nieuw bericht en na een herstart:
    eenmalig, herhalend of bij een gebeurtenis uit Node-RED (blok “NOVA taak
    starten”). Risicovolle stappen wachten hier op jouw goedkeuring; gevaarlijke
    acties worden nooit zelfstandig uitgevoerd. Vraag NOVA om een taak te maken.
  </p>
  {#if tasks.length}
    <ul class="tasks">
      {#each tasks as task (task.id)}
        <li>
          <strong>{task.title}</strong>
          · {STATUS[task.status] ?? task.status} · {task.trigger} · runs {task.runs}
          {#if task.nextRunAt}· volgende {when(task.nextRunAt)}{/if}
          <br />
          <small
            >Stappen: {task.steps
              .map((s) => `${s.tool} (${s.status})`)
              .join(", ")}</small
          >
          {#if task.last}<br /><small
              >Laatste run {when(task.last.at)}: {task.last.outcome}, {task.last
                .summary}</small
            >{/if}
          {#if task.waitingForApproval.length}
            <p role="alert">
              Wacht op goedkeuring voor: {task.waitingForApproval.join(", ")}
            </p>
            <Button
              type="button"
              disabled={busy}
              onclick={() =>
                act(() => approveAutonomyTask(task.id), "Stap goedgekeurd.")}
              >Goedkeuren</Button
            >
          {/if}
          <Button
            type="button"
            disabled={busy}
            onclick={() =>
              act(() => cancelAutonomyTask(task.id), "Taak geannuleerd.")}
            >Annuleren</Button
          >
        </li>
      {/each}
    </ul>
  {:else if loaded}<p>Geen zelfstandige taken.</p>
  {:else}<p>Laden…</p>{/if}
</section>

<style>
  .autonomy {
    margin: 1.5rem 0;
  }
  .tasks {
    list-style: none;
    padding: 0;
    display: grid;
    gap: 0.9rem;
  }
  .tasks li {
    border: 1px solid var(--line, #8883);
    border-radius: 8px;
    padding: 0.7rem 0.9rem;
  }
</style>
