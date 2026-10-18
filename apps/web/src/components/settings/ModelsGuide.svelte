<script lang="ts">
  import { onMount } from "svelte";
  import type {
    OmniRouteAccountCreateResult,
    OmniRouteAccountsReport,
  } from "@nova/contracts";
  import { getModelMetrics, getOmniRouteAccounts } from "#lib/api/settings.ts";
  import FreePolicyWizard from "./FreePolicyWizard.svelte";
  import OmniRouteAccountCreate from "./OmniRouteAccountCreate.svelte";
  import Disclosure from "./ui/Disclosure.svelte";
  import StatusPill from "./ui/StatusPill.svelte";

  type Connection = OmniRouteAccountsReport["connections"][number];
  const NAMES: Record<string, string> = {
    openrouter: "OpenRouter",
    gemini: "Google Gemini",
    mistral: "Mistral",
    cohere: "Cohere",
    "cloudflare-ai": "Cloudflare",
    sambanova: "SambaNova",
    groq: "Groq",
    huggingface: "Hugging Face",
    cerebras: "Cerebras",
  };
  const label = (item: Connection) => NAMES[item.provider] ?? item.provider;

  let loading = $state(true);
  let reachable = $state(true);
  let routeReady = $state(false);
  let connections = $state<Connection[]>([]);
  let adding = $state(false);
  let confirming = $state(false);
  let showAll = $state(false);
  let notice = $state("");

  const working = $derived(
    connections.filter(
      (item) => item.active === true && item.credentialPresent,
    ),
  );
  const others = $derived(
    connections.filter((item) => !working.includes(item)),
  );

  /** One honest sentence about whether NOVA can answer right now. */
  const summary = $derived.by(() => {
    const n = working.length;
    if (loading) return { tone: "neutral", text: "Even kijken…" } as const;
    if (!reachable)
      return {
        tone: "bad",
        text: "NOVA kan de AI-verbinding nu niet bereiken. Probeer het zo nog eens.",
      } as const;
    if (n === 0)
      return {
        tone: "warn",
        text: "Er is nog geen dienst verbonden, dus NOVA kan niet antwoorden. Voeg hieronder een gratis dienst toe.",
      } as const;
    if (!routeReady)
      return {
        tone: "bad",
        text: "NOVA staat geblokkeerd omdat nieuwe diensten nog niet als gratis zijn bevestigd.",
      } as const;
    return {
      tone: "ok",
      text: `${n} ${n === 1 ? "dienst is ingesteld" : "diensten zijn ingesteld"}. De gratis route is bevestigd.`,
    } as const;
  });

  function status(item: Connection) {
    if (item.active === true && item.credentialPresent)
      return routeReady
        ? ({ tone: "ok", label: "Ingesteld" } as const)
        : ({ tone: "warn", label: "Wacht op bevestiging" } as const);
    if (item.active === true)
      return { tone: "warn", label: "Zonder eigen sleutel" } as const;
    if (!item.credentialPresent)
      return { tone: "bad", label: "Uit: sleutel ontbreekt" } as const;
    return { tone: "warn", label: "Uitgeschakeld" } as const;
  }

  async function load() {
    loading = true;
    const [accounts, metrics] = await Promise.allSettled([
      getOmniRouteAccounts(),
      getModelMetrics(),
    ]);
    reachable = accounts.status === "fulfilled" && accounts.value.available;
    connections =
      accounts.status === "fulfilled" ? accounts.value.connections : [];
    routeReady =
      metrics.status === "fulfilled" &&
      metrics.value.available &&
      metrics.value.routeReady;
    loading = false;
  }

  async function added(result?: OmniRouteAccountCreateResult) {
    if (!result?.verified) {
      adding = false;
      return;
    }
    notice = result.routeReady
      ? `${result.name || result.provider} is toegevoegd. NOVA kan er nu gebruik van maken.`
      : `${result.name || result.provider} is toegevoegd. NOVA blijft geblokkeerd tot je hieronder bevestigt dat de diensten gratis zijn.`;
    adding = false;
    await load();
  }

  onMount(() => {
    void load();
    if (location.hash === "#gratis-toevoegen") adding = true;
  });
</script>

<section
  class="big"
  data-tone={summary.tone}
  id="modellen-status"
  aria-live="polite"
  aria-label="Status van de slimme modellen"
>
  <p class="sentence">{summary.text}</p>
  {#if !loading && summary.tone === "bad" && reachable}
    <button type="button" class="go" onclick={() => (confirming = true)}
      >Klik hier om dat te doen</button
    >
  {:else if !loading && !reachable}
    <button type="button" onclick={load}>Opnieuw proberen</button>
  {/if}
</section>

{#if notice}<p role="status" class="ds-note">{notice}</p>{/if}

<Disclosure
  title="AI-accounts"
  hint="Ingestelde diensten en accounts toevoegen"
  id="verbonden"
  group="settings-section"
>
  <p class="ds-lead">
    Accounts voor AI en spraak. Ingesteld betekent: sleutel aanwezig. Bekijk de
    metingen voor beschikbaarheid.
  </p>
  {#if loading}
    <p>Diensten ophalen…</p>
  {:else if !connections.length}
    <p>Nog geen diensten verbonden.</p>
  {:else}
    <ul class="services">
      {#each showAll ? [...working, ...others] : working as item (item.id)}
        {@const s = status(item)}
        <li>
          <span class="name"
            ><strong>{label(item)}</strong>
            {#if item.name && item.name !== label(item)}<small
                >{item.name}</small
              >{/if}</span
          >
          <StatusPill tone={s.tone} label={s.label} />
        </li>
      {/each}
    </ul>
    {#if others.length}
      <button type="button" onclick={() => (showAll = !showAll)}
        >{showAll
          ? "Toon alleen ingestelde diensten"
          : `Toon ook ${others.length} andere ${others.length === 1 ? "dienst" : "diensten"}`}</button
      >
    {/if}
  {/if}
  <div class="actions">
    <button
      type="button"
      class={adding ? "" : "go"}
      aria-expanded={adding}
      onclick={() => (adding = !adding)}
      >{adding ? "Sluiten" : "Gratis dienst toevoegen"}</button
    >
    {#if !confirming && !loading && reachable}
      <button type="button" onclick={() => (confirming = true)}
        >Gratis diensten bevestigen</button
      >
    {/if}
  </div>
</Disclosure>

{#if adding}
  <section
    class="ds-card"
    id="gratis-toevoegen"
    aria-label="Gratis dienst toevoegen"
  >
    <header class="ds-card-head"><h2>Gratis dienst toevoegen</h2></header>
    <p class="ds-lead">
      Maak een gratis account bij een aanbieder en voeg de sleutel toe.
    </p>
    <OmniRouteAccountCreate done={added} />
  </section>
{/if}

{#if confirming}
  <section
    class="ds-card"
    id="gratis-bevestigen"
    aria-label="Gratis diensten bevestigen"
  >
    <FreePolicyWizard autoload done={load} />
  </section>
{/if}

<Disclosure
  kind="more"
  title="Gratis gebruik en bevestiging"
  hint="Waarom NOVA wil weten of een dienst gratis is"
>
  <p>
    NOVA praat met een AI-dienst om te kunnen antwoorden. Veel aanbieders geven
    een beperkt gratis gebruik. NOVA gebruikt alleen diensten waarvan jij hebt
    gezegd dat ze gratis zijn, zodat je nooit per ongeluk geld kwijt bent.
  </p>
  <p>
    Voeg je een nieuwe dienst toe, dan wacht NOVA met antwoorden tot jij
    bevestigt dat die dienst gratis is. Dat doe je met de knop hierboven.
  </p>
  <p>
    Wil je accounts, routes, metingen of limieten beheren? Dat staat bij
    <a href="/settings?section=modellen#modellen-expert">Geavanceerd</a>.
  </p>
</Disclosure>

<style>
  .big {
    margin: 0 0 var(--s5);
    padding: var(--s4);
    border: 1px solid var(--line);
    border-left: 3px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
  }
  .big[data-tone="ok"] {
    border-left-color: var(--good);
  }
  .big[data-tone="warn"] {
    border-left-color: var(--amber);
  }
  .big[data-tone="bad"] {
    border-left-color: var(--alert);
  }
  .sentence {
    margin: 0 0 var(--s3);
    font-size: 18px;
    line-height: 1.4;
    font-weight: 600;
    max-width: 40ch;
  }
  .big :global(button) {
    margin-top: var(--s1);
  }
  .services {
    list-style: none;
    margin: 0 0 var(--s4);
    padding: 0;
  }
  .services li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--s2) var(--s3);
    min-height: 56px;
    padding: var(--s2) 0;
    border-top: 1px solid var(--line);
  }
  .name {
    display: flex;
    flex-direction: column;
  }
  .name small {
    color: var(--dim);
    font-size: 15px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
    margin-top: var(--s4);
  }
  .ds-note {
    padding: var(--s3) var(--s4);
    border: 1px solid var(--line);
    border-left: 5px solid var(--good);
    border-radius: var(--radius-s);
    background: var(--surface-2);
  }
</style>
