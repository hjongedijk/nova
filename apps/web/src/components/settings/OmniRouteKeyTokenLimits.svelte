<script lang="ts">
  import type {
    OmniRouteTokenLimitsReport,
    OmniRouteTokenLimitResult,
    OmniRouteTokenResetInterval,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    getOmniRouteTokenLimits,
    setOmniRouteTokenLimit,
  } from "#lib/api/settings.ts";

  let {
    id,
    done,
  }: { id: string; done?: (result: OmniRouteTokenLimitResult) => void } =
    $props();
  let report = $state<OmniRouteTokenLimitsReport | null>(null);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let limitInput = $state("");
  let interval = $state<OmniRouteTokenResetInterval>("monthly");
  const globalLimit = $derived(
    report?.limits.find(
      (item) => item.scopeType === "global" && item.scopeValue === "",
    ),
  );

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

  async function save() {
    const tokenLimit = Number(limitInput);
    if (!Number.isSafeInteger(tokenLimit) || tokenLimit <= 0) {
      error = "Vul een positief geheel aantal tokens in.";
      return;
    }
    busy = true;
    error = "";
    try {
      const result = await setOmniRouteTokenLimit(id, tokenLimit, interval);
      if (!result.ok) {
        error = result.error || "Limietwijziging is niet gecontroleerd.";
      } else if (result.verified) {
        notice = "Tokenlimiet opgeslagen en gecontroleerd.";
        await load();
        done?.(result);
      } else {
        error = "Uitkomst onzeker. Controleer de tokenlimiet in OmniRoute.";
      }
    } catch {
      error = "Uitkomst onzeker. Controleer de tokenlimiet in OmniRoute.";
    } finally {
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
    <Button onclick={save} disabled={busy || !String(limitInput).trim()}>
      Tokenlimiet opslaan
    </Button>
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
  :global(.token-limits button) {
    min-height: 44px;
  }
</style>
