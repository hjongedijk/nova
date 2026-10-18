<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    getDesktop,
    getDesktopFrame,
    stopDesktop,
    type DesktopOverview,
  } from "#lib/api/desktop.ts";

  let overview = $state<DesktopOverview | null>(null);
  let open = $state(false);
  let minimized = $state(false);
  let visible = $state(false);
  let display = $state(0);
  let image = $state("");
  let capturedAt = $state("");
  let error = $state("");
  let stopping = $state(false);
  let statusDue = 0;
  let seenSession = "";

  const displays = $derived(overview?.agent?.displays ?? []);
  const recent = $derived(
    overview?.audit.find((row) => row.tool === "desktop_act"),
  );

  function acceptOverview(value: DesktopOverview, autoOpen = false) {
    overview = value;
    const session = value.session?.id ?? "";
    if (autoOpen && session && session !== seenSession) show();
    if (session) seenSession = session;
  }

  function clearImage() {
    if (image) URL.revokeObjectURL(image);
    image = "";
    capturedAt = "";
  }

  function show() {
    statusDue = 0;
    minimized = false;
    open = true;
  }

  function failed(cause: unknown, fallback: string) {
    clearImage();
    error = cause instanceof Error ? cause.message : fallback;
  }

  async function stop() {
    stopping = true;
    try {
      const result = await stopDesktop();
      error = result.agentDisarmed
        ? ""
        : "Overname gestopt. De pc is nog niet bereikt om de bediening uit te zetten.";
      statusDue = 0;
    } catch (cause) {
      failed(cause, "Stoppen mislukt.");
    } finally {
      stopping = false;
    }
  }

  onMount(() => {
    const controller = new AbortController();
    visible = !document.hidden;
    const visibility = () => (visible = !document.hidden);
    document.addEventListener("visibilitychange", visibility);
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function checkSession() {
      try {
        if (!document.hidden && (!open || minimized)) {
          const value = await getDesktop(controller.signal);
          if (!controller.signal.aborted) acceptOverview(value, true);
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          failed(cause, "De pc is niet bereikbaar.");
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void checkSession(), 10000);
      }
    }
    void checkSession();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
      clearImage();
    };
  });

  $effect(() => {
    const active = open && !minimized && visible;
    const selected = display;
    if (!active) {
      untrack(clearImage);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    statusDue = 0;

    async function poll() {
      try {
        if (Date.now() >= statusDue) {
          const value = await getDesktop(controller.signal);
          if (controller.signal.aborted) return;
          acceptOverview(value);
          statusDue = Date.now() + 5000;
          if (
            value.agent?.displays?.length &&
            !value.agent.displays.some((item) => item.index === selected)
          ) {
            display = value.agent.displays[0]!.index;
            return;
          }
        }
        if (!overview?.settings.viewEnabled || !overview.agent?.viewAvailable) {
          clearImage();
          error =
            overview?.agentError ??
            "Meekijken staat uit. Zet het aan bij Instellingen → Windows-pc en op de pc.";
        } else {
          const frame = await getDesktopFrame(selected, controller.signal);
          if (controller.signal.aborted) return;
          if (!frame.ok) throw new Error(frame.error);
          const shot = frame.screenshot;
          if (
            !/^image\/(png|jpeg|webp)$/.test(shot.mimeType) ||
            shot.base64.length > 8000000
          )
            throw new Error("Ongeldig schermbeeld ontvangen.");
          const bytes = Uint8Array.from(atob(shot.base64), (character) =>
            character.charCodeAt(0),
          );
          const next = URL.createObjectURL(
            new Blob([bytes], { type: shot.mimeType }),
          );
          clearImage();
          image = next;
          capturedAt = frame.capturedAt;
          error = "";
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        failed(cause, "De pc is niet bereikbaar.");
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void poll(), 1000);
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearImage();
    };
  });
</script>

{#if overview?.configured}
  {#if !open}
    <button class="desktop-launch" type="button" onclick={show}
      >Pc bekijken</button
    >
  {:else}
    <aside class="desktop-live" aria-label="Live meekijken op de pc">
      <header>
        <strong>Meekijken op de pc</strong>
        <div>
          <button
            type="button"
            aria-label={minimized
              ? "Schermbeeld uitklappen"
              : "Schermbeeld minimaliseren"}
            onclick={() => (minimized = !minimized)}
            >{minimized ? "+" : "−"}</button
          >
          <button
            type="button"
            aria-label="Schermbeeld sluiten"
            onclick={() => (open = false)}>×</button
          >
        </div>
      </header>
      {#if !minimized}
        <div class="desktop-content">
          {#if displays.length > 1}
            <label
              >Beeldscherm
              <select bind:value={display} aria-label="Beeldscherm">
                {#each displays as monitor (monitor.index)}
                  <option value={monitor.index}
                    >Scherm {monitor.index}{monitor.primary ? " · primair" : ""} ·
                    {monitor.width}×{monitor.height}</option
                  >
                {/each}
              </select>
            </label>
          {/if}
          <div class="screen">
            {#if image}<img
                src={image}
                alt="Actueel beeld van het geselecteerde pc-scherm"
              />
            {:else}<p>{error || "Schermbeeld ophalen…"}</p>{/if}
          </div>
          {#if image && capturedAt}<small
              >Bijgewerkt {new Date(capturedAt).toLocaleTimeString(
                "nl-NL",
              )}</small
            >{/if}
          {#if error}<p class="error" role="status">{error}</p>{/if}
          <p class="activity">
            {overview?.session
              ? overview.session.goal
              : "Er loopt geen overname."}
          </p>
          {#if recent}<small
              >Laatste actie: {String(
                recent.arguments?.action ?? "pc bedienen",
              )}</small
            >{/if}
          <button
            class="stop"
            type="button"
            disabled={stopping ||
              (!overview?.session && !overview?.disarmPending)}
            onclick={stop}>{stopping ? "Stoppen…" : "Stop overname"}</button
          >
        </div>
      {/if}
    </aside>
  {/if}
{/if}

<style>
  .desktop-launch,
  .desktop-live {
    position: fixed;
    right: 20px;
    bottom: 88px;
    z-index: 45;
    color: var(--text, #edf4ff);
    background: var(--panel, #101820);
    border: 1px solid var(--line, #334454);
    border-radius: 14px;
    box-shadow: 0 10px 40px #0005;
  }
  .desktop-launch {
    padding: 10px 14px;
    cursor: pointer;
  }
  .desktop-live {
    width: min(420px, calc(100vw - 32px));
    max-height: calc(100dvh - 120px);
    overflow: auto;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    gap: 12px;
  }
  header div {
    display: flex;
    gap: 6px;
  }
  button,
  select {
    font: inherit;
    color: inherit;
  }
  header button {
    border: 0;
    background: transparent;
    font-size: 22px;
    cursor: pointer;
    min-width: 32px;
    min-height: 32px;
  }
  .desktop-content {
    padding: 0 14px 14px;
    display: grid;
    gap: 8px;
  }
  label {
    display: grid;
    gap: 4px;
    font-size: 13px;
  }
  select {
    background: #111c27;
    border: 1px solid #415264;
    border-radius: 6px;
    padding: 6px;
    width: 100%;
  }
  .screen {
    background: #080c11;
    border-radius: 8px;
    min-height: 110px;
    display: grid;
    place-items: center;
    overflow: hidden;
  }
  .screen img {
    display: block;
    width: 100%;
    max-height: 42dvh;
    object-fit: contain;
  }
  p {
    margin: 0;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .screen p {
    padding: 14px;
  }
  small {
    color: #a8b9cb;
    font-size: 11px;
  }
  .error {
    color: #ffc2ad;
  }
  .stop {
    margin-top: 4px;
    border: 1px solid #b86b65;
    background: #542b2b;
    border-radius: 8px;
    padding: 8px;
    cursor: pointer;
  }
  .stop:disabled {
    opacity: 0.45;
    cursor: default;
  }
  button:focus-visible,
  select:focus-visible {
    outline: 2px solid #8ddcf6;
    outline-offset: 2px;
  }
</style>
