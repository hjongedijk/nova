<script lang="ts">
  import Disclosure from "./ui/Disclosure.svelte";
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
          ? "Overname gestopt."
          : "De pc is niet bereikt. NOVA probeert opnieuw te stoppen; gebruik zo nodig Ctrl+Alt+Shift+K op de pc.",
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

<section class="desktop-section" aria-label="Meekijken op je pc">
  <h2>Laat NOVA meekijken op je pc</h2>
  <p class="hint">
    Na koppelen kan NOVA je pc bekijken en bedienen. Schermafbeeldingen worden
    niet bewaard; schermtekst is informatie, geen opdracht.
  </p>
  {#if overview}
    {#if !overview.configured}<p role="status">
        NOVA is nog niet gekoppeld aan je Windows-pc. Koppel die eerst
        hierboven.
      </p>
    {:else if overview.agentError}<p role="status">{overview.agentError}</p>
    {:else if overview.agent}<p>
        Agent op de pc: zien {overview.agent.viewAvailable
          ? "beschikbaar"
          : "uit"}, bedienen {overview.agent.controlAvailable
          ? "beschikbaar"
          : "uit"}.
      </p>{/if}

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
      Schermbeschrijving 10 seconden onthouden voor snellere reacties
    </label>

    <h3>Bezig met de pc</h3>
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

    <Disclosure
      kind="more"
      title="Wat NOVA op je pc deed"
      hint="De laatste acties"
    >
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
    </Disclosure>
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
