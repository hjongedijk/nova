<script lang="ts">
  import { onMount } from "svelte";
  import { parseReply, type Word } from "#lib/chat/markdown.ts";
  import { registerStage } from "#lib/chat/stage.ts";
  import { MODE_LABELS } from "#lib/entity/states.ts";
  import { chat } from "#lib/stores/chat.svelte.ts";
  import { shell } from "#lib/stores/shell.svelte.ts";
  import { playback } from "#lib/voice/audio.ts";
  import { speechProgress } from "#lib/voice/speaker.ts";
  import Chips from "./Chips.svelte";
  import Dock from "./Dock.svelte";

  let stage: HTMLElement;
  let reply: HTMLElement | undefined = $state();

  const blocks = $derived(parseReply(chat.reply));
  const totalChars = $derived.by(() => {
    const last = blocks.at(-1);
    const words = last?.type === "ul" ? last.items.at(-1) : last?.words;
    return words?.at(-1)?.end ?? 0;
  });

  const idleHint = $derived(
    !shell.speechSupported
      ? "Spraak werkt in Chrome of Edge. Typ hieronder."
      : shell.wakeActive
        ? "Zeg “Hey NOVA”, tik op mij of typ hieronder."
        : "Tik op mij om te spreken, of typ hieronder.",
  );

  /** Words lit up so far, and whether the voice is playing (the answer dims until it is said). */
  let spoken = $state(0);
  let talking = $state(false);

  $effect(() => {
    if (!chat.reply) spoken = 0;
  });

  // Follow a growing answer.
  $effect(() => {
    void chat.reply;
    if (chat.streaming && reply)
      queueMicrotask(() => reply && (reply.scrollTop = reply.scrollHeight));
  });

  const wordsOf = (): Word[] =>
    blocks.flatMap((b) => (b.type === "ul" ? b.items.flat() : b.words));

  onMount(() => {
    registerStage(stage);
    // Read along with its own voice: the words light up as they are spoken.
    let frame = 0;
    const follow = () => {
      const audio = playback.current;
      const now = chat.uiState === "speaking" && !!audio && !audio.paused;
      if (now !== talking) talking = now;
      if (now && reply) {
        const words = wordsOf();
        const goal = Math.min(1, speechProgress() * 1.04) * totalChars;
        let n = spoken;
        while (n < words.length && words[n]!.end <= goal) n++;
        if (n !== spoken) {
          spoken = n;
          const el =
            reply.querySelectorAll<HTMLElement>(".w")[Math.max(0, n - 1)];
          if (el) {
            const box = reply.getBoundingClientRect();
            const r = el.getBoundingClientRect();
            if (r.bottom > box.bottom - 24 || r.top < box.top + 24)
              reply.scrollTo({
                top: reply.scrollTop + r.top - box.top - box.height / 2,
                behavior: "smooth",
              });
          }
        }
      }
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => {
      cancelAnimationFrame(frame);
      registerStage(null);
    };
  });
</script>

{#snippet words(list: Word[])}
  {#each list as w (w.index)}{w.space ? " " : ""}<span
      class="w {w.cls} new"
      class:said={w.index < spoken}>{w.text}</span
    >{/each}
{/snippet}

<main class="stage" bind:this={stage}>
  <p id="you">{chat.you}</p>
  <Chips />
  <div
    id="reply"
    bind:this={reply}
    class:long={chat.reply.length > 200 && chat.reply.length <= 560}
    class:xl={chat.reply.length > 560}
    class:speaking={talking}
  >
    {#each blocks as block, b (b)}
      {#if block.type === "ul"}
        <ul>
          {#each block.items as item, i (i)}
            <li>
              {@render words(
                item,
              )}{#if chat.streaming && b === blocks.length - 1 && i === block.items.length - 1}<span
                  class="caret"
                ></span>{/if}
            </li>
          {/each}
        </ul>
      {:else}
        <p class:h={block.heading}>
          {@render words(
            block.words,
          )}{#if chat.streaming && b === blocks.length - 1}<span class="caret"
            ></span>{/if}
        </p>
      {/if}
    {/each}{#if chat.streaming && blocks.length === 0}<span class="caret"
      ></span>{/if}
  </div>
  <Dock />
  <p class="status-line" role="status">
    <span id="mode">{MODE_LABELS[chat.uiState] ?? chat.uiState}</span>
    <span id="voiceHint">{chat.hint || idleHint}</span>
  </p>
</main>
