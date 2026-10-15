<script lang="ts">
  import { onMount } from "svelte";
  import Button from "#components/ui/Button.svelte";
  import {
    getDesktop,
    saveDesktop,
    stopDesktop,
    type DesktopOverview,
    type DesktopSettings,
  } from "#lib/api/desktop.ts";
  import { fail, say } from "./state.svelte.ts";

  let overview = $state<DesktopOverview | null>(null);
  let busy = $state(false);
  let confirmControl = $state(false);
  let timer: ReturnType<typeof setInterval> | undefined;

  const time = (value: number | string) =>
    new Date(value).toLocaleTimeString("nl-NL");
  const left = (until: number) =>
    Math.max(0, Math.round((until - Date.now()) / 1000));

  async function load() {
    try {
      overview = await getDesktop();
    } catch (cause) {
      fail(cause);
    }
  }
  async function save(patch: Partial<DesktopSettings>, message: string) {
    busy = true;
    try {
      await saveDesktop(patch);
      say(message, "ok");
      confirmControl = false;
      await load();
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }
  async function stop() {
    busy = true;
    try {
      const result = await stopDesktop();
      say(
        result.agentDisarmed
          ? "Overname gestopt en de bediening op de pc uitgezet."
          : "Overname gestopt, maar de pc is niet bereikt. NOVA probeert het opnieuw; de agent zet de bediening zelf uit na de ingestelde tijd.",
        result.agentDisarmed ? "ok" : "bad",
      );
      await load();
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }
  const describe = (row: DesktopOverview["audit"][number]) => {
    const a = row.arguments ?? {};
    if (row.tool === "desktop_session")
      return row.phase === "started"
        ? `Overname gestart${a.goal ? `: ${String(a.goal)}` : ""}`
        : `Overname gestopt (${row.reason ?? "onbekend"})`;
    if (row.tool === "desktop_act")
      return `Actie ${String(a.action ?? "")}${a.window ? ` in "${String(a.window)}"` : ""}${typeof a.textCharacters === "number" ? ` (${a.textCharacters} tekens, niet bewaard)` : ""}`;
    return String(row.tool ?? "");
  };

  onMount(() => {
    void load();
    timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  });
</script>

<section class="desktop-section" aria-label="Bureaublad zien en bedienen">
  <h2>Bureaublad zien en bedienen</h2>
  <p class="hint">
    NOVA kan op je Windows-pc meekijken en, na jouw bevestiging, de muis en het
    toetsenbord kort overnemen. Alles staat standaard uit. Wat op het scherm
    staat is voor NOVA informatie en nooit een opdracht.
  </p>
  {#if overview}
    {#if !overview.configured}<p role="status">
        Er is geen Windows-agent ingesteld. Stel die eerst in bij Apparaten.
      </p>
    {:else if overview.agentError}<p role="status">{overview.agentError}</p>
    {:else if overview.agent}<p>
        Agent op de pc: zien {overview.agent.viewAvailable
          ? "beschikbaar"
          : "uit"}, bedienen {overview.agent.controlAvailable
          ? "beschikbaar"
          : "uit"}. Zet het ook op de pc aan als het daar uit staat.
      </p>{/if}

    <label class="switch">
      <input
        type="checkbox"
        checked={overview.settings.viewEnabled}
        disabled={busy}
        onchange={(event) =>
          save(
            { viewEnabled: event.currentTarget.checked },
            event.currentTarget.checked
              ? "NOVA mag het bureaublad zien."
              : "Zien en bedienen staan uit.",
          )}
      />
      Bureaublad zien: schermafbeeldingen worden door het gratis visiemodel via OmniRoute
      gelezen en niet bewaard
    </label>
    <label class="switch">
      <input
        type="checkbox"
        checked={overview.settings.controlEnabled}
        disabled={busy || !overview.settings.viewEnabled}
        onchange={(event) => {
          if (event.currentTarget.checked) {
            event.currentTarget.checked = false;
            confirmControl = true;
          } else void save({ controlEnabled: false }, "Bedienen staat uit.");
        }}
      />
      Bureaublad bedienen: elke overname vraagt eerst een nieuwe bevestiging
    </label>
    {#if confirmControl}
      <div class="connection-pending" role="alert">
        <p>
          Sta je toe dat NOVA op jouw vraag, na een bevestiging per sessie (max.
          15 minuten), de muis en het toetsenbord bedient? Betalen, verwijderen,
          versturen en inloggen vragen daarbij steeds opnieuw bevestiging.
        </p>
        <Button
          type="button"
          disabled={busy}
          onclick={() =>
            save({ controlEnabled: true }, "Bedienen is toegestaan.")}
          >Ja, toestaan</Button
        >
        <Button type="button" onclick={() => (confirmControl = false)}
          >Annuleren</Button
        >
      </div>
    {/if}
    <label class="switch">
      <input
        type="checkbox"
        checked={overview.settings.cacheEnabled}
        disabled={busy}
        onchange={(event) =>
          save(
            { cacheEnabled: event.currentTarget.checked },
            "Instelling opgeslagen.",
          )}
      />
      Beschrijving van het scherm 10 seconden onthouden
    </label>

    <h3>Sessie</h3>
    {#if overview.session}
      <p role="status">
        Bezig: “{overview.session.goal}” · {overview.session.actions}/{overview
          .session.maxActions} acties · nog {left(overview.session.expiresAt)} s ·
        laatste activiteit {time(overview.session.lastActivityAt)}
      </p>
    {:else}<p>Er loopt geen overname.</p>{/if}
    {#if overview.disarmPending}<p role="alert">
        De pc is nog niet bereikt om de bediening uit te zetten. NOVA blijft het
        proberen.
      </p>{/if}
    <Button
      type="button"
      disabled={busy || (!overview.session && !overview.disarmPending)}
      onclick={stop}>Stop overname nu</Button
    >

    <h3>Actielog</h3>
    {#if overview.audit.length}
      <ul>
        {#each overview.audit as row (row.id)}
          <li>
            <time datetime={row.at}>{time(row.at)}</time>
            {describe(row)}{row.confirmation === "pending"
              ? " · wacht op bevestiging"
              : ""}{row.ok === false ? " · mislukt" : ""}
          </li>
        {/each}
      </ul>
    {:else}<p>Nog niets gedaan.</p>{/if}
  {:else}<p>Laden…</p>{/if}
</section>

<style>
  .desktop-section {
    margin: 1.5rem 0;
  }
  .switch {
    display: flex;
    gap: 0.75rem;
    align-items: flex-start;
    margin: 0.75rem 0;
  }
  p,
  li {
    color: #a4bacd;
  }
  ul {
    padding-left: 1.2rem;
  }
</style>
