<script lang="ts">
  import type { PublicWidget } from "@nova/contracts";
  import { ApiError } from "#lib/api/client.ts";
  import { pressWidgetButton } from "#lib/api/widgets.ts";
  import { ask } from "#lib/stores/chat.svelte.ts";
  import { showChrome } from "#lib/stores/chrome.svelte.ts";
  import { sidebar } from "#lib/stores/sidebar.svelte.ts";
  import { showToast } from "#lib/stores/toasts.svelte.ts";

  let { widget }: { widget: PublicWidget } = $props();

  let pressing = $state<number | null>(null);

  const data = $derived(sidebar.data[widget.id]);
  const live = $derived(widget.type === "value" || widget.type === "list");
  const stamp = $derived(
    live && data && !data.error && data.at
      ? new Date(data.at).toLocaleTimeString("nl-NL", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "",
  );

  async function press(index: number, label: string) {
    pressing = index;
    try {
      const result = await pressWidgetButton(widget.id, index);
      if (result.action === "ask") {
        showChrome();
        void ask(result.prompt);
      } else if (result.action === "link") {
        window.open(result.url, "_blank", "noopener");
      } else {
        showToast({
          severity: result.ok ? "info" : "warning",
          title: label,
          detail: result.message,
        });
      }
    } catch (error) {
      showToast({
        severity: "warning",
        title: "Deze knop werkt niet",
        detail:
          error instanceof ApiError || error instanceof Error
            ? error.message
            : "Dat is niet gelukt.",
      });
    } finally {
      pressing = null;
    }
  }
</script>

<section class="hud" data-panel="w:{widget.id}" aria-label={widget.title}>
  <h2>{widget.title} <em>{stamp}</em></h2>
  <div class="wbody">
    {#if widget.type === "note"}
      <p class="wnote">{widget.text}</p>
    {:else if widget.type === "buttons"}
      <div class="wbuttons">
        {#each widget.buttons as button, index (index)}
          <button
            type="button"
            class="wbtn"
            disabled={pressing === index}
            onclick={() => press(index, button.label)}>{button.label}</button
          >
        {/each}
      </div>
    {:else if !data}
      <p class="empty">Laden…</p>
    {:else if data.error}
      <p class="empty">{data.error}</p>
    {:else if widget.type === "value"}
      <div class="wvalue">
        <b
          >{typeof data.value === "number"
            ? data.value.toLocaleString("nl-NL")
            : data.value}</b
        >
        {#if widget.unit}<span>{widget.unit}</span>{/if}
      </div>
    {:else if !data.items?.length}
      <p class="empty">Leeg.</p>
    {:else}
      <ul>
        {#each data.items as text, i (i)}
          <li><i></i><span>{text}</span></li>
        {/each}
      </ul>
    {/if}
  </div>
</section>
