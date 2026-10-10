<script lang="ts">
  import { onDestroy } from "svelte";
  import type { NativePromptPrepared } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    prepareNativePrompt,
    confirmNativePrompt,
  } from "#lib/api/settings.ts";
  let {
    initialEnabled,
    saved,
  }: {
    initialEnabled: boolean | null;
    saved: (enabled: boolean, prefix: number, suffix: number) => void;
  } = $props();
  let editing = $state(false);
  let enabled = $state(false);
  let prefix = $state("");
  let suffix = $state("");
  let acknowledged = $state(false);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let pending = $state<NativePromptPrepared | null>(null);
  let expired = $state(false);
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  function open() {
    enabled = initialEnabled ?? false;
    editing = true;
    error = "";
    notice = "";
  }
  async function prepare() {
    if (!acknowledged) return;
    busy = true;
    error = "";
    try {
      const result = await prepareNativePrompt({
        enabled,
        prefixPrompt: prefix,
        suffixPrompt: suffix,
        acknowledgeGlobal: true,
      });
      if (!result.ok || !result.action) {
        error = result.error || "De vervanging kon niet worden voorbereid.";
        return;
      }
      pending = result;
      expired = false;
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(
        () => {
          expired = true;
        },
        Math.max(0, result.action.expiresAt - Date.now()),
      );
    } catch {
      error =
        "De vervanging kon niet worden voorbereid. Gebruik geen geheimen en controleer je PIN.";
    } finally {
      busy = false;
    }
  }
  async function confirm(approve: boolean) {
    if (!pending?.action) return;
    busy = true;
    error = "";
    try {
      const result = await confirmNativePrompt(
        pending.action.sessionId,
        pending.action.confirmationId,
        approve,
      );
      if (!result.ok)
        error =
          result.error || "De promptwijziging kon niet worden gecontroleerd.";
      else if (approve && result.verified === true) {
        saved(enabled, prefix.length, suffix.length);
        notice = `Gateway-prompt opgeslagen en gecontroleerd.${result.auditWarning ? ` ${result.auditWarning}` : ""}`;
        editing = false;
        prefix = "";
        suffix = "";
      } else notice = "Promptvervanging geannuleerd.";
    } catch {
      error =
        "Bevestiging kon niet worden afgerond. Controleer de gateway-status voordat je opnieuw vervangt.";
    } finally {
      pending = null;
      acknowledged = false;
      clearTimeout(expiryTimer);
      busy = false;
    }
  }
  onDestroy(() => clearTimeout(expiryTimer));
</script>

<div class="prompt-editor">
  {#if !editing}<Button onclick={open}>Gateway-prompt vervangen</Button>{/if}
  {#if error}<p role="status">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if editing}
    <h3>Vervang beide gateway-promptvelden</h3>
    <p>
      Dit geldt voor alle clients van OmniRoute. Bestaande tekst blijft privé.
      Lege velden wissen de bestaande inhoud. Plaats geen geheimen in een
      prompt.
    </p>
    <fieldset disabled={busy || !!pending}>
      <label class="check"
        ><input type="checkbox" bind:checked={enabled} /> Extra gateway-prompt inschakelen</label
      >
      <label
        >Nieuw voorvoegsel<textarea
          aria-label="Nieuw gateway-voorvoegsel"
          maxlength="50000"
          rows="5"
          bind:value={prefix}></textarea></label
      >
      <label
        >Nieuw achtervoegsel<textarea
          aria-label="Nieuw gateway-achtervoegsel"
          maxlength="50000"
          rows="5"
          bind:value={suffix}></textarea></label
      >
      <label class="check"
        ><input type="checkbox" bind:checked={acknowledged} /> Ik vervang beide velden
        voor alle gateway-clients.</label
      >
      <div class="buttons">
        <Button onclick={prepare} disabled={!acknowledged}
          >Promptvervanging voorbereiden</Button
        ><Button
          onclick={() => {
            editing = false;
            prefix = "";
            suffix = "";
            acknowledged = false;
          }}>Sluiten</Button
        >
      </div>
    </fieldset>
  {/if}
  {#if pending}
    <div
      class="prompt-confirm"
      role="group"
      aria-label="Gateway-prompt vervangen bevestigen"
    >
      <h3>Bevestig vervanging voor alle gateway-clients</h3>
      <p>
        Extra prompt: {enabled ? "aan" : "uit"}. Voorvoegsel: {prefix.length} tekens;
        achtervoegsel: {suffix.length} tekens.
      </p>
      <p>
        {expired
          ? "Bevestiging verlopen. Annuleer en bereid de vervanging opnieuw voor."
          : "Deze risicovolle vervanging vraagt toestemming binnen 60 seconden, één keer geldig."}
      </p>
      <div class="buttons">
        <Button onclick={() => confirm(true)} disabled={busy || expired}
          >Bevestig gateway-prompt</Button
        ><Button onclick={() => confirm(false)} disabled={busy}
          >Annuleer gateway-prompt</Button
        >
      </div>
    </div>
  {/if}
</div>

<style>
  .prompt-editor {
    margin: 1rem 0;
  }
  p {
    color: #a4bacd;
    line-height: 1.6;
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  label {
    display: block;
    margin: 1rem 0;
  }
  .check {
    display: flex;
    gap: 0.6rem;
    align-items: start;
  }
  textarea {
    display: block;
    width: 100%;
    box-sizing: border-box;
    margin-top: 0.5rem;
    padding: 0.75rem;
    background: #0a1622;
    color: #e4edf6;
    border: 1px solid #30465a;
    font: inherit;
    resize: vertical;
  }
  .buttons {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .buttons :global(button) {
    min-height: 44px;
  }
  .prompt-confirm {
    padding: 1rem;
    border: 1px solid #ff8a4c;
    margin-top: 1rem;
  }
</style>
