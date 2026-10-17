<script lang="ts">
  import Disclosure from "./ui/Disclosure.svelte";
  import type {
    HelperModeHistory,
    WallpaperHistory,
    HelperMode,
    HelperSettings,
    WallpaperMode,
    WallpaperState,
  } from "@nova/contracts";
  import {
    getHelper,
    getHelperModeHistory,
    getWallpaper,
    getWallpaperHistory,
    rollbackHelperModeRevision,
    setHelper,
    setWallpaper,
    rollbackWallpaper,
  } from "#lib/api/settings.ts";
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
  let wallpaperHistory = $state<WallpaperHistory | null>(null);
  let wallpaperHistoryBusy = $state(false);

  $effect(() => {
    getWallpaper().then(
      (data) => (wallpaper = data),
      () =>
        (wallpaper = {
          available: false,
          reason: "unreachable",
          error: "De pc-instellingen zijn nu niet bereikbaar.",
        }),
    );
  });

  const CHOICES: [HelperMode, string, string][] = [
    [
      "wallpaper",
      "Achtergrond",
      "NOVA beweegt achter je bureaubladiconen, zoals hieronder ingesteld.",
    ],
    [
      "helper",
      "Helper",
      "Een klein helpervenster met gesprek, meldingen en overzicht.",
    ],
    ["both", "Beide", "De achtergrond én het balkje er bovenop."],
  ];

  // Wat NOVA onthoudt (ook als de pc uit staat) en wat de pc nu doet.
  let helper = $state<HelperSettings>({ mode: "wallpaper", display: 0 });
  let helperBusy = $state(false);
  let helperHistory = $state<HelperModeHistory | null>(null);
  let helperHistoryBusy = $state(false);

  $effect(() => {
    getHelper().then(
      (data) => (helper = data.settings),
      () => {},
    );
  });

  async function applyHelper(next: HelperSettings): Promise<void> {
    const before = helper;
    helper = next;
    helperBusy = true;
    say("Even geduld, de pc wordt aangepast…");
    try {
      const result = await setHelper(next.mode, next.display);
      helper = result.settings;
      wallpaper = result.desktop;
      if (result.historyWarning) say(result.historyWarning, "bad");
      else if (result.applied)
        say(
          next.mode === "wallpaper"
            ? "NOVA staat als achtergrond."
            : "De helper staat bovenaan je scherm.",
          "ok",
        );
      else
        say(
          `Opgeslagen, maar nog niet op de pc: ${result.error ?? "geen verbinding"}. Het wordt toegepast zodra je het opnieuw kiest.`,
        );
    } catch (error) {
      helper = before;
      fail(error);
    } finally {
      helperBusy = false;
    }
  }

  async function loadHelperHistory(): Promise<void> {
    helperHistoryBusy = true;
    try {
      helperHistory = await getHelperModeHistory();
    } catch (error) {
      fail(error);
    } finally {
      helperHistoryBusy = false;
    }
  }

  async function rollbackHelperHistory(id: string): Promise<void> {
    if (!window.confirm("Deze helperkeuze terugzetten?")) return;
    helperBusy = true;
    try {
      const result = await rollbackHelperModeRevision(id);
      helper = result.settings;
      wallpaper = result.desktop;
      await loadHelperHistory();
      say(
        result.historyWarning ??
          (result.applied
            ? "Helperkeuze teruggezet en toegepast."
            : `Helperkeuze opgeslagen, maar niet op de pc toegepast: ${result.error ?? "geen verbinding"}.`),
        result.historyWarning ? "bad" : result.applied ? "ok" : undefined,
      );
    } catch (error) {
      fail(error);
    } finally {
      helperBusy = false;
    }
  }

  async function apply(display: number, mode: WallpaperMode): Promise<void> {
    applying = display;
    say("Even geduld, het venster wordt achter je bureaublad gezet…");
    try {
      wallpaper = await setWallpaper(display, mode);
      if (wallpaper.historyWarning) say(wallpaper.historyWarning, "bad");
      else
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

  async function loadWallpaperHistory(): Promise<void> {
    wallpaperHistoryBusy = true;
    try {
      wallpaperHistory = await getWallpaperHistory();
    } catch (error) {
      fail(error);
    } finally {
      wallpaperHistoryBusy = false;
    }
  }

  async function restoreWallpaper(id: string): Promise<void> {
    if (!window.confirm("Deze achtergrondkeuze terugzetten?")) return;
    wallpaperHistoryBusy = true;
    try {
      wallpaper = await rollbackWallpaper(id);
      await loadWallpaperHistory();
      say(
        wallpaper.historyWarning ?? "Achtergrondkeuze teruggezet.",
        wallpaper.historyWarning ? "bad" : "ok",
      );
    } catch (error) {
      fail(error);
    } finally {
      wallpaperHistoryBusy = false;
    }
  }

  function why(data: Extract<WallpaperState, { available: false }>): string {
    return {
      "no-agent":
        "NOVA heeft nog geen verbinding met je Windows-pc. Installeer de Windows-agent uit de map agents/windows en zet WINDOWS_AGENT_URL en WINDOWS_AGENT_TOKEN in .env.",
      "old-agent":
        "De Windows-agent op je pc is nog oud. Download nova-agent.ps1, zet hem in de map van de agent op je pc (bijvoorbeeld C:\\NOVAAgent) en start daarna NOVAAgent opnieuw in Taakplanner.",
      unreachable:
        "NOVA bereikt de Windows-agent niet. Controleer de verbinding en probeer het opnieuw.",
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
    disabled={applying === display || helper.mode === "helper"}
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
  <h2>NOVA als app</h2>
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

  <h2>NOVA op je Windows-pc</h2>
  <p class="hint">
    Kies wat je pc laat zien: NOVA als levende achtergrond, een kleine helper
    bovenaan je scherm (de bol, een invoerveld en de microfoon; hij klapt open
    voor een antwoord of een vraag om te bevestigen en sluit zichzelf weer), of
    allebei.
  </p>
  <fieldset class="helper-choice" disabled={helperBusy}>
    <legend class="sr-only">Wat toont je pc?</legend>
    {#each CHOICES as [value, text, detail] (value)}
      <label class:picked={helper.mode === value}>
        <input
          type="radio"
          name="helperMode"
          {value}
          checked={helper.mode === value}
          onchange={() => applyHelper({ ...helper, mode: value })}
        />
        <strong>{text}</strong>
        <small>{detail}</small>
      </label>
    {/each}
  </fieldset>
  {#if helper.mode !== "wallpaper"}
    <div class="helper-display">
      <label for="helperDisplay">Helper op</label>
      <select
        id="helperDisplay"
        disabled={helperBusy}
        value={helper.display}
        onchange={(event) =>
          applyHelper({
            ...helper,
            display: Number(event.currentTarget.value),
          })}
      >
        <option value={0}>Hoofdscherm</option>
        {#if wallpaper?.available}
          {#each wallpaper.displays as screen (screen.index)}
            <option value={screen.index}
              >Beeldscherm {screen.index}{screen.primary
                ? " (hoofdscherm)"
                : ""}</option
            >
          {/each}
        {/if}
      </select>
    </div>
  {/if}
  <Disclosure
    kind="history"
    title="Wijzigingsgeschiedenis"
    hint="Eerdere keuzes terugzetten"
  >
    <section class="helper-history" aria-label="Helpergeschiedenis">
      <Button disabled={helperHistoryBusy} onclick={loadHelperHistory}
        >{helperHistoryBusy
          ? "Geschiedenis laden…"
          : "Geschiedenis laden"}</Button
      >
      {#if helperHistory}
        {#if helperHistory.revisions.length}
          <ol>
            {#each helperHistory.revisions as revision (revision.id)}
              <li>
                <span>
                  {new Date(revision.at).toLocaleString("nl-NL")}: {revision
                    .before.mode}, scherm {revision.before.display}
                  → {revision.after.mode}, scherm {revision.after.display}
                </span>
                <Button
                  disabled={helperBusy}
                  onclick={() => rollbackHelperHistory(revision.id)}
                  >Terugzetten</Button
                >
              </li>
            {/each}
          </ol>
        {:else}<p>Geen wijzigingen opgeslagen.</p>{/if}
        {#if helperHistory.truncated}<small
            >Alleen de nieuwste 50 wijzigingen getoond.</small
          >{/if}
      {/if}
    </section>
  </Disclosure>

  <h3>Bureaublad-achtergrond</h3>
  <p class="hint">
    Je Windows-pc laat NOVA bewegen achter je bureaubladiconen, per beeldscherm.
    Je eigen achtergrond blijft ongemoeid: zet je het uit, dan zie je die weer.
    Het gebruikt de Windows-agent die NOVA al heeft. Je kunt er gewoon mee
    praten (klik op de bol of zeg “Hey NOVA”) en typen (klik op het invoerveld
    onderaan).
  </p>
  {#if helper.mode === "helper"}
    <p class="hint">
      De achtergrond staat uit zolang je alleen de helper kiest. Je keuzes
      hieronder blijven bewaard.
    </p>
  {/if}
  <div>
    {#if !wallpaper}
      <p class="hint">Beeldschermen opzoeken…</p>
    {:else if !wallpaper.available}
      <p class="hint">{why(wallpaper)}</p>
      {#if wallpaper.reason === "old-agent"}
        <Button
          go
          href="/windows-agent/nova-agent.ps1"
          download="nova-agent.ps1">Download de nieuwe agent</Button
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
  <Disclosure
    kind="history"
    title="Wijzigingsgeschiedenis"
    hint="Eerdere keuzes terugzetten"
  >
    <section class="helper-history" aria-label="Achtergrondgeschiedenis">
      <Button disabled={wallpaperHistoryBusy} onclick={loadWallpaperHistory}
        >{wallpaperHistoryBusy
          ? "Geschiedenis laden…"
          : "Geschiedenis laden"}</Button
      >
      {#if wallpaperHistory}
        {#if wallpaperHistory.revisions.length}
          <ol>
            {#each wallpaperHistory.revisions as revision (revision.id)}
              <li>
                <span
                  >{new Date(revision.at).toLocaleString("nl-NL")}: beeldscherm {revision.display},
                  {revision.before} → {revision.after}</span
                >
                <Button
                  disabled={wallpaperHistoryBusy}
                  onclick={() => restoreWallpaper(revision.id)}
                  >Terugzetten</Button
                >
              </li>
            {/each}
          </ol>
        {:else}<p>Geen wijzigingen opgeslagen.</p>{/if}
        {#if wallpaperHistory.truncated}<small
            >Alleen de nieuwste 50 wijzigingen getoond.</small
          >{/if}
      {/if}
    </section>
  </Disclosure>
  <div class="set-toolbar">
    <Button href="/windows-agent/nova-agent.ps1" download="nova-agent.ps1"
      >Download de NOVA-agent</Button
    >
  </div>
  <Disclosure
    kind="more"
    title="Meer uitleg"
    hint="De agent installeren of bijwerken"
  >
    <p class="hint">
      De NOVA-agent is het kleine programma op je pc waarmee NOVA je achtergrond
      en helper kan tonen. Nieuwe installatie: gebruik nova-agent.ps1 en
      install.ps1. Heb je de agent al, dan vervang je het oude bestand met deze
      download, start je NOVAAgent opnieuw in Taakplanner en voer je install.ps1
      uit.
    </p>
  </Disclosure>
</section>

<style>
  .helper-choice {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px;
    border: 0;
    margin: 0 0 10px;
    padding: 0;
  }
  .helper-choice label {
    display: grid;
    gap: 4px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    cursor: pointer;
  }
  .helper-choice label.picked {
    border-color: var(--glow);
    background: color-mix(in srgb, var(--glow) 10%, transparent);
  }
  .helper-choice input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .helper-choice label:has(input:focus-visible) {
    outline: 2px solid var(--glow);
  }
  .helper-choice small {
    color: var(--dim);
    line-height: 1.35;
  }
  .helper-display {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
