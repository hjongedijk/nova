<script lang="ts">
  import { onMount } from "svelte";
  import type {
    FreePolicyOptions,
    FreePolicyHistory,
    FreePolicyHistorySnapshot,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import Disclosure from "./ui/Disclosure.svelte";
  import {
    getFreePolicyOptions,
    getFreePolicyHistory,
    applyFreePolicy,
  } from "#lib/api/settings.ts";

  let { done, autoload = false }: { done?: () => void; autoload?: boolean } =
    $props();
  let options = $state<FreePolicyOptions | null>(null);
  let selection = $state<
    { connectionId: string; modelId: string; officialSource: string }[]
  >([]);
  let accountId = $state("");
  let modelId = $state("");
  let source = $state("");
  let busy = $state(false);
  let message = $state("");
  let history = $state<FreePolicyHistory | null>(null);
  let historyBusy = $state(false);
  let historyError = $state("");
  const account = $derived(
    options?.accounts.find((item) => item.id === accountId),
  );
  const models = $derived(
    options?.models.filter((item) => item.provider === account?.provider) || [],
  );
  onMount(() => {
    if (autoload) void load();
  });

  async function loadHistory() {
    historyBusy = true;
    historyError = "";
    try {
      history = await getFreePolicyHistory();
    } catch {
      history = null;
      historyError = "De beleidsgeschiedenis kon niet worden geladen.";
    } finally {
      historyBusy = false;
    }
  }
  function describe(snapshot: FreePolicyHistorySnapshot) {
    const policy = snapshot.policy;
    if (!policy) return "Geen lokaal beleid";
    const models = Array.isArray(policy.enabledModels)
      ? policy.enabledModels.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    return `${String(snapshot.settings.freeAccessPolicy ?? "onbekend")} · ${models.length} modellen`;
  }

  async function load() {
    busy = true;
    message = "";
    try {
      options = await getFreePolicyOptions();
      selection = [];
      accountId = modelId = source = "";
      if (!options.available)
        message = options.error || "De diensten kunnen nu niet worden geladen.";
    } catch {
      message =
        "De diensten konden niet worden geladen. Controleer of de AI-verbinding aan staat.";
    } finally {
      busy = false;
    }
  }
  function add() {
    if (
      !account ||
      !models.some((item) => item.modelId === modelId) ||
      !source.trim()
    )
      return;
    if (
      selection.some(
        (item) =>
          item.modelId === modelId &&
          options?.accounts.find((a) => a.id === item.connectionId)
            ?.provider === account.provider,
      )
    ) {
      message = "Dit model staat al in je lijst.";
      return;
    }
    if (
      selection.some(
        (item) =>
          item.connectionId !== accountId &&
          options?.accounts.find((a) => a.id === item.connectionId)
            ?.provider === account.provider,
      )
    ) {
      message = "Kies per aanbieder één account.";
      return;
    }
    selection = [
      ...selection,
      { connectionId: accountId, modelId, officialSource: source.trim() },
    ];
    message = "";
  }
  async function apply() {
    busy = true;
    message = "";
    try {
      const result = await applyFreePolicy({ selection });
      if (!result.ok)
        message =
          result.error ||
          "Uitkomst onbekend. Controleer de gateway en gratis route.";
      else if (
        result.verified === true &&
        result.evidenceSource === "operator-account" &&
        result.nativeQuotaVerified === false
      ) {
        message = result.routeReady
          ? "Gelukt. NOVA kan weer antwoorden via je gratis diensten."
          : "Opgeslagen, maar NOVA blijft geblokkeerd. De controle van de diensten is nog niet geslaagd.";
        if (result.auditWarning) message += ` ${result.auditWarning}`;
        done?.();
      } else
        message =
          "We weten niet zeker of het gelukt is. Controleer de status voordat je verdergaat.";
    } catch {
      message =
        "We weten niet zeker of het gelukt is. Controleer de status op de pagina Slimme modellen.";
    } finally {
      busy = false;
    }
  }
</script>

<section class="policy-wizard" aria-label="Gratis beleid maken">
  <h2>Gratis diensten kiezen</h2>
  <p>
    NOVA gebruikt alleen de diensten die je hieronder kiest. Kies welke diensten
    en modellen NOVA mag gebruiken. Jij weet het best of je account echt gratis
    is, want NOVA kan dat niet zelf controleren.
  </p>
  <Button onclick={load} disabled={busy}>Mijn diensten laden</Button>
  {#if message}<p role="status">{message}</p>{/if}
  {#if options?.available}
    <fieldset disabled={busy}>
      <legend>Diensten en modellen kiezen</legend>
      <label
        >Dienst<select
          bind:value={accountId}
          onchange={() => {
            modelId = "";
          }}
        >
          <option value="">Kies een dienst</option>
          {#each options.accounts as item (item.id)}<option value={item.id}
              >{item.name} ({item.provider})</option
            >{/each}
        </select></label
      >
      <label
        >Model<select bind:value={modelId}>
          <option value="">Kies een model</option>
          {#each models as item (item.modelId)}<option value={item.modelId}
              >{item.name} ({item.modelId})</option
            >{/each}
        </select></label
      >
      <label
        >Webpagina van de aanbieder waar staat dat dit gratis is<input
          type="url"
          bind:value={source}
          maxlength="2048"
          placeholder="https://provider.example/voorwaarden"
        /></label
      >
      <Button
        onclick={add}
        disabled={!accountId ||
          !modelId ||
          !source.trim() ||
          selection.length >= 20}>Model toevoegen</Button
      >
      <ul>
        {#each selection as item, index (`${item.connectionId}:${item.modelId}`)}
          <li>
            {options.accounts.find((a) => a.id === item.connectionId)?.name}: {item.modelId}
            <p>{item.officialSource}</p>
            <Button
              onclick={() => {
                selection = selection.filter((_, i) => i !== index);
              }}>Verwijder keuze {index + 1}</Button
            >
          </li>
        {/each}
      </ul>
      <Button onclick={apply} disabled={!selection.length || busy}
        >Beleid toepassen</Button
      >
    </fieldset>
  {/if}
</section>

<Disclosure
  title="Eerdere wijzigingen"
  kind="history"
  id="gratis-beleid-geschiedenis"
>
  <section class="policy-history" aria-label="Gratis beleidsgeschiedenis">
    <h3>Eerdere keuzes</h3>
    <p>
      Privégeschiedenis op deze server. Sleutelwaarden worden niet opgeslagen.
    </p>
    <Button onclick={loadHistory} disabled={historyBusy || busy}>
      {historyBusy ? "Geschiedenis laden…" : "Beleidsgeschiedenis laden"}
    </Button>
    {#if historyError}<p role="status">{historyError}</p>{/if}
    {#if history}
      {#if history.truncated}<p>
          Alleen de tien nieuwste wijzigingen worden getoond.
        </p>{/if}
      {#if !history.revisions.length}<p>
          Er zijn nog geen beleidswijzigingen.
        </p>{/if}
      <ol>
        {#each [...history.revisions].reverse() as revision (revision.id)}
          <li>
            <strong>{new Date(revision.at).toLocaleString("nl-NL")}</strong>
            <p>
              Van: {describe(revision.before)} → Naar: {describe(
                revision.after,
              )}
            </p>
          </li>
        {/each}
      </ol>
      {#if history.revisions.length}
        <p role="status">
          Terugzetten is geblokkeerd totdat OmniRoute sleutelrechten met een
          revisiecontrole kan wijzigen. Zo voorkomen we dat een rollback een
          gelijktijdige toegangsaanpassing overschrijft.
        </p>
      {/if}
    {/if}
  </section>
</Disclosure>

<style>
  .policy-wizard {
    margin-block: 2rem;
  }
  .policy-history {
    margin-block: 2rem;
  }
  fieldset {
    padding: 1rem;
    margin-block: 1rem;
    border: 1px solid var(--border, #555);
    min-width: 0;
  }
  label {
    display: grid;
    gap: 0.5rem;
    margin-block: 1rem;
  }
  input,
  select {
    width: 100%;
    min-height: 44px;
  }
  :global(.policy-wizard button) {
    min-height: 44px;
    margin: 0.25rem 0.5rem 0.25rem 0;
  }
  li,
  p {
    overflow-wrap: anywhere;
  }
</style>
