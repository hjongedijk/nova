<script lang="ts">
  import type {
    AgentSkillCandidate,
    AgentSkillSearchResult,
    AgentSkillSummary,
  } from "@nova/contracts";
  import { onMount } from "svelte";
  import {
    getAgentSkills,
    installAgentSkill,
    removeAgentSkill,
    searchAgentSkills,
    setAgentSkillEnabled,
  } from "#lib/api/settings.ts";
  import Badge from "#components/ui/Badge.svelte";
  import Button from "#components/ui/Button.svelte";
  import Toggle from "#components/ui/Toggle.svelte";
  import { fail, say } from "./state.svelte.ts";

  let skills = $state<AgentSkillSummary[]>([]);
  let loaded = $state(false);
  let source = $state("");
  let query = $state("");
  let found = $state<AgentSkillSearchResult | null>(null);
  let searching = $state(false);
  /** The install id or skill name that is busy right now. */
  let busy = $state<string | null>(null);
  /** Skill whose removal waits for a second click. */
  let removing = $state<string | null>(null);

  async function load(): Promise<void> {
    try {
      skills = (await getAgentSkills()).skills;
    } catch (error) {
      fail(error);
    } finally {
      loaded = true;
    }
  }

  async function search(): Promise<void> {
    searching = true;
    try {
      found = await searchAgentSkills(query.trim());
    } catch (error) {
      fail(error);
    } finally {
      searching = false;
    }
  }

  async function install(id: string, replace = false): Promise<void> {
    const value = id.trim();
    if (!value) return;
    busy = value;
    try {
      const result = await installAgentSkill(value, replace);
      const notes = [
        ...result.warnings,
        ...(result.skipped.length
          ? [`Niet opgeslagen: ${result.skipped.join(", ")}`]
          : []),
      ];
      say(
        `“${result.skill.name}” is ${result.replaced ? "bijgewerkt" : "geïnstalleerd"}. NOVA gebruikt hem vanaf het volgende bericht.`,
        "ok",
        notes.length ? [result.skill.name, ...notes] : undefined,
      );
      if (value === source.trim()) source = "";
      await load();
      if (found)
        found = {
          ...found,
          results: found.results.map((item) =>
            item.install === value ? { ...item, installed: true } : item,
          ),
        };
    } catch (error) {
      fail(error);
    } finally {
      busy = null;
    }
  }

  async function flip(
    skill: AgentSkillSummary,
    on: boolean,
    box: HTMLInputElement,
  ): Promise<void> {
    box.disabled = true;
    try {
      await setAgentSkillEnabled(skill.name, on);
      say(on ? `“${skill.name}” staat aan.` : `“${skill.name}” staat uit.`);
      await load();
    } catch (error) {
      box.checked = !on;
      fail(error);
    } finally {
      box.disabled = false;
    }
  }

  async function remove(skill: AgentSkillSummary): Promise<void> {
    if (removing !== skill.name) {
      removing = skill.name;
      return;
    }
    busy = skill.name;
    try {
      await removeAgentSkill(skill.name);
      say(`“${skill.name}” is verwijderd.`, "ok");
      removing = null;
      await load();
    } catch (error) {
      fail(error);
    } finally {
      busy = null;
    }
  }

  const where = (value: string) =>
    value === "local"
      ? "Zelf in de map gezet"
      : value.replace(/^github:/, "GitHub: ");

  const installs = (item: AgentSkillCandidate) =>
    item.installs === null
      ? null
      : `${new Intl.NumberFormat("nl-NL", { notation: "compact" }).format(item.installs)} installaties`;

  onMount(() => {
    void load();
    void search();
  });
</script>

<p class="hint">
  Agent Skills zijn kant-en-klare werkwijzen in het open SKILL.md-formaat,
  dezelfde die Claude en andere assistenten gebruiken. NOVA ziet alleen de naam
  en omschrijving en leest de volledige instructies pas als een vraag erom
  vraagt. Alleen tekst wordt opgeslagen: scripts uit een skill voert NOVA nooit
  uit. NOVA mag zelf een skill installeren als dat helpt, en vertelt je dat dan.
</p>

<form
  class="set-toolbar"
  onsubmit={(event) => {
    event.preventDefault();
    void install(source);
  }}
>
  <input
    type="text"
    bind:value={source}
    maxlength="400"
    spellcheck="false"
    autocomplete="off"
    aria-label="GitHub-adres of eigenaar/repository@skill"
    placeholder="obra/superpowers@brainstorming of een GitHub-adres"
  />
  <Button go type="submit" disabled={!source.trim() || busy !== null}
    >{busy === source.trim() ? "Installeren…" : "Installeren"}</Button
  >
</form>

<h3>Geïnstalleerd</h3>
{#if skills.length}
  <ul class="set-list">
    {#each skills as skill (skill.name)}
      <li class="set-row" class:off={!skill.enabled || !!skill.error}>
        <Toggle
          checked={skill.enabled && !skill.error}
          disabled={!!skill.error}
          label="{skill.name} aan of uit"
          onchange={(on, box) => flip(skill, on, box)}
        />
        <div class="what">
          <strong>{skill.name}</strong>
          {#if skill.license}<Badge text={skill.license} />{/if}
          {#if skill.error}<Badge tone="warn" text="ongeldig" />{/if}
          <p>{skill.error ?? skill.description}</p>
          <p class="origin">
            {where(skill.source)}{skill.files.length
              ? ` · ${skill.files.length} naslagbestand${skill.files.length === 1 ? "" : "en"}`
              : ""}
          </p>
        </div>
        <div class="acts">
          <Button
            disabled={busy === skill.name}
            onclick={() => remove(skill)}
            onblur={() => {
              if (removing === skill.name && busy !== skill.name)
                removing = null;
            }}
            >{busy === skill.name
              ? "Verwijderen…"
              : removing === skill.name
                ? "Zeker weten?"
                : "Verwijderen"}</Button
          >
        </div>
      </li>
    {/each}
  </ul>
{:else if loaded}
  <p class="hint">
    Nog geen skills. Zoek hieronder of plak een GitHub-adres hierboven.
  </p>
{/if}

<h3>Zoeken</h3>
<form
  class="set-toolbar"
  onsubmit={(event) => {
    event.preventDefault();
    void search();
  }}
>
  <input
    type="search"
    bind:value={query}
    maxlength="100"
    aria-label="Zoek een skill"
    placeholder="Bijvoorbeeld: schrijven, plannen, onderzoek"
  />
  <Button type="submit" disabled={searching}
    >{searching ? "Zoeken…" : "Zoek"}</Button
  >
</form>
{#if found}
  <p class="hint">
    {found.origin === "skills.sh"
      ? `Resultaten van skills.sh voor “${found.query}”. Controleer de bron en licentie voordat je installeert.`
      : "Aanbevolen skills die bij een huisassistent passen (licentie gecontroleerd)."}
  </p>
  {#if found.results.length}
    <ul class="set-list">
      {#each found.results as item (item.install)}
        <li class="set-row result">
          <div class="what">
            <strong>{item.name}</strong>
            {#if item.license}<Badge text={item.license} />{/if}
            {#if item.description}<p>{item.description}</p>{/if}
            <p class="origin">
              {item.source}{installs(item) ? ` · ${installs(item)}` : ""}
            </p>
          </div>
          <div class="acts">
            <Button
              href="https://github.com/{item.source}"
              target="_blank"
              rel="noopener noreferrer">Bron</Button
            >
            <Button
              go={!item.installed}
              disabled={busy !== null}
              onclick={() => install(item.install, item.installed)}
              >{busy === item.install
                ? "Installeren…"
                : item.installed
                  ? "Bijwerken"
                  : "Installeren"}</Button
            >
          </div>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="hint">Niets gevonden. Probeer een ander woord.</p>
  {/if}
{/if}

<style>
  :global(#settingsBody) .what .origin {
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  /* search results have no toggle column */
  :global(#settingsBody) .set-row.result {
    grid-template-columns: 1fr auto;
  }

  .acts :global(a.btn) {
    margin: 0;
  }
</style>
