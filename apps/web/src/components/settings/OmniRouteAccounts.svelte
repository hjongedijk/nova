<script lang="ts">
  import OmniRouteAccountRemoval from "./OmniRouteAccountRemoval.svelte";
  import OmniRouteAccountCreate from "./OmniRouteAccountCreate.svelte";
  import OmniRouteAccountKeyUpdate from "./OmniRouteAccountKeyUpdate.svelte";
  import OmniRouteAccountRename from "./OmniRouteAccountRename.svelte";
  import OmniRouteAccountActivation from "./OmniRouteAccountActivation.svelte";
  import OmniRouteComboActivation from "./OmniRouteComboActivation.svelte";
  import OmniRouteKeyActivation from "./OmniRouteKeyActivation.svelte";
  import OmniRouteKeyModelAccess from "./OmniRouteKeyModelAccess.svelte";
  import OmniRouteComboCreate from "./OmniRouteComboCreate.svelte";
  import OmniRouteComboRemoval from "./OmniRouteComboRemoval.svelte";
  import OmniRouteComboUpdate from "./OmniRouteComboUpdate.svelte";
  import type {
    OmniRouteAccountRemovalResult,
    OmniRouteAccountCreateResult,
    OmniRouteAccountKeyUpdateResult,
    OmniRouteAccountRenameResult,
    OmniRouteAccountActivationResult,
    OmniRouteAccountsReport,
    OmniRouteApiKeyInventory,
    OmniRouteUsageReport,
    OmniRouteComboActivationResult,
    OmniRouteModelVisibilityReport,
    OmniRouteKeyActivationResult,
    OmniRouteComboCreateResult,
    OmniRouteComboRemovalResult,
    OmniRouteComboUpdateResult,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    getOmniRouteAccounts,
    getOmniRouteUsage,
    getOmniRouteApiKeys,
    getOmniRouteModelVisibility,
  } from "#lib/api/settings.ts";
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
  async function accountCreated(result?: OmniRouteAccountCreateResult) {
    if (!result?.verified) return;
    notice = result.routeReady
      ? `Provideraccount ${result.name || result.provider} toegevoegd en gecontroleerd; de gratis route blijft geverifieerd.${result.auditWarning ? ` ${result.auditWarning}` : ""}`
      : `Provideraccount ${result.name || result.provider} toegevoegd en gecontroleerd. NOVA houdt AI geblokkeerd tot het gratis routebeleid is geverifieerd.${result.auditWarning ? ` ${result.auditWarning}` : ""}`;
    await load();
  }
  async function accountKeyUpdated(result?: OmniRouteAccountKeyUpdateResult) {
    if (!result?.verified) return;
    notice = result.routeReady
      ? "API-sleutel vervangen en gecontroleerd; de gratis route blijft geverifieerd."
      : "API-sleutel vervangen en gecontroleerd. NOVA houdt AI geblokkeerd tot het gratis routebeleid is geverifieerd.";
    if (result.auditWarning) notice += ` ${result.auditWarning}`;
    await load();
  }
  async function accountRenamed(
    id: string,
    result?: OmniRouteAccountRenameResult,
  ) {
    if (!result?.verified) return;
    notice = `Accountnaam gewijzigd en gecontroleerd voor ${result.name || id}; dit geldt voor alle OmniRoute-clients.${result.auditWarning ? ` ${result.auditWarning}` : ""}${result.historyWarning ? ` ${result.historyWarning}` : ""}`;
    await load();
  }
  function comboChanged(
    comboId: string,
    result?: OmniRouteComboActivationResult,
  ) {
    if (!result?.verified || !report) return;
    const combo = report.combos.find((item) => item.id === comboId);
    if (combo && result.enabled !== undefined) combo.active = result.enabled;
    notice = result.routeReady
      ? `Combo ${result.enabled ? "ingeschakeld" : "uitgeschakeld"} en opslag gecontroleerd; gratis route blijft geverifieerd.${result.auditWarning ? ` ${result.auditWarning}` : ""}`
      : `Combo ${result.enabled ? "ingeschakeld" : "uitgeschakeld"} en opslag gecontroleerd. NOVA houdt AI geblokkeerd tot het gratis routebeleid opnieuw is geverifieerd.${result.auditWarning ? ` ${result.auditWarning}` : ""}`;
  }
  async function comboCreated(result?: OmniRouteComboCreateResult) {
    if (!result?.verified) return;
    notice = result.routeReady
      ? `Combo ${result.name || "route"} aangemaakt en opslag gecontroleerd; gratis route blijft geverifieerd.`
      : `Combo ${result.name || "route"} opgeslagen. NOVA houdt AI geblokkeerd tot het routebeleid opnieuw is geverifieerd.`;
    await load();
  }
  async function comboRemoved(
    id: string,
    result?: OmniRouteComboRemovalResult,
  ) {
    if (!result?.verified || !report) return;
    report.combos = report.combos.filter((combo) => combo.id !== id);
    notice = result.routeReady
      ? `Combo verwijderd en gecontroleerd; gratis route blijft geverifieerd.${result.auditWarning ? ` ${result.auditWarning}` : ""}`
      : `Combo verwijderd en gecontroleerd. NOVA houdt AI geblokkeerd tot het routebeleid opnieuw is geverifieerd.${result.auditWarning ? ` ${result.auditWarning}` : ""}`;
  }
  async function comboUpdated(result?: OmniRouteComboUpdateResult) {
    if (!result?.verified) return;
    notice = result.routeReady
      ? `Combo bijgewerkt en gecontroleerd; gratis route blijft geverifieerd.${result.auditWarning ? ` ${result.auditWarning}` : ""}${result.historyWarning ? ` ${result.historyWarning}` : ""}`
      : `Combo bijgewerkt en gecontroleerd. NOVA houdt AI geblokkeerd tot het gratis routebeleid opnieuw is geverifieerd.${result.auditWarning ? ` ${result.auditWarning}` : ""}${result.historyWarning ? ` ${result.historyWarning}` : ""}`;
    await load();
  }
  function accountChanged(
    id: string,
    result?: OmniRouteAccountActivationResult,
  ) {
    if (!result?.verified || !report) return;
    const account = report.connections.find((item) => item.id === id);
    if (account && result.enabled !== undefined)
      account.active = result.enabled;
    notice = result.routeReady
      ? `Provideraccount ${result.enabled ? "ingeschakeld" : "uitgeschakeld"} en gecontroleerd; gratis route blijft geverifieerd.${result.auditWarning ? ` ${result.auditWarning}` : ""}${result.historyWarning ? ` ${result.historyWarning}` : ""}`
      : `Provideraccount ${result.enabled ? "ingeschakeld" : "uitgeschakeld"} en gecontroleerd. NOVA houdt AI geblokkeerd tot het gratis routebeleid opnieuw is geverifieerd.${result.auditWarning ? ` ${result.auditWarning}` : ""}${result.historyWarning ? ` ${result.historyWarning}` : ""}`;
  }
  function keyChanged(id: string, result?: OmniRouteKeyActivationResult) {
    if (!result?.verified || !apiKeys) return;
    const key = apiKeys.keys.find((item) => item.id === id);
    if (key && result.enabled !== undefined) key.active = result.enabled;
    notice = result.routeReady
      ? `API-sleutel ${result.enabled ? "ingeschakeld" : "uitgeschakeld"} en gecontroleerd; gratis route blijft geverifieerd.${result.auditWarning ? ` ${result.auditWarning}` : ""}${result.historyWarning ? ` ${result.historyWarning}` : ""}`
      : `API-sleutel ${result.enabled ? "ingeschakeld" : "uitgeschakeld"} en gecontroleerd. NOVA houdt AI geblokkeerd tot het routebeleid opnieuw is geverifieerd.${result.auditWarning ? ` ${result.auditWarning}` : ""}${result.historyWarning ? ` ${result.historyWarning}` : ""}`;
  }
  let busy = $state(false);
  let error = $state("");
  let usage = $state<OmniRouteUsageReport | null>(null);
  let usageBusy = $state(false);
  let usageError = $state("");
  let apiKeys = $state<OmniRouteApiKeyInventory | null>(null);
  let apiKeysBusy = $state(false);
  let apiKeysError = $state("");
  let modelVisibility = $state<OmniRouteModelVisibilityReport | null>(null);
  let modelVisibilityBusy = $state(false);
  let modelVisibilityError = $state("");
  async function loadModelVisibility() {
    modelVisibilityBusy = true;
    modelVisibilityError = "";
    try {
      modelVisibility = await getOmniRouteModelVisibility();
    } catch {
      modelVisibility = null;
      modelVisibilityError = "Modelzichtbaarheid kon niet worden geladen.";
    } finally {
      modelVisibilityBusy = false;
    }
  }
  async function loadApiKeys() {
    apiKeysBusy = true;
    apiKeysError = "";
    try {
      apiKeys = await getOmniRouteApiKeys();
    } catch {
      apiKeys = null;
      apiKeysError = "API-sleutels konden niet worden geladen.";
    } finally {
      apiKeysBusy = false;
    }
  }
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
  async function loadUsage() {
    usageBusy = true;
    usageError = "";
    try {
      usage = await getOmniRouteUsage();
    } catch {
      usage = null;
      usageError = "Providerlimieten konden niet worden geladen.";
    } finally {
      usageBusy = false;
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
  <Button onclick={loadUsage} disabled={usageBusy || !!selection}
    >{usageBusy ? "Limieten laden…" : "Gebruik en limieten laden"}</Button
  >
  <Button onclick={loadApiKeys} disabled={apiKeysBusy || !!selection}
    >{apiKeysBusy ? "Sleutels laden…" : "API-sleutelrechten bekijken"}</Button
  >
  {#if apiKeysError}<p role="status">{apiKeysError}</p>{/if}
  {#if apiKeys && !apiKeys.available}<p role="status">{apiKeys.error}</p>{/if}
  {#if apiKeys?.available}
    <section aria-label="OmniRoute API-sleutelrechten">
      <h3>API-sleutels en toegangsrechten ({apiKeys.keys.length})</h3>
      <p role="status">
        Alleen namen, status en aantallen van beperkingen. Sleutelwaarden worden
        niet opgehaald voor de interface.
      </p>
      {#if apiKeys.truncated}<p>
          Dit overzicht is begrensd tot 200 sleutels.
        </p>{/if}
      {#if !apiKeys.keys.length}<p>Geen API-sleutels gevonden.</p>{/if}
      <ul>
        {#each apiKeys.keys as key (key.id)}
          <li>
            <strong>{key.name || "Sleutel zonder naam"}</strong>
            <span
              >{key.active === true
                ? "Actief"
                : key.active === false
                  ? "Uitgeschakeld"
                  : "Status onbekend"} · toegang: {key.accessMode}</span
            >
            {#if !key.isNovaKey && key.active !== null}
              <OmniRouteKeyActivation
                id={key.id}
                name={key.name}
                enabled={key.active}
                done={(result) => keyChanged(key.id, result)}
              />
            {:else if key.isNovaKey}<span
                >NOVA’s eigen sleutel is beschermd.</span
              >{/if}
            {#if !key.isNovaKey && key.active === true}
              <OmniRouteKeyModelAccess
                id={key.id}
                done={async (result) => {
                  const status = result.routeReady
                    ? "Modeltoegang gewijzigd en gecontroleerd; de gratis route blijft geverifieerd."
                    : "Modeltoegang gecontroleerd. NOVA houdt AI geblokkeerd tot de route opnieuw is geverifieerd.";
                  notice = result.historyWarning
                    ? `${status} ${result.historyWarning}`
                    : status;
                  await loadApiKeys();
                }}
              />
            {/if}
            <span
              >Toegestane modellen: {key.allowedModelCount ?? "onbekend"} · combo's:
              {key.allowedComboCount ?? "onbekend"} · accounts: {key.allowedConnectionCount ??
                "onbekend"}</span
            >
            {#if key.expiresAt}<span
                >Verloopt: {new Date(key.expiresAt).toLocaleString(
                  "nl-NL",
                )}</span
              >{/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  <Button
    onclick={loadModelVisibility}
    disabled={modelVisibilityBusy || !!selection}
    >{modelVisibilityBusy
      ? "Modelstatus laden…"
      : "Verborgen modellen bekijken"}</Button
  >
  {#if modelVisibilityError}<p role="status">{modelVisibilityError}</p>{/if}
  {#if modelVisibility && !modelVisibility.available}<p role="status">
      {modelVisibility.error}
    </p>{/if}
  {#if modelVisibility?.available}
    <section aria-label="Modellen verborgen uit de catalogus">
      <h3>Verborgen uit modelcatalogus ({modelVisibility.hidden.length})</h3>
      <p role="status">
        Verborgen modellen ontbreken in de OmniRoute-modelcatalogus. Dit
        schakelt modelaanroepen niet uit en is geen toegangsbeveiliging.
      </p>
      {#if modelVisibility.truncated}<p>
          Dit overzicht is begrensd tot 500 verborgen modellen.
        </p>{/if}
      {#if !modelVisibility.hidden.length}<p>
          Geen verborgen modellen gemeld.
        </p>{/if}
      <ul>
        {#each modelVisibility.hidden as model (`${model.provider}/${model.modelId}`)}
          <li><strong>{model.provider}</strong> · {model.modelId}</li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if usageError}<p role="status">{usageError}</p>{/if}
  {#if usage && !usage.available}<p role="status">{usage.error}</p>{/if}
  {#if usage?.available}
    <section aria-label="Providergebruik en limieten">
      <h3>Gecachete providerlimieten</h3>
      <p role="status">
        Alleen opgeslagen quota-overzichten. Ze kunnen verouderd zijn en
        bevestigen geen gratis toegang. Er is geen verversing of providerprobe
        gestart.
      </p>
      {#if usage.truncated}<p>Dit overzicht is begrensd.</p>{/if}
      {#if usage.lastAutoSyncAt}<p>
          Laatste automatische sync: {usage.lastAutoSyncAt}
        </p>{/if}
      {#if !usage.connections.length}<p>
          Geen actuele accountlimieten beschikbaar.
        </p>{/if}
      <ul>
        {#each usage.connections as account (account.id)}
          <li>
            <strong>{account.name || account.provider}</strong>
            <span
              >{account.provider} · cache: {account.stale === null
                ? "actualiteit onbekend"
                : account.stale
                  ? "mogelijk verouderd"
                  : "binnen sync-interval"}</span
            ><span>Opgehaald: {account.fetchedAt}</span>
            {#if account.quotas.length}
              <ul>
                {#each account.quotas as quota (quota.window)}
                  <li>
                    {quota.window}: resterend {quota.remaining === null
                      ? "onbekend"
                      : quota.remaining.toLocaleString("nl-NL")}; limiet {quota.limit ===
                    null
                      ? "onbekend"
                      : quota.limit.toLocaleString("nl-NL")}
                    {#if quota.remainingPercentage !== null}
                      · {quota.remainingPercentage.toLocaleString("nl-NL", {
                        maximumFractionDigits: 1,
                      })}% resterend
                    {/if}
                    {#if quota.unlimited === true}· onbeperkt{/if}
                    {#if quota.resetAt}· reset {quota.resetAt}{/if}
                  </li>
                {/each}
              </ul>
            {:else}<span>Geen quota-vensters in cache.</span>{/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
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
    <OmniRouteAccountCreate done={accountCreated} />
    <OmniRouteAccountKeyUpdate
      connections={report.connections}
      done={accountKeyUpdated}
    />
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
          <OmniRouteAccountRename
            id={account.id}
            provider={account.provider}
            initialName={account.name}
            done={(result) => accountRenamed(account.id, result)}
          />
          {#if account.active !== null}
            <OmniRouteAccountActivation
              id={account.id}
              name={account.name || account.provider}
              enabled={account.active}
              done={(result) => accountChanged(account.id, result)}
            />
          {/if}
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
      <OmniRouteComboCreate models={report.models} done={comboCreated} />
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
            {#if combo.active !== null && !combo.name.startsWith("qtSd/")}
              <OmniRouteComboUpdate
                id={combo.id}
                initialName={combo.name}
                initialModels={combo.models}
                models={report.models}
                done={comboUpdated}
              />
              <OmniRouteComboActivation
                id={combo.id}
                name={combo.displayName || combo.name}
                enabled={combo.active}
                done={(result) => comboChanged(combo.id, result)}
              />
              <OmniRouteComboRemoval
                id={combo.id}
                name={combo.displayName || combo.name}
                done={(result) => comboRemoved(combo.id, result)}
              />
            {/if}
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
