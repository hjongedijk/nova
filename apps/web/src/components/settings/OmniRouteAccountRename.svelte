<script lang="ts">
  import { onDestroy } from "svelte";
  import type {
    OmniRouteAccountRenamePrepared,
    OmniRouteAccountRenameResult,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    confirmOmniRouteAccountRename,
    prepareOmniRouteAccountRename,
  } from "#lib/api/settings.ts";

  let {
    id,
    provider,
    initialName,
    done,
  }: {
    id: string;
    provider: string;
    initialName: string;
    done: (result?: OmniRouteAccountRenameResult) => void;
  } = $props();
  let editing = $state(false);
  let name = $state("");
  let busy = $state(false);
  let error = $state("");
  let pending = $state<OmniRouteAccountRenamePrepared | null>(null);
  let expired = $state(false);
  let acknowledged = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));

  async function prepare() {
    busy = true;
    error = "";
    try {
      const result = await prepareOmniRouteAccountRename(id, name, true);
      if (!result.ok || !result.action) {
        error = result.error || "Accountnaam kon niet worden voorbereid.";
        return;
      }
      pending = result;
      expired = false;
      acknowledged = false;
      timer = setTimeout(
        () => (expired = true),
        Math.max(0, result.action.expiresAt - Date.now()),
      );
    } catch {
      error = "Accountnaam kon niet worden voorbereid. Controleer je PIN.";
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
      const result = await confirmOmniRouteAccountRename(
        action.sessionId,
        action.confirmationId,
        approve,
      );
      if (!result.ok) error = result.error || "Accountnaam is niet gewijzigd.";
      else if (!approve) {
        editing = false;
        done();
      } else if (result.verified === true) {
        editing = false;
        done(result);
      } else {
        error =
          "Uitkomst niet gecontroleerd. Controleer de accountnaam in OmniRoute.";
      }
    } catch {
      error = "Uitkomst niet gecontroleerd. Controleer OmniRoute.";
    } finally {
      pending = null;
      clearTimeout(timer);
      busy = false;
    }
  }
</script>

<section aria-label={`Accountnaam wijzigen ${provider}`}>
  {#if error}<p role="status">{error}</p>{/if}
  {#if pending}
    <p>
      <strong>{pending.oldName}</strong> → <strong>{pending.newName}</strong> · {pending.provider}
    </p>
    <p>
      De naam is zichtbaar voor alle OmniRoute-clients. Indien ingeschakeld,
      OmniRoute kan de wijziging ook met zijn cloud synchroniseren.
    </p>
    <label>
      <input type="checkbox" bind:checked={acknowledged} /> Ik begrijp dat de naamswijziging
      alle OmniRoute-clients raakt en mogelijk naar OmniRoute Cloud wordt gesynchroniseerd.
    </label>
    {#if expired}<p role="status">
        Bevestiging verlopen. Bereid de wijziging opnieuw voor.
      </p>{/if}
    <Button
      onclick={() => confirm(true)}
      disabled={busy || expired || !acknowledged}>Naam wijzigen</Button
    >
    <Button onclick={() => confirm(false)} disabled={busy}>Annuleren</Button>
  {:else if editing}
    <label>
      Nieuwe accountnaam
      <input
        bind:value={name}
        maxlength="200"
        autocomplete="off"
        disabled={busy}
      />
    </label>
    <Button onclick={prepare} disabled={busy || !name.trim()}
      >Controleren</Button
    >
    <Button
      onclick={() => {
        editing = false;
        error = "";
      }}
      disabled={busy}>Annuleren</Button
    >
  {:else}
    <Button
      onclick={() => {
        name = initialName;
        editing = true;
        error = "";
      }}
      disabled={busy}>Naam wijzigen</Button
    >
  {/if}
</section>
