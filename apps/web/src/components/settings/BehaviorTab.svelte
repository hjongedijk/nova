<script lang="ts">
  import { savePersona, revokeStandingApproval } from "#lib/api/settings.ts";
  import Badge from "#components/ui/Badge.svelte";
  import Button from "#components/ui/Button.svelte";
  import Field from "#components/ui/Field.svelte";
  import QuickActionsEditor from "./QuickActionsEditor.svelte";
  import SoundSection from "./SoundSection.svelte";
  import { afterChange, fail, settings } from "./state.svelte.ts";

  let persona = $state(settings.data?.persona ?? "");

  async function save(): Promise<void> {
    try {
      await savePersona(persona);
      await afterChange("De eigen regels zijn opgeslagen.");
    } catch (error) {
      fail(error);
    }
  }
</script>

<h3>Geluid op dit apparaat</h3>
<SoundSection />
<h3>Hoe NOVA zich gedraagt</h3>
<section>
  <p class="hint">
    Eigen regels voor hoe NOVA zich gedraagt. Ze gaan voor zijn standaardstijl
    en gelden bij elke vraag. Schrijf ze als gewone zinnen.
  </p>
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
<h3>Snelle opdrachten op het beginscherm</h3>
<QuickActionsEditor />

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
