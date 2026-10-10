<script lang="ts">
  import OmniRouteAccountRemoval from "./OmniRouteAccountRemoval.svelte";
  import type {
    OmniRouteAccountRemovalResult,
    OmniRouteAccountsReport,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import { getOmniRouteAccounts } from "#lib/api/settings.ts";
  let report = $state<OmniRouteAccountsReport | null>(null);
  let selection = $state<{ id: string; name: string } | null>(null);
  let notice = $state("");
  function removed(result?: OmniRouteAccountRemovalResult) {
    if (result?.verified === true && selection && report) {
      report.connections = report.connections.filter(
        (account) => account.id !== selection?.id,
      );
      notice = `Account verwijderd en gecontroleerd. ${result.routeReady ? "Gratis route opnieuw geverifieerd." : "AI blijft geblokkeerd. Controleer je gratis routebeleid."}${result.auditWarning ? ` ${result.auditWarning}` : ""}`;
    }
    selection = null;
  }
  let busy = $state(false);
  let error = $state("");
  async function load() {
    busy = true;
    error = "";
    try {
      report = await getOmniRouteAccounts();
    } catch {
      report = null;
      error =
        "Accounts konden niet worden geladen. Controleer je PIN en de koppeling.";
    } finally {
      busy = false;
    }
  }
</script>

<section aria-label="OmniRoute-accounts en modelcatalogus">
  <h2>Accounts en gratis modelcatalogus</h2>
  <p>
    Bekijk aangesloten accounts en de catalogus van OmniRoute. Een gratis label
    bewijst niet dat jouw account kosteloos werkt.
  </p>
  <Button onclick={load} disabled={busy || !!selection}
    >{busy ? "Laden…" : "Accounts en catalogus laden"}</Button
  >
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if selection}{#key selection.id}<OmniRouteAccountRemoval
        id={selection.id}
        name={selection.name}
        done={removed}
      />{/key}{/if}
  {#if error}<p role="status">{error}</p>{/if}
  {#if report && !report.available}<p role="status">{report.error}</p>{/if}
  {#if report?.available}
    <p role="status">
      Facturering en harde gratis limieten zijn niet gecontroleerd. Dit
      overzicht verandert je route niet.
    </p>
    {#if report.truncated}<p>
        Het overzicht is begrensd. Meer accounts of modellen kunnen in OmniRoute
        staan.
      </p>{/if}
    <h3>Aangesloten accounts ({report.connections.length})</h3>
    {#if !report.connections.length}<p>Geen accounts gevonden.</p>{/if}
    <ul>
      {#each report.connections as account, index (index)}
        <li>
          <strong>{account.name || account.provider}</strong><span
            >{account.provider} · {account.active === true
              ? "Actief"
              : account.active === false
                ? "Uitgeschakeld"
                : "Status onbekend"}</span
          ><span
            >{account.credentialPresent
              ? "Sleutel aanwezig"
              : "Geen sleutel gemeld"}</span
          >
          <Button
            disabled={busy || !!selection}
            onclick={() => {
              selection = {
                id: account.id,
                name: account.name || account.provider,
              };
              notice = "";
            }}>Verwijder {account.name || account.provider}</Button
          >
        </li>
      {/each}
    </ul>
    <details>
      <summary>Modelcatalogus ({report.models.length})</summary>
      <p>
        Proefcredits en tijdelijke aanbiedingen kunnen in deze catalogus staan.
        NOVA controleert gratis toegang afzonderlijk.
      </p>
      <ul>
        {#each report.models as model, index (index)}
          <li>
            <strong>{model.name || model.modelId}</strong><span
              >{model.provider}/{model.modelId}</span
            ><span>{model.freeType || "Type onbekend"}</span>
            {#if model.monthlyTokens !== null}<span
                >Maandbudget volgens catalogus: {model.monthlyTokens.toLocaleString(
                  "nl-NL",
                )} tokens</span
              >{/if}
            {#if model.creditTokens !== null}<span
                >Credits volgens catalogus: {model.creditTokens.toLocaleString(
                  "nl-NL",
                )} tokens</span
              >{/if}
          </li>
        {/each}
      </ul>
    </details>
    <details>
      <summary>Combo-routes ({report.combos.length})</summary>
      <p>
        Alleen route-metadata. De instellingen wijzigen niets; gebruik of
        beschikbaarheid wordt hiermee niet gegarandeerd.
      </p>
      {#if !report.combos.length}<p>Geen combo-routes gevonden.</p>{/if}
      <ul>
        {#each report.combos as combo, index (index)}
          <li>
            <strong>{combo.displayName || combo.name}</strong><span
              >{combo.name} · {combo.active === true
                ? "Actief"
                : combo.active === false
                  ? "Uitgeschakeld"
                  : "Status onbekend"}</span
            ><span>Strategie: {combo.strategy || "onbekend"}</span>
            <ul>
              {#each combo.models as model, modelIndex (`${modelIndex}-${model}`)}
                <li>{model}</li>
              {/each}
            </ul>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
</section>

<style>
  section {
    margin-block: 1.5rem;
  }
  ul {
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.75rem;
  }
  li {
    border: 1px solid var(--color-border, #2e4654);
    padding: 0.75rem;
    overflow-wrap: anywhere;
  }
  li span {
    display: block;
    margin-top: 0.25rem;
  }
  summary {
    min-height: 44px;
    cursor: pointer;
    padding-block: 0.75rem;
  }
</style>
