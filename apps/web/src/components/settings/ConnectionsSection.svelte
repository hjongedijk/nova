<script lang="ts">
  import { ApiError } from "#lib/api/client.ts";
  import { onMount } from "svelte";
  import type {
    MqttOverview,
    QdrantOverview,
    QdrantIndexHistory,
    ManagedTargetInventory,
    ManagedTargetsAccessPolicy,
    ManagedTargetsAccessHistory,
    ServiceRestartStatus,
    ServiceConnection,
    ServiceConnectionTest,
    NodeRedFlowInventory,
    PendingConfirmation,
    HomeAssistantAccessPolicy,
    HomeAssistantAccessHistory,
  } from "@nova/contracts";
  import {
    getServiceConnections,
    getMqttOverview,
    getQdrantOverview,
    runQdrantMaintenance,
    runQdrantReindex,
    getQdrantIndexHistory,
    rollbackQdrantIndex,
    getHomeAssistantInventory,
    getHomeAssistantAccess,
    getHomeAssistantAccessHistory,
    rollbackHomeAssistantAccess,
    saveHomeAssistantAccess,
    getManagedTargetInventory,
    getManagedTargetsAccess,
    getManagedTargetsAccessHistory,
    rollbackManagedTargetsAccess,
    saveManagedTargetsAccess,
    saveServiceConnection,
    pairWindowsAgent,
    testServiceConnection,
    getServiceRestartStatus,
    requestServiceRestart,
    getNodeRedFlows,
  } from "#lib/api/settings.ts";
  import { fail, say } from "./state.svelte.ts";
  import Button from "#components/ui/Button.svelte";
  import Disclosure from "./ui/Disclosure.svelte";
  import NodeRedFlowHistory from "./NodeRedFlowHistory.svelte";
  import NodeRedBriefing from "./NodeRedBriefing.svelte";
  import NodeRedPalette from "./NodeRedPalette.svelte";
  import NodeRedEditor from "./NodeRedEditor.svelte";
  import NodeRedLogs from "./NodeRedLogs.svelte";
  import AdminConfirmation from "#components/admin/AdminConfirmation.svelte";
  import { sessionId } from "#components/admin/session.ts";
  import { executeAction } from "#lib/api/admin.ts";
  let {
    ids,
    showHelp = true,
    expanded = false,
  }: { ids?: string[]; showHelp?: boolean; expanded?: boolean } = $props();
  let services = $state<ServiceConnection[]>([]);
  let drafts = $state<Record<string, Record<string, string | boolean>>>({});
  let clear = $state<Record<string, Record<string, boolean>>>({});
  let tests = $state<Record<string, ServiceConnectionTest>>({});
  let busy = $state<string | null>(null);
  let error = $state("");
  let windowsPairCode = $state("");
  let mqttOverview = $state<MqttOverview | null>(null);
  let mqttError = $state("");
  let qdrantOverview = $state<QdrantOverview | null>(null);
  let qdrantError = $state("");
  let qdrantMaintenance = $state<{
    scanned?: number;
    archived?: number;
    more?: boolean;
  } | null>(null);
  let qdrantReindex = $state<{
    points?: number;
    collection?: string;
    warning?: string;
  } | null>(null);
  let qdrantIndexHistory = $state<QdrantIndexHistory | null>(null);
  let homeInventory = $state<Awaited<
    ReturnType<typeof getHomeAssistantInventory>
  > | null>(null);
  let homeInventoryError = $state("");
  let homeAccess = $state<HomeAssistantAccessPolicy | null>(null);
  let homeAccessHistory = $state<HomeAssistantAccessHistory | null>(null);
  let targetInventory = $state<ManagedTargetInventory | null>(null);
  let targetInventoryError = $state("");
  let targetAccess = $state<ManagedTargetsAccessPolicy | null>(null);
  let targetAccessHistory = $state<ManagedTargetsAccessHistory | null>(null);
  let restartStatus = $state<ServiceRestartStatus | null>(null);
  let nodeRedFlows = $state<NodeRedFlowInventory | null>(null);
  let nodeRedFlowsError = $state("");
  let nodeRedFlowsBusy = $state(false);
  let selectedNodeRedFlowId = $state("");
  let nodeRedRunBusy = $state(false);
  let nodeRedRunMessage = $state("");
  let nodeRedBriefingTime = $state("07:30");
  let nodeRedEveningReviewTime = $state("20:30");
  let nodeRedReminderTime = $state("08:00");
  let nodeRedReminderText = $state("Zet de afvalcontainer buiten.");
  let nodeRedRunConfirmation = $state<{
    label: string;
    action: PendingConfirmation;
  } | null>(null);
  const nodeRedTemplates = [
    {
      id: "alert_on_error",
      label: "Foutmelding",
      description: "catchable flowfouten",
    },
    {
      id: "alert_on_offline",
      label: "Offline-melding",
      description: "offline/disconnected node-status",
    },
    {
      id: "morning_briefing",
      label: "Ochtendbriefing",
      description: "dagelijkse korte gesproken samenvatting",
    },
    {
      id: "evening_review",
      label: "Avondoverzicht",
      description: "dagelijks overzicht van open punten en morgen",
    },
    {
      id: "daily_reminder",
      label: "Eigen dagelijkse routine",
      description: "stuur dagelijks een eigen herinnering",
    },
  ];
  function formatBytes(value: number | null): string {
    if (value === null) return "onbekend";
    if (value < 1024) return `${value} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let size = value;
    let unit = "B";
    for (const next of units) {
      size /= 1024;
      unit = next;
      if (size < 1024) break;
    }
    return `${new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 1 }).format(size)} ${unit}`;
  }
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
  // Only the first render honours `expanded`; later renders keep the user's choice.
  function openOnMount(node: HTMLDetailsElement, shouldOpen: boolean) {
    if (shouldOpen) node.open = true;
  }
  function openForFlowLink(node: HTMLDetailsElement, shouldOpen: boolean) {
    if (shouldOpen) node.open = true;
    return {
      update(next: boolean) {
        if (next) node.open = true;
      },
    };
  }
  async function load() {
    try {
      const [connections, restart] = await Promise.all([
        getServiceConnections(),
        getServiceRestartStatus(),
      ]);
      services = connections.services ?? [];
      restartStatus = restart;
      services.forEach(reset);
      error = "";
    } catch (e) {
      error =
        e instanceof ApiError
          ? e.message
          : "De koppelingen zijn niet beschikbaar.";
    }
  }
  async function restart() {
    busy = "restart";
    try {
      const result = await requestServiceRestart();
      if (!result.ok)
        throw new Error(result.error ?? "Herstart kon niet worden ingepland.");
      restartStatus = {
        available: true,
        pendingChanges: true,
        restartPending: true,
      };
      say("Herstart aangevraagd. NOVA kan kort niet bereikbaar zijn.", "ok");
    } catch (e) {
      fail(e);
    } finally {
      busy = null;
    }
  }
  onMount(() => {
    void load();
    const flowId = new URLSearchParams(window.location.search).get(
      "nodeRedFlow",
    );
    if (
      flowId &&
      (!ids || ids.includes("node-red")) &&
      /^[A-Za-z0-9._:-]{1,128}$/.test(flowId)
    ) {
      selectedNodeRedFlowId = flowId;
      void loadNodeRedFlows();
    }
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
  async function pairWindows() {
    busy = "windows";
    try {
      const result = await pairWindowsAgent(windowsPairCode);
      windowsPairCode = "";
      services = result.services;
      services.forEach(reset);
      restartStatus = await getServiceRestartStatus();
      delete tests.windows;
      say(
        result.auditWarning ??
          "Windows-agent gekoppeld. Herstart NOVA om de verbinding te gebruiken.",
        result.auditWarning ? "bad" : "ok",
      );
    } catch (e) {
      fail(e);
    } finally {
      busy = null;
    }
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
        restartStatus = await getServiceRestartStatus();
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
        e instanceof ApiError ? e.message : "MQTT-overzicht niet beschikbaar.";
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
        e instanceof ApiError
          ? e.message
          : "Qdrant-overzicht niet beschikbaar.";
    } finally {
      busy = null;
    }
  }
  async function maintainQdrant() {
    busy = "qdrant-maintenance";
    qdrantError = "";
    try {
      const result = await runQdrantMaintenance();
      if (!result.ok) throw new Error("Geheugen opschonen is niet gelukt.");
      qdrantMaintenance = result;
    } catch (e) {
      qdrantError =
        e instanceof ApiError
          ? e.message
          : "Geheugen opschonen is niet gelukt.";
    } finally {
      busy = null;
    }
  }
  async function reindexQdrant() {
    busy = "qdrant-reindex";
    qdrantError = "";
    try {
      const result = await runQdrantReindex();
      if (!result.ok)
        throw new Error(result.error ?? "Herindexeren is niet gelukt.");
      qdrantReindex = result;
      await loadQdrantOverview();
    } catch (e) {
      qdrantError =
        e instanceof ApiError ? e.message : "Herindexeren is niet gelukt.";
    } finally {
      busy = null;
    }
  }
  async function loadQdrantIndexHistory() {
    busy = "qdrant-index-history";
    try {
      qdrantIndexHistory = await getQdrantIndexHistory();
      qdrantError = "";
    } catch (e) {
      qdrantError =
        e instanceof ApiError
          ? e.message
          : "Indexgeschiedenis niet beschikbaar.";
    } finally {
      busy = null;
    }
  }
  async function restoreQdrantIndex(id: string) {
    busy = "qdrant-index-rollback";
    qdrantError = "";
    try {
      const result = await rollbackQdrantIndex(id);
      if (!result.ok)
        throw new Error(result.error ?? "Indexherstel is niet gelukt.");
      qdrantIndexHistory = await getQdrantIndexHistory();
      qdrantOverview = await getQdrantOverview();
    } catch (e) {
      qdrantError =
        e instanceof ApiError ? e.message : "Indexherstel is niet gelukt.";
    } finally {
      busy = null;
    }
  }
  async function loadHomeInventory() {
    busy = "home-inventory";
    try {
      [homeInventory, homeAccess, homeAccessHistory] = await Promise.all([
        getHomeAssistantInventory(),
        getHomeAssistantAccess(),
        getHomeAssistantAccessHistory(),
      ]);
      homeInventoryError = "";
    } catch (e) {
      homeInventoryError =
        e instanceof ApiError
          ? e.message
          : "Apparatenoverzicht niet beschikbaar.";
    } finally {
      busy = null;
    }
  }
  async function saveHomeAccess() {
    if (!homeAccess) return;
    busy = "home-access";
    try {
      const result = await saveHomeAssistantAccess(homeAccess);
      homeAccess = result.policy;
      homeAccessHistory = await getHomeAssistantAccessHistory();
      homeInventoryError = result.historyWarning
        ? `Toegang opgeslagen. ${result.historyWarning}`
        : "Toegang voor Home Assistant opgeslagen.";
    } catch (e) {
      homeInventoryError =
        e instanceof ApiError ? e.message : "Toegang opslaan is niet gelukt.";
    } finally {
      busy = null;
    }
  }
  async function rollbackHomeAccess(revision: string) {
    busy = "home-access-history";
    try {
      const result = await rollbackHomeAssistantAccess(revision);
      if (!result.ok || !result.policy) {
        homeInventoryError = result.error ?? "Toegang is niet teruggezet.";
        return;
      }
      homeAccess = result.policy;
      homeAccessHistory = await getHomeAssistantAccessHistory();
      homeInventoryError = result.historyWarning
        ? `Toegang teruggezet. ${result.historyWarning}`
        : "Home Assistant-toegang teruggezet en gecontroleerd.";
    } catch (e) {
      homeInventoryError =
        e instanceof ApiError
          ? e.message
          : "Toegang terugzetten is niet gelukt.";
    } finally {
      busy = null;
    }
  }
  function toggleHomeAccess(
    key: "areaIds" | "deviceIds" | "entityIds",
    id: string,
    checked: boolean,
  ) {
    if (!homeAccess) return;
    const values = homeAccess[key];
    homeAccess[key] = checked
      ? values.includes(id)
        ? values
        : [...values, id]
      : values.filter((value) => value !== id);
  }
  async function loadTargetInventory() {
    busy = "target-inventory";
    try {
      [targetInventory, targetAccess, targetAccessHistory] = await Promise.all([
        getManagedTargetInventory(),
        getManagedTargetsAccess(),
        getManagedTargetsAccessHistory(),
      ]);
      targetInventoryError = "";
    } catch (e) {
      targetInventoryError =
        e instanceof ApiError ? e.message : "Doelenoverzicht niet beschikbaar.";
    } finally {
      busy = null;
    }
  }
  function toggleTargetAccess(
    key: Exclude<keyof ManagedTargetsAccessPolicy, "mode">,
    id: string,
    checked: boolean,
  ) {
    if (!targetAccess) return;
    const values = targetAccess[key];
    targetAccess[key] = checked
      ? values.includes(id)
        ? values
        : [...values, id]
      : values.filter((value) => value !== id);
  }
  function targetPolicySummary(policy: ManagedTargetsAccessPolicy) {
    if (policy.mode === "all") return "alle doelen";
    const count =
      policy.proxmoxNodeIds.length +
      policy.proxmoxGuestIds.length +
      policy.termixHostIds.length +
      policy.pangolinSiteIds.length +
      policy.pangolinResourceIds.length;
    return `allowlist · ${count} doelen (${policy.proxmoxNodeIds.length} Proxmox-knooppunten, ${policy.proxmoxGuestIds.length} VM's, ${policy.termixHostIds.length} Termix-hosts, ${policy.pangolinSiteIds.length} sites, ${policy.pangolinResourceIds.length} resources)`;
  }
  async function saveTargetAccess() {
    if (!targetAccess) return;
    busy = "target-access";
    try {
      const result = await saveManagedTargetsAccess(targetAccess);
      targetAccess = result.policy;
      targetAccessHistory = await getManagedTargetsAccessHistory();
      targetInventoryError = result.historyWarning
        ? `Doeltoegang opgeslagen. ${result.historyWarning}`
        : "Doeltoegang opgeslagen.";
    } catch (e) {
      targetInventoryError =
        e instanceof ApiError
          ? e.message
          : "Doeltoegang opslaan is niet gelukt.";
    } finally {
      busy = null;
    }
  }
  async function rollbackTargetAccess(revision: string) {
    busy = "target-access-history";
    try {
      const result = await rollbackManagedTargetsAccess(revision);
      if (!result.ok || !result.policy) {
        targetInventoryError =
          result.error ?? "Doeltoegang is niet teruggezet.";
        return;
      }
      targetAccess = result.policy;
      targetAccessHistory = await getManagedTargetsAccessHistory();
      targetInventoryError = [result.historyWarning, result.auditWarning].some(
        Boolean,
      )
        ? `Doeltoegang teruggezet. ${[result.historyWarning, result.auditWarning].filter(Boolean).join(" ")}`
        : "Doeltoegang teruggezet en gecontroleerd.";
    } catch (e) {
      targetInventoryError =
        e instanceof ApiError
          ? e.message
          : "Doeltoegang terugzetten is niet gelukt.";
    } finally {
      busy = null;
    }
  }
  async function loadNodeRedFlows() {
    nodeRedFlowsBusy = true;
    try {
      nodeRedFlows = await getNodeRedFlows();
      nodeRedFlowsError = "";
    } catch (e) {
      nodeRedFlowsError =
        e instanceof ApiError ? e.message : "Flows niet beschikbaar.";
    } finally {
      nodeRedFlowsBusy = false;
    }
  }
  async function runNodeRedFlow(flow: NodeRedFlowInventory["flows"][number]) {
    if (!flow.runnableFlowId) return;
    nodeRedRunBusy = true;
    nodeRedRunMessage = "";
    nodeRedRunConfirmation = null;
    try {
      const result = await executeAction(sessionId(), "node_red_flow", {
        flow: flow.runnableFlowId,
        payload: {},
      });
      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        if (!result.action) throw new Error("Bevestiging niet beschikbaar.");
        nodeRedRunConfirmation = {
          label: flow.label,
          action: result.action as PendingConfirmation,
        };
        nodeRedRunMessage = `Bevestig het starten van ${flow.label}.`;
      } else if (!result.ok) {
        throw new Error(result.error || "Flow niet gestart.");
      } else {
        nodeRedRunMessage = `${flow.label} is gestart.`;
        await loadNodeRedFlows();
      }
    } catch (e) {
      nodeRedRunMessage =
        e instanceof ApiError ? e.message : "Flow niet gestart.";
    } finally {
      nodeRedRunBusy = false;
    }
  }
  async function setNodeRedFlowEnabled(
    flow: NodeRedFlowInventory["flows"][number],
    enabled: boolean,
  ) {
    if (!flow.manageable) return;
    nodeRedRunBusy = true;
    nodeRedRunMessage = "";
    nodeRedRunConfirmation = null;
    const verb = enabled ? "Inschakelen" : "Uitschakelen";
    try {
      const result = await executeAction(sessionId(), "node_red_flow_state", {
        tabId: flow.id,
        enabled,
      });
      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        if (!result.action) throw new Error("Bevestiging niet beschikbaar.");
        nodeRedRunConfirmation = {
          label: `${verb}: ${flow.label}`,
          action: result.action as PendingConfirmation,
        };
        nodeRedRunMessage = `Bevestig: ${verb.toLowerCase()} ${flow.label}.`;
      } else if (!result.ok) {
        throw new Error(result.error || "Flowstatus niet gewijzigd.");
      } else {
        nodeRedRunMessage = `${flow.label} is ${enabled ? "ingeschakeld" : "uitgeschakeld"}.`;
        await loadNodeRedFlows();
      }
    } catch (e) {
      nodeRedRunMessage =
        e instanceof ApiError ? e.message : "Flowstatus niet gewijzigd.";
    } finally {
      nodeRedRunBusy = false;
    }
  }
  async function addNodeRedTemplate(
    flow: NodeRedFlowInventory["flows"][number],
    template: (typeof nodeRedTemplates)[number],
  ) {
    if (!flow.templates.includes(template.id)) return;
    nodeRedRunBusy = true;
    nodeRedRunMessage = "";
    nodeRedRunConfirmation = null;
    try {
      const result = await executeAction(sessionId(), "node_red_flow_create", {
        flow: flow.id,
        kind: template.id,
        ...(template.id === "morning_briefing"
          ? { time: nodeRedBriefingTime }
          : template.id === "evening_review"
            ? { time: nodeRedEveningReviewTime }
            : template.id === "daily_reminder"
              ? { time: nodeRedReminderTime, message: nodeRedReminderText }
              : {}),
      });
      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        if (!result.action) throw new Error("Bevestiging niet beschikbaar.");
        nodeRedRunConfirmation = {
          label: `${template.label} toevoegen aan ${flow.label} (${template.description}${template.id === "morning_briefing" ? `, dagelijks om ${nodeRedBriefingTime}` : template.id === "evening_review" ? `, dagelijks om ${nodeRedEveningReviewTime}` : template.id === "daily_reminder" ? `, dagelijks om ${nodeRedReminderTime}: ${nodeRedReminderText}` : ""})`,
          action: result.action as PendingConfirmation,
        };
        nodeRedRunMessage = `Bevestig het toevoegen van ${template.label} aan ${flow.label}.`;
      } else if (!result.ok) {
        throw new Error(result.error || "Sjabloon niet toegevoegd.");
      } else {
        nodeRedRunMessage = `${template.label} toegevoegd aan ${flow.label}.`;
        await loadNodeRedFlows();
      }
    } catch (e) {
      nodeRedRunMessage =
        e instanceof ApiError ? e.message : "Sjabloon niet toegevoegd.";
    } finally {
      nodeRedRunBusy = false;
    }
  }
</script>

<section class="connections-section">
  {#if showHelp}
    <Disclosure title="Meer uitleg" kind="more">
      <p class="hint">
        Wat je hier invult wordt bewaard. Een nieuw adres of een nieuwe sleutel
        werkt pas nadat NOVA opnieuw is gestart. Met “Testen” controleer je of
        het werkt, zonder iets te bewaren.
      </p>
    </Disclosure>
  {/if}
  {#if error}<p role="status">{error}</p>
    <button type="button" onclick={load}>Opnieuw proberen</button>{/if}
  {#if ids?.some( (id) => ["proxmox", "termix", "pangolin"].includes(id) ) || shown.some( (service) => ["proxmox", "termix", "pangolin"].includes(service.id) )}
    <Disclosure
      title="Servers en machines"
      hint="Doelen en gedeelde toegangsregels"
    >
      <section aria-label="Server- en machineoverzicht" class="mqtt-overview">
        <p class="hint">
          On-demand namenoverzicht; alleen-lezen. Dit bepaalt nog niet welke
          doelen NOVA mag gebruiken.
        </p>
        <button
          type="button"
          disabled={busy !== null}
          onclick={loadTargetInventory}>Doelen laden</button
        >
        {#if targetInventoryError}<p role="status" class="connection-failed">
            {targetInventoryError}
          </p>{/if}
        {#if targetInventory}
          {#if targetAccess}<fieldset>
              <legend>Doeltoegang</legend>
              <label>
                <input
                  type="radio"
                  name="managed-target-access-mode"
                  checked={targetAccess.mode === "all"}
                  onchange={() => (targetAccess!.mode = "all")}
                /> Alle doelen van deze services
              </label>
              <label>
                <input
                  type="radio"
                  name="managed-target-access-mode"
                  checked={targetAccess.mode === "allowlist"}
                  onchange={() => (targetAccess!.mode = "allowlist")}
                /> Alleen geselecteerde doelen
              </label>
            </fieldset>
          {/if}
          {#if targetAccess?.mode === "allowlist"}
            {#if targetInventory.proxmox.configured}<h4>Proxmox-knooppunten</h4>
              {#each targetInventory.proxmox.nodes as item (item.id ?? item.name)}<label
                >
                  <input
                    type="checkbox"
                    checked={!!item.id &&
                      targetAccess.proxmoxNodeIds.includes(item.id)}
                    disabled={!item.id}
                    onchange={(event) =>
                      item.id &&
                      toggleTargetAccess(
                        "proxmoxNodeIds",
                        item.id,
                        event.currentTarget.checked,
                      )}
                  />
                  {item.name}
                </label>{/each}
              <h4>Proxmox-machines</h4>
              {#each targetInventory.proxmox.guests as item (item.id ?? item.name)}<label
                >
                  <input
                    type="checkbox"
                    checked={!!item.id &&
                      targetAccess.proxmoxGuestIds.includes(item.id)}
                    disabled={!item.id}
                    onchange={(event) =>
                      item.id &&
                      toggleTargetAccess(
                        "proxmoxGuestIds",
                        item.id,
                        event.currentTarget.checked,
                      )}
                  />
                  {item.name}
                </label>{/each}
            {/if}
            {#if targetInventory.termix.configured}<h4>Termix-hosts</h4>
              {#each targetInventory.termix.hosts as item (item.id ?? item.name)}<label
                >
                  <input
                    type="checkbox"
                    checked={!!item.id &&
                      targetAccess.termixHostIds.includes(item.id)}
                    disabled={!item.id}
                    onchange={(event) =>
                      item.id &&
                      toggleTargetAccess(
                        "termixHostIds",
                        item.id,
                        event.currentTarget.checked,
                      )}
                  />
                  {item.name}
                </label>{/each}
            {/if}
            {#if targetInventory.pangolin.configured}<h4>Pangolin-sites</h4>
              {#each targetInventory.pangolin.sites as item (item.id ?? item.name)}<label
                >
                  <input
                    type="checkbox"
                    checked={!!item.id &&
                      targetAccess.pangolinSiteIds.includes(item.id)}
                    disabled={!item.id}
                    onchange={(event) =>
                      item.id &&
                      toggleTargetAccess(
                        "pangolinSiteIds",
                        item.id,
                        event.currentTarget.checked,
                      )}
                  />
                  {item.name}
                </label>{/each}
              <h4>Pangolin-resources</h4>
              {#each targetInventory.pangolin.resources as item (item.id ?? item.name)}<label
                >
                  <input
                    type="checkbox"
                    checked={!!item.id &&
                      targetAccess.pangolinResourceIds.includes(item.id)}
                    disabled={!item.id}
                    onchange={(event) =>
                      item.id &&
                      toggleTargetAccess(
                        "pangolinResourceIds",
                        item.id,
                        event.currentTarget.checked,
                      )}
                  />
                  {item.name}
                </label>{/each}
            {/if}
            <p class="hint">
              Zonder selectie ziet NOVA geen doelen. Een geselecteerd Proxmox-
              knooppunt geeft toegang tot alle machines op dat knooppunt.
            </p>
          {/if}
          {#if targetAccess}<button
              type="button"
              disabled={busy !== null}
              onclick={saveTargetAccess}>Doeltoegang opslaan</button
            >{/if}
          {#if targetAccessHistory?.revisions.length}
            <h4>Wijzigingsgeschiedenis doeltoegang</h4>
            {#if targetAccessHistory.truncated}<p class="hint">
                Oudere wijzigingen zijn opgeschoond.
              </p>{/if}
            <ul>
              {#each targetAccessHistory.revisions as revision (revision.id)}<li
                >
                  {new Date(revision.at).toLocaleString("nl-NL")} ·
                  {targetPolicySummary(revision.before)} →
                  {targetPolicySummary(revision.after)}
                  <button
                    type="button"
                    disabled={busy !== null}
                    onclick={() => rollbackTargetAccess(revision.id)}
                    >Herstellen</button
                  >
                </li>{/each}
            </ul>
          {/if}
          {#if targetInventory.proxmox.configured}<h4>Proxmox</h4>
            {#if targetInventory.proxmox.error}<p>
                {targetInventory.proxmox.error}
              </p>{/if}
            <ul>
              {#each targetInventory.proxmox.nodes as item (item.id ?? item.name)}<li
                >
                  Knooppunt · {item.name}
                </li>{/each}
              {#each targetInventory.proxmox.guests as item (item.id ?? item.name)}<li
                >
                  {item.id ? `VM ${item.id}` : "VM"} · {item.name}
                </li>{/each}
            </ul>
          {:else}<p>Proxmox niet ingesteld.</p>{/if}
          {#if targetInventory.termix.configured}<h4>Termix</h4>
            {#if targetInventory.termix.error}<p>
                {targetInventory.termix.error}
              </p>{/if}
            <ul>
              {#each targetInventory.termix.hosts as item (item.id ?? item.name)}<li
                >
                  {item.name}
                </li>{/each}
            </ul>
          {:else}<p>Termix niet ingesteld.</p>{/if}
          {#if targetInventory.pangolin.configured}<h4>Pangolin</h4>
            {#if targetInventory.pangolin.error}<p>
                {targetInventory.pangolin.error}
              </p>{/if}
            <ul>
              {#each targetInventory.pangolin.sites as item (item.id ?? item.name)}<li
                >
                  Site · {item.name}
                </li>{/each}
              {#each targetInventory.pangolin.resources as item (item.id ?? item.name)}<li
                >
                  Resource · {item.name}
                </li>{/each}
            </ul>
          {:else}<p>Pangolin niet ingesteld.</p>{/if}
          <small
            >Gecontroleerd: {targetInventory.checkedAt}. Namenoverzicht begrensd
            tot 200 per lijst.</small
          >
        {/if}
      </section>
    </Disclosure>
  {/if}
  {#if restartStatus?.pendingChanges && shown.some((service) => service.restartRequired)}
    <div class="connection-pending" role="status">
      <p>
        Opgeslagen wijzigingen wachten op een herstart van NOVA.
        {#if !restartStatus.available}
          {restartStatus.reason ?? "Herstart NOVA handmatig."}
        {/if}
      </p>
      {#if restartStatus.available}<Button
          disabled={busy !== null || restartStatus.restartPending}
          onclick={restart}
          >{restartStatus.restartPending
            ? "Herstart aangevraagd"
            : "Herstart NOVA"}</Button
        >{/if}
    </div>
  {/if}
  {#each shown as service (service.id)}
    <details
      id={`connection-${service.id}`}
      class="connection-editor"
      use:openOnMount={expanded}
      use:openForFlowLink={service.id === "node-red" &&
        Boolean(selectedNodeRedFlowId)}
    >
      <summary>
        <strong>{service.label}</strong>
        <span
          class="connection-status"
          class:pending={service.restartRequired}
          class:healthy={!service.restartRequired &&
            tests[service.id]?.ok === true}
          class:failed={!service.restartRequired &&
            tests[service.id]?.ok === false}
        >
          {service.restartRequired
            ? "Herstart nodig"
            : tests[service.id]
              ? tests[service.id]!.ok
                ? "Bereikbaar"
                : "Controle mislukt"
              : "Nog niet gecontroleerd"}
        </span>
      </summary>
      {#if service.id === "omniroute"}
        <p class="hint">
          Een ander gateway-adres vraagt een nieuwe gratis-route-controle. Tot
          die controle klopt, antwoordt NOVA niet via die gateway.
        </p>
      {/if}
      {#if service.id === "windows"}
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void pairWindows();
          }}
        >
          <fieldset disabled={busy !== null}>
            <legend class="connection-legend">Koppelen met je pc</legend>
            <div class="connection-field">
              <label for="windows-pair-code"
                >Koppelcode uit NOVA voor Windows</label
              >
              <input
                id="windows-pair-code"
                type="password"
                bind:value={windowsPairCode}
                autocomplete="new-password"
                maxlength="2048"
                required
              />
              <small
                >Open bij het NOVA-pictogram op je pc ‘Instellen en koppelen’ en
                kopieer de code.</small
              >
            </div>
            <Button type="submit" disabled={!windowsPairCode.trim()}
              >Windows-agent koppelen</Button
            >
          </fieldset>
        </form>
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
      {#if service.id === "node-red"}
        <section
          id="node-red-flows"
          class="mqtt-overview"
          aria-label="Node-RED-flows"
        >
          <h4>Flows</h4>
          <p class="hint">
            Toont flows en de planning van vaste NOVA-briefings. Overige
            nodeconfiguratie en credentials blijven verborgen.
          </p>
          {#if nodeRedFlows?.editorUrl}<p>
              <a href={nodeRedFlows.editorUrl} target="_blank" rel="noreferrer"
                >Open Node-RED-editor</a
              >
            </p>{/if}
          <p class="hint">
            Flowbron in de repository: <code>deploy/nodered/flows.json</code>.
            Exporteer/importeer flows via de Node-RED-editor; NOVA overschrijft
            bestaande `/data/flows.json` niet bij updates.
          </p>
          <Button disabled={nodeRedFlowsBusy} onclick={loadNodeRedFlows}
            >{nodeRedFlowsBusy ? "Flows laden…" : "Flows laden"}</Button
          >
          {#if nodeRedFlowsError}<p class="connection-failed" role="status">
              {nodeRedFlowsError}
            </p>{/if}
          {#if nodeRedFlows}
            {#if nodeRedFlows.flows.length}<ul>
                {#each nodeRedFlows.flows as flow (flow.id)}
                  <li
                    id={selectedNodeRedFlowId === flow.id
                      ? "node-red-failed-flow"
                      : undefined}
                  >
                    <strong>{flow.label}</strong> · {flow.nodeCount} nodes{flow.disabled
                      ? " · uitgeschakeld"
                      : ""}
                    {#if flow.lastRun}<small>
                        · laatste run {flow.lastRun}</small
                      >{/if}
                    {#if flow.lastError}<span class="connection-failed">
                        · laatste fout: {flow.lastError}</span
                      >{/if}
                    {#if selectedNodeRedFlowId === flow.id}<span
                        class="connection-failed"
                      >
                        · bevat de gemelde fout</span
                      >{/if}
                    {#each flow.briefings ?? [] as briefing (briefing.id)}
                      <NodeRedBriefing {briefing} onSaved={loadNodeRedFlows} />
                    {/each}
                    {#if flow.runnableFlowId}<Button
                        disabled={nodeRedRunBusy || flow.disabled}
                        onclick={() => runNodeRedFlow(flow)}>Nu starten</Button
                      >{/if}
                    {#if flow.manageable}<Button
                        disabled={nodeRedRunBusy}
                        onclick={() =>
                          setNodeRedFlowEnabled(flow, flow.disabled)}
                        >{flow.disabled
                          ? "Inschakelen"
                          : "Uitschakelen"}</Button
                      >{/if}
                    {#if flow.templates.length}<span class="hint"
                        >Sjablonen:</span
                      >
                      {#each nodeRedTemplates.filter( (template) => flow.templates.includes(template.id) ) as template (template.id)}<Button
                          disabled={nodeRedRunBusy}
                          onclick={() => addNodeRedTemplate(flow, template)}
                          >{template.label} toevoegen</Button
                        >{#if template.id === "morning_briefing"}<label>
                            Tijd
                            <input
                              type="time"
                              aria-label="Tijd voor ochtendbriefing"
                              bind:value={nodeRedBriefingTime}
                            />
                          </label>{:else if template.id === "evening_review"}<label
                          >
                            Tijd
                            <input
                              type="time"
                              aria-label="Tijd voor avondoverzicht"
                              bind:value={nodeRedEveningReviewTime}
                            />
                          </label>{:else if template.id === "daily_reminder"}<label
                            >Bericht
                            <input
                              maxlength="240"
                              aria-label="Tekst van dagelijkse routine"
                              bind:value={nodeRedReminderText}
                            />
                          </label><label>
                            Tijd
                            <input
                              type="time"
                              aria-label="Tijd voor dagelijkse routine"
                              bind:value={nodeRedReminderTime}
                            />
                          </label>{/if}{/each}
                    {/if}
                  </li>
                {/each}
              </ul>{:else}<p>Geen flows gevonden.</p>{/if}
            {#if nodeRedFlows.truncated}<small
                >Alleen de eerste 200 flows getoond.</small
              >{/if}
            {#if nodeRedFlows.revision}<small
                >Versie: {nodeRedFlows.revision}</small
              >{/if}
            {#if nodeRedRunMessage}<p role="status">{nodeRedRunMessage}</p>{/if}
            {#if nodeRedRunConfirmation}<AdminConfirmation
                action={nodeRedRunConfirmation.action}
                description={nodeRedRunConfirmation.label}
                onreply={async (reply) => {
                  nodeRedRunMessage = reply;
                  nodeRedRunConfirmation = null;
                  await loadNodeRedFlows();
                }}
              />{/if}
          {/if}
          <NodeRedEditor />
          <NodeRedFlowHistory />
          <NodeRedPalette />
          <NodeRedLogs />
        </section>
      {/if}
      {#if service.id === "qdrant"}
        <section aria-label="Qdrant-collecties" class="mqtt-overview">
          <h3>Qdrant-geheugen</h3>
          <p class="hint">
            Collectiestatus is alleen-lezen. Opschonen archiveert uitsluitend
            lage-prioriteitsherinneringen die langer dan 90 dagen niet zijn
            gebruikt; het verwijdert geen gegevens.
          </p>
          <button
            type="button"
            disabled={busy !== null}
            onclick={loadQdrantOverview}>Collecties controleren</button
          >
          <button
            type="button"
            disabled={busy !== null}
            onclick={maintainQdrant}>Oude herinneringen archiveren</button
          >
          <button type="button" disabled={busy !== null} onclick={reindexQdrant}
            >Geheugenindex herindexeren</button
          >
          <button
            type="button"
            disabled={busy !== null}
            onclick={loadQdrantIndexHistory}>Indexgeschiedenis bekijken</button
          >
          {#if qdrantIndexHistory}<ul aria-label="Qdrant-indexgeschiedenis">
              {#each qdrantIndexHistory.revisions as revision (revision.id)}<li>
                  <span
                    >{new Date(revision.at).toLocaleString("nl-NL")}: {revision.points}
                    herinneringen</span
                  ><button
                    type="button"
                    disabled={busy !== null || !revision.current}
                    onclick={() => restoreQdrantIndex(revision.id)}
                    >Deze index terugzetten</button
                  >
                </li>{:else}<li>Geen indexwijzigingen vastgelegd.</li>{/each}
            </ul>{/if}
          {#if qdrantReindex}<p role="status">
              Index vernieuwd: {qdrantReindex.points ?? 0} herinneringen{qdrantReindex.warning
                ? `; ${qdrantReindex.warning}`
                : "."}
            </p>{/if}
          {#if qdrantMaintenance}<p role="status">
              Controle: {qdrantMaintenance.scanned ?? 0} herinneringen;
              {qdrantMaintenance.archived ?? 0} gearchiveerd{qdrantMaintenance.more
                ? "; er is nog meer te verwerken"
                : "."}
            </p>{/if}
          {#if qdrantError}<p role="status" class="connection-failed">
              {qdrantError}
            </p>{/if}
          {#if qdrantOverview}
            <p role="status">{qdrantOverview.message}</p>
            {#if qdrantOverview.activeMemoryCollection}<p class="hint">
                Actieve geheugenindex: {qdrantOverview.activeMemoryCollection}
              </p>{/if}
            {#if qdrantOverview.ok}
              {#if qdrantOverview.collections.length}
                <ul>
                  {#each qdrantOverview.collections as collection (collection.name)}<li
                    >
                      <code>{collection.name}</code> · {collection.points ??
                        "onbekend"} punten · {collection.indexedVectors ??
                        "onbekend"} geïndexeerd · {collection.segments ??
                        "onbekend"} segmenten · {collection.status} · {formatBytes(
                        collection.diskBytes,
                      )} op schijf · {formatBytes(collection.ramBytes)} RAM-data
                    </li>{/each}
                </ul>
              {:else}<p>Geen collecties gevonden.</p>{/if}
              {#if qdrantOverview.truncated}<p class="hint">
                  Maximaal 20 collecties; niet-ondersteunde namen worden
                  weggelaten.
                </p>{/if}
              <p class="hint">
                Grootte komt uit Qdrants collectie-info; RAM-data is geen meting
                van het vrije systeemgeheugen. Herindexeren is nog niet
                beschikbaar; gedeeltelijke vectorupdates kunnen zoekresultaten
                tijdelijk onjuist maken.
              </p>
            {/if}
          {/if}
        </section>
      {/if}
      {#if service.id === "home-assistant"}
        <section aria-label="Home Assistant-apparaten" class="mqtt-overview">
          <h3>Apparatenoverzicht</h3>
          <p class="hint">
            Kies welke gebieden of apparaten NOVA mag zien en bedienen. De
            selectie wordt ook afgedwongen voor zoeken, uitlezen en bedienen.
          </p>
          <button
            type="button"
            disabled={busy !== null}
            onclick={loadHomeInventory}>Apparaten laden</button
          >
          {#if homeInventoryError}<p role="status" class="connection-failed">
              {homeInventoryError}
            </p>{/if}
          {#if homeInventory}
            <p>
              {homeInventory.areas.length} gebieden · {homeInventory.devices
                .length} apparaten · {homeInventory.entities.length} entiteiten
            </p>
            <h4>Apparaten</h4>
            {#if homeAccess}
              <fieldset>
                <legend>Toegang</legend>
                <label>
                  <input
                    type="radio"
                    name="home-access-mode"
                    checked={homeAccess.mode === "all"}
                    onchange={() => (homeAccess!.mode = "all")}
                  /> Alle Home Assistant-apparaten
                </label>
                <label>
                  <input
                    type="radio"
                    name="home-access-mode"
                    checked={homeAccess.mode === "allowlist"}
                    onchange={() => (homeAccess!.mode = "allowlist")}
                  /> Alleen de geselecteerde gebieden en apparaten
                </label>
              </fieldset>
              {#if homeAccess.mode === "allowlist"}
                <h4>Gebieden</h4>
                {#each homeInventory.areas as area (area.id)}<label>
                    <input
                      type="checkbox"
                      checked={homeAccess.areaIds.includes(area.id)}
                      onchange={(event) =>
                        toggleHomeAccess(
                          "areaIds",
                          area.id,
                          event.currentTarget.checked,
                        )}
                    />
                    {area.name}
                  </label>{/each}
                <h4>Apparaten</h4>
                {#each homeInventory.devices as device (device.id)}<label>
                    <input
                      type="checkbox"
                      checked={homeAccess.deviceIds.includes(device.id)}
                      onchange={(event) =>
                        toggleHomeAccess(
                          "deviceIds",
                          device.id,
                          event.currentTarget.checked,
                        )}
                    />
                    {device.name}{#if device.areaId}
                      · {homeInventory.areas.find(
                        (area) => area.id === device.areaId,
                      )?.name ?? "Onbekend gebied"}{/if}
                  </label>{/each}
                {@const unassignedEntities = homeInventory.entities.filter(
                  (entity) => !entity.areaId && !entity.deviceId,
                )}
                {#if unassignedEntities.length}<h4>Losse entiteiten</h4>
                  {#each unassignedEntities as entity (entity.id)}<label>
                      <input
                        type="checkbox"
                        checked={homeAccess.entityIds.includes(entity.id)}
                        onchange={(event) =>
                          toggleHomeAccess(
                            "entityIds",
                            entity.id,
                            event.currentTarget.checked,
                          )}
                      />
                      {entity.name} · {entity.domain}
                    </label>{/each}
                {/if}
                <p class="hint">
                  Zonder selectie krijgt NOVA geen Home Assistant-apparaten.
                  Maximaal 100 gebieden, 500 apparaten en 1.000 losse
                  entiteiten.
                </p>
              {/if}
              <button
                type="button"
                disabled={busy !== null}
                onclick={saveHomeAccess}>Toegang opslaan</button
              >
              {#if homeAccessHistory?.revisions.length}
                <section aria-label="Home Assistant-toegangsgeschiedenis">
                  <h4>Wijzigingsgeschiedenis</h4>
                  {#if homeAccessHistory.truncated}<p class="hint">
                      Alleen de 50 recentste wijzigingen getoond.
                    </p>{/if}
                  <ol>
                    {#each homeAccessHistory.revisions as revision (revision.id)}
                      <li>
                        <span
                          >{new Date(revision.at).toLocaleString("nl-NL")}: {revision
                            .before.mode === "all"
                            ? "alle apparaten"
                            : `${revision.before.areaIds.length + revision.before.deviceIds.length + revision.before.entityIds.length} doelen`}
                          → {revision.after.mode === "all"
                            ? "alle apparaten"
                            : `${revision.after.areaIds.length + revision.after.deviceIds.length + revision.after.entityIds.length} doelen`}</span
                        >
                        <button
                          type="button"
                          disabled={busy !== null}
                          onclick={() => rollbackHomeAccess(revision.id)}
                          >Herstellen</button
                        >
                      </li>
                    {/each}
                  </ol>
                </section>
              {/if}
            {/if}
            <ul>
              {#each homeInventory.devices as device (device.id)}<li>
                  {device.name}{#if device.areaId}
                    · {homeInventory.areas.find(
                      (area) => area.id === device.areaId,
                    )?.name ?? "Onbekend gebied"}{/if}
                </li>{/each}
            </ul>
            {#each homeInventory.areas as area (area.id)}<h4>{area.name}</h4>
              <ul>
                {#each homeInventory.entities
                  .filter((entity) => entity.areaId === area.id)
                  .slice(0, 100) as entity (entity.id)}<li>
                    <code>{entity.id}</code> · {entity.name} · {entity.domain}
                  </li>{/each}
              </ul>{/each}
            {@const unassigned = homeInventory.entities.filter(
              (entity) => !entity.areaId,
            )}
            {#if unassigned.length}<h4>Zonder gebied</h4>
              <ul>
                {#each unassigned.slice(0, 100) as entity (entity.id)}<li>
                    <code>{entity.id}</code> · {entity.name} · {entity.domain}
                  </li>{/each}
              </ul>{/if}
            {#if homeInventory.syncedAt}<small
                >Bijgewerkt: {homeInventory.syncedAt}</small
              >{/if}
            <p class="hint">
              Overzicht begrensd tot 100 gebieden, 500 apparaten en 1.000
              entiteiten.
            </p>
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
    margin: 12px 0;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
  }
  .connection-editor summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    cursor: pointer;
    min-height: 44px;
    font-size: 15px;
  }
  .connection-editor summary span,
  .connection-field small {
    color: var(--dim);
    font-size: 14px;
  }
  .connection-editor[open] {
    padding-bottom: 12px;
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
    margin-bottom: 12px;
    max-width: 650px;
  }
  .connection-field label {
    font-size: 16px;
    font-weight: 600;
  }
  .connection-field input:not([type="checkbox"]) {
    width: 100%;
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--mist);
    padding: 12px;
    border-radius: 8px;
    min-height: 48px;
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
  .connection-status {
    border: 1px solid var(--line);
    padding: 2px 8px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .connection-editor summary .healthy {
    color: var(--good);
  }
  .connection-editor summary .failed {
    color: var(--alert);
  }
  .connection-editor summary .pending {
    color: var(--amber);
  }
  .connection-pending {
    color: var(--amber);
  }
  .connection-failed {
    color: var(--alert);
  }
</style>
