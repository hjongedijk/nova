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
  import Disclosure from "./ui/Disclosure.svelte";
  import Field from "./ui/Field.svelte";
  import SectionCard from "./ui/SectionCard.svelte";
  import Switch from "./ui/Switch.svelte";

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

<div class="conversation">
  {#if overview}
    <SectionCard
      title="Praten met NOVA"
      lead="Bel intern nummer 700 met Linphone en praat gewoon met NOVA. Je mag haar onderbreken."
    >
      <Switch
        label="Gesprekken met NOVA toestaan"
        hint="Staat standaard uit. Zet ook Telefoon aan (zie Telefoon)."
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
      <Field id="conversationLanguage" label="Taal">
        <select
          id="conversationLanguage"
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
      </Field>
      <Field
        id="conversationGreeting"
        label="Begroeting"
        hint="Dit zegt NOVA als ze opneemt."
      >
        <input
          id="conversationGreeting"
          type="text"
          maxlength="200"
          bind:value={greeting}
          disabled={busy}
          onchange={() => save({ greeting }, "Begroeting opgeslagen.")}
        />
      </Field>
      <Disclosure title="Meer uitleg" kind="more">
        <p class="hint">
          Tijdens een telefoongesprek gebruikt NOVA alleen leesopdrachten. Wat
          een bevestiging op het scherm nodig heeft, doet ze niet over de
          telefoon.
        </p>
      </Disclosure>
    </SectionCard>

    <SectionCard title="Nu">
      {#if overview.status.speechToText.ready}
        <p role="status">
          Spraakherkenning is klaar ({overview.status.speechToText.model}).
        </p>
      {:else}
        <p role="alert">{overview.status.speechToText.problem}</p>
      {/if}
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
    </SectionCard>

    <Disclosure
      kind="more"
      title="Meer opties"
      hint="Wachttijden en maximale duur"
    >
      <Field
        id="conversationIdle"
        label="Stilte voordat NOVA vraagt of je er nog bent (seconden)"
      >
        <input
          id="conversationIdle"
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
      </Field>
      <Field
        id="conversationMax"
        label="Maximale duur van een gesprek (minuten)"
      >
        <input
          id="conversationMax"
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
      </Field>
    </Disclosure>
  {:else}<p>Laden…</p>{/if}
</div>
