<script lang="ts">
  import { onDestroy } from "svelte";
  import NativePromptEditor from "./NativePromptEditor.svelte";
  import type {
    NativeGatewayReport,
    NativeMemoryPrepared,
    NativeMemoryHistory,
    NativeMemoryRecords,
    NativeMemoryRecordPrepared,
    NativeMemoryRecordsDeletePrepared,
    NativeSkillDocument,
    NativeSkillMode,
    NativeSkillModeHistory,
    NativeSkillModePrepared,
    NativeSkillRemovalPrepared,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    getNativeGateway,
    getNativeSkillDocument,
    prepareNativeSkillMode,
    confirmNativeSkillMode,
    getNativeSkillModeHistory,
    prepareNativeSkillModeRollback,
    prepareNativeSkillRemoval,
    confirmNativeSkillRemoval,
    prepareNativeMemory,
    confirmNativeMemory,
    getNativeMemoryHistory,
    getNativeMemoryRecords,
    prepareNativeMemoryRollback,
    prepareNativeMemoryRecordDelete,
    prepareNativeMemoryRecordsDelete,
    prepareNativeMemoryRecordUpdate,
    confirmNativeMemoryRecordDelete,
    confirmNativeMemoryRecordsDelete,
    confirmNativeMemoryRecordUpdate,
  } from "#lib/api/settings.ts";
  let report = $state<NativeGatewayReport | null>(null);
  let document = $state<NativeSkillDocument | null>(null);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let globalAcknowledged = $state<Record<string, boolean>>({});
  let modeHistories = $state<Record<string, NativeSkillModeHistory>>({});
  let pending = $state<
    (NativeSkillModePrepared & { id: string; mode: NativeSkillMode }) | null
  >(null);
  let pendingRemoval = $state<
    (NativeSkillRemovalPrepared & { id: string }) | null
  >(null);
  let pendingMemory = $state<
    (NativeMemoryPrepared & { enabled: boolean }) | null
  >(null);
  let memoryAcknowledged = $state(false);
  let memoryHistory = $state<NativeMemoryHistory | null>(null);
  let memoryRecords = $state<NativeMemoryRecords | null>(null);
  let pendingMemoryDelete = $state<NativeMemoryRecordPrepared | null>(null);
  let pendingMemoryBulkDelete =
    $state<NativeMemoryRecordsDeletePrepared | null>(null);
  let selectedMemoryIds = $state<string[]>([]);
  let pendingMemoryEdit = $state<NativeMemoryRecordPrepared | null>(null);
  let editingMemoryId = $state<string | null>(null);
  let editingMemoryContent = $state("");
  let expired = $state(false);
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const modeName = (mode: NativeSkillMode) =>
    ({ on: "Aan", off: "Uit", auto: "Automatisch" })[mode];
  async function prepare(
    id: string,
    mode: NativeSkillMode,
    scope: "nova" | "global",
    rollbackRevisionId?: string,
  ) {
    busy = true;
    error = "";
    notice = "";
    try {
      const acknowledged =
        scope === "global" && globalAcknowledged[id] === true;
      const result = rollbackRevisionId
        ? await prepareNativeSkillModeRollback(
            id,
            rollbackRevisionId,
            acknowledged,
          )
        : await prepareNativeSkillMode(id, mode, acknowledged);
      if (!result.ok || !result.action) {
        error = result.error || "Wijziging kon niet worden voorbereid.";
        return;
      }
      pending = { ...result, id, mode };
      if (scope === "global") globalAcknowledged[id] = false;
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
        "Wijziging kon niet worden voorbereid. Controleer je PIN en de koppeling.";
    } finally {
      busy = false;
    }
  }
  async function confirm(approve: boolean) {
    const current = pending;
    if (!current?.action) return;
    busy = true;
    error = "";
    try {
      const result = await confirmNativeSkillMode(
        current.id,
        current.action.sessionId,
        current.action.confirmationId,
        approve,
      );
      if (!result.ok)
        error = result.error || "Wijziging kon niet worden gecontroleerd.";
      else if (approve && result.verified === true) {
        const skill = report?.skills.find((item) => item.id === current.id);
        if (skill && result.mode && typeof result.enabled === "boolean") {
          skill.mode = result.mode;
          skill.enabled = result.enabled;
        }
        if (current.scope === "global") globalAcknowledged[current.id] = false;
        // Keep history on-demand. Refresh it after a change only when the
        // user has already opened this skill's history panel.
        if (modeHistories[current.id]) {
          const history = await getNativeSkillModeHistory(current.id).catch(
            () => null,
          );
          if (history) modeHistories[current.id] = history;
        }
        notice = `Modus opgeslagen en gecontroleerd. De gateway kan maximaal één minuut achterlopen.${result.auditWarning ? ` ${result.auditWarning}` : ""}${result.historyWarning ? ` ${result.historyWarning}` : ""}`;
      } else notice = "Wijziging geannuleerd.";
    } catch {
      error =
        "Bevestiging kon niet worden afgerond. Controleer de status voordat je opnieuw wijzigt.";
    } finally {
      pending = null;
      clearTimeout(expiryTimer);
      busy = false;
    }
  }
  async function loadModeHistory(id: string) {
    busy = true;
    error = "";
    try {
      modeHistories[id] = await getNativeSkillModeHistory(id);
    } catch {
      error = "Skillgeschiedenis kon niet worden geladen.";
    } finally {
      busy = false;
    }
  }
  async function prepareRemoval(id: string) {
    busy = true;
    error = "";
    notice = "";
    try {
      const result = await prepareNativeSkillRemoval(id);
      if (!result.ok || !result.action) {
        error = result.error || "Verwijderen kon niet worden voorbereid.";
        return;
      }
      pendingRemoval = { ...result, id };
    } catch {
      error =
        "Verwijderen kon niet worden voorbereid. Controleer je PIN en de koppeling.";
    } finally {
      busy = false;
    }
  }
  async function confirmRemoval(approve: boolean) {
    const current = pendingRemoval;
    if (!current?.action) return;
    busy = true;
    error = "";
    try {
      const result = await confirmNativeSkillRemoval(
        current.id,
        current.action.sessionId,
        current.action.confirmationId,
        approve,
      );
      if (!result.ok || (approve && result.verified !== true))
        error = result.error || "Verwijderen kon niet worden gecontroleerd.";
      else {
        if (approve && report)
          report.skills = report.skills.filter(
            (skill) => skill.id !== current.id,
          );
        notice = approve
          ? `Skill verwijderd en gecontroleerd.${result.auditWarning ? ` ${result.auditWarning}` : ""}`
          : "Verwijderen geannuleerd.";
      }
    } catch {
      error =
        "Verwijderen kon niet worden afgerond. Laad het overzicht opnieuw.";
    } finally {
      pendingRemoval = null;
      busy = false;
    }
  }
  async function prepareMemory(enabled: boolean) {
    busy = true;
    error = "";
    notice = "";
    try {
      const result = await prepareNativeMemory(enabled, true);
      if (!result.ok || !result.action) {
        error = result.error || "Wijziging kon niet worden voorbereid.";
        return;
      }
      pendingMemory = { ...result, enabled };
      memoryAcknowledged = false;
    } catch {
      error =
        "Wijziging kon niet worden voorbereid. Controleer de PIN en OmniRoute.";
    } finally {
      busy = false;
    }
  }
  async function confirmMemory(approve: boolean) {
    const current = pendingMemory;
    if (!current?.action) return;
    busy = true;
    error = "";
    try {
      const result = await confirmNativeMemory(
        current.action.sessionId,
        current.action.confirmationId,
        approve,
      );
      if (!result.ok)
        error = result.error || "Wijziging kon niet worden bevestigd.";
      else if (approve && result.verified) {
        if (report) report.memory.enabled = result.enabled ?? current.enabled;
        memoryHistory = await getNativeMemoryHistory().catch(
          () => memoryHistory,
        );
        notice = `Gateway-geheugen ${result.enabled ? "ingeschakeld" : "uitgeschakeld"} voor alle clients.${result.auditWarning ? ` ${result.auditWarning}` : ""}`;
      } else notice = "Wijziging geannuleerd.";
    } catch {
      error = "Uitkomst onbekend. Laad de geheugenstatus opnieuw.";
    } finally {
      pendingMemory = null;
      memoryAcknowledged = false;
      busy = false;
    }
  }
  async function rollbackMemory(id: string) {
    busy = true;
    error = "";
    notice = "";
    try {
      const result = await prepareNativeMemoryRollback(id);
      if (!result.ok || !result.action) {
        error = result.error || "Herstel kon niet worden voorbereid.";
        return;
      }
      pendingMemory = { ...result, enabled: result.enabled ?? false };
      memoryAcknowledged = false;
    } catch {
      error =
        "Herstel kon niet worden voorbereid. Controleer de PIN en OmniRoute.";
    } finally {
      busy = false;
    }
  }
  async function loadMemoryRecords(offset = 0) {
    busy = true;
    error = "";
    try {
      const result = await getNativeMemoryRecords(offset);
      memoryRecords = offset
        ? {
            ...result,
            memories: [...(memoryRecords?.memories ?? []), ...result.memories],
          }
        : result;
      if (!offset) selectedMemoryIds = [];
      if (result.error) error = result.error;
    } catch {
      error = "NOVA-geheugenrecords konden niet worden geladen.";
    } finally {
      busy = false;
    }
  }
  async function prepareMemoryRecordDelete(id: string) {
    busy = true;
    error = "";
    try {
      const result = await prepareNativeMemoryRecordDelete(id);
      if (!result.ok || !result.action) {
        error = result.error || "Verwijderen kon niet worden voorbereid.";
        return;
      }
      pendingMemoryDelete = result;
    } catch {
      error = "Verwijderen kon niet worden voorbereid. Laad records opnieuw.";
    } finally {
      busy = false;
    }
  }
  async function prepareMemoryRecordsBulkDelete() {
    if (!selectedMemoryIds.length) return;
    busy = true;
    error = "";
    try {
      const result = await prepareNativeMemoryRecordsDelete(selectedMemoryIds);
      if (!result.ok || !result.action) {
        error = result.error || "Bulkverwijdering kon niet worden voorbereid.";
        return;
      }
      pendingMemoryBulkDelete = result;
    } catch {
      error =
        "Bulkverwijdering kon niet worden voorbereid. Laad records opnieuw.";
    } finally {
      busy = false;
    }
  }
  async function prepareMemoryRecordUpdate(id: string) {
    busy = true;
    error = "";
    try {
      const result = await prepareNativeMemoryRecordUpdate(
        id,
        editingMemoryContent,
      );
      if (!result.ok || !result.action) {
        error = result.error || "Wijziging kon niet worden voorbereid.";
        return;
      }
      pendingMemoryEdit = result;
    } catch {
      error = "Wijziging kon niet worden voorbereid. Laad records opnieuw.";
    } finally {
      busy = false;
    }
  }
  async function confirmMemoryRecordDelete(approve: boolean) {
    const action = pendingMemoryDelete?.action;
    if (!action) return;
    busy = true;
    error = "";
    try {
      const result = await confirmNativeMemoryRecordDelete(
        action.sessionId,
        action.confirmationId,
        approve,
      );
      if (!result.ok || (approve && result.verified !== true))
        error = result.error || "Verwijdering kon niet worden gecontroleerd.";
      else {
        notice = approve
          ? "Geheugenrecord verwijderd."
          : "Verwijderen geannuleerd.";
        if (approve) await loadMemoryRecords();
      }
    } catch {
      error = "Uitkomst onbekend. Laad de records opnieuw.";
    } finally {
      pendingMemoryDelete = null;
      busy = false;
    }
  }
  async function confirmMemoryRecordsBulkDelete(approve: boolean) {
    const action = pendingMemoryBulkDelete?.action;
    if (!action) return;
    busy = true;
    error = "";
    try {
      const result = await confirmNativeMemoryRecordsDelete(
        action.sessionId,
        action.confirmationId,
        approve,
      );
      if (!result.ok || (approve && result.verified !== true))
        error =
          result.error || "Bulkverwijdering kon niet worden gecontroleerd.";
      else {
        notice = approve
          ? "Geselecteerde geheugenrecords verwijderd."
          : "Bulkverwijdering geannuleerd.";
        if (approve) await loadMemoryRecords();
        else selectedMemoryIds = [];
      }
    } catch {
      error = "Uitkomst onbekend. Vernieuw de geheugenrecords.";
    } finally {
      pendingMemoryBulkDelete = null;
      busy = false;
    }
  }
  async function confirmMemoryRecordEdit(approve: boolean) {
    const action = pendingMemoryEdit?.action;
    if (!action) return;
    busy = true;
    error = "";
    try {
      const result = await confirmNativeMemoryRecordUpdate(
        action.sessionId,
        action.confirmationId,
        approve,
      );
      if (!result.ok || (approve && result.verified !== true))
        error = result.error || "Wijziging kon niet worden gecontroleerd.";
      else {
        notice = approve
          ? "Geheugenrecord bijgewerkt."
          : "Wijzigen geannuleerd.";
        if (approve) await loadMemoryRecords();
      }
    } catch {
      error = "Uitkomst onbekend. Laad de records opnieuw.";
    } finally {
      pendingMemoryEdit = null;
      editingMemoryId = null;
      editingMemoryContent = "";
      busy = false;
    }
  }
  onDestroy(() => clearTimeout(expiryTimer));
  async function load() {
    busy = true;
    error = "";
    document = null;
    memoryRecords = null;
    try {
      report = await getNativeGateway();
      report.memory ??= { enabled: null, backend: null, maxTokens: null };
      memoryHistory = await getNativeMemoryHistory().catch(() => null);
    } catch {
      report = null;
      error = "OmniRoute-overzicht kon niet worden geladen.";
    } finally {
      busy = false;
    }
  }
  async function read(id: string) {
    busy = true;
    error = "";
    try {
      document = await getNativeSkillDocument(id);
    } catch {
      document = null;
      error = "Documentatie kon niet worden geladen.";
    } finally {
      busy = false;
    }
  }
</script>

<section aria-label="OmniRoute-skills en prompts">
  <h2>Skills in OmniRoute</h2>
  <p>
    OmniRoute heeft eigen uitvoerbare skills en een aparte
    documentatiecatalogus. Dit overzicht voert niets uit.
  </p>
  <Button
    onclick={load}
    disabled={busy ||
      !!pending ||
      !!pendingRemoval ||
      !!pendingMemory ||
      !!pendingMemoryDelete ||
      !!pendingMemoryBulkDelete ||
      !!pendingMemoryEdit}
    >{busy ? "Laden…" : "OmniRoute-overzicht laden"}</Button
  >
  {#if error}<p role="status">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if pending}
    <div
      class="mode-confirm"
      role="group"
      aria-label="Native skillwijziging bevestigen"
    >
      <h3>{pending.name}: modus {modeName(pending.mode)}</h3>
      <p>
        Native skills kunnen code uitvoeren in de gateway. Deze modus geldt
        {pending.scope === "global"
          ? " voor alle gateway-clients. "
          : " voor NOVA. "}
        NOVA blijft zijn eigen toolbevestigingen gebruiken.
      </p>
      <p>
        {expired
          ? "Bevestiging verlopen. Annuleer en kies de wijziging opnieuw."
          : "Bevestig binnen 60 seconden. Deze toestemming geldt één keer."}
      </p>
      <Button onclick={() => confirm(true)} disabled={busy || expired}
        >Bevestig skillmodus voor {pending.scope === "global"
          ? "alle clients"
          : "NOVA"}</Button
      >
      <Button onclick={() => confirm(false)} disabled={busy}
        >Annuleer skillmodus</Button
      >
    </div>
  {/if}
  {#if pendingRemoval}
    <div
      class="mode-confirm"
      role="group"
      aria-label="NOVA-skill verwijderen bevestigen"
    >
      <h3>Verwijder {pendingRemoval.name}?</h3>
      <p>
        Dit verwijdert de uitvoerbare skill van NOVA uit OmniRoute. Dit kan niet
        vanuit NOVA ongedaan worden gemaakt. De gateway kan maximaal één minuut
        achterlopen.
      </p>
      <p>
        Bevestig deze eenmalige DANGEROUS-wijziging alleen als je deze skill
        echt wilt verwijderen.
      </p>
      <Button onclick={() => confirmRemoval(true)} disabled={busy}
        >Verwijder skill definitief</Button
      >
      <Button onclick={() => confirmRemoval(false)} disabled={busy}
        >Annuleer verwijderen</Button
      >
    </div>
  {/if}
  {#if pendingMemory}
    <div
      class="mode-confirm"
      role="group"
      aria-label="Gateway-geheugenwijziging bevestigen"
    >
      <h3>
        Gateway-geheugen {pendingMemory.enabled
          ? "inschakelen"
          : "uitschakelen"}?
      </h3>
      <p>
        Dit geldt voor alle clients op deze OmniRoute-gateway. Inschakelen kan
        opgeslagen context in verzoeken opnemen en extra tokens gebruiken.
      </p>
      <p>Bevestig binnen 60 seconden. Deze toestemming geldt één keer.</p>
      <Button onclick={() => confirmMemory(true)} disabled={busy}
        >Bevestig voor alle clients</Button
      >
      <Button onclick={() => confirmMemory(false)} disabled={busy}
        >Annuleer</Button
      >
    </div>
  {/if}
  {#if report}
    {#if !report.available}<p role="status">{report.error}</p>
    {:else}
      <h3>Uitvoerbare skills</h3>
      <p>Gateway-status kan maximaal één minuut achterlopen.</p>
      <p>
        Wijzig NOVA- en gedeelde skill-modi. Gedeelde modi gelden voor alle
        gateway-clients en vragen extra bevestiging. NOVA-skills kunnen na een
        aparte DANGEROUS-bevestiging worden verwijderd. Gedeelde skills blijven
        beschermd; installeren en handlercode wijzigen gebeurt niet hier.
      </p>
      {#if report.truncated}<p>
          Alleen de eerste 200 gateway-items zijn gecontroleerd. Er kunnen meer
          NOVA-skills zijn.
        </p>{/if}
      {#if !report.skills.length}<p>
          Geen skills voor NOVA gevonden in deze pagina.
        </p>{/if}
      <ul>
        {#each report.skills as skill (skill.id)}<li>
            <strong>{skill.name}</strong> · {skill.version}<br
            />{skill.scope === "nova"
              ? "NOVA"
              : "Gedeeld met alle gateway-clients"} · {skill.enabled === null
              ? "Status onbekend"
              : skill.enabled
                ? "Ingeschakeld"
                : "Uitgeschakeld"} · modus {skill.mode
              ? modeName(skill.mode)
              : "onbekend"}
            {#if skill.scope === "global"}
              <label class="global-ack">
                <input
                  type="checkbox"
                  bind:checked={globalAcknowledged[skill.id]}
                  disabled={busy || !!pending || !!pendingRemoval}
                />
                Ik begrijp dat dit alle OmniRoute-clients raakt.
              </label>
            {/if}
            {#if skill.scope === "nova"}
              <Button
                onclick={() => prepareRemoval(skill.id)}
                disabled={busy || !!pending || !!pendingRemoval}
                >Verwijder NOVA-skill</Button
              >
            {/if}
            {#if skill.scope === "nova" || skill.scope === "global"}
              <div class="mode-buttons">
                {#each ["on", "off", "auto"] as mode (mode)}
                  <Button
                    onclick={() =>
                      prepare(skill.id, mode as NativeSkillMode, skill.scope)}
                    disabled={busy ||
                      !!pending ||
                      !!pendingRemoval ||
                      skill.mode === mode ||
                      (skill.scope === "global" &&
                        globalAcknowledged[skill.id] !== true)}
                  >
                    {modeName(mode as NativeSkillMode)}
                    {skill.name}
                  </Button>
                {/each}
              </div>
              <Button
                onclick={() => loadModeHistory(skill.id)}
                disabled={busy || !!pending || !!pendingRemoval}
                >Geschiedenis {skill.name}</Button
              >
              {#if modeHistories[skill.id]?.revisions.length}
                <ol aria-label={`Skillgeschiedenis ${skill.name}`}>
                  {#each modeHistories[skill.id]?.revisions ?? [] as revision, index (revision.id)}
                    <li>
                      <time datetime={revision.at}
                        >{new Date(revision.at).toLocaleString("nl-NL")}</time
                      >
                      · {modeName(revision.before)} → {modeName(revision.after)}
                      {#if revision.revertedFrom}<span> · herstel</span>{/if}
                      {#if index === 0}
                        <Button
                          onclick={() =>
                            prepare(
                              skill.id,
                              revision.before,
                              revision.scope,
                              revision.id,
                            )}
                          disabled={busy ||
                            !!pending ||
                            !!pendingRemoval ||
                            skill.mode !== revision.after ||
                            (revision.scope === "global" &&
                              globalAcknowledged[skill.id] !== true)}
                          >Zet terug</Button
                        >
                      {/if}
                    </li>
                  {/each}
                </ol>
              {/if}
            {/if}
          </li>{/each}
      </ul>
      <h3>Gateway-prompt</h3>
      <p>
        Extra prompt voor alle gateway-clients: {report.prompt.enabled === null
          ? "status onbekend"
          : report.prompt.enabled
            ? "ingeschakeld"
            : "uitgeschakeld"}. Voorvoegsel: {report.prompt.prefixCharacters ??
          "onbekend"} tekens; achtervoegsel: {report.prompt.suffixCharacters ??
          "onbekend"} tekens.
      </p>
      <p>NOVA-instructies beheer je bij Skills; eigen geheugen bij Geheugen.</p>
      <h3>Gateway-geheugen</h3>
      <p>
        {report.memory.enabled === null
          ? "Status niet beschikbaar."
          : report.memory.enabled
            ? "Ingeschakeld"
            : "Uitgeschakeld"}; backend {report.memory.backend ?? "onbekend"};
        limiet {report.memory.maxTokens ?? "onbekend"} tokens. Dit is OmniRoute-geheugen,
        apart van NOVA's eigen geheugen.
      </p>
      <details>
        <summary>Eigen geheugenrecords bekijken</summary>
        <p>
          Laadt alleen NOVA-records. De inhoud blijft verborgen tot je dit
          onderdeel opent en de knop kiest.
        </p>
        <Button onclick={() => loadMemoryRecords()} disabled={busy}
          >Records laden</Button
        >
        {#if memoryRecords}
          {#if memoryRecords.memories.length}
            <p>
              {selectedMemoryIds.length} record(s) geselecteerd (maximaal 25).
            </p>
            <Button
              onclick={prepareMemoryRecordsBulkDelete}
              disabled={busy ||
                !selectedMemoryIds.length ||
                selectedMemoryIds.length > 25 ||
                !!pendingMemoryBulkDelete ||
                !!pendingMemoryDelete ||
                !!pendingMemoryEdit}>Verwijder selectie</Button
            >
          {/if}
          <ol aria-label="NOVA-geheugenrecords">
            {#each memoryRecords.memories as item (item.id)}<li>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`Selecteer record ${item.id}`}
                    checked={selectedMemoryIds.includes(item.id)}
                    disabled={busy ||
                      !!pendingMemoryBulkDelete ||
                      !!pendingMemoryDelete ||
                      !!pendingMemoryEdit}
                    onchange={(event) => {
                      selectedMemoryIds = event.currentTarget.checked
                        ? [...selectedMemoryIds, item.id]
                        : selectedMemoryIds.filter((id) => id !== item.id);
                    }}
                  />
                  Selecteer voor verwijderen
                </label>
                <time
                  >{item.created_at
                    ? new Date(item.created_at).toLocaleString("nl-NL")
                    : "Datum onbekend"}</time
                >
                <pre>{item.text}</pre>
                {#if editingMemoryId === item.id}
                  <label>
                    Geheugentekst
                    <textarea
                      bind:value={editingMemoryContent}
                      maxlength="4000"
                      disabled={busy || !!pendingMemoryEdit}></textarea>
                  </label>
                  <Button
                    onclick={() => prepareMemoryRecordUpdate(item.id)}
                    disabled={busy || !!pendingMemoryEdit}
                    >Wijziging controleren</Button
                  >
                  <Button
                    onclick={() => {
                      editingMemoryId = null;
                      editingMemoryContent = "";
                    }}
                    disabled={busy}>Annuleer bewerken</Button
                  >
                {:else}
                  <Button
                    onclick={() => {
                      editingMemoryId = item.id;
                      editingMemoryContent = item.text;
                    }}
                    disabled={busy ||
                      !!pendingMemoryDelete ||
                      !!pendingMemoryEdit}>Bewerk dit record</Button
                  >
                {/if}
                <Button
                  onclick={() => prepareMemoryRecordDelete(item.id)}
                  disabled={busy ||
                    !!pendingMemoryDelete ||
                    !!pendingMemoryBulkDelete}>Verwijder dit record</Button
                >
              </li>{/each}
          </ol>
          {#if memoryRecords.next !== null}<Button
              onclick={() => loadMemoryRecords(memoryRecords!.next!)}
              disabled={busy}>Meer laden</Button
            >{/if}
        {/if}
      </details>
      {#if pendingMemoryDelete?.action}
        <div role="group" aria-label="Geheugenrecord verwijderen bevestigen">
          <h3>Geheugenrecord definitief verwijderen?</h3>
          <p>
            Alleen dit NOVA-record wordt verwijderd. Dit kan niet ongedaan
            worden gemaakt.
          </p>
          <Button
            onclick={() => confirmMemoryRecordDelete(true)}
            disabled={busy}>Verwijder record</Button
          >
          <Button
            onclick={() => confirmMemoryRecordDelete(false)}
            disabled={busy}>Annuleer verwijderen</Button
          >
        </div>
      {/if}
      {#if pendingMemoryBulkDelete?.action}
        <div role="group" aria-label="Geheugenrecords verwijderen bevestigen">
          <h3>
            {pendingMemoryBulkDelete.count} geheugenrecords definitief verwijderen?
          </h3>
          <p>
            Alleen de geselecteerde NOVA-records worden verwijderd. Dit kan niet
            ongedaan worden gemaakt.
          </p>
          <Button
            onclick={() => confirmMemoryRecordsBulkDelete(true)}
            disabled={busy}>Verwijder selectie</Button
          >
          <Button
            onclick={() => confirmMemoryRecordsBulkDelete(false)}
            disabled={busy}>Annuleer bulkverwijdering</Button
          >
        </div>
      {/if}
      {#if pendingMemoryEdit?.action}
        <div role="group" aria-label="Geheugenrecord wijzigen bevestigen">
          <h3>Geheugenrecord wijzigen?</h3>
          <p>
            Controleer de nieuwe tekst. Alleen dit NOVA-record wordt aangepast.
          </p>
          <pre>{editingMemoryContent}</pre>
          <Button onclick={() => confirmMemoryRecordEdit(true)} disabled={busy}>
            Bevestig wijziging
          </Button>
          <Button
            onclick={() => confirmMemoryRecordEdit(false)}
            disabled={busy}
          >
            Annuleer wijziging
          </Button>
        </div>
      {/if}
      <label class="global-ack">
        <input
          type="checkbox"
          bind:checked={memoryAcknowledged}
          disabled={busy || !!pendingMemory}
        />
        Ik begrijp dat deze geheugenschakelaar alle OmniRoute-clients raakt.
      </label>
      {#if memoryHistory?.revisions.length}
        <h4>Wijzigingsgeschiedenis</h4>
        <p>
          Alleen de nieuwste stand kan worden teruggezet. Herstel raakt alle
          gateway-clients en vraagt opnieuw om bevestiging.
        </p>
        {#if memoryHistory.truncated}<p>
            Alleen de laatste 20 wijzigingen zijn bewaard.
          </p>{/if}
        <ol aria-label="Gateway-geheugengeschiedenis">
          {#each memoryHistory.revisions as revision (revision.id)}
            <li>
              <time datetime={revision.at}
                >{new Date(revision.at).toLocaleString("nl-NL")}</time
              >
              · {revision.before ? "Aan" : "Uit"} → {revision.after
                ? "Aan"
                : "Uit"}
              {#if revision.revertedFrom}<span> · herstel</span>{/if}
              <Button
                onclick={() => rollbackMemory(revision.id)}
                disabled={busy ||
                  !!pending ||
                  !!pendingRemoval ||
                  !!pendingMemory ||
                  report.memory.enabled !== revision.after ||
                  !memoryAcknowledged}>Zet terug</Button
              >
            </li>
          {/each}
        </ol>
      {/if}
      {#if report.memory.enabled !== null}
        <Button
          onclick={() => prepareMemory(!report?.memory.enabled)}
          disabled={busy ||
            !!pending ||
            !!pendingRemoval ||
            !!pendingMemory ||
            !memoryAcknowledged}
          >{report.memory.enabled
            ? "Gateway-geheugen uitschakelen"
            : "Gateway-geheugen inschakelen"}</Button
        >
      {/if}
      <NativePromptEditor
        initialEnabled={report.prompt.enabled}
        saved={(enabled, prefixCharacters, suffixCharacters) => {
          if (report)
            report.prompt = { enabled, prefixCharacters, suffixCharacters };
        }}
      />
      <h3>Documentatie</h3>
      <ul>
        {#each report.documentation as skill (skill.id)}<li>
            <strong>{skill.name}</strong>
            <p>{skill.description}</p>
            <Button
              onclick={() => read(skill.id)}
              disabled={busy || !!pending || !!pendingRemoval}
              >Lees {skill.name}</Button
            >
          </li>{/each}
      </ul>
    {/if}
  {/if}
  {#if document}
    {#if document.available}<h3>{document.name}</h3>
      <pre>{document.documentation}</pre>
    {:else}<p role="status">{document.error}</p>{/if}
  {/if}
</section>

<style>
  .mode-confirm {
    border: 1px solid #ff8a4c;
    padding: 1rem;
    margin-top: 1rem;
  }
  .mode-confirm :global(button) {
    min-height: 44px;
    margin: 0 0.5rem 0.5rem 0;
  }
  .mode-buttons :global(button) {
    min-height: 44px;
  }
  .mode-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  section {
    margin-top: 2rem;
  }
  p {
    color: #a4bacd;
    line-height: 1.6;
  }
  ul {
    list-style: none;
    padding: 0;
  }
  li {
    padding: 1rem 0;
    border-bottom: 1px solid #30465a;
    overflow-wrap: anywhere;
  }
  pre {
    padding: 1rem;
    background: #0a1622;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 30rem;
    overflow: auto;
  }
</style>
