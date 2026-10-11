<script lang="ts">
  import { onDestroy } from "svelte";
  import type {
    FreePolicyOptions,
    FreePolicyPrepared,
    FreePolicyHistory,
    FreePolicyHistorySnapshot,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    getFreePolicyOptions,
    getFreePolicyHistory,
    prepareFreePolicy,
    confirmFreePolicy,
  } from "#lib/api/settings.ts";

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
        message = options.error || "Accountkeuze is niet beschikbaar.";
    } catch {
      message =
        "Accountkeuze kon niet worden geladen. Controleer je PIN en de gateway.";
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
      message = "Dit model staat al in je keuze.";
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
      message = "Kies één account per provider voor dit beleid.";
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
        message = result.error || "Beleid kon niet worden voorbereid.";
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
        "Beleid kon niet worden voorbereid. Controleer je keuze, bronadressen en PIN.";
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
      else if (!approve) message = "Beleidswijziging geannuleerd.";
      else if (
        result.verified === true &&
        result.evidenceSource === "operator-account" &&
        result.nativeQuotaVerified === false
      ) {
        message =
          "Beleid opgeslagen. Accountbinding en instellingen gecontroleerd. Facturering en harde limiet zijn door jou bevestigd; native quota is niet geverifieerd.";
        if (!result.routeReady)
          message += " De gratis route blijft geblokkeerd.";
        if (result.auditWarning) message += ` ${result.auditWarning}`;
      } else
        message =
          "Uitkomst onbekend. Controleer het beleid voordat NOVA verdergaat.";
    } catch {
      message =
        "Uitkomst onbekend. Instellingen kunnen al gewijzigd zijn. Controleer de gateway en gratis route.";
    } finally {
      clearTimeout(timer);
      pending = null;
      busy = false;
      billing = hardStop = terms = allClients = quotaRefresh = false;
    }
  }
</script>

<section class="policy-wizard" aria-label="Gratis beleid maken">
  <h2>Gratis beleid maken</h2>
  <p>
    Kies actieve accounts en terugkerend gratis modellen. Je bevestigt zelf de
    accountvoorwaarden, facturering en harde limiet.
  </p>
  <p>
    Modelnamen en gecachte quota bewijzen geen gratis gebruik. NOVA controleert
    de accountbinding en opgeslagen instellingen. Beschikbare quota en
    bronadressen worden niet onafhankelijk geverifieerd.
  </p>
  <Button onclick={load} disabled={busy || !!pending}
    >Keuzes voor gratis beleid laden</Button
  >
  {#if message}<p role="status">{message}</p>{/if}
  {#if options?.available}
    <fieldset disabled={busy || !!pending}>
      <legend>Accounts en modellen</legend>
      <label
        >Account<select
          bind:value={accountId}
          onchange={() => {
            modelId = "";
          }}
        >
          <option value="">Kies een account</option>
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
        >Officiële bron voor gratis account en harde limiet<input
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
          selection.length >= 20}>Model toevoegen aan beleid</Button
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
        ><input type="checkbox" bind:checked={billing} />Ik heb voor elk gekozen
        account gecontroleerd dat betaalde facturering en automatisch
        opwaarderen uitstaan.</label
      >
      <label class="check"
        ><input type="checkbox" bind:checked={hardStop} />Ik heb gecontroleerd
        dat elke provider gegarandeerd stopt bij de gratis limiet, zonder
        betaalde fallback.</label
      >
      <label class="check"
        ><input type="checkbox" bind:checked={terms} />Deze accounts hebben
        recht op de terugkerende gratis toegang en de voorwaarden staan dit
        gebruik toe.</label
      >
      <label class="check"
        ><input type="checkbox" bind:checked={allClients} />Dit vervangt het
        gratis beleid, wijzigt de globale modelkeuze voor alle gateway-clients
        en beperkt de NOVA-sleutel tot deze accounts.</label
      >
      <label class="check"
        ><input type="checkbox" bind:checked={quotaRefresh} />De
        kandidaatcontrole mag quota-informatie bij providers verversen. Die
        informatie geldt niet als bewijs van gratis gebruik.</label
      >
      <Button
        onclick={prepare}
        disabled={!selection.length ||
          !billing ||
          !hardStop ||
          !terms ||
          !allClients ||
          !quotaRefresh}>Gratis beleid voorbereiden</Button
      >
    </fieldset>
  {/if}
  {#if pending?.action}
    <div class="confirmation">
      <h3>Beleidswijziging bevestigen</h3>
      <p>
        NOVA blokkeert AI vóór de wijziging. Alleen gecontroleerde instellingen
        en accountbinding kunnen de route vrijgeven. Native strict blijft aan.
      </p>
      <p>
        Risicovolle wijziging. Toestemming is 60 seconden geldig en één keer
        bruikbaar.
      </p>
      {#if expired}<p role="status">
          Toestemming verlopen. Annuleer en bereid opnieuw voor.
        </p>{/if}
      <Button onclick={() => confirm(true)} disabled={busy || expired}
        >Bevestig gratis beleid</Button
      >
      <Button onclick={() => confirm(false)} disabled={busy}
        >Annuleer gratis beleid</Button
      >
    </div>
  {/if}
</section>

<section class="policy-history" aria-label="Gratis beleidsgeschiedenis">
  <h3>Beleidswijzigingen</h3>
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
            Van: {describe(revision.before)} → Naar: {describe(revision.after)}
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
