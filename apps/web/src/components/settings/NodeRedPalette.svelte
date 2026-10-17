<script lang="ts">
  import { ApiError } from "#lib/api/client.ts";
  import { onDestroy } from "svelte";
  import {
    confirmNodeRedPalette,
    getNodeRedPalette,
    prepareNodeRedPalette,
    type NodeRedPaletteState,
  } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";

  let palette = $state<NodeRedPaletteState | null>(null);
  let busy = $state(false);
  let message = $state("");
  let pending = $state<{
    module: string;
    warning: string;
    action: Awaited<ReturnType<typeof prepareNodeRedPalette>>["action"];
  } | null>(null);
  let expired = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));

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

  async function prepare(module: string, install: boolean) {
    if (!palette) return;
    busy = true;
    try {
      const result = await prepareNodeRedPalette(
        module,
        install,
        palette.revision,
      );
      pending = { module, warning: result.warning, action: result.action };
      expired = false;
      clearTimeout(timer);
      timer = setTimeout(
        () => (expired = true),
        Math.max(0, result.action.expiresAt - Date.now()),
      );
    } catch (error) {
      message =
        error instanceof ApiError
          ? error.message
          : "Palettewijziging niet beschikbaar.";
    } finally {
      busy = false;
    }
  }

  async function confirm(approve: boolean) {
    const selected = pending;
    if (!selected) return;
    busy = true;
    try {
      const result = await confirmNodeRedPalette(
        selected.action.sessionId,
        selected.action.confirmationId,
        approve,
      );
      if (!result.ok) throw new Error(result.error);
      if (result.state) palette = result.state;
      message =
        approve && result.state
          ? result.pendingRestart
            ? `${selected.module}: versie klaargezet. Herstart Node-RED via Services om de versie actief te maken.`
            : result.verified === false
              ? `${selected.module} aangevraagd; controle ontbreekt.`
              : `${selected.module} gewijzigd en gecontroleerd.`
          : "Palettewijziging geannuleerd.";
    } catch (error) {
      message =
        error instanceof ApiError ? error.message : "Palettewijziging mislukt.";
    } finally {
      pending = null;
      clearTimeout(timer);
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
              <Button
                disabled={busy || pending !== null}
                onclick={() => prepare(module.name, true)}
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
              disabled={busy ||
                pending !== null ||
                (!module.installed && module.restartRequired)}
              onclick={() => prepare(module.name, !module.installed)}
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
  {#if pending}
    <div role="group" aria-label="Palettewijziging bevestigen">
      <p>{pending.warning}</p>
      <p>Module: <strong>{pending.module}</strong></p>
      {#if expired}<p>Bevestiging verlopen. Kies opnieuw.</p>{/if}
      <Button disabled={busy || expired} onclick={() => confirm(true)}
        >Ja, doorgaan</Button
      >
      <Button disabled={busy} onclick={() => confirm(false)}>Annuleren</Button>
    </div>
  {/if}
</section>
