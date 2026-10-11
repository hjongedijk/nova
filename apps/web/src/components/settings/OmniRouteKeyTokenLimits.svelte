<script lang="ts">
  import { onDestroy } from "svelte";
  import type {
    OmniRouteTokenLimitPrepared,
    OmniRouteTokenLimitsReport,
    OmniRouteTokenLimitResult,
    OmniRouteTokenResetInterval,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    confirmOmniRouteTokenLimit,
    getOmniRouteTokenLimits,
    prepareOmniRouteTokenLimit,
  } from "#lib/api/settings.ts";

  let {
    id,
    done,
  }: { id: string; done?: (result: OmniRouteTokenLimitResult) => void } =
    $props();
  let report = $state<OmniRouteTokenLimitsReport | null>(null);
  let pending = $state<OmniRouteTokenLimitPrepared | null>(null);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let limitInput = $state("");
  let interval = $state<OmniRouteTokenResetInterval>("monthly");
  let acknowledge = $state(false);
  let confirmedImpact = $state(false);
  let expired = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const globalLimit = $derived(
    report?.limits.find(
      (item) => item.scopeType === "global" && item.scopeValue === "",
    ),
  );
  onDestroy(() => clearTimeout(timer));

  async function load() {
    busy = true;
    error = "";
    notice = "";
    try {
      const result = await getOmniRouteTokenLimits(id);
      if (!result.available)
        throw new Error(result.error || "Niet beschikbaar.");
      report = result;
      if (globalLimit) {
        limitInput = String(globalLimit.tokenLimit);
        interval = globalLimit.resetInterval;
      }
    } catch {
      error = "Tokenlimieten konden niet veilig worden geladen.";
    } finally {
      busy = false;
    }
  }

  async function prepare() {
    const tokenLimit = Number(limitInput);
    if (!Number.isSafeInteger(tokenLimit) || tokenLimit <= 0) {
      error = "Vul een positief geheel aantal tokens in.";
      return;
    }
    busy = true;
    error = "";
    try {
      const result = await prepareOmniRouteTokenLimit(id, tokenLimit, interval);
      if (!result.ok || !result.action) {
        error = result.error || "Limiet kon niet worden voorbereid.";
        return;
      }
      pending = result;
      confirmedImpact = false;
      expired = false;
      timer = setTimeout(
        () => (expired = true),
        Math.max(0, result.action!.expiresAt - Date.now()),
      );
    } catch {
      error = "Limiet kon niet worden voorbereid. Controleer je PIN.";
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
      const result = await confirmOmniRouteTokenLimit(
        id,
        action.sessionId,
        action.confirmationId,
        approve,
      );
      if (!result.ok) {
        error = result.error || "Limietwijziging is niet gecontroleerd.";
      } else if (!approve) {
        pending = null;
        acknowledge = false;
      } else if (result.verified) {
        pending = null;
        acknowledge = false;
        notice = "Tokenlimiet opgeslagen en gecontroleerd.";
        await load();
        done?.(result);
      } else {
        error = "Uitkomst onzeker. Controleer de tokenlimiet in OmniRoute.";
      }
    } catch {
      error = "Uitkomst onzeker. Controleer de tokenlimiet in OmniRoute.";
    } finally {
      pending = null;
      confirmedImpact = false;
      clearTimeout(timer);
      busy = false;
    }
  }
</script>

<section class="token-limits" aria-label="Tokenlimieten per API-sleutel">
  <Button onclick={load} disabled={busy}
    >{busy ? "Laden…" : "Tokenlimieten laden"}</Button
  >
  {#if error}<p role="status">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if report}
    <p>
      Tokenbudgetten gelden voor alle clients die deze sleutel gebruiken. Bij
      het bereiken van de limiet kan OmniRoute verzoeken met HTTP 429 weigeren.
      Dit is geen factureringsgarantie.
    </p>
    {#if report.limits.length}
      <ul aria-label="Ingestelde tokenlimieten">
        {#each report.limits as item (item.id)}
          <li>
            {item.scopeType === "global"
              ? "Globaal"
              : `${item.scopeType}: ${item.scopeValue}`} · {item.tokenLimit.toLocaleString(
              "nl-NL",
            )} tokens / {item.resetInterval} · {item.enabled ? "actief" : "uit"}
          </li>
        {/each}
      </ul>
    {:else}
      <p>Geen tokenlimieten ingesteld.</p>
    {/if}
    <p>
      Hier kun je alleen een globale limiet toevoegen of de bestaande globale
      limiet verlagen of activeren. Verhogen, uitschakelen en verwijderen is
      niet beschikbaar.
    </p>
    {#if globalLimit && globalLimit.enabled}
      <p>
        Huidige globale limiet: {globalLimit.tokenLimit.toLocaleString("nl-NL")} tokens
        per {globalLimit.resetInterval}.
      </p>
    {/if}
    {#if pending?.action}
      <div class="approval" role="group" aria-label="Tokenlimiet bevestigen">
        <p>
          {pending.oldLimit == null
            ? "Nieuwe globale limiet"
            : `Globale limiet ${pending.oldLimit.toLocaleString("nl-NL")} →`}
          <strong
            >{pending.tokenLimit?.toLocaleString("nl-NL")} tokens / {pending.resetInterval}</strong
          >
        </p>
        <p>
          Dit verandert verzoeken voor alle OmniRoute-clients met deze sleutel.
          Een gelijktijdige wijziging in OmniRoute kan niet atomair worden
          vergrendeld.
        </p>
        <label
          ><input type="checkbox" bind:checked={confirmedImpact} /> Ik begrijp dat
          deze limiet alle clients met deze sleutel raakt.</label
        >
        {#if expired}<p role="status">
            Bevestiging verlopen. Bereid opnieuw voor.
          </p>{/if}
        <Button
          onclick={() => confirm(true)}
          disabled={busy || expired || !confirmedImpact}
          >Tokenlimiet bevestigen</Button
        >
        <Button onclick={() => confirm(false)} disabled={busy}>Annuleren</Button
        >
      </div>
    {:else}
      <label>
        Globale tokenlimiet
        <input
          type="number"
          min="1"
          step="1"
          bind:value={limitInput}
          disabled={busy}
        />
      </label>
      <label>
        Periode
        <select bind:value={interval} disabled={busy || !!globalLimit}>
          <option value="daily">Dag</option>
          <option value="weekly">Week</option>
          <option value="monthly">Maand</option>
        </select>
      </label>
      <label
        ><input type="checkbox" bind:checked={acknowledge} disabled={busy} /> Ik begrijp
        dat dit alle clients met deze sleutel kan raken.</label
      >
      <Button
        onclick={prepare}
        disabled={busy || !acknowledge || !String(limitInput).trim()}
      >
        Controleren en voorbereiden
      </Button>
    {/if}
  {/if}
</section>

<style>
  .token-limits {
    display: grid;
    gap: 0.65rem;
    margin-block: 0.75rem;
  }
  label {
    display: flex;
    gap: 0.55rem;
    align-items: center;
  }
  input[type="number"],
  select {
    max-width: 14rem;
    padding: 0.5rem;
  }
  .approval {
    display: grid;
    gap: 0.65rem;
    border: 1px solid var(--color-border, #777);
    padding: 0.8rem;
  }
  :global(.token-limits button) {
    min-height: 44px;
  }
</style>
