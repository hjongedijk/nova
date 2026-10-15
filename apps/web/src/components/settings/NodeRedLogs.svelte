<script lang="ts">
  import { onDestroy } from "svelte";
  import { getNodeRedLogs, type NodeRedLogs } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";

  let logs = $state<NodeRedLogs | null>(null);
  let busy = $state(false);
  let message = $state("");
  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
  });
  async function load() {
    if (busy) return;
    busy = true;
    message = "";
    try {
      const result = await getNodeRedLogs();
      if (destroyed) return;
      logs = result;
      if (!result.available) message = "Node-RED-logboek is niet beschikbaar.";
    } catch {
      if (!destroyed) {
        logs = null;
        message = "Node-RED-logboek is niet beschikbaar.";
      }
    } finally {
      if (!destroyed) busy = false;
    }
  }
</script>

<section aria-label="Node-RED-logboek" class="log-section">
  <h4>Logboek en fouten</h4>
  <p class="hint">
    Een momentopname van de laatste 100 containerregels. Bekende geheimen worden
    geredigeerd. Eigen flows kunnen andere privégegevens loggen.
  </p>
  <div class="set-toolbar">
    <Button disabled={busy} onclick={load}
      >{busy ? "Logboek laden…" : "Logboek laden"}</Button
    >
    {#if logs}<button
        type="button"
        disabled={busy}
        onclick={() => {
          logs = null;
          message = "";
        }}>Wissen van scherm</button
      >{/if}
  </div>
  {#if message}<p role="status">{message}</p>{/if}
  {#if logs?.available}
    {#if logs.truncated}<p role="status" class="hint">
        Lange regels zijn verborgen of het venster is begrensd.
      </p>{/if}
    {#if !logs.flowLinksAvailable}<p class="hint">
        Flowkoppelingen zijn voor deze momentopname niet beschikbaar.
      </p>{/if}
    {#if logs.entries.length}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to focus the scrollable log region.) -->
      <div
        class="log-window"
        tabindex="0"
        role="region"
        aria-label="Recente Node-RED-logregels"
      >
        <ol>
          {#each logs.entries as row, index (index)}
            <li class:error={row.level === "error" || row.level === "fatal"}>
              <div class="log-meta">
                <time datetime={row.at}
                  >{new Date(row.at).toLocaleString()}</time
                >
                · {row.level === "unknown" ? row.stream : row.level}
                {#if row.flowId}<a
                    href={`/settings?section=connections&nodeRedFlow=${encodeURIComponent(row.flowId)}#node-red-flows`}
                    >Open flow</a
                  >{/if}
              </div>
              <pre>{row.text}</pre>
            </li>
          {/each}
        </ol>
      </div>
    {:else}<p role="status">Geen recente logregels beschikbaar.</p>{/if}
    <p class="hint">
      Geen livevolging of opslag door NOVA. Koppelingen gebruiken de huidige
      flowconfiguratie; onduidelijke bronnen blijven zonder koppeling.
    </p>
  {/if}
</section>

<style>
  .log-section {
    margin-top: 1.5rem;
  }
  .log-window {
    max-height: 24rem;
    overflow: auto;
    border: 1px solid var(--border, #334155);
    border-radius: 0.5rem;
    margin-top: 0.75rem;
    padding: 0.75rem;
  }
  ol {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  li + li {
    border-top: 1px solid var(--border, #334155);
    padding-top: 0.6rem;
    margin-top: 0.6rem;
  }
  .log-meta {
    font-size: 0.8rem;
    opacity: 0.8;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  pre {
    font:
      0.8rem/1.5 ui-monospace,
      monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 0.3rem 0 0;
  }
  .error {
    border-left: 2px solid #f87171;
    padding-left: 0.5rem;
  }
</style>
