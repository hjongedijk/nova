<script lang="ts">
  import { onMount } from "svelte";
  import {
    apiStatus,
    connectApi,
    getApis,
    protocolLabel,
    removeApi,
    testApi,
    validApiAddress,
    type ApiIntegrationView,
  } from "#lib/api/apis.ts";
  import { fail, say } from "./state.svelte.ts";
  import SectionCard from "./ui/SectionCard.svelte";
  import Field from "./ui/Field.svelte";
  import StatusPill from "./ui/StatusPill.svelte";
  import DangerZone from "./ui/DangerZone.svelte";

  let apis = $state<ApiIntegrationView[]>([]);
  let loaded = $state(false);
  let busy = $state(false);
  let confirming = $state<string | null>(null);
  let baseUrl = $state("");
  let name = $state("");
  let token = $state("");
  let docsUrl = $state("");
  let localNetwork = $state(false);

  const when = (value?: string) =>
    value ? new Date(value).toLocaleString("nl-NL") : "nog niet";

  async function load() {
    try {
      apis = (await getApis()).integrations ?? [];
      loaded = true;
    } catch (cause) {
      fail(cause);
    }
  }
  async function act(run: () => Promise<unknown>, message: string) {
    busy = true;
    try {
      await run();
      say(message, "ok");
      confirming = null;
      await load();
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }
  async function connect() {
    if (!validApiAddress(baseUrl))
      return say(
        "Vul het hele adres in, bijvoorbeeld https://api.voorbeeld.nl/v1.",
        "bad",
      );
    await act(async () => {
      const result = await connectApi({
        baseUrl: baseUrl.trim(),
        name: name.trim() || undefined,
        token: token || undefined,
        docsUrl: docsUrl.trim() || undefined,
        localNetwork,
      });
      // The secret never stays in the form once it is sent.
      token = "";
      baseUrl = "";
      name = "";
      docsUrl = "";
      return result;
    }, "Gekoppeld. Bekijk hieronder wat NOVA heeft geleerd.");
  }

  onMount(() => {
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => clearInterval(timer);
  });
</script>

<SectionCard
  title="API's koppelen"
  lead="Geef NOVA het adres van een API en, als die er is, een token. NOVA zoekt zelf uit hoe de API werkt, test hem alleen lezend en maakt er gereedschappen van voor gesprekken en taken. Wijzigende acties vragen altijd om jouw toestemming. Je kunt ook in een gesprek zeggen: “koppel https://… met token …”."
>
  {#if !loaded}
    <p class="hint">Laden…</p>
  {:else if !apis.length}
    <p class="hint">Er zijn nog geen API's gekoppeld.</p>
  {:else}
    <ul class="apis">
      {#each apis as api (api.id)}
        {@const status = apiStatus(api)}
        <li>
          <div class="head">
            <strong>{api.name}</strong>
            <StatusPill tone={status.tone} label={status.label} />
          </div>
          <p class="meta">
            {protocolLabel(api.protocol)} · {api.baseUrl}{#if api.local}
              · lokaal netwerk{/if}
          </p>
          <p class="meta">
            {api.enabledOperations} van {api.operations} acties aan ({api.byRisk
              .READ_ONLY} lezend, {api.byRisk.CONFIRM} vragen toestemming, {api
              .byRisk.DANGEROUS} gevaarlijk) · token {api.auth.type === "none"
              ? "niet nodig"
              : api.auth.credentialStored
                ? "opgeslagen"
                : "ontbreekt"}
          </p>
          <p class="meta">
            Laatste test: {when(api.lastTest?.at)}{#if api.lastTest}
              · {api.lastTest.ok ? "gelukt" : "mislukt"} ({api.lastTest
                .note}){/if}
          </p>
          {#each api.needs as need (need)}
            <p class="alert" role="status">{need}</p>
          {/each}
          <div class="actions">
            <button
              type="button"
              disabled={busy}
              onclick={() =>
                act(() => testApi(api.id), "Test uitgevoerd (alleen lezen).")}
              >Opnieuw testen</button
            >
          </div>
          <DangerZone title="Verwijderen">
            {#if confirming === api.id}
              <p role="alert">
                “{api.name}” en het opgeslagen token definitief verwijderen?
              </p>
              <div class="actions">
                <button
                  type="button"
                  disabled={busy}
                  onclick={() =>
                    act(() => removeApi(api.id), "Koppeling verwijderd.")}
                  >Ja, verwijderen</button
                >
                <button
                  type="button"
                  disabled={busy}
                  onclick={() => (confirming = null)}>Annuleren</button
                >
              </div>
            {:else}
              <button
                type="button"
                disabled={busy}
                onclick={() => (confirming = api.id)}>Verwijderen</button
              >
            {/if}
          </DangerZone>
        </li>
      {/each}
    </ul>
  {/if}

  <h3>Nieuwe API koppelen</h3>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void connect();
    }}
  >
    <Field
      label="Adres van de API"
      id="api-url"
      hint="Bijvoorbeeld https://api.voorbeeld.nl/v1"
    >
      <input
        id="api-url"
        type="url"
        autocomplete="off"
        bind:value={baseUrl}
        aria-describedby="api-url-hint"
      />
    </Field>
    <Field label="Naam (niet verplicht)" id="api-name">
      <input id="api-name" type="text" autocomplete="off" bind:value={name} />
    </Field>
    <Field
      label="Token of sleutel (niet verplicht)"
      id="api-token"
      hint="Wordt versleuteld bewaard en nooit meer getoond."
    >
      <input
        id="api-token"
        type="password"
        autocomplete="off"
        bind:value={token}
        aria-describedby="api-token-hint"
      />
    </Field>
    <Field
      label="Adres van de documentatie (niet verplicht)"
      id="api-docs"
      hint="Een OpenAPI- of Swagger-bestand helpt als NOVA zelf niets vindt."
    >
      <input
        id="api-docs"
        type="url"
        autocomplete="off"
        bind:value={docsUrl}
        aria-describedby="api-docs-hint"
      />
    </Field>
    <label class="check">
      <input type="checkbox" bind:checked={localNetwork} />
      Deze API staat op mijn eigen netwerk
    </label>
    <button type="submit" class="go" disabled={busy || !baseUrl.trim()}
      >Koppelen</button
    >
  </form>
</SectionCard>

<style>
  .apis {
    list-style: none;
    margin: 0 0 1.5rem;
    padding: 0;
    display: grid;
    gap: 1rem;
  }
  .apis li {
    border: 1px solid var(--line);
    border-radius: var(--radius-s, 8px);
    padding: 1rem;
    min-width: 0;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
    align-items: center;
    justify-content: space-between;
  }
  .head strong {
    font-size: 17px;
    overflow-wrap: anywhere;
  }
  .meta,
  .hint {
    margin: 0.35rem 0;
    font-size: 16px;
    color: var(--dim);
    overflow-wrap: anywhere;
  }
  .alert {
    margin: 0.5rem 0;
    font-size: 16px;
    color: var(--amber);
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.75rem 0;
  }
  .check {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: 16px;
    margin: 0.75rem 0;
  }
  h3 {
    font-size: 17px;
    margin: 1rem 0 0.5rem;
  }
</style>
