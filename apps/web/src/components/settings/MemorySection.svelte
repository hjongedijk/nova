<script lang="ts">
  import { onMount } from "svelte";
  import type { PendingConfirmation } from "@nova/contracts";
  import AdminConfirmation from "#components/admin/AdminConfirmation.svelte";
  import AdminDialog from "#components/admin/AdminDialog.svelte";
  import { sessionId } from "#components/admin/session.ts";
  import {
    MEMORY_KINDS,
    confidenceWord,
    correctMemory,
    forgetMemoryRecord,
    kindLabel,
    listMemories,
    visibleText,
    type MemoryItem,
    type MemoryKindId,
  } from "#lib/api/memory.ts";
  import { fail, say } from "./state.svelte.ts";
  import SectionCard from "./ui/SectionCard.svelte";
  import Field from "./ui/Field.svelte";
  import Switch from "./ui/Switch.svelte";
  import StatusPill from "./ui/StatusPill.svelte";
  import Disclosure from "./ui/Disclosure.svelte";

  let items = $state<MemoryItem[]>([]);
  let next = $state<string | number | null>(null);
  let loaded = $state(false);
  let loading = $state(false);
  let unavailable = $state("");
  let query = $state("");
  let kind = $state<MemoryKindId | "">("");
  let history = $state(false);

  let revealed = $state<Record<string, boolean>>({});
  let editing = $state<string | null>(null);
  let draft = $state("");
  let forgetting = $state<string | null>(null);
  let withHistory = $state(false);
  let cards = $state<Record<string, PendingConfirmation>>({});
  let busy = $state(false);
  let version = 0;

  const date = (value?: string) =>
    value ? new Date(value).toLocaleDateString("nl-NL") : "";

  async function load(more = false) {
    const mine = ++version;
    loading = true;
    try {
      const page = await listMemories({
        kind,
        q: query,
        history,
        cursor: more ? next : null,
      });
      if (mine !== version) return;
      unavailable = page.unavailable ?? "";
      items = more
        ? [...items, ...(page.memories ?? [])]
        : (page.memories ?? []);
      next = page.next ?? null;
      loaded = true;
    } catch (cause) {
      if (mine === version) fail(cause);
    } finally {
      if (mine === version) loading = false;
    }
  }

  function search(event: SubmitEvent) {
    event.preventDefault();
    void load();
  }

  function startEdit(item: MemoryItem) {
    editing = item.id;
    draft = item.text;
    forgetting = null;
  }

  async function saveEdit(item: MemoryItem) {
    const text = draft.trim();
    if (text.length < 2) return say("Vul de nieuwe tekst in.", "bad");
    busy = true;
    try {
      const result = await correctMemory(item.id, text, sessionId());
      if (!result.ok) return say(result.error || "Niet opgeslagen.", "bad");
      say(
        "Gecorrigeerd. De oude tekst blijft bewaard als eerdere versie.",
        "ok",
      );
      editing = null;
      await load();
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  async function askForget(item: MemoryItem) {
    busy = true;
    try {
      const result = await forgetMemoryRecord(
        item.id,
        sessionId(),
        withHistory,
      );
      if (result.requiresConfirmation && result.action) {
        cards[item.id] = result.action;
        forgetting = null;
      } else if (!result.ok) say(result.error || "Niet verwijderd.", "bad");
      else {
        say("Vergeten.", "ok");
        forgetting = null;
        await load();
      }
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  function forgotten(id: string, reply: string) {
    say(reply, "ok");
    delete cards[id];
    void load();
  }

  onMount(() => void load());
</script>

<SectionCard
  title="Wat NOVA onthoudt"
  lead="Zoek in je herinneringen, corrigeer wat niet klopt of laat NOVA iets vergeten. Gevoelige herinneringen blijven verborgen tot je ze opent."
>
  <form class="filters" role="search" onsubmit={search}>
    <Field label="Zoeken" id="memory-search">
      <input
        id="memory-search"
        type="search"
        bind:value={query}
        maxlength="200"
        autocomplete="off"
        placeholder="Zoek in herinneringen"
      />
    </Field>
    <Field label="Soort" id="memory-kind">
      <select id="memory-kind" bind:value={kind} onchange={() => load()}>
        <option value="">Alles</option>
        {#each MEMORY_KINDS as option (option.id)}
          <option value={option.id}>{option.label}</option>
        {/each}
      </select>
    </Field>
    <button type="submit" class="go" disabled={loading}>Zoeken</button>
  </form>
  <Switch
    bind:checked={history}
    label="Eerdere versies tonen"
    hint="Ook herinneringen die later gecorrigeerd zijn."
    onchange={() => queueMicrotask(() => load())}
  />

  {#if unavailable}
    <p role="alert" class="hint">{unavailable}</p>
  {:else if !loaded}
    <p class="hint">Laden…</p>
  {:else if !items.length}
    <p class="hint">
      {query || kind
        ? "Niets gevonden met deze zoekopdracht."
        : "NOVA heeft nog niets onthouden."}
    </p>
  {:else}
    <ul class="memories" aria-live="polite">
      {#each items as item (item.id)}
        {@const old = !!item.superseded_by}
        {@const hidden = item.sensitive === true && !revealed[item.id]}
        <li class:old>
          <div class="head">
            <StatusPill tone="neutral" label={kindLabel(item.kind)} />
            <StatusPill
              tone={confidenceWord(item.confidence) === "zeker" ? "ok" : "warn"}
              label={confidenceWord(item.confidence)}
            />
            {#if old}<StatusPill tone="neutral" label="eerdere versie" />{/if}
            {#if item.sensitive}<StatusPill tone="warn" label="gevoelig" />{/if}
            <span class="date">{date(item.updated_at ?? item.created_at)}</span>
          </div>

          {#if editing === item.id}
            <label class="edit" for="edit-{item.id}">Nieuwe tekst</label>
            <textarea
              id="edit-{item.id}"
              bind:value={draft}
              maxlength="2000"
              rows="3"></textarea>
            <div class="actions">
              <button
                type="button"
                class="go"
                disabled={busy}
                onclick={() => saveEdit(item)}>Opslaan</button
              >
              <button
                type="button"
                disabled={busy}
                onclick={() => (editing = null)}>Annuleren</button
              >
            </div>
          {:else}
            <p class="text" class:masked={hidden}>
              {visibleText(item, !!revealed[item.id])}
            </p>
            <div class="actions">
              {#if item.sensitive}
                <button
                  type="button"
                  aria-pressed={!!revealed[item.id]}
                  onclick={() => (revealed[item.id] = !revealed[item.id])}
                  >{revealed[item.id] ? "Verbergen" : "Tonen"}</button
                >
              {/if}
              {#if !old}
                <button
                  type="button"
                  disabled={busy || hidden}
                  title={hidden ? "Toon de tekst eerst" : undefined}
                  onclick={() => startEdit(item)}>Corrigeren</button
                >
              {/if}
              <button
                type="button"
                disabled={busy}
                onclick={() => {
                  forgetting = item.id;
                  withHistory = false;
                  editing = null;
                }}>Vergeten</button
              >
            </div>
          {/if}

          {#if forgetting === item.id}
            <div class="forget" role="group" aria-label="Vergeten bevestigen">
              <p>Deze herinnering vergeten?</p>
              <label class="check">
                <input type="checkbox" bind:checked={withHistory} />
                ook eerdere versies verwijderen
              </label>
              <div class="actions">
                <button
                  type="button"
                  disabled={busy}
                  onclick={() => askForget(item)}>Verder</button
                >
                <button type="button" onclick={() => (forgetting = null)}
                  >Annuleren</button
                >
              </div>
            </div>
          {/if}
          {#if cards[item.id]}
            <AdminConfirmation
              action={cards[item.id] as PendingConfirmation}
              onreply={(reply) => forgotten(item.id, reply)}
            />
          {/if}
        </li>
      {/each}
    </ul>
    {#if next !== null}
      <button type="button" disabled={loading} onclick={() => load(true)}
        >Meer laden</button
      >
    {/if}
  {/if}
</SectionCard>

<Disclosure title="Iets laten onthouden" hint="Voeg zelf een herinnering toe">
  <AdminDialog embedded initialView="memories" memoriesFormOnly />
</Disclosure>

<style>
  .filters {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.75rem;
    align-items: end;
    margin-bottom: 0.75rem;
  }
  @media (min-width: 700px) {
    .filters {
      grid-template-columns: 2fr 1fr auto;
    }
  }
  .memories {
    list-style: none;
    margin: 1rem 0;
    padding: 0;
    display: grid;
    gap: 0.9rem;
  }
  .memories li {
    border: 1px solid var(--line);
    border-radius: var(--radius-s, 8px);
    padding: 0.9rem 1rem;
    min-width: 0;
  }
  .memories li.old {
    border-style: dashed;
    opacity: 0.85;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 0.6rem;
    align-items: center;
  }
  .date {
    margin-left: auto;
    font-size: 16px;
    color: var(--dim);
  }
  .text {
    margin: 0.6rem 0;
    font-size: 16px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .text.masked {
    color: var(--dim);
    font-style: italic;
  }
  .edit {
    display: block;
    margin-top: 0.6rem;
    font-size: 16px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.5rem 0;
  }
  .forget {
    border-top: 1px solid var(--line);
    margin-top: 0.5rem;
    padding-top: 0.5rem;
  }
  .hint {
    font-size: 16px;
    color: var(--dim);
  }
</style>
