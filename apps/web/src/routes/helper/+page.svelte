<script lang="ts">
  import { onMount, tick } from "svelte";
  import Orb from "#components/helper/Orb.svelte";
  import HelperConfirm from "#components/helper/HelperConfirm.svelte";
  import { requestHelperSize } from "#lib/api/helper.ts";
  import { answerCard, cards } from "#lib/chat/cards.svelte.ts";
  import "#lib/chat/ask.ts";
  import { loadPublicConfig } from "#lib/chat/index.ts";
  import { parseReply } from "#lib/chat/markdown.ts";
  import { glowColor, MODE_LABELS } from "#lib/entity/states.ts";
  import { ask, chat } from "#lib/stores/chat.svelte.ts";
  import { shell } from "#lib/stores/shell.svelte.ts";
  import { toasts } from "#lib/stores/toasts.svelte.ts";
  import { playback } from "#lib/voice/audio.ts";
  import { pressCore } from "#lib/voice/core.ts";
  import { initRecognition } from "#lib/voice/recognition.ts";
  import { stopSpeaking } from "#lib/voice/speaker.ts";
  import { installAudioUnlock } from "#lib/voice/unlock.ts";
  import { initWake } from "#lib/voice/wake.ts";
  import "../../components/helper/helper.css";

  /** How long the helper stays open once nothing is going on. */
  const IDLE_MS = 12000;

  let input: HTMLInputElement | undefined = $state();
  let expanded = $state(false);
  let idle: ReturnType<typeof setTimeout> | undefined;
  // The answer stays readable until the helper collapses, also after the big stage would have cleared it.
  let lastYou = $state("");
  let lastAnswer = $state("");

  const blocks = $derived(parseReply(lastAnswer));
  const waiting = $derived(cards.some((card) => !card.done));
  const problem = $derived(toasts.items.find((t) => t.severity !== "info"));
  const status = $derived(
    problem?.title ||
      chat.hint ||
      (shell.awaiting ? "Ik luister…" : MODE_LABELS[chat.uiState]),
  );

  /** Something is going on that must not be hidden. */
  const busy = () =>
    chat.busy ||
    chat.uiState !== "ready" ||
    shell.awaiting ||
    !!playback.current ||
    cards.some((card) => !card.done) ||
    (document.activeElement === input && shell.draft.trim() !== "");

  function keepOpen(): void {
    clearTimeout(idle);
    idle = setTimeout(
      () => (busy() ? keepOpen() : (expanded = false)),
      IDLE_MS,
    );
  }
  function open(): void {
    expanded = true;
    keepOpen();
  }
  function close(): void {
    clearTimeout(idle);
    expanded = false;
    input?.blur();
  }

  // An answer or a question to confirm opens the helper by itself.
  $effect(() => {
    if (chat.reply) {
      lastAnswer = chat.reply;
      lastYou = chat.you;
      open();
    }
  });
  $effect(() => {
    if (waiting) open();
  });
  $effect(() => {
    if (chat.busy) open();
  });
  // Typing, talking and the voice all count as activity.
  $effect(() => {
    void shell.draft;
    void chat.uiState;
    if (expanded) keepOpen();
  });

  // Grow or shrink the window on the PC, and the page along with it.
  $effect(() => {
    void requestHelperSize(expanded);
    document.body.classList.toggle("expanded", expanded);
  });

  $effect(() => {
    document.body.dataset.state = chat.uiState;
    document.body.style.setProperty("--glow", glowColor(chat.uiState));
  });

  // After an answer the cursor is back in the field.
  let wasBusy = false;
  $effect(() => {
    const now = chat.busy;
    if (wasBusy && !now && expanded) queueMicrotask(() => input?.focus());
    wasBusy = now;
  });

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const text = shell.draft;
    shell.draft = "";
    void ask(text);
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      if (!expanded && chat.uiState === "speaking") stopSpeaking();
      close();
      return;
    }
    // Y / N answer the question on the screen, unless you are typing.
    const key = event.key.toLowerCase();
    const typing = event.target instanceof HTMLInputElement;
    const open = cards.find((card) => !card.locked);
    if (
      open &&
      !typing &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      (key === "y" || key === "n")
    ) {
      event.preventDefault();
      void answerCard(open.id, key === "y");
    }
  }

  /** A click on the island opens it and puts the cursor in the field. */
  function press(): void {
    open();
    void tick().then(() => input?.focus());
  }

  onMount(() => {
    document.body.classList.add("helper");
    initRecognition();
    const stops = [installAudioUnlock(), initWake()];
    void loadPublicConfig();
    return () => {
      stops.forEach((stop) => stop());
      clearTimeout(idle);
      document.body.classList.remove("helper");
    };
  });
</script>

<svelte:window onkeydown={onKey} />
<svelte:head><title>NOVA helper</title></svelte:head>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="hp"
  class:open={expanded}
  class:err={!!problem}
  onpointermove={() => expanded && keepOpen()}
>
  <div class="hp-bar" onpointerdown={() => !expanded && press()}>
    <button
      type="button"
      class="hp-core"
      aria-label="Spreken of spraak stoppen"
      title="Tik om te spreken"
      onclick={(event) => {
        event.stopPropagation();
        pressCore();
      }}
      onpointerdown={(event) => event.stopPropagation()}><Orb /></button
    >
    <p class="hp-status" role="status">
      <i class="dot" class:on={chat.uiState !== "ready"}></i>{status}
    </p>
    <button
      type="button"
      class="hp-icon hp-mic-compact"
      aria-label="Spreek met NOVA"
      hidden={!shell.speechSupported}
      class:on={chat.uiState === "listening"}
      onpointerdown={(event) => event.stopPropagation()}
      onclick={pressCore}
    >
      {@render micIcon()}
    </button>
  </div>

  <section class="hp-card" aria-label="NOVA" inert={!expanded}>
    <div class="hp-glow" aria-hidden="true"></div>
    {#if lastYou}<p class="hp-you">{lastYou}</p>{/if}
    <div class="hp-answer" aria-live="polite">
      {#each blocks as block, b (b)}
        {#if block.type === "ul"}
          <ul>
            {#each block.items as item, i (i)}
              <li>
                {#each item as w (w.index)}{w.space ? " " : ""}<span
                    class="w {w.cls}">{w.text}</span
                  >{/each}
              </li>
            {/each}
          </ul>
        {:else}
          <p class:h={block.heading}>
            {#each block.words as w (w.index)}{w.space ? " " : ""}<span
                class="w {w.cls}">{w.text}</span
              >{/each}
          </p>
        {/if}
      {:else}
        <p class="hp-empty">Vraag me iets. Zeg “Hey NOVA” of typ hieronder.</p>
      {/each}
      {#if chat.streaming}<span class="caret"></span>{/if}
    </div>
    <div class="hp-cards">
      {#each cards as card (card.id)}
        <HelperConfirm {card} />
      {/each}
    </div>
    <form class="hp-form" onsubmit={submit}>
      <div class="hp-field">
        <input
          bind:this={input}
          bind:value={shell.draft}
          autocomplete="off"
          aria-label="Bericht aan NOVA"
          placeholder={shell.wakeActive
            ? "Zeg “Hey NOVA” of typ…"
            : "Zeg of typ iets…"}
          disabled={chat.busy}
          onfocus={open}
        />
        <button
          type="submit"
          class="hp-send"
          aria-label="Verstuur"
          disabled={chat.busy || !shell.draft.trim()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"
            ><path d="M12 19V5M5 12l7-7 7 7" /></svg
          >
        </button>
      </div>
      <button
        type="button"
        class="hp-icon"
        aria-label="Spreek met NOVA"
        hidden={!shell.speechSupported}
        class:on={chat.uiState === "listening"}
        onclick={pressCore}
      >
        {@render micIcon()}
      </button>
      <button
        type="button"
        class="hp-icon"
        aria-label="Sluiten"
        title="Sluiten (Esc)"
        onclick={close}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"
          ><path d="M6 6l12 12M18 6L6 18" /></svg
        >
      </button>
    </form>
  </section>
</div>

{#snippet micIcon()}
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="9" y="3" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
{/snippet}
