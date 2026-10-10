<script lang="ts">
  import { onMount } from "svelte";
  import type {
    MqttOverview,
    QdrantOverview,
    ServiceConnection,
    ServiceConnectionTest,
  } from "@nova/contracts";
  import {
    getServiceConnections,
    getMqttOverview,
    getQdrantOverview,
    saveServiceConnection,
    testServiceConnection,
  } from "#lib/api/settings.ts";
  import { fail, say } from "./state.svelte.ts";
  let { ids }: { ids?: string[] } = $props();
  let services = $state<ServiceConnection[]>([]);
  let drafts = $state<Record<string, Record<string, string | boolean>>>({});
  let clear = $state<Record<string, Record<string, boolean>>>({});
  let tests = $state<Record<string, ServiceConnectionTest>>({});
  let busy = $state<string | null>(null);
  let error = $state("");
  let mqttOverview = $state<MqttOverview | null>(null);
  let mqttError = $state("");
  let qdrantOverview = $state<QdrantOverview | null>(null);
  let qdrantError = $state("");
  const shown = $derived(
    services.filter((item) => !ids || ids.includes(item.id)),
  );
  function reset(service: ServiceConnection) {
    drafts[service.id] = Object.fromEntries(
      service.fields.map((field) => [
        field.key,
        field.kind === "secret" ? "" : (field.value ?? ""),
      ]),
    );
    clear[service.id] = {};
  }
  async function load() {
    try {
      services = (await getServiceConnections()).services;
      services.forEach(reset);
      error = "";
    } catch (e) {
      error =
        e instanceof Error
          ? e.message
          : "De koppelingen zijn niet beschikbaar.";
    }
  }
  onMount(() => {
    void load();
  });
  const cleared = (id: string) =>
    Object.entries(clear[id] ?? {})
      .filter(([, value]) => value)
      .map(([key]) => key);
  function changedValues(service: ServiceConnection) {
    return Object.fromEntries(
      service.fields.flatMap((field) => {
        const value = drafts[service.id]?.[field.key];
        if (
          value === undefined ||
          (field.kind === "secret" ? value === "" : value === field.value)
        )
          return [];
        return [[field.key, value]];
      }),
    );
  }
  async function apply(service: ServiceConnection, test: boolean) {
    busy = service.id;
    try {
      if (test)
        tests[service.id] = await testServiceConnection(
          service.id,
          changedValues(service),
          cleared(service.id),
        );
      else {
        const result = await saveServiceConnection(
          service.id,
          changedValues(service),
          cleared(service.id),
        );
        services = result.services;
        const saved = services.find((item) => item.id === service.id)!;
        reset(saved);
        delete tests[service.id];
        say(
          result.auditWarning ??
            (saved.restartRequired
              ? "Opgeslagen. Herstart NOVA om deze koppeling toe te passen."
              : "De koppeling is opgeslagen."),
          result.auditWarning ? "bad" : "ok",
        );
      }
    } catch (e) {
      fail(e);
    } finally {
      busy = null;
    }
  }
  async function loadMqttOverview() {
    busy = "mqtt-overview";
    try {
      mqttOverview = await getMqttOverview();
      mqttError = "";
    } catch (e) {
      mqttError =
        e instanceof Error ? e.message : "MQTT-overzicht niet beschikbaar.";
    } finally {
      busy = null;
    }
  }
  async function loadQdrantOverview() {
    busy = "qdrant-overview";
    try {
      qdrantOverview = await getQdrantOverview();
      qdrantError = "";
    } catch (e) {
      qdrantError =
        e instanceof Error ? e.message : "Qdrant-overzicht niet beschikbaar.";
    } finally {
      busy = null;
    }
  }
</script>

<section class="connections-section">
  <p class="hint">
    Opgeslagen waarden zijn leidend. Een gewijzigd adres of geheim wordt
    toegepast bij de volgende start van NOVA. Testen gebruikt de ingevulde
    waarden en slaat niets op.
  </p>
  {#if error}<p role="status">{error}</p>
    <button type="button" onclick={load}>Opnieuw proberen</button>{/if}
  {#each shown as service (service.id)}
    <details class="connection-editor">
      <summary
        ><strong>{service.label}</strong><span
          >{service.restartRequired
            ? "Herstart nodig"
            : "Bekijk of wijzig"}</span
        ></summary
      >
      {#if service.id === "omniroute"}
        <p class="hint">
          Een ander gateway-adres vraagt een nieuwe gratis-route-controle. Tot
          die controle klopt, antwoordt NOVA niet via die gateway.
        </p>
      {/if}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void apply(service, false);
        }}
      >
        <fieldset disabled={busy !== null}>
          <legend class="connection-legend">{service.label} instellen</legend>
          {#each service.fields as field (field.key)}
            {@const key = `${service.id}-${field.key}`}
            <div class="connection-field">
              {#if field.kind === "boolean"}
                <label class="connection-check"
                  ><input
                    id={key}
                    type="checkbox"
                    checked={drafts[service.id]?.[field.key] === true}
                    onchange={(event) => {
                      drafts[service.id]![field.key] =
                        event.currentTarget.checked;
                    }}
                  />{field.label}</label
                >
              {:else}
                <label for={key}>{field.label}</label>
                <input
                  id={key}
                  type={field.kind === "secret"
                    ? "password"
                    : field.kind === "url"
                      ? "url"
                      : "text"}
                  autocomplete={field.kind === "secret"
                    ? "new-password"
                    : "off"}
                  maxlength={field.kind === "secret" ? 4096 : 500}
                  value={String(drafts[service.id]?.[field.key] ?? "")}
                  placeholder={field.kind === "secret"
                    ? field.set
                      ? "Ingesteld · leeg laten om te bewaren"
                      : "Nog niet ingesteld"
                    : ""}
                  oninput={(event) => {
                    drafts[service.id]![field.key] = event.currentTarget.value;
                  }}
                />
              {/if}
              <small
                >{field.source === "settings"
                  ? "Opgeslagen in NOVA"
                  : "Startwaarde"}{field.kind === "secret"
                  ? field.set
                    ? " · geheim ingesteld"
                    : " · geen geheim ingesteld"
                  : ""}</small
              >
              {#if field.kind === "secret" && field.set}
                <label class="connection-check"
                  ><input
                    type="checkbox"
                    checked={clear[service.id]?.[field.key] ?? false}
                    onchange={(event) => {
                      clear[service.id]![field.key] =
                        event.currentTarget.checked;
                    }}
                  />Dit geheim wissen bij opslaan of testen</label
                >
              {/if}
            </div>
          {/each}
          <div class="set-toolbar">
            <button type="submit">Opslaan</button><button
              type="button"
              onclick={() => apply(service, true)}>Verbinding testen</button
            >
          </div>
        </fieldset>
      </form>
      {#if service.id === "mqtt"}
        <section aria-label="MQTT-berichten" class="mqtt-overview">
          <h3>MQTT-status en berichten</h3>
          <p class="hint">
            Alleen berichten die NOVA sinds de start heeft verzonden. Inhoud en
            privégegevens blijven verborgen.
          </p>
          <button
            type="button"
            disabled={busy !== null}
            onclick={loadMqttOverview}>Berichten laden</button
          >
          {#if mqttError}<p role="status" class="connection-failed">
              {mqttError}
            </p>{/if}
          {#if mqttOverview}
            <p role="status">
              {mqttOverview.connected ? "Verbonden" : "Niet verbonden"}
            </p>
            <h4>Topics die NOVA gebruikt</h4>
            <ul>
              {#each mqttOverview.topics as topic (topic)}<li>
                  <code>{topic}</code>
                </li>{/each}
            </ul>
            <h4>Recente berichten</h4>
            {#if mqttOverview.recent.length}
              <ul>
                {#each mqttOverview.recent as message, index (index)}<li>
                    <code>{message.topic}</code> · {message.summary} · {message.delivery ===
                    "accepted"
                      ? "aangenomen"
                      : message.delivery === "failed"
                        ? "mislukt"
                        : "in wachtrij"} ·
                    <time datetime={message.at}>{message.at}</time>
                  </li>{/each}
              </ul>
            {:else}<p>Nog geen berichten sinds deze start.</p>{/if}
            <p class="hint">
              Dit is alleen de lokale verzendgeschiedenis. ‘Aangenomen’ betekent
              dat de MQTT-client de verzending aannam; NOVA bevestigt geen
              ontvangst. Berichten van andere apparaten worden niet gelezen.
            </p>
          {/if}
        </section>
      {/if}
      {#if service.id === "qdrant"}
        <section aria-label="Qdrant-collecties" class="mqtt-overview">
          <h3>Qdrant-geheugen</h3>
          <p class="hint">
            Lees collectieaantallen en indexstatus op verzoek. Er worden geen
            punten gelezen of gewijzigd.
          </p>
          <button
            type="button"
            disabled={busy !== null}
            onclick={loadQdrantOverview}>Collecties controleren</button
          >
          {#if qdrantError}<p role="status" class="connection-failed">
              {qdrantError}
            </p>{/if}
          {#if qdrantOverview}
            <p role="status">{qdrantOverview.message}</p>
            {#if qdrantOverview.ok}
              {#if qdrantOverview.collections.length}
                <ul>
                  {#each qdrantOverview.collections as collection (collection.name)}<li
                    >
                      <code>{collection.name}</code> · {collection.points ??
                        "onbekend"} punten · {collection.indexedVectors ??
                        "onbekend"} geïndexeerd · {collection.segments ??
                        "onbekend"} segmenten · {collection.status}
                    </li>{/each}
                </ul>
              {:else}<p>Geen collecties gevonden.</p>{/if}
              {#if qdrantOverview.truncated}<p class="hint">
                  Maximaal 20 collecties; niet-ondersteunde namen worden
                  weggelaten.
                </p>{/if}
              <p class="hint">
                Dit toont geen opslaggrootte in bytes. Opschonen en herindexeren
                worden hier niet uitgevoerd.
              </p>
            {/if}
          {/if}
        </section>
      {/if}
      {#if service.restartRequired}<p class="connection-pending">
          Herstart nodig. De draaiende service gebruikt nog de vorige
          verbinding.
        </p>{/if}
      {#if tests[service.id]}<p
          role="status"
          class:connection-failed={!tests[service.id]!.ok}
        >
          {tests[service.id]!.message}
        </p>{/if}
    </details>
  {/each}
  {#if services.length === 0 && !error}<p>
      Verbindingsinstellingen laden…
    </p>{/if}
</section>

<style>
  .connection-editor {
    border-top: 1px solid var(--line);
    padding: 16px 0;
  }
  .connection-editor summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    cursor: pointer;
  }
  .connection-editor summary span,
  .connection-field small {
    color: var(--dim);
    font-size: 12px;
  }
  .connection-editor fieldset {
    margin: 20px 0 0;
    padding: 0;
    border: 0;
  }
  .connection-legend {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .connection-field {
    display: grid;
    gap: 6px;
    margin-bottom: 18px;
    max-width: 650px;
  }
  .connection-field label {
    font-size: 13px;
  }
  .connection-field input:not([type="checkbox"]) {
    width: 100%;
    border: 1px solid var(--line);
    background: #112338;
    color: var(--mist);
    padding: 10px 12px;
    font: inherit;
  }
  .connection-check {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .connection-editor button,
  .connections-section > button {
    padding: 10px 16px;
    background: #112338;
    color: var(--mist);
    border: 1px solid var(--line);
    font: inherit;
    cursor: pointer;
  }
  .connection-editor button:disabled {
    opacity: 0.6;
    cursor: wait;
  }
  .connection-pending {
    color: var(--amber);
  }
  .connection-failed {
    color: var(--alert);
  }
</style>
