<script lang="ts">
  import { onMount } from "svelte";
  import Button from "#components/ui/Button.svelte";
  import {
    getConversation,
    hangUpConversation,
    saveConversation,
    type ConversationOverview,
    type ConversationSettings,
  } from "#lib/api/conversation.ts";
  import { fail, say } from "./state.svelte.ts";

  let overview = $state<ConversationOverview | null>(null);
  let busy = $state(false);
  let greeting = $state("");

  async function load() {
    try {
      overview = await getConversation();
      if (!greeting) greeting = overview.settings.greeting;
    } catch (cause) {
      fail(cause);
    }
  }
  async function save(patch: Partial<ConversationSettings>, message: string) {
    busy = true;
    try {
      overview = await saveConversation(patch);
      say(message, "ok");
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }
  async function hangUp() {
    busy = true;
    try {
      const result = await hangUpConversation();
      say(result.hungUp ? "Gesprek beëindigd." : "Er liep geen gesprek.", "ok");
      await load();
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  });
</script>

<section class="conversation" aria-label="Gesprekken">
  <h2>Gesprekken</h2>
  <p class="hint">
    Echte gesprekken met NOVA via de telefoon: bel intern 700 (Linphone). NOVA
    luistert, begrijpt je en antwoordt in gewone zinnen; je mag haar
    onderbreken. Tijdens een telefoongesprek gebruikt NOVA alleen
    leesopdrachten: wat een bevestiging op het scherm nodig heeft, doet ze niet
    over de telefoon. Uit tenzij je het aanzet.
  </p>
  {#if overview}
    <label class="switch">
      <input
        type="checkbox"
        checked={overview.settings.enabled}
        disabled={busy}
        onchange={(event) =>
          save(
            { enabled: event.currentTarget.checked },
            event.currentTarget.checked
              ? "Gesprekken staan aan. Zet ook Telefonie aan."
              : "Gesprekken staan uit.",
          )}
      />
      Gesprekken met NOVA toestaan (nummer 700)
    </label>

    <h3>Spraakherkenning</h3>
    {#if overview.status.speechToText.ready}
      <p role="status">
        Klaar: {overview.status.speechToText.model} ({overview.status
          .speechToText.mode}).
      </p>
    {:else}
      <p role="alert">{overview.status.speechToText.problem}</p>
    {/if}

    <h3>Instellingen</h3>
    <label>
      Taal
      <select
        value={overview.settings.language}
        disabled={busy}
        onchange={(event) =>
          save(
            { language: event.currentTarget.value as "nl" | "en" },
            "Taal opgeslagen.",
          )}
      >
        <option value="nl">Nederlands</option>
        <option value="en">English</option>
      </select>
    </label>
    <label>
      Begroeting
      <input
        type="text"
        maxlength="200"
        bind:value={greeting}
        disabled={busy}
        onchange={() => save({ greeting }, "Begroeting opgeslagen.")}
      />
    </label>
    <label>
      Stilte voordat NOVA vraagt of je er nog bent (seconden)
      <input
        type="number"
        min="5"
        max="60"
        value={overview.settings.idleSeconds}
        disabled={busy}
        onchange={(event) =>
          save(
            { idleSeconds: Number(event.currentTarget.value) },
            "Opgeslagen.",
          )}
      />
    </label>
    <label>
      Maximale duur van een gesprek (minuten)
      <input
        type="number"
        min="1"
        max="60"
        value={overview.settings.maxMinutes}
        disabled={busy}
        onchange={(event) =>
          save(
            { maxMinutes: Number(event.currentTarget.value) },
            "Opgeslagen.",
          )}
      />
    </label>

    <h3>Nu</h3>
    <p>
      {overview.status.listening
        ? `NOVA luistert op ${overview.status.dialTarget}.`
        : "NOVA luistert niet (uit)."}
      {overview.status.calls} gesprek(ken) sinds de start.
    </p>
    {#if overview.status.active}
      <p role="status">
        Gesprek bezig: {overview.status.active.state}, {overview.status.active
          .turns} beurten, {overview.status.active.seconds} s.
      </p>
      <Button type="button" disabled={busy} onclick={hangUp}
        >Gesprek beëindigen</Button
      >
    {:else}<p>Er loopt geen gesprek.</p>{/if}
  {:else}<p>Laden…</p>{/if}
</section>

<style>
  .conversation {
    margin: 1.5rem 0;
  }
  .switch,
  label {
    display: block;
    margin: 0.7rem 0;
  }
  input[type="text"],
  input[type="number"],
  select {
    display: block;
    margin-top: 0.3rem;
    min-width: 14rem;
    max-width: 100%;
  }
</style>
