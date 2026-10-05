<script lang="ts">
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
  let saving = $state(false);

  async function forget(id: string): Promise<void> {
    try {
      const result = await forgetMemory(id, sessionId());
      if (result.requiresConfirmation && result.action)
        cards[id] = result.action;
      else say(result.error || "Verwijderd");
    } catch (error) {
      say(error instanceof Error ? error.message : "Geheugen niet beschikbaar");
    }
  }

  async function remember(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    saving = true;
    try {
      const result: ConfirmableResult = await rememberMemory(text, sessionId());
      if (result.requiresConfirmation && result.action) {
        formCard = result.action;
        say("Bevestig deze herinnering om hem op te slaan.");
        return;
      }
      if (!result.ok) throw new Error(result.error || "Niet opgeslagen");
      await reload();
      say("Opgeslagen");
    } catch (error) {
      say(error instanceof Error ? error.message : "Niet opgeslagen");
    } finally {
      saving = false;
    }
  }
</script>

{#each data.memories ?? [] as item (item.id)}
  <section class="admin-row">
    <strong>{item.type}</strong>
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
    placeholder="Een duurzame voorkeur of feit. Geen wachtwoorden of tokens."
    bind:value={text}></textarea>
  <Button type="submit" disabled={saving}>Onthouden</Button>
</form>
