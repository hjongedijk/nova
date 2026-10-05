<script lang="ts">
  import type { WallpaperMode, WallpaperState } from "@nova/contracts";
  import { getWallpaper, setWallpaper } from "#lib/api/settings.ts";
  import { IS_IOS, IS_MOBILE } from "#lib/stores/device.ts";
  import { secureBase } from "#lib/stores/shell.svelte.ts";
  import {
    installState,
    onInstallStateChange,
    promptInstall,
  } from "#lib/modes/pwa.ts";
  import Badge from "#components/ui/Badge.svelte";
  import Button from "#components/ui/Button.svelte";
  import { fail, say } from "./state.svelte.ts";

  const MODES: [WallpaperMode, string][] = [
    ["off", "Uit"],
    ["full", "NOVA met panelen"],
    ["sphere", "Alleen de bol"],
  ];

  let install = $state(installState());
  $effect(() => onInstallStateChange(() => (install = installState())));

  let wallpaper = $state<WallpaperState | null>(null);
  // The picker being applied (its screen number), so only that one is locked.
  let applying = $state<number | null>(null);

  $effect(() => {
    getWallpaper().then(
      (data) => (wallpaper = data),
      (error: unknown) =>
        (wallpaper = {
          available: false,
          reason: "unreachable",
          error: error instanceof Error ? error.message : undefined,
        }),
    );
  });

  async function apply(display: number, mode: WallpaperMode): Promise<void> {
    applying = display;
    say("Even geduld, het venster wordt achter je bureaublad gezet…");
    try {
      wallpaper = await setWallpaper(display, mode);
      say(
        mode === "off"
          ? "De achtergrond is uitgezet."
          : "NOVA staat achter je bureaublad.",
        "ok",
      );
    } catch (error) {
      fail(error);
    } finally {
      applying = null;
    }
  }

  function why(data: Extract<WallpaperState, { available: false }>): string {
    return {
      "no-agent":
        "NOVA heeft nog geen verbinding met je Windows-pc. Installeer de Windows-agent uit de map integrations/windows-agent en zet WINDOWS_AGENT_URL en WINDOWS_AGENT_TOKEN in .env.",
      "old-agent":
        "De Windows-agent op je pc is nog oud. Download jarvis-agent.ps1, zet hem in de map van de agent op je pc (bijvoorbeeld C:\\JarvisAgent) en start daarna de taak JarvisAgent opnieuw.",
      unreachable: `NOVA bereikt de Windows-agent niet${data.error ? `: ${data.error}` : "."}`,
    }[data.reason];
  }

  const how = IS_IOS
    ? "Tik in Safari op Deel en kies “Zet op beginscherm”."
    : IS_MOBILE
      ? "Open het menu van Chrome en kies “App installeren” of “Toevoegen aan startscherm”."
      : "Klik op het installatie-icoon rechts in de adresbalk van Chrome of Edge, of kies Menu, Opslaan en delen, “Installeren als app”.";
</script>

{#snippet picker(label: string, display: number, current: WallpaperMode | "")}
  <select
    aria-label="Achtergrond op {label}"
    disabled={applying === display}
    value={current}
    onchange={(event) =>
      apply(display, event.currentTarget.value as WallpaperMode)}
  >
    {#if current === ""}
      <option value="" disabled selected>Kies…</option>
    {/if}
    {#each MODES as [value, text] (value)}
      <option {value}>{text}</option>
    {/each}
  </select>
{/snippet}

<section>
  <h3>NOVA als app</h3>
  <p class="hint">
    Een app opent in een eigen venster of op je beginscherm, zonder adresbalk.
    Dit werkt op Windows, Mac, Android en iPhone.
  </p>
  {#if install === "installed"}
    <p class="hint">NOVA draait al als app op dit apparaat.</p>
  {:else}
    <div>
      {#if install === "available"}
        <Button go onclick={() => promptInstall()}
          >Installeer NOVA als app</Button
        >
      {:else}
        <p class="hint">{how}</p>
      {/if}
      {#if !window.isSecureContext}
        <p class="hint">
          Je gebruikt nu een onbeveiligde verbinding. Open NOVA via {secureBase()}
          om de app te kunnen installeren.
        </p>
      {/if}
    </div>
  {/if}

  <h3>NOVA als bureaublad-achtergrond</h3>
  <p class="hint">
    Je Windows-pc laat NOVA bewegen achter je bureaubladiconen, per beeldscherm.
    Je eigen achtergrond blijft ongemoeid: zet je het uit, dan zie je die weer.
    Het gebruikt de Windows-agent die NOVA al heeft. Je kunt er gewoon mee
    praten (klik op de bol of zeg “Hey NOVA”) en typen (klik op het invoerveld
    onderaan).
  </p>
  <div>
    {#if !wallpaper}
      <p class="hint">Beeldschermen opzoeken…</p>
    {:else if !wallpaper.available}
      <p class="hint">{why(wallpaper)}</p>
      {#if wallpaper.reason === "old-agent"}
        <Button
          go
          href="/windows-agent/jarvis-agent.ps1"
          download="jarvis-agent.ps1">Download de nieuwe agent</Button
        >
      {/if}
    {:else}
      <ul class="set-list">
        {#each wallpaper.displays as screen (screen.index)}
          <li class="set-row" class:off={screen.mode === "off"}>
            <span></span>
            <div class="what">
              <strong>Beeldscherm {screen.index}</strong>
              {#if screen.primary}<Badge text="hoofdscherm" />{/if}
              <p>{screen.width} × {screen.height}</p>
            </div>
            <div class="acts">
              {@render picker(
                `beeldscherm ${screen.index}`,
                screen.index,
                screen.mode,
              )}
            </div>
          </li>
        {/each}
        {#if wallpaper.displays.length > 1}
          <li class="set-row">
            <span></span>
            <div class="what"><strong>Alle beeldschermen</strong></div>
            <div class="acts">
              {@render picker("alle beeldschermen", 0, "")}
            </div>
          </li>
        {/if}
      </ul>
    {/if}
  </div>
  <div class="set-toolbar">
    <Button href="/windows-agent/jarvis-agent.ps1" download="jarvis-agent.ps1"
      >Download de nieuwste Windows-agent</Button
    >
  </div>
  <p class="hint">
    Een nieuwere agent installeren: overschrijf jarvis-agent.ps1 in de map van
    de agent op je pc (bijvoorbeeld C:\JarvisAgent) en start de taak JarvisAgent
    opnieuw in Taakplanner.
  </p>
</section>
