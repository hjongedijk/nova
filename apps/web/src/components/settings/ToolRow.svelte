<script lang="ts">
  import type { ToolInfo } from "@nova/contracts";
  import { saveToolOverride } from "#lib/api/settings.ts";
  import Badge from "#components/ui/Badge.svelte";
  import Button from "#components/ui/Button.svelte";
  import Toggle from "#components/ui/Toggle.svelte";
  import { RISK_LABEL, riskTone } from "./labels.ts";
  import { afterChange, fail } from "./state.svelte.ts";

  let { tool }: { tool: ToolInfo } = $props();

  let editing = $state(false);
  let description = $state("");

  async function save(
    override: { enabled?: boolean; description?: string },
    box?: HTMLInputElement,
  ): Promise<void> {
    try {
      // The API only knows `enabled: false`; switched on again means no override for it.
      const body = {
        ...(override.enabled === false ? { enabled: false as const } : {}),
        ...(override.description !== undefined
          ? { description: override.description }
          : {}),
      };
      await saveToolOverride(tool.name, body);
      editing = false;
      await afterChange(`“${tool.name}” is bijgewerkt.`);
    } catch (error) {
      if (box) {
        box.checked = tool.enabled;
        box.disabled = false;
      }
      fail(error);
    }
  }

  function edit(): void {
    description = tool.description;
    editing = true;
  }
</script>

<li class="set-row" class:off={!tool.enabled}>
  <Toggle
    checked={tool.enabled}
    label="{tool.name} aan of uit"
    onchange={(on, box) => {
      box.disabled = true;
      void save(
        {
          enabled: on,
          ...(tool.edited ? { description: tool.description } : {}),
        },
        box,
      );
    }}
  />
  <div class="what">
    <strong>{tool.name}</strong>
    <Badge text={tool.source} />
    <Badge
      tone={riskTone(tool.risk)}
      text={RISK_LABEL[tool.risk] ?? tool.risk}
    />
    {#if tool.edited}<Badge tone="edited" text="aangepast" />{/if}
    <p>{tool.description}</p>
  </div>
  <div class="acts">
    <Button onclick={edit}>Beschrijving</Button>
  </div>
  {#if editing}
    <!-- svelte-ignore a11y_autofocus -->
    <textarea
      rows="4"
      aria-label="Beschrijving van {tool.name}"
      autofocus
      bind:value={description}></textarea>
    <div class="acts">
      <Button go onclick={() => save({ enabled: tool.enabled, description })}
        >Opslaan</Button
      >
      {#if tool.edited}
        <Button onclick={() => save({ enabled: tool.enabled })}
          >Standaard herstellen</Button
        >
      {/if}
      <Button onclick={() => (editing = false)}>Annuleren</Button>
    </div>
  {/if}
</li>
