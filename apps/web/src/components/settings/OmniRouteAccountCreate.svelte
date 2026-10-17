<script lang="ts">
  import { onDestroy } from "svelte";
  import type {
    OmniRouteAccountCreatePrepared,
    OmniRouteAccountCreateResult,
  } from "@nova/contracts";
  import Field from "./ui/Field.svelte";
  import {
    prepareOmniRouteAccountCreate,
    confirmOmniRouteAccountCreate,
  } from "#lib/api/settings.ts";

  let { done }: { done: (result?: OmniRouteAccountCreateResult) => void } =
    $props();
  /** Free services people can register for themselves, with where to get a key. */
  const PRESETS = [
    {
      id: "groq",
      name: "Groq",
      site: "https://console.groq.com/keys",
      hint: "Snel, ook voor spraakherkenning",
    },
    {
      id: "gemini",
      name: "Google Gemini",
      site: "https://aistudio.google.com/apikey",
      hint: "Ruim gratis gebruik met een Google-account",
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      site: "https://openrouter.ai/keys",
      hint: "Veel gratis modellen op één plek",
    },
    {
      id: "mistral",
      name: "Mistral",
      site: "https://console.mistral.ai/api-keys",
      hint: "Europese aanbieder met een gratis laag",
    },
    {
      id: "cerebras",
      name: "Cerebras",
      site: "https://cloud.cerebras.ai",
      hint: "Erg snelle antwoorden",
    },
    {
      id: "cohere",
      name: "Cohere",
      site: "https://dashboard.cohere.com/api-keys",
      hint: "Gratis proefsleutel voor eigen gebruik",
    },
  ];
  let choice = $state<string>("groq");
  let customProvider = $state("");
  let customName = $state("");
  const preset = $derived(PRESETS.find((item) => item.id === choice));
  const provider = $derived(preset ? preset.id : customProvider);
  const name = $derived(preset ? preset.name : customName);
  let apiKey = $state("");
  let acknowledged = $state(false);
  let busy = $state(false);
  let error = $state("");
  let pending = $state<OmniRouteAccountCreatePrepared | null>(null);
  let expired = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));

  async function prepare() {
    busy = true;
    error = "";
    try {
      const result = await prepareOmniRouteAccountCreate(
        provider,
        name,
        apiKey,
        true,
      );
      apiKey = "";
      if (!result.ok || !result.action) {
        error = result.error || "Account kon niet worden voorbereid.";
        return;
      }
      pending = result;
      expired = false;
      timer = setTimeout(
        () => (expired = true),
        Math.max(0, result.action.expiresAt - Date.now()),
      );
    } catch {
      apiKey = "";
      error = "Account kon niet worden voorbereid. Controleer je PIN.";
    } finally {
      busy = false;
    }
  }

  async function confirm(approve: boolean) {
    const action = pending?.action;
    if (!action) return;
    busy = true;
    error = "";
    try {
      const result = await confirmOmniRouteAccountCreate(
        action.sessionId,
        action.confirmationId,
        approve,
      );
      if (!result.ok) error = result.error || "Account is niet gecontroleerd.";
      else if (!approve || result.verified === true)
        done(approve ? result : undefined);
      else
        error =
          "Uitkomst onbekend. Controleer OmniRoute; NOVA houdt AI geblokkeerd.";
    } catch {
      error =
        "Uitkomst onbekend. Controleer OmniRoute; NOVA houdt AI geblokkeerd.";
    } finally {
      pending = null;
      clearTimeout(timer);
      busy = false;
    }
  }
</script>

<section class="creator" aria-label="Provideraccount toevoegen">
  <ol class="steps">
    <li>
      <h4>Maak een gratis account aan</h4>
      <Field
        label="Bij welke dienst?"
        id="newServiceChoice"
        hint={preset?.hint}
      >
        <select id="newServiceChoice" bind:value={choice} disabled={!!pending}>
          {#each PRESETS as item (item.id)}<option value={item.id}
              >{item.name}</option
            >{/each}
          <option value="">Een andere dienst</option>
        </select>
      </Field>
      {#if preset}
        <p>
          Ga naar <a
            href={preset.site}
            target="_blank"
            rel="noopener noreferrer">{preset.site.replace("https://", "")}</a
          >
          en registreer je met je e-mailadres. Kies altijd het gratis abonnement en
          vul geen betaalgegevens in.
        </p>
      {:else}
        <Field
          label="Naam van de dienst (Provider-ID)"
          id="newServiceProvider"
          hint="Zoals de aanbieder die in OmniRoute heet, bijvoorbeeld cerebras."
        >
          <input
            id="newServiceProvider"
            bind:value={customProvider}
            maxlength="100"
            autocomplete="off"
            disabled={!!pending}
          />
        </Field>
        <Field label="Accountnaam" id="newServiceName">
          <input
            id="newServiceName"
            bind:value={customName}
            maxlength="200"
            autocomplete="off"
            disabled={!!pending}
          />
        </Field>
      {/if}
    </li>
    <li>
      <h4>Maak een sleutel en kopieer die</h4>
      <p>
        Zoek in je account naar “API keys” of “API-sleutels” en kies “Nieuwe
        sleutel maken”. Kopieer de lange tekst die je krijgt. Deel die tekst met
        niemand: het is als een wachtwoord.
      </p>
    </li>
    <li>
      <h4>Plak de sleutel hier</h4>
      {#if error}<p role="status" class="problem">{error}</p>{/if}
      {#if pending}
        <p>
          Toe te voegen: <strong>{pending.name}</strong> ({pending.provider})
        </p>
        <label class="ds-ack">
          <input type="checkbox" bind:checked={acknowledged} />
          <span
            >Ik begrijp dat NOVA deze sleutel meteen test en dat de dienst dan
            voor alle programma’s op deze server beschikbaar wordt. NOVA kan
            niet garanderen dat het gebruik gratis blijft.</span
          >
        </label>
        {#if expired}<p role="status" class="problem">
            Te lang gewacht. Plak de sleutel opnieuw.
          </p>{/if}
        <div class="row">
          <button
            type="button"
            class="go"
            onclick={() => confirm(true)}
            disabled={busy || expired || !acknowledged}>Dienst toevoegen</button
          >
          <button type="button" onclick={() => confirm(false)} disabled={busy}
            >Annuleren</button
          >
        </div>
      {:else}
        <Field
          label="API-sleutel"
          id="newServiceKey"
          hint="De sleutel wordt alleen gebruikt om de dienst te testen en wordt niet getoond."
        >
          <input
            id="newServiceKey"
            type="password"
            bind:value={apiKey}
            maxlength="64000"
            autocomplete="new-password"
          />
        </Field>
        <button
          type="button"
          class="go"
          onclick={prepare}
          disabled={busy || !provider.trim() || !name.trim() || !apiKey.trim()}
          >Controleren en voorbereiden</button
        >
      {/if}
    </li>
  </ol>
</section>

<style>
  .creator {
    margin-block: var(--s3, 12px);
  }
  .steps {
    margin: 0;
    padding: 0;
    list-style: none;
    counter-reset: step;
    display: grid;
    gap: var(--s4, 16px);
  }
  .steps > li {
    counter-increment: step;
    position: relative;
    padding: var(--s4, 16px) var(--s4, 16px) var(--s4, 16px) 64px;
    border: 1px solid var(--line, #34506b);
    border-radius: var(--radius-s, 8px);
  }
  .steps > li::before {
    content: counter(step);
    position: absolute;
    left: var(--s4, 16px);
    top: var(--s4, 16px);
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--glow, #8fd6f6);
    color: var(--ink, #04101c);
    font-weight: 700;
  }
  .steps h4 {
    margin: 0 0 var(--s2, 8px);
  }
  .ds-ack {
    display: flex;
    gap: var(--s3, 12px);
    align-items: flex-start;
    margin-block: var(--s3, 12px);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2, 8px);
  }
  .problem {
    color: var(--alert, #ff9f88);
  }
</style>
