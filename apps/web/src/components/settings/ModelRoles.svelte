<script lang="ts">
  import { onMount } from "svelte";
  import Button from "#components/ui/Button.svelte";
  import type {
    ModelRoleHistory,
    ModelRoleId,
    ModelRolesSettings,
  } from "@nova/contracts";
  import {
    getModelRoleHistory,
    getModelRoles,
    rollbackModelRoleHistory,
    saveModelRoles,
  } from "#lib/api/settings.ts";

  const labels: Record<ModelRoleId, string> = {
    conversation: "Gesprek",
    code: "Code",
    planning: "Denken en plannen",
    summary: "Samenvatten",
    vision: "Beeld",
    embedding: "Inbedden",
  };
  const ids = Object.keys(labels) as ModelRoleId[];
  let roleSettings = $state<ModelRolesSettings | null>(null);
  let history = $state<ModelRoleHistory | null>(null);
  let busy = $state(false);
  let message = $state("");

  async function load() {
    busy = true;
    message = "";
    try {
      roleSettings = await getModelRoles();
      const loadedHistory = await getModelRoleHistory();
      history = Array.isArray(loadedHistory?.revisions) ? loadedHistory : null;
    } catch {
      message = "Modelrollen konden niet worden geladen.";
    } finally {
      busy = false;
    }
  }
  async function save() {
    if (!roleSettings?.available) return;
    busy = true;
    message = "";
    try {
      roleSettings = await saveModelRoles(roleSettings.roles);
      const loadedHistory = await getModelRoleHistory();
      history = Array.isArray(loadedHistory?.revisions) ? loadedHistory : null;
      message = roleSettings.historyWarning ?? "Modelrolvoorkeuren opgeslagen.";
    } catch {
      message = "Opslaan geweigerd. Controleer de actuele gratis route.";
    } finally {
      busy = false;
    }
  }
  async function rollback(id: string) {
    busy = true;
    message = "";
    try {
      roleSettings = await rollbackModelRoleHistory(id);
      const loadedHistory = await getModelRoleHistory();
      history = Array.isArray(loadedHistory?.revisions) ? loadedHistory : null;
      message = roleSettings.historyWarning ?? "Modelrolvoorkeuren teruggezet.";
    } catch {
      message =
        "Terugzetten geweigerd: controleer of de modelrollen en gratis route nog gelijk zijn.";
      await load();
    } finally {
      busy = false;
    }
  }
  const modelCount = (roles: ModelRolesSettings["roles"]) =>
    Object.values(roles).reduce(
      (total, preference) =>
        total + preference.preferred.length + (preference.fallback ? 1 : 0),
      0,
    );
  function toggle(role: ModelRoleId, model: string, checked: boolean) {
    if (!roleSettings) return;
    const preferred = roleSettings.roles[role].preferred;
    roleSettings.roles[role].preferred = checked
      ? [...preferred, model].slice(0, 5)
      : preferred.filter((item) => item !== model);
    if (roleSettings.roles[role].fallback === model)
      roleSettings.roles[role].fallback = null;
  }
  function modelsForRole(role: ModelRoleId): string[] {
    const embeddings = new Set(roleSettings?.verifiedEmbeddingModels ?? []);
    return (roleSettings?.verifiedFreeModels ?? []).filter((model) =>
      role === "embedding" ? embeddings.has(model) : !embeddings.has(model),
    );
  }
  onMount(() => void load());
</script>

<section aria-labelledby="model-roles-title">
  <h2 id="model-roles-title">Modelrollen</h2>
  <p>
    Stel voorkeur en terugval in. Alleen modellen uit de actuele, geverifieerde
    gratis route zijn kiesbaar. De rollen bepalen de modelkeuze zodra de router
    per rol is ingeschakeld.
  </p>
  {#if message}<p role="status">{message}</p>{/if}
  {#if !roleSettings}
    <Button onclick={load} disabled={busy}
      >{busy ? "Laden…" : "Modelrollen laden"}</Button
    >
  {:else if !roleSettings.available}
    <p role="status">{roleSettings.error}</p>
  {:else}
    {#each ids as id (id)}
      <fieldset>
        <legend>{labels[id]}</legend>
        {#if id === "embedding"}
          <p>
            Een andere voorkeur gaat in na herstart van NOVA. Bestaande
            geheugenindexen moeten daarna opnieuw worden opgebouwd.
          </p>
        {/if}
        {#if modelsForRole(id).length}
          <p>Voorkeurslijst (maximaal 5, in ingestelde volgorde):</p>
          {#each modelsForRole(id) as model (model)}
            <label>
              <input
                type="checkbox"
                checked={roleSettings.roles[id].preferred.includes(model)}
                disabled={busy ||
                  (!roleSettings.roles[id].preferred.includes(model) &&
                    roleSettings.roles[id].preferred.length >= 5)}
                onchange={(event) =>
                  toggle(id, model, event.currentTarget.checked)}
              />
              {model}
            </label>
          {/each}
          <label
            >Terugval
            <select
              bind:value={roleSettings.roles[id].fallback}
              disabled={busy}
            >
              <option value={null}>Geen extra terugval</option>
              {#each modelsForRole(id).filter((model) => !roleSettings!.roles[id].preferred.includes(model)) as model (model)}
                <option value={model}>{model}</option>
              {/each}
            </select>
          </label>
        {:else}
          <p>
            Geen geschikt geverifieerd gratis model beschikbaar voor deze rol.
          </p>
        {/if}
      </fieldset>
    {/each}
    <Button onclick={save} disabled={busy}>Voorkeuren opslaan</Button>
    <section aria-labelledby="model-role-history-title">
      <h3 id="model-role-history-title">Wijzigingsgeschiedenis</h3>
      {#if !history}
        <Button
          onclick={async () => (history = await getModelRoleHistory())}
          disabled={busy}
        >
          Geschiedenis laden
        </Button>
      {:else if history.revisions.length === 0}
        <p>Nog geen wijzigingen.</p>
      {:else}
        <ul>
          {#each history.revisions as revision (revision.id)}
            <li>
              <time datetime={revision.at}
                >{new Date(revision.at).toLocaleString("nl-NL")}</time
              >
              · {modelCount(revision.before)} → {modelCount(revision.after)} modelkeuzes
              <Button onclick={() => rollback(revision.id)} disabled={busy}
                >Terugzetten</Button
              >
            </li>
          {/each}
        </ul>
        {#if history.truncated}<small
            >Alleen de laatste 50 wijzigingen getoond.</small
          >{/if}
      {/if}
    </section>
  {/if}
</section>

<style>
  section {
    margin-top: 2rem;
  }
  fieldset {
    margin-block: 1rem;
    border: 1px solid #30465a;
    padding: 1rem;
  }
  li {
    margin-block: 0.6rem;
  }
  legend {
    font-weight: 700;
  }
  fieldset > label {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-block: 0.35rem;
    overflow-wrap: anywhere;
  }
  select {
    min-height: 44px;
    margin-left: 0.5rem;
    max-width: 100%;
  }
</style>
