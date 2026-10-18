<script lang="ts">
  import { ApiError } from "#lib/api/client.ts";
  import type {
    OmniRouteKeyModelAccessOptions,
    OmniRouteKeyModelAccessHistory,
    OmniRouteKeyModelAccessResult,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    getOmniRouteKeyModelAccess,
    getOmniRouteKeyModelAccessHistory,
    setOmniRouteKeyModelAccess,
    rollbackOmniRouteKeyModelAccess,
  } from "#lib/api/settings.ts";

  let {
    id,
    done,
  }: { id: string; done: (result: OmniRouteKeyModelAccessResult) => void } =
    $props();
  let report = $state<OmniRouteKeyModelAccessOptions | null>(null);
  let history = $state<OmniRouteKeyModelAccessHistory | null>(null);
  let selected = $state<string[]>([]);
  let busy = $state(false);
  let error = $state("");

  async function load() {
    busy = true;
    error = "";
    try {
      report = await getOmniRouteKeyModelAccess(id);
      if (!report.available) throw new Error(report.error);
      selected = [...report.allowedModels];
    } catch (cause) {
      error =
        cause instanceof ApiError
          ? cause.message
          : "Modelrechten konden niet worden geladen.";
      report = null;
    } finally {
      busy = false;
    }
  }

  async function loadHistory() {
    busy = true;
    error = "";
    try {
      history = await getOmniRouteKeyModelAccessHistory(id);
    } catch (cause) {
      error =
        cause instanceof ApiError
          ? cause.message
          : "Modelrechtenhistorie kon niet worden geladen.";
    } finally {
      busy = false;
    }
  }

  async function run(
    action: () => Promise<OmniRouteKeyModelAccessResult>,
    failure: string,
  ) {
    busy = true;
    error = "";
    try {
      const result = await action();
      if (!result.ok) {
        report = null;
        throw new Error(result.error ?? failure);
      }
      if (result.verified) {
        report = null;
        done(result);
        await load();
        await loadHistory();
      } else {
        error = result.error ?? "Uitkomst onbekend. AI blijft geblokkeerd.";
      }
    } catch (cause) {
      error =
        cause instanceof ApiError || cause instanceof Error
          ? cause.message
          : failure;
    } finally {
      busy = false;
    }
  }
  const save = () =>
    run(
      () => setOmniRouteKeyModelAccess(id, selected),
      "Modelrechten konden niet worden opgeslagen.",
    );
  const rollback = (revisionId: string) =>
    run(
      () => rollbackOmniRouteKeyModelAccess(id, revisionId),
      "Modelrechtenherstel is niet gelukt.",
    );
</script>

<div>
  {#if !report}
    <Button onclick={load} disabled={busy}
      >{busy ? "Laden…" : "Modelrechten instellen"}</Button
    >
  {/if}
  {#if error}<p role="status">{error}</p>{/if}
  {#if report}
    <fieldset disabled={busy}>
      <legend>Toegestane geverifieerde gratis modellen</legend>
      <p>
        Huidige toegang: {report.accessMode}. Opslaan beperkt deze sleutel tot
        de aangevinkte modellen.
      </p>
      {#each report.verifiedFreeModels as model (model)}
        <label>
          <input
            type="checkbox"
            checked={selected.includes(model)}
            onchange={(event) => {
              selected = event.currentTarget.checked
                ? [...selected, model]
                : selected.filter((item) => item !== model);
            }}
          />
          {model}
        </label>
      {/each}
      <Button onclick={save} disabled={busy || selected.length === 0}
        >Modelrechten opslaan</Button
      >
    </fieldset>
    <Button onclick={loadHistory} disabled={busy}>Wijzigingsgeschiedenis</Button
    >
  {/if}
  {#if history}
    <section aria-label="Modelrechtenhistorie">
      {#if history.truncated}<p>
          Alleen de nieuwste 100 modelrechtenwijzigingen worden bewaard.
        </p>{/if}
      {#if history.revisions.length}
        <ol>
          {#each history.revisions as revision, index (revision.id)}
            <li>
              <time datetime={revision.at}
                >{new Date(revision.at).toLocaleString()}</time
              >
              — {revision.name}: {revision.beforeMode === "all"
                ? "alle modellen"
                : revision.beforeModels.join(", ")} → {revision.afterMode ===
              "all"
                ? "alle modellen"
                : revision.afterModels.join(", ")}
              {#if revision.revertedFrom}<span> (herstel)</span>{/if}
              {#if index === 0}
                <Button onclick={() => rollback(revision.id)} disabled={busy}
                  >Herstel deze versie</Button
                >
              {/if}
            </li>
          {/each}
        </ol>
      {:else}
        <p>Geen modelrechtenwijzigingen opgeslagen.</p>
      {/if}
    </section>
  {/if}
</div>
