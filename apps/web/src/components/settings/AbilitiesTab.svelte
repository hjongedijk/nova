<script lang="ts">
  import type { Ability } from "@nova/contracts";
  import { setAbility } from "#lib/api/settings.ts";
  import { showChrome } from "#lib/stores/chrome.svelte.ts";
  import { ask } from "#lib/stores/chat.svelte.ts";
  import Badge from "#components/ui/Badge.svelte";
  import Button from "#components/ui/Button.svelte";
  import Toggle from "#components/ui/Toggle.svelte";
  import { afterChange, fail, settings } from "./state.svelte.ts";

  let { close }: { close: () => void } = $props();

  const abilities = $derived(settings.data?.abilities ?? []);

  async function flip(ability: Ability, on: boolean, box: HTMLInputElement) {
    box.disabled = true;
    try {
      await setAbility(ability.id, on);
      await afterChange(
        on
          ? `${ability.name} staat aan.`
          : `${ability.name} staat uit. NOVA doet dit nu niet meer.`,
      );
    } catch (error) {
      box.checked = !on;
      fail(error);
    } finally {
      box.disabled = false;
    }
  }

  // Closes the settings and says the sentence to NOVA, as if it was typed.
  function tryPhrase(text: string): void {
    close();
    showChrome();
    void ask(text);
  }
</script>

<p class="hint">
  Dit is alles wat NOVA nu voor je kan. Zet iets uit als NOVA dat niet mag doen.
  Met “Probeer” zeg je de voorbeeldzin meteen tegen NOVA.
</p>
<ul class="set-list">
  {#each abilities as ability (ability.id)}
    <li class="set-row" class:off={ability.state === "off"}>
      <Toggle
        checked={ability.state !== "off"}
        label="{ability.name} aan of uit"
        onchange={(on, box) => flip(ability, on, box)}
      />
      <div class="what">
        <strong>{ability.name}</strong>
        {#if ability.state === "partial"}
          <Badge text="{ability.enabledCount} van {ability.total} aan" />
        {/if}
        {#if ability.changes}
          <Badge tone="warn" text="vraagt eerst bevestiging" />
        {/if}
        <p>{ability.description}</p>
        {#if ability.example}
          <p>Zeg bijvoorbeeld: “{ability.example}”</p>
        {/if}
      </div>
      <div class="acts">
        {#if ability.example && ability.state !== "off"}
          <Button onclick={() => tryPhrase(ability.example ?? "")}
            >Probeer</Button
          >
        {/if}
      </div>
    </li>
  {/each}
</ul>
{#if abilities.length === 0}
  <p class="hint">NOVA is nog aan het opstarten.</p>
{/if}
