<script lang="ts">
  import NativePromptEditor from "./NativePromptEditor.svelte";
  import type {
    NativeGatewayReport,
    NativeMemoryHistory,
    NativeMemoryRecords,
    NativeSkillDocument,
    NativeSkillMode,
    NativeSkillModeHistory,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    getNativeGateway,
    getNativeSkillDocument,
    setNativeSkillMode,
    getNativeSkillModeHistory,
    rollbackNativeSkillMode,
    removeNativeSkill,
    setNativeMemory,
    getNativeMemoryHistory,
    getNativeMemoryRecords,
    rollbackNativeMemory,
    deleteNativeMemoryRecord,
    deleteNativeMemoryRecords,
    updateNativeMemoryRecord,
  } from "#lib/api/settings.ts";
  let report = $state<NativeGatewayReport | null>(null);
  let document = $state<NativeSkillDocument | null>(null);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let modeHistories = $state<Record<string, NativeSkillModeHistory>>({});
  let memoryHistory = $state<NativeMemoryHistory | null>(null);
  let memoryRecords = $state<NativeMemoryRecords | null>(null);
  let selectedMemoryIds = $state<string[]>([]);
  let editingMemoryId = $state<string | null>(null);
  let editingMemoryContent = $state("");
  const modeName = (mode: NativeSkillMode) =>
    ({ on: "Aan", off: "Uit", auto: "Automatisch" })[mode];
  async function applyMode(
    id: string,
    mode: NativeSkillMode,
    rollbackRevisionId?: string,
  ) {
    busy = true;
    error = "";
    notice = "";
    try {
      const result = rollbackRevisionId
        ? await rollbackNativeSkillMode(id, rollbackRevisionId)
        : await setNativeSkillMode(id, mode);
      if (!result.ok || result.verified !== true) {
        error = result.error || "Wijziging kon niet worden gecontroleerd.";
        return;
      }
      const skill = report?.skills.find((item) => item.id === id);
      if (skill && result.mode && typeof result.enabled === "boolean") {
        skill.mode = result.mode;
        skill.enabled = result.enabled;
      }
      // Keep history on-demand. Refresh it after a change only when the
      // user has already opened this skill's history panel.
      if (modeHistories[id]) {
        const history = await getNativeSkillModeHistory(id).catch(() => null);
        if (history) modeHistories[id] = history;
      }
      notice = `Modus opgeslagen en gecontroleerd. De gateway kan maximaal één minuut achterlopen.${result.auditWarning ? ` ${result.auditWarning}` : ""}${result.historyWarning ? ` ${result.historyWarning}` : ""}`;
    } catch {
      error =
        "Wijziging kon niet worden afgerond. Controleer de status voordat je opnieuw wijzigt.";
    } finally {
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
  async function removeSkill(id: string) {
    busy = true;
    error = "";
    notice = "";
    try {
      const result = await removeNativeSkill(id);
      if (!result.ok || result.verified !== true) {
        error = result.error || "Verwijderen kon niet worden gecontroleerd.";
        return;
      }
      if (report)
        report.skills = report.skills.filter((skill) => skill.id !== id);
      notice = `Skill verwijderd en gecontroleerd.${result.auditWarning ? ` ${result.auditWarning}` : ""}`;
    } catch {
      error =
        "Verwijderen kon niet worden afgerond. Laad het overzicht opnieuw.";
    } finally {
      busy = false;
    }
  }
  async function applyMemory(enabled: boolean, rollbackId?: string) {
    busy = true;
    error = "";
    notice = "";
    try {
      const result = rollbackId
        ? await rollbackNativeMemory(rollbackId)
        : await setNativeMemory(enabled);
      if (!result.ok || !result.verified) {
        error = result.error || "Wijziging kon niet worden gecontroleerd.";
        return;
      }
      if (report) report.memory.enabled = result.enabled ?? enabled;
      memoryHistory = await getNativeMemoryHistory().catch(() => memoryHistory);
      notice = `Gateway-geheugen ${result.enabled ? "ingeschakeld" : "uitgeschakeld"} voor alle clients.${result.auditWarning ? ` ${result.auditWarning}` : ""}`;
    } catch {
      error = "Uitkomst onbekend. Laad de geheugenstatus opnieuw.";
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
  async function deleteMemoryRecord(id: string) {
    busy = true;
    error = "";
    try {
      const result = await deleteNativeMemoryRecord(id);
      if (!result.ok || result.verified !== true)
        error = result.error || "Verwijdering kon niet worden gecontroleerd.";
      else {
        notice = "Geheugenrecord verwijderd.";
        await loadMemoryRecords();
      }
    } catch {
      error = "Uitkomst onbekend. Laad de records opnieuw.";
    } finally {
      busy = false;
    }
  }
  async function deleteSelectedMemoryRecords() {
    if (!selectedMemoryIds.length) return;
    busy = true;
    error = "";
    try {
      const result = await deleteNativeMemoryRecords(selectedMemoryIds);
      if (!result.ok || result.verified !== true)
        error =
          result.error || "Bulkverwijdering kon niet worden gecontroleerd.";
      else {
        notice = "Geselecteerde geheugenrecords verwijderd.";
        await loadMemoryRecords();
      }
    } catch {
      error = "Uitkomst onbekend. Vernieuw de geheugenrecords.";
    } finally {
      busy = false;
    }
  }
  async function saveMemoryRecord(id: string) {
    busy = true;
    error = "";
    try {
      const result = await updateNativeMemoryRecord(id, editingMemoryContent);
      if (!result.ok || result.verified !== true)
        error = result.error || "Wijziging kon niet worden gecontroleerd.";
      else {
        notice = "Geheugenrecord bijgewerkt.";
        editingMemoryId = null;
        editingMemoryContent = "";
        await loadMemoryRecords();
      }
    } catch {
      error = "Uitkomst onbekend. Laad de records opnieuw.";
    } finally {
      busy = false;
    }
  }
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
  <Button onclick={load} disabled={busy}
    >{busy ? "Laden…" : "OmniRoute-overzicht laden"}</Button
  >
  {#if error}<p role="status">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if report}
    {#if !report.available}<p role="status">{report.error}</p>
    {:else}
      <h3>Uitvoerbare skills</h3>
      <p>Gateway-status kan maximaal één minuut achterlopen.</p>
      <p>
        Wijzig NOVA- en gedeelde skill-modi. Gedeelde modi gelden voor alle
        gateway-clients. NOVA-skills kunnen worden verwijderd. Gedeelde skills
        blijven beschermd; installeren en handlercode wijzigen gebeurt niet
        hier.
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
            {#if skill.scope === "nova"}
              <Button onclick={() => removeSkill(skill.id)} disabled={busy}
                >Verwijder NOVA-skill</Button
              >
            {/if}
            {#if skill.scope === "nova" || skill.scope === "global"}
              <div class="mode-buttons">
                {#each ["on", "off", "auto"] as mode (mode)}
                  <Button
                    onclick={() => applyMode(skill.id, mode as NativeSkillMode)}
                    disabled={busy || skill.mode === mode}
                  >
                    {modeName(mode as NativeSkillMode)}
                    {skill.name}
                  </Button>
                {/each}
              </div>
              <Button onclick={() => loadModeHistory(skill.id)} disabled={busy}
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
                            applyMode(skill.id, revision.before, revision.id)}
                          disabled={busy || skill.mode !== revision.after}
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
              onclick={deleteSelectedMemoryRecords}
              disabled={busy ||
                !selectedMemoryIds.length ||
                selectedMemoryIds.length > 25}>Verwijder selectie</Button
            >
          {/if}
          <ol aria-label="NOVA-geheugenrecords">
            {#each memoryRecords.memories as item (item.id)}<li>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`Selecteer record ${item.id}`}
                    checked={selectedMemoryIds.includes(item.id)}
                    disabled={busy}
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
                      disabled={busy}></textarea>
                  </label>
                  <Button
                    onclick={() => saveMemoryRecord(item.id)}
                    disabled={busy}>Wijziging opslaan</Button
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
                    disabled={busy}>Bewerk dit record</Button
                  >
                {/if}
                <Button
                  onclick={() => deleteMemoryRecord(item.id)}
                  disabled={busy}>Verwijder dit record</Button
                >
              </li>{/each}
          </ol>
          {#if memoryRecords.next !== null}<Button
              onclick={() => loadMemoryRecords(memoryRecords!.next!)}
              disabled={busy}>Meer laden</Button
            >{/if}
        {/if}
      </details>
      {#if memoryHistory?.revisions.length}
        <h4>Wijzigingsgeschiedenis</h4>
        <p>
          Alleen de nieuwste stand kan worden teruggezet. Herstel raakt alle
          gateway-clients.
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
                onclick={() => applyMemory(revision.before, revision.id)}
                disabled={busy || report.memory.enabled !== revision.after}
                >Zet terug</Button
              >
            </li>
          {/each}
        </ol>
      {/if}
      {#if report.memory.enabled !== null}
        <Button
          onclick={() => applyMemory(!report?.memory.enabled)}
          disabled={busy}
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
            <Button onclick={() => read(skill.id)} disabled={busy}
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
