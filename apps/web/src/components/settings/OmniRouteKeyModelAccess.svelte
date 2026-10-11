<script lang="ts">
  import type {
    OmniRouteKeyModelAccessOptions,
    OmniRouteKeyModelAccessHistory,
    OmniRouteKeyModelAccessPrepareResult,
    OmniRouteKeyModelAccessResult,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    confirmOmniRouteKeyModelAccess,
    getOmniRouteKeyModelAccess,
    getOmniRouteKeyModelAccessHistory,
    prepareOmniRouteKeyModelAccess,
    prepareOmniRouteKeyModelAccessRollback,
  } from "#lib/api/settings.ts";

  let {
    id,
    done,
  }: { id: string; done: (result: OmniRouteKeyModelAccessResult) => void } =
    $props();
  let report = $state<OmniRouteKeyModelAccessOptions | null>(null);
  let history = $state<OmniRouteKeyModelAccessHistory | null>(null);
  let selected = $state<string[]>([]);
  let pending = $state<Extract<
    OmniRouteKeyModelAccessPrepareResult,
    { ok: true }
  > | null>(null);
  let acknowledged = $state(false);
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
        cause instanceof Error
          ? cause.message
          : "Modelrechten konden niet worden geladen.";
      report = null;
    } finally {
      busy = false;
    }
  }

  async function prepare() {
    if (!report?.revision || !acknowledged) return;
    busy = true;
    error = "";
    try {
      const result = await prepareOmniRouteKeyModelAccess(
        id,
        selected,
        report.revision,
      );
      if (!result.ok) throw new Error(result.error);
      pending = result;
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : "Modelrechten konden niet worden voorbereid.";
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
        cause instanceof Error
          ? cause.message
          : "Modelrechtenhistorie kon niet worden geladen.";
    } finally {
      busy = false;
    }
  }

  async function prepareRollback(revisionId: string) {
    if (!acknowledged) return;
    busy = true;
    error = "";
    try {
      const result = await prepareOmniRouteKeyModelAccessRollback(
        id,
        revisionId,
      );
      if (!result.ok) throw new Error(result.error);
      pending = result;
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : "Modelrechtenherstel kon niet worden voorbereid.";
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
      const result = await confirmOmniRouteKeyModelAccess(
        id,
        action.sessionId,
        action.confirmationId,
        approve,
      );
      if (!result.ok) {
        pending = null;
        report = null;
        throw new Error(
          result.error ?? "Modelrechten konden niet worden gecontroleerd.",
        );
      }
      pending = null;
      if (result.verified) {
        report = null;
        done(result);
        await load();
        await loadHistory();
      } else if (!approve) {
        error = "Wijziging geannuleerd.";
      } else {
        error = result.error ?? "Uitkomst onbekend. AI blijft geblokkeerd.";
      }
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : "Modelrechten konden niet worden bevestigd.";
    } finally {
      busy = false;
    }
  }
</script>

<div>
  {#if !report && !pending}
    <Button onclick={load} disabled={busy}
      >{busy ? "Laden…" : "Modelrechten instellen"}</Button
    >
  {/if}
  {#if error}<p role="status">{error}</p>{/if}
  {#if report}
    <fieldset disabled={busy || !!pending}>
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
      <label>
        <input type="checkbox" bind:checked={acknowledged} />
        Ik begrijp dat dit modeltoegang wijzigt voor alle OmniRoute-clients die deze
        sleutel gebruiken.
      </label>
      <Button
        onclick={prepare}
        disabled={busy || !acknowledged || selected.length === 0}
        >Wijziging voorbereiden</Button
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
                <Button
                  onclick={() => prepareRollback(revision.id)}
                  disabled={busy || !acknowledged}>Herstellen</Button
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
  {#if pending}
    <p role="alert">
      {pending.warning ??
        `Wijzig toegang voor ${pending.name} naar ${pending.modelCount} geverifieerde gratis modellen? Dit geldt voor alle clients met deze sleutel.`}
      NOVA voert de wijziging alleen na bevestiging uit.
    </p>
    <Button onclick={() => confirm(true)} disabled={busy}>Bevestigen</Button>
    <Button onclick={() => confirm(false)} disabled={busy}>Annuleren</Button>
  {/if}
</div>
