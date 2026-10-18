<script lang="ts">
  import type { NativePromptHistory } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    replaceNativePrompt,
    getNativePromptHistory,
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
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let history = $state<NativePromptHistory | null>(null);
  function open() {
    enabled = initialEnabled ?? false;
    editing = true;
    error = "";
    notice = "";
    void loadHistory();
  }
  async function loadHistory() {
    try {
      history = await getNativePromptHistory();
    } catch {
      history = null;
    }
  }
  function restore(value: {
    enabled: boolean;
    prefixPrompt: string;
    suffixPrompt: string;
  }) {
    enabled = value.enabled;
    prefix = value.prefixPrompt;
    suffix = value.suffixPrompt;
    notice =
      "Versie als concept geladen. Controleer beide velden en sla ze op.";
  }
  async function save() {
    busy = true;
    error = "";
    try {
      const result = await replaceNativePrompt({
        enabled,
        prefixPrompt: prefix,
        suffixPrompt: suffix,
      });
      if (!result.ok)
        error =
          result.error || "De promptwijziging kon niet worden gecontroleerd.";
      else if (result.verified === true) {
        saved(enabled, prefix.length, suffix.length);
        notice = `Gateway-prompt opgeslagen en gecontroleerd.${result.auditWarning ? ` ${result.auditWarning}` : ""}`;
        editing = false;
        prefix = "";
        suffix = "";
        await loadHistory();
      } else
        error =
          "De promptwijziging kon niet worden gecontroleerd. Controleer de gateway-status.";
    } catch {
      error =
        "De promptwijziging kon niet worden opgeslagen. Gebruik geen geheimen en controleer de gateway-status.";
    } finally {
      busy = false;
    }
  }
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
    {#if history?.revisions.length}
      <details>
        <summary>Eerdere veilige versies ({history.revisions.length})</summary>
        {#if history.truncated}<p>
            Oudere versies zijn niet meer beschikbaar.
          </p>{/if}
        <ul>
          {#each history.revisions as revision (revision.id)}
            <li>
              {new Date(revision.at).toLocaleString("nl-NL")} · {revision.after
                .enabled
                ? "aan"
                : "uit"} · {revision.after.prefixPrompt.length}+{revision.after
                .suffixPrompt.length} tekens
              <Button onclick={() => restore(revision.before)} disabled={busy}
                >Laad vorige versie als concept</Button
              >
            </li>
          {/each}
        </ul>
      </details>
    {/if}
    <fieldset disabled={busy}>
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
      <div class="buttons">
        <Button onclick={save} disabled={busy}>Gateway-prompt opslaan</Button
        ><Button
          onclick={() => {
            editing = false;
            prefix = "";
            suffix = "";
          }}>Sluiten</Button
        >
      </div>
    </fieldset>
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
</style>
