<script lang="ts">
  import { onMount } from "svelte";
  import Button from "#components/ui/Button.svelte";
  import {
    approveAutonomyTask,
    cancelAutonomyTask,
    cancelAgentRun,
    getAgentRuns,
    getAutonomyTasks,
    respondAgentRun,
    type AgentRunView,
    type AutonomyTask,
  } from "#lib/api/autonomy.ts";
  import { fail, say } from "./state.svelte.ts";

  let tasks = $state<AutonomyTask[]>([]);
  let loaded = $state(false);
  let busy = $state(false);
  let runs = $state<AgentRunView[]>([]);
  let answer = $state<Record<string, string>>({});

  const STATUS: Record<string, string> = {
    scheduled: "gepland",
    running: "bezig",
    waiting_approval: "onderbroken taak uit eerdere versie",
    completed: "klaar",
    failed: "mislukt",
    cancelled: "geannuleerd",
  };
  const when = (value: string | null) =>
    value ? new Date(value).toLocaleString("nl-NL") : "-";

  async function load() {
    try {
      tasks = (await getAutonomyTasks()).tasks ?? [];
      runs = (await getAgentRuns()).runs ?? [];
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

<section class="autonomy" aria-label="Zelfstandigheid">
  <p class="hint">
    NOVA draait volledig zelfstandig: acties worden direct uitgevoerd en
    achteraf gemeld. Zeg het als iets niet klopt, dan leert NOVA ervan.
  </p>

  <h2>Opdrachten op de achtergrond</h2>
  {#if runs.length}
    <ul class="tasks">
      {#each runs as run (run.id)}
        <li>
          <strong>{run.goal}</strong> · {run.status} · beurten {run.turns}
          {#if run.result}<br /><small>{run.result}</small
            >{:else if run.lastStep}<br /><small>{run.lastStep}</small>{/if}
          {#if run.waitingFor}
            <p role="alert">{run.waitingFor.text}</p>
            {#if run.waitingFor.kind === "approval"}
              <Button
                type="button"
                disabled={busy}
                onclick={() =>
                  act(
                    () => respondAgentRun(run.id, { approve: true }),
                    "Goedgekeurd.",
                  )}>Hervatten</Button
              >
              <Button
                type="button"
                disabled={busy}
                onclick={() =>
                  act(
                    () => respondAgentRun(run.id, { approve: false }),
                    "Geweigerd.",
                  )}>Weigeren</Button
              >
            {:else}
              <input type="text" bind:value={answer[run.id]} maxlength="400" />
              <Button
                type="button"
                disabled={busy || !answer[run.id]?.trim()}
                onclick={() =>
                  act(
                    () => respondAgentRun(run.id, { answer: answer[run.id] }),
                    "Antwoord verstuurd.",
                  )}>Antwoorden</Button
              >
            {/if}
          {/if}
          {#if run.status === "running" || run.status === "waiting" || run.status === "interrupted"}
            <Button
              type="button"
              disabled={busy}
              onclick={() => act(() => cancelAgentRun(run.id), "Gestopt.")}
              >Stoppen</Button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {:else if loaded}<p class="hint">
      Geen. Zeg bijvoorbeeld “zoek uit wat de goedkoopste route is en laat het
      me weten”.
    </p>{/if}

  <h2>Zelfstandige taken</h2>
  <p class="hint">
    NOVA voert taken zelfstandig uit: eenmalig, herhalend of na een gebeurtenis.
    Vraag bijvoorbeeld: “herinner me elke maandag aan de vuilnisbakken”.
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
              Oude onderbroken stappen: {task.waitingForApproval.join(", ")}
            </p>
            <Button
              type="button"
              disabled={busy}
              onclick={() =>
                act(() => approveAutonomyTask(task.id), "Taak hervat.")}
              >Hervatten</Button
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
