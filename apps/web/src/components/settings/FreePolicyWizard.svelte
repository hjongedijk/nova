<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type {
    FreePolicyOptions,
    FreePolicyPrepared,
    FreePolicyHistory,
    FreePolicyHistorySnapshot,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import Disclosure from "./ui/Disclosure.svelte";
  import {
    getFreePolicyOptions,
    getFreePolicyHistory,
    prepareFreePolicy,
    confirmFreePolicy,
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
  let billing = $state(false);
  let hardStop = $state(false);
  let terms = $state(false);
  let allClients = $state(false);
  let quotaRefresh = $state(false);
  let busy = $state(false);
  let message = $state("");
  let pending = $state<FreePolicyPrepared | null>(null);
  let history = $state<FreePolicyHistory | null>(null);
  let historyBusy = $state(false);
  let historyError = $state("");
  let expired = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const account = $derived(
    options?.accounts.find((item) => item.id === accountId),
  );
  const models = $derived(
    options?.models.filter((item) => item.provider === account?.provider) || [],
  );
  onDestroy(() => clearTimeout(timer));
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
      billing = hardStop = terms = allClients = quotaRefresh = false;
      if (!options.available)
        message = options.error || "De diensten kunnen nu niet worden geladen.";
    } catch {
      message =
        "De diensten konden niet worden geladen. Controleer je PIN en of de AI-verbinding aan staat.";
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
    billing = hardStop = terms = allClients = quotaRefresh = false;
    selection = [
      ...selection,
      { connectionId: accountId, modelId, officialSource: source.trim() },
    ];
    message = "";
  }
  async function prepare() {
    busy = true;
    message = "";
    try {
      const result = await prepareFreePolicy({
        inventoryToken: options?.inventoryToken || "",
        selection,
        acknowledgeBillingDisabled: true,
        acknowledgeHardStop: true,
        acknowledgeTerms: true,
        acknowledgeAllClients: true,
        acknowledgeQuotaRefresh: true,
      });
      if (!result.ok || !result.action) {
        message = result.error || "Voorbereiden lukte niet.";
        return;
      }
      pending = result;
      expired = false;
      timer = setTimeout(
        () => {
          expired = true;
        },
        Math.max(0, result.action.expiresAt - Date.now()),
      );
    } catch {
      message =
        "Voorbereiden lukte niet. Controleer je keuze, de webadressen en je PIN.";
    } finally {
      busy = false;
    }
  }
  async function confirm(approve: boolean) {
    const action = pending?.action;
    if (!action) return;
    busy = true;
    message = "";
    try {
      const result = await confirmFreePolicy(
        action.sessionId,
        action.confirmationId,
        approve,
      );
      if (!result.ok)
        message =
          result.error ||
          "Uitkomst onbekend. Controleer de gateway en gratis route.";
      else if (!approve) message = "Geannuleerd.";
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
      clearTimeout(timer);
      pending = null;
      busy = false;
      billing = hardStop = terms = allClients = quotaRefresh = false;
    }
  }
</script>

<section class="policy-wizard" aria-label="Gratis beleid maken">
  <h2>Gratis diensten bevestigen</h2>
  <p>
    NOVA gebruikt alleen diensten waarvan jij hebt bevestigd dat ze gratis zijn.
    Kies hieronder welke diensten en modellen NOVA mag gebruiken. Jij weet het
    best of je account echt gratis is, want NOVA kan dat niet zelf controleren.
  </p>
  <Button onclick={load} disabled={busy || !!pending}
    >Mijn diensten laden</Button
  >
  {#if message}<p role="status">{message}</p>{/if}
  {#if options?.available}
    <fieldset disabled={busy || !!pending}>
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
                billing = hardStop = terms = allClients = quotaRefresh = false;
              }}>Verwijder keuze {index + 1}</Button
            >
          </li>
        {/each}
      </ul>
      <label class="check"
        ><input type="checkbox" bind:checked={billing} />Ik heb bij elke gekozen
        dienst gecontroleerd dat betalen en automatisch tegoed bijkopen
        uitstaan.</label
      >
      <label class="check"
        ><input type="checkbox" bind:checked={hardStop} />Ik heb gecontroleerd
        dat elke dienst stopt zodra het gratis tegoed op is en dan niet
        automatisch gaat rekenen.</label
      >
      <label class="check"
        ><input type="checkbox" bind:checked={terms} />Mijn accounts hebben
        recht op dit gratis gebruik en de voorwaarden van de aanbieder staan het
        toe.</label
      >
      <label class="check"
        ><input type="checkbox" bind:checked={allClients} />Ik snap dat deze
        keuze de vorige lijst vervangt en geldt voor alle programma’s die deze
        server gebruiken.</label
      >
      <label class="check"
        ><input type="checkbox" bind:checked={quotaRefresh} />NOVA mag bij de
        aanbieders opvragen hoeveel tegoed er nog is. Dat bewijst niet dat het
        gratis is.</label
      >
      <Button
        onclick={prepare}
        disabled={!selection.length ||
          !billing ||
          !hardStop ||
          !terms ||
          !allClients ||
          !quotaRefresh}>Controleren en voorbereiden</Button
      >
    </fieldset>
  {/if}
  {#if pending?.action}
    <div class="confirmation">
      <h3>Nog één keer bevestigen</h3>
      <p>
        Tijdens het wijzigen blokkeert NOVA haar antwoorden. Pas na de controle
        kan ze weer antwoorden.
      </p>
      <p>Je hebt 60 seconden om te bevestigen.</p>
      {#if expired}<p role="status">
          Te lang gewacht. Annuleer en begin opnieuw.
        </p>{/if}
      <Button onclick={() => confirm(true)} disabled={busy || expired}
        >Ja, dit zijn gratis diensten</Button
      >
      <Button onclick={() => confirm(false)} disabled={busy}>Annuleren</Button>
    </div>
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
  fieldset,
  .confirmation {
    padding: 1rem;
    margin-block: 1rem;
    border: 1px solid var(--border, #555);
    min-width: 0;
  }
  .confirmation {
    border-color: #ff8a33;
  }
  label {
    display: grid;
    gap: 0.5rem;
    margin-block: 1rem;
  }
  .check {
    display: flex;
    align-items: flex-start;
  }
  input:not([type="checkbox"]),
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
