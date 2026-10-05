<script lang="ts">
  import { ask, chat } from "#lib/stores/chat.svelte.ts";
  import { shell } from "#lib/stores/shell.svelte.ts";
</script>

<div
  id="chips"
  class="chips"
  aria-label="Snelle opdrachten"
  hidden={Boolean(chat.reply || chat.streaming)}
>
  {#each shell.quickActions as item (item.label)}
    <button
      type="button"
      class="chip"
      disabled={chat.busy}
      onclick={() => ask(item.prompt)}>{item.label}</button
    >
  {/each}
</div>
