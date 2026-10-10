<script lang="ts">
  import type { Skill, SkillVersionHistory } from "@nova/contracts";
  import { draftSkill, skillVersions, updateSkill } from "#lib/api/settings.ts";
  import Badge from "#components/ui/Badge.svelte";
  import Button from "#components/ui/Button.svelte";
  import Details from "#components/ui/Details.svelte";
  import Toggle from "#components/ui/Toggle.svelte";
  import SkillEditor from "./SkillEditor.svelte";
  import { RISK_LABEL, riskTone } from "./labels.ts";
  import {
    afterChange,
    fail,
    say,
    settings,
    startEditing,
  } from "./state.svelte.ts";

  const SKILL_IDEAS = [
    "Als ik “filmavond” zeg: dim de lampen in de woonkamer en zet de tv aan.",
    "Als ik vraag hoe het met de garage is, kijk dan op http://192.168.1.50/status en vertel het.",
    "Als ik “goedemorgen” zeg: vertel het weer, mijn agenda en het nieuws.",
  ];

  const skills = $derived(settings.data?.skills ?? []);
  let wish = $state("");
  let making = $state(false);
  let histories = $state<Record<string, SkillVersionHistory>>({});
  let historyBusy = $state<string | null>(null);

  async function make(): Promise<void> {
    making = true;
    try {
      const result = await draftSkill(wish);
      startEditing(result.draft.type ?? "instruction", null, result.draft);
      say(
        `${result.notes ? `${result.notes} ` : ""}Lees het voorstel na en druk op Opslaan. Daarna kun je het meteen proberen.`,
        result.fellBack ? "" : "ok",
      );
    } catch (error) {
      fail(error);
    } finally {
      making = false;
    }
  }

  async function flip(skill: Skill, on: boolean, box: HTMLInputElement) {
    try {
      await updateSkill(skill.id, { ...skill, enabled: on } as Skill);
      await afterChange(
        on ? `“${skill.name}” staat aan.` : `“${skill.name}” staat uit.`,
      );
      delete histories[skill.id];
    } catch (error) {
      box.checked = !on;
      fail(error);
    }
  }

  async function showVersions(skill: Skill) {
    const requestedVersion = skill.version;
    historyBusy = skill.id;
    try {
      const history = await skillVersions(skill.id);
      const current = settings.data?.skills.find(
        (item) => item.id === skill.id,
      );
      if (
        current?.version === requestedVersion &&
        history.currentVersion === requestedVersion
      )
        histories[skill.id] = history;
    } catch (error) {
      fail(error);
    } finally {
      historyBusy = null;
    }
  }
</script>

{#if settings.editing}
  {#key settings.editing}
    <SkillEditor
      type={settings.editing.type}
      skill={settings.editing.skill}
      draft={settings.editing.draft}
    />
  {/key}
{:else}
  <div class="panel">
    <strong>Leer NOVA iets nieuws</strong>
    <p class="hint">
      Beschrijf in gewone woorden wat NOVA moet kunnen. NOVA maakt er een
      voorstel van dat je kunt nakijken.
    </p>
    <textarea
      rows="3"
      maxlength="1500"
      id="skillWish"
      aria-label="Wat moet NOVA kunnen?"
      placeholder="Bijvoorbeeld: als ik “filmavond” zeg, dim de lampen…"
      bind:value={wish}></textarea>
    <div class="set-toolbar">
      <Button go disabled={making} onclick={make}
        >{making ? "Even denken…" : "Maak een voorstel"}</Button
      >
      {#each SKILL_IDEAS as idea, index (idea)}
        <Button
          title={idea}
          onclick={() => {
            wish = idea;
            document.getElementById("skillWish")?.focus();
          }}>Idee {index + 1}</Button
        >
      {/each}
    </div>
  </div>
  <h3>Jouw vaardigheden</h3>
  {#if skills.length}
    <ul class="set-list">
      {#each skills as skill (skill.id)}
        <li class="set-row" class:off={!skill.enabled}>
          <Toggle
            checked={skill.enabled}
            label="{skill.name} aan of uit"
            onchange={(on, box) => flip(skill, on, box)}
          />
          <div class="what">
            <strong>{skill.name}</strong>
            <Badge text={skill.type === "webhook" ? "webhook" : "instructie"} />
            {#if skill.type === "webhook"}
              <Badge
                tone={riskTone(skill.risk)}
                text={RISK_LABEL[skill.risk] ?? skill.risk}
              />
            {/if}
            <p>
              {skill.description ||
                (skill.type === "instruction"
                  ? skill.instructions.slice(0, 140)
                  : "")}
            </p>
            {#if skill.examples.length > 0}
              <p>Zeg bijvoorbeeld: “{skill.examples[0]}”</p>
            {/if}
          </div>
          <div class="acts">
            <Button onclick={() => startEditing(skill.type, skill)}
              >Bewerken</Button
            >
            <Button
              disabled={historyBusy === skill.id}
              onclick={() => showVersions(skill)}
              >{historyBusy === skill.id ? "Laden…" : "Versies"}</Button
            >
          </div>
          {#if histories[skill.id]?.currentVersion === skill.version}
            <div class="skill-versions" aria-label="Versiegeschiedenis">
              <strong
                >Huidige versie {histories[skill.id]!.currentVersion}</strong
              >
              <p class="hint">
                Versiegegevens uit de laatste {histories[skill.id]!
                  .scannedEntries} auditregels. De inhoud en geheime headers staan
                hier niet.
              </p>
              {#if histories[skill.id]!.versions.length}
                <ol>
                  {#each histories[skill.id]!.versions as version (`${version.version}-${version.at}`)}
                    <li>
                      v{version.version} · {version.action === "created"
                        ? "gemaakt"
                        : "bijgewerkt"} ·
                      <time datetime={version.at}>{version.at}</time>
                    </li>
                  {/each}
                </ol>
              {:else}<p>Geen versiegegevens in de recente auditregels.</p>{/if}
              {#if histories[skill.id]!.truncated}<p class="hint">
                  De lijst is begrensd; oudere versies ontbreken mogelijk.
                </p>{/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="hint">
      Nog niets hier. Beschrijf hierboven wat NOVA moet kunnen, of kies een van
      de ideeën.
    </p>
  {/if}
  <Details summary="Meer instellingen">
    <p class="hint">
      Zelf alles invullen. Een instructie is een draaiboek met wat NOVA al kan.
      Een aanroep stuurt een verzoek naar een webadres dat jij kiest.
    </p>
    <div class="set-toolbar">
      <Button onclick={() => startEditing("instruction")}
        >Nieuwe instructie</Button
      >
      <Button onclick={() => startEditing("webhook")}
        >Nieuwe aanroep naar een dienst</Button
      >
    </div>
  </Details>
{/if}
