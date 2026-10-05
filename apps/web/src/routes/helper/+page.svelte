<script lang="ts">
  import { onMount } from "svelte";
  import Orb from "#components/helper/Orb.svelte";
  import ConfirmationCard from "#components/shell/ConfirmationCard.svelte";
  import { requestHelperSize } from "#lib/api/helper.ts";
  import { cards } from "#lib/chat/cards.svelte.ts";
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
    if (event.key !== "Escape") return;
    if (!expanded && chat.uiState === "speaking") stopSpeaking();
    close();
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
  onpointerdown={open}
  onpointermove={() => expanded && keepOpen()}
>
  <form class="hp-bar" onsubmit={submit}>
    <button
      type="button"
      class="hp-core"
      aria-label="Spreken of spraak stoppen"
      title="Tik om te spreken"
      onclick={pressCore}><Orb /></button
    >
    <div class="hp-mid">
      <p class="hp-status" role="status" class:bad={!!problem}>{status}</p>
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
    </div>
    <button
      type="button"
      class="hp-mic"
      aria-label="Spreek met NOVA"
      hidden={!shell.speechSupported}
      class:on={chat.uiState === "listening"}
      onclick={pressCore}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="9" y="3" width="6" height="12" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
    </button>
  </form>

  <section
    class="hp-body"
    aria-label="Laatste antwoord"
    aria-hidden={!expanded}
  >
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
        <p class="hp-empty">Vraag me iets. Zeg “Hey NOVA” of typ hierboven.</p>
      {/each}
      {#if chat.streaming}<span class="caret"></span>{/if}
    </div>
    <div class="hp-cards">
      {#each cards as card (card.id)}
        <ConfirmationCard {card} />
      {/each}
    </div>
  </section>
</div>
