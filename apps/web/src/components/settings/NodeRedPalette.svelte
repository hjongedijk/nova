<script lang="ts">
  import { ApiError } from "#lib/api/client.ts";
  import {
    getNodeRedPalette,
    changeNodeRedPalette,
    type NodeRedPaletteState,
  } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";

  let palette = $state<NodeRedPaletteState | null>(null);
  let busy = $state(false);
  let message = $state("");

  async function load() {
    busy = true;
    try {
      palette = await getNodeRedPalette();
      message = "";
    } catch (error) {
      message =
        error instanceof ApiError ? error.message : "Palette niet beschikbaar.";
    } finally {
      busy = false;
    }
  }

  async function change(module: string, install: boolean) {
    busy = true;
    message = "";
    try {
      const result = await changeNodeRedPalette(module, install);
      if (!result.ok) throw new Error(result.error);
      if (result.state) palette = result.state;
      message = result.pendingRestart
        ? `${module}: versie klaargezet. Herstart Node-RED via Services om de versie actief te maken.`
        : result.verified === false
          ? `${module} aangevraagd; controle ontbreekt.`
          : `${module} gewijzigd en gecontroleerd.`;
    } catch (error) {
      message =
        error instanceof ApiError ? error.message : "Palettewijziging mislukt.";
    } finally {
      busy = false;
    }
  }
</script>

<section aria-label="Node-RED-palette">
  <h4>Palette-nodes</h4>
  <p class="hint">
    Alleen modules die op de server zijn toegestaan. Installatie gebruikt de
    opgegeven vaste versie in Node-RED. Zonder vaste versie wordt de actuele
    npm-versie gebruikt.
  </p>
  <Button disabled={busy} onclick={load}>Palette laden</Button>
  {#if message}<p role="status">{message}</p>{/if}
  {#if palette}
    {#if palette.modules.length}
      <ul>
        {#each palette.modules as module (module.name)}
          <li>
            <strong>{module.name}</strong>
            · {module.installed
              ? `geïnstalleerd${module.version ? ` (${module.version})` : ""}`
              : "niet geïnstalleerd"}
            · {module.targetVersion
              ? `vaste versie ${module.targetVersion}`
              : "geen vaste versie"}
            {#if module.installed && !module.restartRequired && module.targetVersion && module.version !== module.targetVersion}
              <Button disabled={busy} onclick={() => change(module.name, true)}
                >Versie {module.targetVersion} installeren</Button
              >
            {/if}
            {#if module.restartRequired}
              <span
                >· wacht op herstart{module.pendingVersion
                  ? ` voor versie ${module.pendingVersion}`
                  : " (versie onbekend)"}</span
              >
            {/if}
            <Button
              disabled={busy || (!module.installed && module.restartRequired)}
              onclick={() => change(module.name, !module.installed)}
            >
              {module.installed ? "Verwijderen" : "Installeren"}
            </Button>
          </li>
        {/each}
      </ul>
      {#if palette.modules.some((module) => module.restartRequired)}
        <a href="/settings?section=geavanceerd#services"
          >Node-RED herstarten via Services</a
        >
      {/if}
    {:else}
      <p>Geen toegestane palette-modules ingesteld.</p>
    {/if}
  {/if}
</section>
