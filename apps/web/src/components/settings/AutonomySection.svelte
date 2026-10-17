<script lang="ts">
  import { onMount } from "svelte";
  import Button from "#components/ui/Button.svelte";
  import {
    approveAutonomyTask,
    cancelAutonomyTask,
    cancelAgentRun,
    getAgentRuns,
    getAutonomyLevel,
    getAutonomyTasks,
    respondAgentRun,
    setAutonomyLevel,
    type AgentRunView,
    type AutonomyLevel,
    type AutonomyTask,
  } from "#lib/api/autonomy.ts";
  import { fail, say } from "./state.svelte.ts";

  let tasks = $state<AutonomyTask[]>([]);
  let loaded = $state(false);
  let busy = $state(false);
  let level = $state<AutonomyLevel>("balanced");
  let runs = $state<AgentRunView[]>([]);
  let answer = $state<Record<string, string>>({});

  const LEVELS: { id: AutonomyLevel; name: string; text: string }[] = [
    {
      id: "careful",
      name: "Voorzichtig",
      text: "NOVA vraagt bij elke actie die iets verandert.",
    },
    {
      id: "balanced",
      name: "Gebalanceerd",
      text: "Gewone handelingen (licht, muziek, agenda, bellen naar je contacten) doet NOVA zelf.",
    },
    {
      id: "independent",
      name: "Zelfstandig",
      text: "Ook scripts, agenda verplaatsen en lijsten legen zonder te vragen. Gevaarlijke acties blijven altijd om toestemming vragen.",
    },
  ];

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
      runs = (await getAgentRuns()).runs ?? [];
      level = (await getAutonomyLevel()).level;
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
  <h2>Hoe zelfstandig is NOVA?</h2>
  <div class="levels" role="radiogroup" aria-label="Zelfstandigheid">
    {#each LEVELS as option (option.id)}
      <label class:on={level === option.id}>
        <input
          type="radio"
          name="autonomy-level"
          value={option.id}
          checked={level === option.id}
          disabled={busy}
          onchange={() =>
            act(async () => {
              level = (await setAutonomyLevel(option.id)).level;
            }, "Zelfstandigheid opgeslagen.")}
        />
        <strong>{option.name}</strong>
        <small>{option.text}</small>
      </label>
    {/each}
  </div>
  <p class="hint">
    Tekst van websites, mail of documenten zet NOVA drie minuten lang op
    voorzichtig, ongeacht deze keuze.
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
                  )}>Goedkeuren</Button
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
    Taken die NOVA zelf uitvoert, ook zonder nieuw bericht: eenmalig, herhalend
    of als er iets gebeurt. Risicovolle stappen wachten hier op jouw
    goedkeuring; gevaarlijke acties doet NOVA nooit zelf. Vraag NOVA in het
    gesprek om een taak te maken, bijvoorbeeld “herinner me elke maandag aan de
    vuilnisbakken”.
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
  .levels {
    display: grid;
    gap: 0.6rem;
    margin: 0.6rem 0;
  }
  .levels label {
    display: grid;
    gap: 0.15rem;
    border: 1px solid var(--line, #8883);
    border-radius: 8px;
    padding: 0.7rem 0.9rem;
    cursor: pointer;
  }
  .levels label.on {
    border-color: var(--accent, #4aa3ff);
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
