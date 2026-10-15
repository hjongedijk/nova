<script lang="ts">
  import { ApiError } from "#lib/api/client.ts";
  import type {
    ConfirmableResult,
    MemoryListResponse,
    PendingConfirmation,
  } from "@nova/contracts";
  import { forgetMemory, rememberMemory } from "#lib/api/admin.ts";
  import Button from "#components/ui/Button.svelte";
  import AdminConfirmation from "./AdminConfirmation.svelte";
  import { sessionId } from "./session.ts";

  let {
    data,
    say,
    reload,
  }: {
    data: MemoryListResponse;
    say: (text: string) => void;
    reload: () => Promise<void>;
  } = $props();

  // A card waiting under a memory ("Vergeten") or under the form ("Onthouden").
  let cards = $state<Record<string, PendingConfirmation>>({});
  let formCard = $state<PendingConfirmation | null>(null);
  let text = $state("");
  let type = $state("USER_FACT");
  let relatedEntity = $state("");
  let saving = $state(false);

  const memoryTypes = [
    { value: "USER_FACT", label: "Feit" },
    { value: "PERSON", label: "Persoon" },
    { value: "PET", label: "Huisdier" },
    { value: "PREFERENCE", label: "Voorkeur" },
    { value: "HABIT", label: "Gewoonte" },
    { value: "PROJECT", label: "Project" },
  ];
  const labels = Object.fromEntries(
    memoryTypes.map(({ value, label }) => [value, label]),
  );

  async function forget(id: string): Promise<void> {
    try {
      const result = await forgetMemory(id, sessionId());
      if (result.requiresConfirmation && result.action)
        cards[id] = result.action;
      else say(result.error || "Verwijderd");
    } catch (error) {
      say(
        error instanceof ApiError ? error.message : "Geheugen niet beschikbaar",
      );
    }
  }

  async function remember(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    saving = true;
    try {
      const result: ConfirmableResult = await rememberMemory(
        text,
        sessionId(),
        type,
        relatedEntity,
      );
      if (result.requiresConfirmation && result.action) {
        formCard = result.action;
        say("Bevestig deze herinnering om hem op te slaan.");
        return;
      }
      if (!result.ok) throw new Error(result.error || "Niet opgeslagen");
      await reload();
      text = "";
      relatedEntity = "";
      say("Opgeslagen");
    } catch (error) {
      say(error instanceof ApiError ? error.message : "Niet opgeslagen");
    } finally {
      saving = false;
    }
  }
</script>

{#each data.memories ?? [] as item (item.id)}
  <section class="admin-row">
    <strong>{labels[item.type ?? ""] ?? item.type ?? "Feit"}</strong>
    {#if item.related_entity}<small>Bij: {item.related_entity}</small>{/if}
    <p>{item.text}</p>
    <Button onclick={() => forget(item.id)}>Vergeten</Button>
    {#if cards[item.id]}
      <AdminConfirmation
        action={cards[item.id] as PendingConfirmation}
        onreply={say}
      />
    {/if}
  </section>
{/each}
{#if !data.memories?.length && !data.unavailable}
  <section class="admin-row">
    <strong>Geheugen</strong>
    <p>Nog geen duurzame herinneringen opgeslagen.</p>
  </section>
{/if}
{#if formCard}
  <AdminConfirmation action={formCard} onreply={say} />
{/if}
<form onsubmit={remember}>
  <textarea
    id="memoryText"
    aria-label="Duurzame herinnering"
    placeholder="Wat wil je dat NOVA onthoudt? Geen wachtwoorden of tokens."
    bind:value={text}></textarea>
  <label for="memoryType">Soort</label>
  <select id="memoryType" bind:value={type}>
    {#each memoryTypes as option (option.value)}
      <option value={option.value}>{option.label}</option>
    {/each}
  </select>
  <label for="memoryRelatedEntity"
    >Persoon, huisdier of project (optioneel)</label
  >
  <input
    id="memoryRelatedEntity"
    bind:value={relatedEntity}
    maxlength="200"
    autocomplete="off"
  />
  <Button type="submit" disabled={saving}>Onthouden</Button>
</form>
