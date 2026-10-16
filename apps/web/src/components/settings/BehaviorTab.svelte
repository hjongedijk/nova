<script lang="ts">
  import {
    savePersona,
    savePersonaStyle,
    saveHouseholdProfiles,
    revokeStandingApproval,
  } from "#lib/api/settings.ts";
  import type {
    HouseholdProfile,
    PersonaProfile,
    PersonaStyleId,
  } from "@nova/contracts";
  import Badge from "#components/ui/Badge.svelte";
  import Button from "#components/ui/Button.svelte";
  import Field from "#components/ui/Field.svelte";
  import QuickActionsEditor from "./QuickActionsEditor.svelte";
  import PersonaHistory from "./PersonaHistory.svelte";
  import PersonaPreferencesHistory from "./PersonaPreferencesHistory.svelte";
  import HouseholdProfileHistory from "./HouseholdProfileHistory.svelte";
  import Disclosure from "./ui/Disclosure.svelte";
  import HistoryGroup from "./ui/HistoryGroup.svelte";
  import SoundSection from "./SoundSection.svelte";
  import { afterChange, fail, settings } from "./state.svelte.ts";

  let { part = "all" }: { part?: "all" | "persona" | "approvals" } = $props();

  let persona = $state(settings.data?.persona ?? "");
  let personaStyle = $state<PersonaStyleId>(
    settings.data?.personaStyle ?? "friendly",
  );
  const defaultProfile = (): PersonaProfile => ({
    name: "NOVA",
    character: "warm, nieuwsgierig en met af en toe droge humor",
    address: "je/jij",
    avoid: "doen alsof ik een mens ben of gevoelens en ervaringen verzinnen",
  });
  const initialProfile = settings.data?.personaProfile ?? defaultProfile();
  const initialHouseholdProfiles = settings.data?.householdProfiles ?? [
    {
      id: "primary",
      label: "Gebruiker",
      personaProfile: initialProfile,
      communicationPreferences: [],
    },
  ];
  let profile = $state<PersonaProfile>(initialProfile);
  let householdProfiles = $state<HouseholdProfile[]>(initialHouseholdProfiles);
  let activeProfileId = $state(
    settings.data?.activeHouseholdProfileId ?? "primary",
  );
  let profilePreferences = $state<string[]>(
    initialHouseholdProfiles.find((item) => item.id === activeProfileId)
      ?.communicationPreferences ?? [],
  );
  const preferenceChoices = [
    ["concise", "Kortere antwoorden"],
    ["fewer_jokes", "Minder grapjes"],
    ["more_detail", "Meer uitleg"],
    ["warmer", "Warmere toon"],
  ] as const;
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
        { kind: "persona-rules", text: result.persona },
      );
    } catch (error) {
      fail(error);
    }
  }

  async function chooseStyle(style: PersonaStyleId): Promise<void> {
    try {
      const result = await savePersonaStyle(style);
      personaStyle = result.personaStyle;
      await afterChange("Gespreksstijl opgeslagen.", {
        kind: "persona-style",
        style: result.personaStyle,
      });
    } catch (error) {
      fail(error);
    }
  }

  async function saveProfile(): Promise<void> {
    try {
      const updated = householdProfiles.map((item) =>
        item.id === activeProfileId
          ? {
              ...item,
              personaProfile: profile,
              communicationPreferences:
                profilePreferences as HouseholdProfile["communicationPreferences"],
            }
          : item,
      );
      const result = await saveHouseholdProfiles(updated, activeProfileId);
      householdProfiles = result.householdProfiles;
      await afterChange("Gezinsprofiel opgeslagen.");
    } catch (error) {
      fail(error);
    }
  }

  async function switchProfile(id: string): Promise<void> {
    const next = householdProfiles.find((item) => item.id === id);
    if (!next) return;
    activeProfileId = id;
    profile = { ...next.personaProfile };
    profilePreferences = [...next.communicationPreferences];
    try {
      const result = await saveHouseholdProfiles(householdProfiles, id);
      householdProfiles = result.householdProfiles;
      await afterChange(`Actief profiel: ${next.label}.`);
    } catch (error) {
      fail(error);
    }
  }

  async function addProfile(): Promise<void> {
    if (householdProfiles.length >= 8) return;
    const id = crypto.randomUUID().replaceAll("-", "");
    const label = `Persoon ${householdProfiles.length + 1}`;
    const next = [
      ...householdProfiles,
      {
        id,
        label,
        personaProfile: defaultProfile(),
        communicationPreferences: [],
      },
    ];
    try {
      const result = await saveHouseholdProfiles(next, id);
      householdProfiles = result.householdProfiles;
      activeProfileId = id;
      profile = { ...defaultProfile() };
      profilePreferences = [];
      await afterChange("Gezinsprofiel toegevoegd.");
    } catch (error) {
      fail(error);
    }
  }

  async function removeProfile(): Promise<void> {
    if (householdProfiles.length <= 1) return;
    const next = householdProfiles.filter(
      (item) => item.id !== activeProfileId,
    );
    const id = next[0]!.id;
    try {
      const result = await saveHouseholdProfiles(next, id);
      householdProfiles = result.householdProfiles;
      activeProfileId = id;
      profile = { ...next[0]!.personaProfile };
      profilePreferences = [...next[0]!.communicationPreferences];
      await afterChange("Gezinsprofiel verwijderd.");
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
  <section>
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
    <Disclosure
      kind="advanced"
      title="Geavanceerd: gezinsleden en aanspreekvorm"
      hint="Meerdere personen, naam, karakter en voorkeuren"
    >
      <p class="hint">
        Kies wie NOVA nu aanspreekt. Profielen wisselen toon en
        communicatievoorkeuren; chatgeschiedenis en geheugen blijven gedeeld.
      </p>
      <div class="persona-profile">
        <Field id="householdProfile" label="Actief gezinslid">
          <div class="set-toolbar">
            <select
              id="householdProfile"
              value={activeProfileId}
              onchange={(event) =>
                void switchProfile(event.currentTarget.value)}
            >
              {#each householdProfiles as householdProfile (householdProfile.id)}
                <option value={householdProfile.id}
                  >{householdProfile.label}</option
                >
              {/each}
            </select>
            <Button
              onclick={() => void addProfile()}
              disabled={householdProfiles.length >= 8}>Persoon toevoegen</Button
            >
            <Button
              onclick={() => void removeProfile()}
              disabled={householdProfiles.length <= 1}>Verwijderen</Button
            >
          </div>
        </Field>
        <Field
          id="householdLabel"
          label="Profielnaam"
          help="Bijvoorbeeld Harm of Sam."
        >
          <input
            id="householdLabel"
            maxlength="40"
            value={householdProfiles.find((item) => item.id === activeProfileId)
              ?.label ?? ""}
            oninput={(event) => {
              const label = event.currentTarget.value;
              householdProfiles = householdProfiles.map((item) =>
                item.id === activeProfileId ? { ...item, label } : item,
              );
            }}
          />
        </Field>
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
        <fieldset>
          <legend>Communicatievoorkeuren</legend>
          {#each preferenceChoices as [value, label] (value)}
            <label
              ><input type="checkbox" {value} bind:group={profilePreferences} />
              {label}</label
            >
          {/each}
        </fieldset>
        <Button go onclick={saveProfile}>Profiel opslaan</Button>
      </div>
    </Disclosure>
  </section>
  <HistoryGroup>
    <PersonaHistory />
    <PersonaPreferencesHistory />
    <HouseholdProfileHistory
      onRestored={() => afterChange("Gezinsprofiel hersteld.")}
    />
  </HistoryGroup>
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
