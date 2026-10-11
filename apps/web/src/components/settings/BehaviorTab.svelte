<script lang="ts">
  import {
    savePersona,
    savePersonaStyle,
    savePersonaProfile,
    revokeStandingApproval,
  } from "#lib/api/settings.ts";
  import type { PersonaProfile, PersonaStyleId } from "@nova/contracts";
  import Badge from "#components/ui/Badge.svelte";
  import Button from "#components/ui/Button.svelte";
  import Field from "#components/ui/Field.svelte";
  import QuickActionsEditor from "./QuickActionsEditor.svelte";
  import PersonaHistory from "./PersonaHistory.svelte";
  import PersonaPreferencesHistory from "./PersonaPreferencesHistory.svelte";
  import SoundSection from "./SoundSection.svelte";
  import { afterChange, fail, settings } from "./state.svelte.ts";

  let { part = "all" }: { part?: "all" | "persona" | "approvals" } = $props();

  let persona = $state(settings.data?.persona ?? "");
  let personaStyle = $state<PersonaStyleId>(
    settings.data?.personaStyle ?? "friendly",
  );
  let profile = $state<PersonaProfile>(
    settings.data?.personaProfile ?? {
      name: "NOVA",
      character: "warm, nieuwsgierig en met af en toe droge humor",
      address: "je/jij",
      avoid: "doen alsof ik een mens ben of gevoelens en ervaringen verzinnen",
    },
  );
  const styles: { id: PersonaStyleId; label: string }[] = [
    { id: "professional", label: "Zakelijk" },
    { id: "friendly", label: "Vriendelijk" },
    { id: "playful", label: "Grappig" },
    { id: "concise", label: "Kort" },
  ];

  async function save(): Promise<void> {
    try {
      const result = await savePersona(persona);
      await afterChange(
        result.historyWarning ?? "De eigen regels zijn opgeslagen.",
      );
    } catch (error) {
      fail(error);
    }
  }

  async function chooseStyle(style: PersonaStyleId): Promise<void> {
    try {
      const result = await savePersonaStyle(style);
      personaStyle = result.personaStyle;
      await afterChange("Gespreksstijl opgeslagen.");
    } catch (error) {
      fail(error);
    }
  }

  async function saveProfile(): Promise<void> {
    try {
      const result = await savePersonaProfile(profile);
      profile = result.personaProfile;
      await afterChange("NOVA's profiel is opgeslagen.");
    } catch (error) {
      fail(error);
    }
  }
</script>

{#if part === "all"}
  <h3>Geluid op dit apparaat</h3>
  <SoundSection />
{/if}
{#if part !== "approvals"}
  <h3>Hoe NOVA zich gedraagt</h3>
  <section>
    <p class="hint">
      Bepaal hoe NOVA zichzelf voorstelt en jou aanspreekt. Deze voorkeuren
      gelden alleen in gewone gesprekken.
    </p>
    <div class="persona-profile">
      <Field
        id="personaName"
        label="Naam"
        help="De naam die NOVA gebruikt als dat ter sprake komt."
      >
        <input id="personaName" bind:value={profile.name} maxlength="40" />
      </Field>
      <Field
        id="personaCharacter"
        label="Karakter"
        help="Bijvoorbeeld: warm, nieuwsgierig en met droge humor."
      >
        <input
          id="personaCharacter"
          bind:value={profile.character}
          maxlength="300"
        />
      </Field>
      <Field
        id="personaAddress"
        label="Aanspreekvorm"
        help="Bijvoorbeeld: je/jij of u."
      >
        <input
          id="personaAddress"
          bind:value={profile.address}
          maxlength="40"
        />
      </Field>
      <Field
        id="personaAvoid"
        label="Wat NOVA vermijdt"
        help="Bijvoorbeeld: overdreven enthousiasme of doen alsof ze menselijke ervaringen heeft."
      >
        <input id="personaAvoid" bind:value={profile.avoid} maxlength="300" />
      </Field>
      <Button go onclick={saveProfile}>Profiel opslaan</Button>
    </div>
    <p class="hint">
      Eigen regels voor hoe NOVA zich gedraagt. Ze gaan voor zijn standaardstijl
      en gelden bij elke vraag. Schrijf ze als gewone zinnen.
    </p>
    <Field
      label="Gespreksstijl"
      help="De stijl verandert toon en lengte, niet je eigen regels of veiligheidsgrenzen."
    >
      <div class="set-toolbar" role="group" aria-label="Gespreksstijl kiezen">
        {#each styles as style (style.id)}
          <Button
            go={personaStyle === style.id}
            aria-pressed={personaStyle === style.id}
            onclick={() => void chooseStyle(style.id)}>{style.label}</Button
          >
        {/each}
      </div>
    </Field>
    <Field
      label="Eigen regels"
      id="behaviorText"
      help="Bijvoorbeeld: “Spreek me aan met Harm. Wees kort. Noem temperaturen in hele graden. Vraag altijd eerst of ik zeker weet dat een server herstart moet worden.”"
    >
      <textarea
        id="behaviorText"
        rows="9"
        maxlength="2000"
        aria-label="Eigen regels"
        bind:value={persona}></textarea>
    </Field>
    <div class="set-toolbar">
      <Button go onclick={save}>Opslaan</Button>
      <Badge text="{persona.length} / 2000" />
    </div>
  </section>
  <PersonaHistory />
  <PersonaPreferencesHistory />
{/if}
{#if part === "all"}
  <h3>Snelle opdrachten op het beginscherm</h3>
  <QuickActionsEditor />
{/if}
{#if part !== "persona"}
  <h3>Altijd goedgekeurde handelingen</h3>
  <section>
    <p class="hint">
      Elke toestemming geldt voor één tool met exact dezelfde parameters.
      Risicovolle handelingen blijven bevestiging vragen.
    </p>
    {#each settings.data?.standingApprovals ?? [] as grant (grant.id)}
      <div class="set-toolbar">
        <span
          >{grant.tool}
          {grant.scope ?? ""} · {new Date(grant.createdAt).toLocaleString(
            "nl-NL",
          )}</span
        ><Button
          onclick={async () => {
            try {
              await revokeStandingApproval(grant.id);
              await afterChange("Toestemming ingetrokken.");
            } catch (error) {
              fail(error);
            }
          }}>Intrekken</Button
        >
      </div>
    {:else}<p class="hint">Geen blijvende toestemmingen.</p>{/each}
  </section>
{/if}
