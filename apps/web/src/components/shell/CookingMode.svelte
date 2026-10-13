<script lang="ts">
  import { onMount } from "svelte";
  import { setCookingTimer } from "#lib/api/cooking.ts";
  import {
    beginCooking,
    cooking,
    endCooking,
    nextCookingStep,
    parseRecipe,
    previousCookingStep,
    readCookingStep,
  } from "#lib/cooking/session.svelte.ts";
  import { showToast } from "#lib/stores/toasts.svelte.ts";
  import { pressCore } from "#lib/voice/core.ts";

  let recipe = $state("");
  let minutes = $state(10);
  let timerBusy = $state(false);
  let timerNotice = $state("");
  let dialog: HTMLElement | undefined = $state();

  $effect(() => {
    if (cooking.open) queueMicrotask(() => dialog?.focus());
  });

  onMount(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && cooking.open) {
        event.preventDefault();
        cooking.open = false;
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  });

  function start(): void {
    const steps = parseRecipe(recipe);
    if (!steps.length) {
      showToast({
        severity: "warning",
        title: "Recept niet herkend",
        detail:
          "Zet elke stap op een eigen regel (maximaal 30 stappen, 400 tekens per stap).",
      });
      return;
    }
    timerNotice = "";
    beginCooking(steps);
  }

  async function startTimer(): Promise<void> {
    if (timerBusy || !Number.isInteger(minutes) || minutes < 1 || minutes > 240)
      return;
    timerBusy = true;
    timerNotice = "";
    try {
      await setCookingTimer(minutes, cooking.index + 1);
      timerNotice = `Timer voor stap ${cooking.index + 1}: ${minutes} minuten. NOVA meldt wanneer hij afloopt.`;
    } catch {
      timerNotice =
        "Timer starten mislukt. Controleer de verbinding en probeer opnieuw.";
    } finally {
      timerBusy = false;
    }
  }
</script>

{#if cooking.open}
  <section class="cooking-backdrop" aria-label="Kookmodus">
    <div
      class="cooking-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cooking-title"
      tabindex="-1"
      bind:this={dialog}
    >
      <div class="cooking-head">
        <h2 id="cooking-title">Kookmodus</h2>
        <button
          type="button"
          class="btn"
          aria-label="Kookmodus verbergen"
          onclick={() => (cooking.open = false)}>Sluiten</button
        >
      </div>
      {#if cooking.active}
        <p class="cooking-count">
          Stap {cooking.index + 1} van {cooking.steps.length}
        </p>
        <p class="cooking-step" aria-live="polite">
          {cooking.steps[cooking.index]}
        </p>
        <div class="cooking-actions">
          <button
            type="button"
            class="btn"
            disabled={cooking.index === 0}
            onclick={previousCookingStep}>Vorige</button
          >
          <button
            type="button"
            class="btn"
            onclick={() => void readCookingStep()}>Herhaal</button
          >
          <button type="button" class="btn" onclick={nextCookingStep}
            >Volgende stap</button
          >
          <button type="button" class="btn" onclick={pressCore}
            >🎙 Spreek commando</button
          >
        </div>
        <form
          class="cooking-timer"
          onsubmit={(event) => {
            event.preventDefault();
            void startTimer();
          }}
        >
          <label for="cooking-minutes">Timer voor deze stap</label>
          <input
            id="cooking-minutes"
            type="number"
            min="1"
            max="240"
            step="1"
            bind:value={minutes}
          />
          <span>minuten</span>
          <button
            type="submit"
            class="btn"
            disabled={timerBusy ||
              !Number.isInteger(minutes) ||
              minutes < 1 ||
              minutes > 240}>Start timer</button
          >
        </form>
        {#if timerNotice}<p role="status">{timerNotice}</p>{/if}
        <p class="cooking-help">
          Zeg na “Hey NOVA”: “volgende stap”, “herhaal” of “vorige stap”. Je
          kunt ook op “Spreek commando” tikken of F8 gebruiken. De microfoon
          blijft niet continu open.
        </p>
        <button type="button" class="btn" onclick={endCooking}
          >Kookmodus beëindigen</button
        >
      {:else}
        <p>
          Plak je recept. Zet elke stap op een eigen regel; NOVA leest ze één
          voor één voor.
        </p>
        <label for="cooking-recipe">Receptstappen</label>
        <textarea
          id="cooking-recipe"
          bind:value={recipe}
          maxlength="12000"
          rows="10"
          placeholder="1. Verwarm de oven voor.&#10;2. Meng de ingrediënten.&#10;3. Bak 20 minuten."
        ></textarea>
        <button type="button" class="btn" onclick={start}
          >Begin met stap 1</button
        >
      {/if}
    </div>
  </section>
{/if}

<style>
  .cooking-backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    display: grid;
    place-items: center;
    padding: 16px;
    background: rgba(3, 8, 18, 0.82);
  }
  .cooking-dialog {
    width: min(680px, 100%);
    max-height: min(760px, 92vh);
    overflow-y: auto;
    padding: clamp(20px, 4vw, 36px);
    border: 1px solid var(--line);
    background: #0d1523;
    color: var(--text);
    box-shadow: 0 20px 80px #0009;
  }
  .cooking-head,
  .cooking-actions,
  .cooking-timer {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .cooking-head {
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: 1.5rem;
  }
  .cooking-count {
    color: var(--glow);
    margin-top: 28px;
  }
  .cooking-step {
    font-size: clamp(1.4rem, 4vw, 2.2rem);
    line-height: 1.45;
    min-height: 4em;
    overflow-wrap: anywhere;
  }
  .cooking-actions {
    margin: 22px 0;
  }
  .cooking-timer {
    padding: 18px 0;
    border-top: 1px solid var(--line);
  }
  input,
  textarea {
    color: var(--text);
    background: #111d2a;
    border: 1px solid var(--line);
    padding: 10px;
    font: inherit;
  }
  input {
    width: 82px;
  }
  textarea {
    display: block;
    box-sizing: border-box;
    width: 100%;
    margin: 10px 0 20px;
    resize: vertical;
  }
  .cooking-help {
    color: var(--mist);
    line-height: 1.5;
  }
</style>
