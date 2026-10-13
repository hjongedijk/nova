<script lang="ts">
  import { onMount } from "svelte";
  import type {
    McpServerActivity,
    McpServerCatalog,
    McpServerStatus,
    McpSettingHistory,
    Risk,
  } from "@nova/contracts";
  import {
    getMcpServerActivity,
    getMcpServerCatalog,
    getMcpServerStatus,
    getMcpServerHistory,
    testMcpServerConnection,
    prepareMcpServerToggle,
    confirmMcpServerToggle,
    prepareMcpServerCatalogChange,
    confirmMcpServerCatalogChange,
    prepareMcpToolRisk,
    confirmMcpToolRisk,
    prepareMcpServerHistoryRollback,
  } from "#lib/api/settings.ts";
  import { fail, say } from "./state.svelte.ts";
  import Button from "#components/ui/Button.svelte";
  import McpConnectionConfig from "./McpConnectionConfig.svelte";

  let report = $state<McpServerStatus | null>(null);
  let catalog = $state<McpServerCatalog | null>(null);
  let busy = $state(false);
  let error = $state("");
  let activity = $state<Record<string, McpServerActivity>>({});
  let activityBusy = $state<string | null>(null);
  let history = $state<Record<string, McpSettingHistory>>({});

  async function load() {
    busy = true;
    error = "";
    try {
      const [statusResult, catalogResult] = await Promise.allSettled([
        getMcpServerStatus(),
        getMcpServerCatalog(),
      ]);
      if (statusResult.status === "fulfilled") report = statusResult.value;
      else {
        report = null;
        error = "MCP-status niet beschikbaar.";
      }
      if (catalogResult.status === "fulfilled") catalog = catalogResult.value;
      else {
        catalog = null;
        error =
          error ||
          "De MCP-catalogus is niet lokaal beheerbaar. Verbindingsstatus blijft beschikbaar.";
      }
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void load();
  });

  async function loadActivity(id: string) {
    activityBusy = id;
    error = "";
    try {
      activity[id] = await getMcpServerActivity(id);
    } catch {
      error = "MCP-activiteit kon niet worden geladen.";
    } finally {
      activityBusy = null;
    }
  }

  async function loadHistory(id: string) {
    activityBusy = id;
    error = "";
    try {
      history[id] = await getMcpServerHistory(id);
    } catch {
      error = "MCP-wijzigingsgeschiedenis kon niet worden geladen.";
    } finally {
      activityBusy = null;
    }
  }

  async function rollback(id: string, revisionId: string) {
    activityBusy = id;
    error = "";
    try {
      const prepared = await prepareMcpServerHistoryRollback(id, revisionId);
      if (!prepared.ok || !prepared.action)
        throw new Error(
          prepared.error ?? "Herstel kon niet worden voorbereid.",
        );
      const approve = window.confirm(
        `${prepared.warning ?? "Dit zet de eerdere MCP-stand terug."}\n\nDoorgaan?`,
      );
      const revision = history[id]?.revisions.find(
        (item) => item.id === revisionId,
      );
      const result =
        revision?.change.kind === "tool-risk"
          ? await confirmMcpToolRisk(
              prepared.action.sessionId,
              prepared.action.confirmationId,
              approve,
            )
          : revision?.change.kind === "catalog"
            ? await confirmMcpServerCatalogChange(
                prepared.action.sessionId,
                prepared.action.confirmationId,
                approve,
              )
            : await confirmMcpServerToggle(
                prepared.action.sessionId,
                prepared.action.confirmationId,
                approve,
              );
      if (!approve) {
        say("MCP-herstel geannuleerd.");
        return;
      }
      if (!result.ok)
        throw new Error(result.error ?? "MCP-stand is niet hersteld.");
      await Promise.all([load(), loadHistory(id)]);
      say(
        result.warning ??
          (revision?.change.kind === "tool-risk"
            ? `Eerder risico voor ${revision.change.tool} teruggezet.`
            : revision?.change.kind === "catalog"
              ? `NOVA-toevoeging ${id} teruggedraaid.`
              : `Eerdere MCP-stand van ${id} hersteld.`),
        result.warning ? "bad" : "ok",
      );
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "MCP-herstel is mislukt.";
      fail(cause);
    } finally {
      activityBusy = null;
    }
  }

  async function testConnection(id: string) {
    activityBusy = id;
    error = "";
    try {
      const result = await testMcpServerConnection(id);
      if (!result.ok)
        throw new Error("De MCP-server reageert niet op de test.");
      await loadActivity(id);
      say(
        `Verbinding met ${id} werkt; ${result.toolCount} gereedschappen beschikbaar.`,
        "ok",
      );
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "MCP-verbindingstest mislukt.";
      fail(cause);
    } finally {
      activityBusy = null;
    }
  }

  async function setEnabled(id: string, enabled: boolean) {
    activityBusy = id;
    error = "";
    try {
      const prepared = await prepareMcpServerToggle(id, enabled);
      if (!prepared.ok || !prepared.action)
        throw new Error(
          prepared.error ?? "MCP-wijziging kon niet worden voorbereid.",
        );
      const approve = window.confirm(
        `${prepared.warning ?? "Dit wijzigt de MCP-server."}\n\nEenmalige gevaarlijke bevestiging vereist. Doorgaan?`,
      );
      const result = await confirmMcpServerToggle(
        prepared.action.sessionId,
        prepared.action.confirmationId,
        approve,
      );
      if (!approve) {
        say("MCP-wijziging geannuleerd.");
        return;
      }
      if (!result.ok)
        throw new Error(result.error ?? "MCP-stand is niet gewijzigd.");
      await load();
      say(
        result.warning ??
          `MCP-server ${id} ${enabled ? "ingeschakeld" : "uitgeschakeld"}.`,
        result.warning ? "bad" : "ok",
      );
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : "MCP-stand wijzigen is mislukt.";
      fail(cause);
    } finally {
      activityBusy = null;
    }
  }

  async function changeCatalog(id: string, operation: "add" | "remove") {
    activityBusy = id;
    error = "";
    try {
      const prepared = await prepareMcpServerCatalogChange(id, operation);
      if (!prepared.ok || !prepared.action)
        throw new Error(
          prepared.error ?? "Cataloguswijziging kon niet worden voorbereid.",
        );
      const approve = window.confirm(
        `${prepared.warning ?? "Dit wijzigt de MCP-catalogus."}\n\nEenmalige gevaarlijke bevestiging vereist. Doorgaan?`,
      );
      const result = await confirmMcpServerCatalogChange(
        prepared.action.sessionId,
        prepared.action.confirmationId,
        approve,
      );
      if (!approve) {
        say("MCP-cataloguswijziging geannuleerd.");
        return;
      }
      if (!result.ok || result.verified !== true)
        throw new Error(
          result.error ?? "Cataloguswijziging kon niet worden gecontroleerd.",
        );
      await Promise.all([load(), loadHistory(id)]);
      say(
        operation === "add"
          ? `MCP-server ${id} toegevoegd en uitgeschakeld.`
          : `MCP-server ${id} verwijderd en verbinding gesloten.`,
        "ok",
      );
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : "MCP-cataloguswijziging mislukt.";
      fail(cause);
    } finally {
      activityBusy = null;
    }
  }

  async function setToolRisk(server: string, tool: string, risk: Risk) {
    activityBusy = server;
    error = "";
    try {
      const prepared = await prepareMcpToolRisk(server, tool, risk);
      if (!prepared.ok || !prepared.action)
        throw new Error(prepared.error ?? "Risico kon niet worden voorbereid.");
      const approve = window.confirm(
        `${prepared.warning ?? "Dit wijzigt het gereedschapsrisico."}\n\nNieuw risico: ${risk}. Eenmalige gevaarlijke bevestiging vereist. Doorgaan?`,
      );
      const result = await confirmMcpToolRisk(
        prepared.action.sessionId,
        prepared.action.confirmationId,
        approve,
      );
      if (!approve) {
        say("Risicowijziging geannuleerd.");
        return;
      }
      if (!result.ok)
        throw new Error(result.error ?? "Risiconiveau is niet gewijzigd.");
      await load();
      say(
        result.warning ?? `Risico voor ${tool} gewijzigd naar ${risk}.`,
        result.warning ? "bad" : "ok",
      );
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : "Risiconiveau wijzigen is mislukt.";
      fail(cause);
    } finally {
      activityBusy = null;
    }
  }

  const workerStateLabel = (state: string) =>
    ({
      running: "Actief",
      starting: "Start bezig",
      stopped: "Gestopt",
      missing: "Niet gestart",
      mixed: "Gemengde status",
    })[state] ?? "Onbekend";

  const activityLabel = (kind: McpServerActivity["events"][number]["kind"]) =>
    ({
      connected: "verbonden",
      connection_failed: "verbinding mislukt",
      disconnected: "verbinding verbroken",
      connection_tested: "verbinding getest",
      connection_test_failed: "verbindingstest mislukt",
      tool_succeeded: "gereedschap geslaagd",
      tool_failed: "gereedschap mislukt",
    })[kind];
</script>

<section class="settings-notice" id="mcp-status" aria-label="MCP-servers">
  <h2>MCP-servers</h2>
  <p>
    Verbindingsstatus en gereedschapaantal zijn zichtbaar. Activiteit wordt op
    verzoek geladen en bevat alleen tijd, actie en gereedschapsnaam; invoer,
    uitvoer en foutdetails blijven privé.
  </p>
  <Button onclick={load} disabled={busy}
    >{busy ? "Ophalen…" : "Status ophalen"}</Button
  >
  {#if error}<p role="alert">{error}</p>{/if}
  {#if report}
    {#if catalog?.editable === false}<p class="hint">
        De meegeleverde MCP-catalogus is alleen-lezen. Verbindingsstatus blijft
        beschikbaar.
      </p>{/if}
    {#if report.workers}
      <section class="mcp-workers" aria-label="MCP-workers">
        <h3>Geïsoleerde MCP-workers</h3>
        <p class="hint">
          Deze processen voeren gereedschappen uit. Een actief proces en een
          werkende MCP-verbinding worden apart gecontroleerd.
        </p>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users must be able to scroll the status table.) -->
        <div
          class="mcp-worker-scroll"
          tabindex="0"
          role="region"
          aria-label="Workerstatus"
        >
          <table>
            <thead
              ><tr
                ><th scope="col">Worker</th><th scope="col">Proces</th><th
                  scope="col">Aantal</th
                ><th scope="col">Verbinding</th></tr
              ></thead
            >
            <tbody>
              {#each report.workers as worker (worker.server)}
                <tr class:duplicate={worker.workerCount > 1}>
                  <th scope="row">{worker.server}</th>
                  <td data-label="Proces"
                    >{worker.workerCount === 0
                      ? worker.server === "workspace-git"
                        ? "Op aanvraag"
                        : "Niet gestart"
                      : workerStateLabel(worker.state)}</td
                  >
                  <td data-label="Aantal"
                    >{worker.workerCount}{#if worker.workerCount > 1}<span
                        class="mcp-worker-warning">Meerdere workers</span
                      >{/if}</td
                  >
                  <td
                    data-label="Verbinding"
                    class:worker-connected={worker.connected === true}
                    >{worker.connected === null
                      ? "Op aanvraag"
                      : worker.connected
                        ? "Verbonden"
                        : "Niet verbonden"}</td
                  >
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}
    {#if report.servers.length}
      <ul>
        {#each report.servers as server (server.id)}
          <li>
            <strong>{server.id}</strong> —
            {server.enabled
              ? server.connected
                ? "verbonden"
                : "niet verbonden"
              : "uitgeschakeld"},
            {server.toolCount} gereedschappen
            {#if server.description}<p>{server.description}</p>{/if}
            {#if server.rights}<p>Rechten: {server.rights}</p>{/if}
            {#if server.id === "caldav" || server.id === "imap" || server.id === "github"}
              <McpConnectionConfig id={server.id} onSaved={load} />
            {/if}
            <p>
              Standaardrisico voor gereedschappen zonder eigen instelling: {server.defaultRisk}.
            </p>
            {#if server.howToDisable}<p>
                Uitzetten: {server.howToDisable}
              </p>{/if}
            {#if server.tools.length}
              <ul aria-label={`MCP-gereedschappen ${server.id}`}>
                {#each server.tools as tool (tool.name)}
                  <li>
                    {tool.name} — risico:
                    <select
                      aria-label={`Risico ${tool.name}`}
                      value={tool.risk}
                      disabled={busy || activityBusy !== null}
                      onchange={(event) =>
                        setToolRisk(
                          server.id,
                          tool.name,
                          event.currentTarget.value as Risk,
                        )}
                    >
                      {#each ["READ_ONLY", "SAFE", "CONFIRM", "DANGEROUS"] as risk (risk)}
                        <option value={risk}>{risk}</option>
                      {/each}
                    </select>
                  </li>
                {/each}
              </ul>
            {/if}
            <Button
              onclick={() => setEnabled(server.id, !server.enabled)}
              disabled={busy || activityBusy !== null}
              >{server.enabled ? "Uitschakelen" : "Inschakelen"}</Button
            >
            {#if catalog?.editable !== false && catalog?.installed.includes(server.id)}
              <Button
                onclick={() => changeCatalog(server.id, "remove")}
                disabled={busy || activityBusy !== null}
                >Uit catalogus verwijderen</Button
              >
            {/if}
            <Button
              onclick={() => testConnection(server.id)}
              disabled={!server.connected || busy || activityBusy !== null}
              >Verbinding testen</Button
            >
            <Button
              onclick={() => loadActivity(server.id)}
              disabled={busy || activityBusy !== null}
              >{activityBusy === server.id ? "Laden…" : "Activiteit"}</Button
            >
            <Button
              onclick={() => loadHistory(server.id)}
              disabled={busy || activityBusy !== null}
              >Wijzigingsgeschiedenis</Button
            >
            {#if history[server.id]}
              {#if history[server.id]!.truncated}<p>
                  Alleen de nieuwste 40 MCP-standwijzigingen worden bewaard.
                </p>{/if}
              {#if history[server.id]!.revisions.length}
                <ul aria-label={`MCP-wijzigingsgeschiedenis ${server.id}`}>
                  {#each history[server.id]!.revisions as revision (revision.id)}
                    <li>
                      <time datetime={revision.at}
                        >{new Date(revision.at).toLocaleString()}</time
                      >
                      — {revision.change.kind === "enabled"
                        ? `${revision.change.before ? "aan" : "uit"} → ${revision.change.after ? "aan" : "uit"}`
                        : revision.change.kind === "tool-risk"
                          ? `${revision.change.tool} · ${revision.change.before} → ${revision.change.after}`
                          : revision.change.operation === "add"
                            ? "door NOVA toegevoegd · uitgeschakeld"
                            : "uit catalogus verwijderd"}
                      {#if revision.change.kind !== "catalog" || revision.change.operation === "add"}
                        <Button
                          onclick={() => rollback(server.id, revision.id)}
                          disabled={busy || activityBusy !== null}
                          >Herstellen</Button
                        >
                      {/if}
                    </li>
                  {/each}
                </ul>
              {:else}
                <p>Geen MCP-wijzigingen sinds geschiedenis is ingeschakeld.</p>
              {/if}
            {/if}
            {#if activity[server.id]}
              {#if activity[server.id]!.truncated}<p>
                  Alleen de nieuwste 50 activiteiten van deze server worden
                  bewaard.
                </p>{/if}
              {#if activity[server.id]!.events.length}
                <ul aria-label={`Recente MCP-activiteit ${server.id}`}>
                  {#each activity[server.id]!.events as event (`${event.at}:${event.kind}:${event.tool || ""}`)}
                    <li>
                      <time datetime={event.at}
                        >{new Date(event.at).toLocaleString()}</time
                      >
                      — {activityLabel(event.kind)}{event.tool
                        ? `: ${event.tool}`
                        : ""}
                    </li>
                  {/each}
                </ul>
              {:else}
                <p>Geen activiteit sinds NOVA is gestart.</p>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p>Er zijn geen MCP-servers ingesteld.</p>
    {/if}
    {#if catalog?.available.length}
      <section aria-label="Beoordeelde MCP-catalogus">
        <h3>Beoordeelde servers toevoegen</h3>
        <p>
          Toevoegen start de server niet. Schakel hem daarna apart in om de
          vooraf beoordeelde server te starten.
        </p>
        <ul>
          {#each catalog.available as item (item.id)}
            <li>
              <strong>{item.id}</strong> — risico: {item.risk}
              <p>{item.description}</p>
              <p>Rechten: {item.rights}</p>
              <Button
                onclick={() => changeCatalog(item.id, "add")}
                disabled={busy || activityBusy !== null}>Toevoegen</Button
              >
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</section>

<style>
  .mcp-workers {
    margin-block: 24px;
  }
  .mcp-worker-scroll {
    overflow-x: auto;
  }
  .mcp-workers table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
    font-size: 13px;
  }
  .mcp-workers th,
  .mcp-workers td {
    padding: 12px 10px;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  .mcp-workers thead th {
    color: var(--dim);
    font-weight: 500;
  }
  .mcp-workers tbody th {
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .worker-connected {
    color: var(--good);
  }
  .duplicate,
  .mcp-worker-warning {
    color: var(--amber);
  }
  .mcp-worker-warning {
    display: block;
    font-size: 12px;
  }
  @media (max-width: 600px) {
    .mcp-workers table,
    .mcp-workers tbody {
      display: block;
    }
    .mcp-workers thead {
      position: absolute;
      width: 1px;
      height: 1px;
      clip-path: inset(50%);
      overflow: hidden;
    }
    .mcp-workers tr {
      display: grid;
      grid-template-columns: 1fr 1fr;
      padding-block: 12px;
      border-bottom: 1px solid var(--line);
    }
    .mcp-workers tbody th {
      grid-column: 1 / -1;
    }
    .mcp-workers th,
    .mcp-workers td {
      border: 0;
      padding: 6px 10px;
    }
    .mcp-workers td:last-child {
      grid-column: 1 / -1;
    }
    .mcp-workers td::before {
      content: attr(data-label);
      display: block;
      color: var(--dim);
      font-size: 11px;
      margin-bottom: 3px;
    }
  }
</style>
