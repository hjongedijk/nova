<script lang="ts">
  import { onMount } from "svelte";
  import type {
    WorkspaceProjectsReport,
    WorkspaceProjectSelectionHistory,
  } from "@nova/contracts";
  import {
    createWorkspaceProject,
    getWorkspaceProjects,
    selectWorkspaceProject,
    getWorkspaceProjectSelectionHistory,
    rollbackWorkspaceProjectSelection,
  } from "#lib/api/settings.ts";
  import { fail, say } from "./state.svelte.ts";

  let report = $state<WorkspaceProjectsReport | null>(null);
  let name = $state("");
  let busy = $state(false);
  let history = $state<WorkspaceProjectSelectionHistory | null>(null);
  let showHistory = $state(false);

  async function load() {
    busy = true;
    try {
      report = await getWorkspaceProjects();
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }

  async function create() {
    busy = true;
    try {
      report = await createWorkspaceProject(name);
      if (history !== null)
        history = await getWorkspaceProjectSelectionHistory();
      name = "";
      say(
        report.historyWarning || "Project aangemaakt en geopend.",
        report.historyWarning ? "bad" : "ok",
      );
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }

  async function select(id: string) {
    busy = true;
    try {
      report = await selectWorkspaceProject(id);
      if (history !== null)
        history = await getWorkspaceProjectSelectionHistory();
      say(
        report.historyWarning || "Project geopend.",
        report.historyWarning ? "bad" : "ok",
      );
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }

  async function toggleHistory() {
    showHistory = !showHistory;
    if (!showHistory || history !== null) return;
    busy = true;
    try {
      history = await getWorkspaceProjectSelectionHistory();
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }

  async function rollback(id: string) {
    busy = true;
    try {
      const result = await rollbackWorkspaceProjectSelection(id);
      if (!result.ok || result.verified !== true) {
        fail(
          new Error(
            result.error || "Projectherstel kon niet worden gecontroleerd.",
          ),
        );
        return;
      }
      report = await getWorkspaceProjects();
      history = await getWorkspaceProjectSelectionHistory();
      say(
        result.historyWarning ||
          result.auditWarning ||
          "Projectkeuze hersteld en gecontroleerd.",
        result.historyWarning || result.auditWarning ? "bad" : "ok",
      );
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }

  onMount(() => void load());
</script>

<section aria-labelledby="workspaceProjectsHeading">
  <h2 id="workspaceProjectsHeading">Codeprojecten</h2>
  <p>
    Projectmappen staan lokaal in nova-data/workspace. De codeweergave toont de
    bestanden en testuitvoer.
  </p>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void create();
    }}
  >
    <label for="workspaceProjectName">Nieuw project</label>
    <input
      id="workspaceProjectName"
      bind:value={name}
      maxlength="64"
      required
      autocomplete="off"
      placeholder="Bijvoorbeeld mijn-project"
    />
    <button type="submit" disabled={busy || !name.trim()}>Aanmaken</button>
  </form>
  <button type="button" onclick={load} disabled={busy}>Vernieuwen</button>
  <button type="button" onclick={toggleHistory} disabled={busy}
    >{showHistory ? "Geschiedenis verbergen" : "Projectgeschiedenis"}</button
  >
  {#if showHistory}
    {#if history === null}<p>Projectgeschiedenis laden…</p>
    {:else if history.revisions.length === 0}<p>
        Geen projectwijzigingen vastgelegd.
      </p>
    {:else}<ol aria-label="Projectkeuzegeschiedenis">
        {#each history.revisions as revision, index (revision.id)}
          <li>
            <time datetime={revision.at}
              >{new Date(revision.at).toLocaleString("nl-NL")}</time
            >
            {#if revision.kind === "created"}
              · Aangemaakt: {report?.projects.find(
                (item) => item.id === revision.projectId,
              )?.name ?? "project"}
            {:else}
              · {report?.projects.find((item) => item.id === revision.beforeId)
                ?.name ?? "Geen actief project"}
              → {report?.projects.find((item) => item.id === revision.afterId)
                ?.name ?? "Geen actief project"}
            {/if}
            {#if index === 0 && report?.activeId === revision.afterId}
              <button
                type="button"
                onclick={() => void rollback(revision.id)}
                disabled={busy}>Zet terug</button
              >
            {/if}
          </li>
        {/each}
      </ol>{/if}
  {/if}
  {#if report?.projects.length}
    <ul>
      {#each report.projects as project (project.id)}
        <li>
          <strong>{project.name}</strong>
          {#if report.activeId === project.id}
            <span aria-label="Actief project"> — geopend</span>
          {:else}<button
              type="button"
              disabled={busy}
              onclick={() => void select(project.id)}>Openen</button
            >{/if}
        </li>
      {/each}
    </ul>
  {:else if report}<p>Je hebt nog geen projecten.</p>{/if}
</section>
